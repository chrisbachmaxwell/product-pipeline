/**
 * Contract tests for the isolated order-import operator CLI. Everything runs
 * against a real on-disk production-scoped migration store; only the eBay and
 * Shopify HTTP transports are faked (the real bounded adapters run against
 * fixture responses). No network access of any kind occurs, and no test can
 * create a real Shopify order.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveExternalIdentityKey,
  deriveScopeKey,
  MigrationStoreError,
  openMigrationStore,
  openMigrationStoreReadOnly,
  sha256Digest,
  type IntegrationScope,
} from '../../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../../shopify/production-identity.js';
import {
  createEbayOrderReadAdapter,
  exchangeOrderImportEbayToken,
  EbayOrderReadError,
  EBAY_ORDER_TOKEN_SCOPES,
} from '../ebay-order-adapter.js';
import { createShopifyOrderAdapter } from '../shopify-order-adapter.js';
import { buildOrderImportAdminProgram, type OrderImportAdminIo } from '../program.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const SCOPE_KEY = deriveScopeKey(MIGRATION_SCOPE);
const SHOPIFY_URL = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}`
  + `/admin/api/${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.adminApiVersion}/graphql.json`;

const ORDER_ID = '11-11111-11111';
const PRE_ORDER_ID = '22-22222-22222';
const EQUAL_ORDER_ID = '33-33333-33333';
const LATER_ORDER_ID = '44-44444-44444';
const SKU = 'CAN3570-U119';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000563491';
const BOUNDARY_UTC = '2026-08-19T18:00:00.000Z';

// Fixture PII that must never reach the durable store, stdout, or stderr.
const PII_FULL_NAME = 'Fixture Buyer Name';
const PII_STREET = '123 Fixture Street';
const PII_EMAIL = 'fixture-buyer@example.com';
const PII_PHONE = '555-0100';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function digest(label: string): string {
  return sha256Digest(label);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ebayOrderFixture(orderId: string, creationDate: string): Record<string, unknown> {
  return {
    orderId,
    creationDate,
    orderFulfillmentStatus: 'NOT_STARTED',
    orderPaymentStatus: 'PAID',
    pricingSummary: { total: { value: '129.95', currency: 'USD' } },
    lineItems: [{
      lineItemId: `li-${orderId}`,
      sku: SKU,
      title: 'Canon EF 35-70mm Lens',
      quantity: 1,
      lineItemCost: { value: '119.95', currency: 'USD' },
    }],
    buyer: { username: 'fixture_buyer' },
    fulfillmentStartInstructions: [{
      shippingStep: {
        shipTo: {
          fullName: PII_FULL_NAME,
          email: PII_EMAIL,
          primaryPhone: { phoneNumber: PII_PHONE },
          contactAddress: {
            addressLine1: PII_STREET,
            city: 'Salt Lake City',
            stateOrProvince: 'UT',
            postalCode: '84101',
            countryCode: 'US',
          },
        },
      },
    }],
  };
}

type World = {
  migrationDatabasePath: string;
  setClock: (iso: string) => void;
  ebayListOrders: Array<Record<string, unknown>>;
  ebayOrderDetails: Map<string, Record<string, unknown>>;
  ebayUrls: string[];
  shopifyScopes: string[];
  ordersByTag: Map<string, string[]>;
  ordersBySourceIdentifier: Map<string, string[]>;
  variantsBySku: Map<string, string>;
  orderCreateCalls: Array<Record<string, any>>;
  orderCreateBehavior: { mode: 'success' | 'user_errors' | 'transport_error' | 'created_not_indexed' };
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  buildProgram: () => ReturnType<typeof buildOrderImportAdminProgram>;
  run: (argv: string[]) => Promise<void>;
  lastStdout: () => Record<string, any>;
  lastStderr: () => Record<string, any>;
};

function createWorld(): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'order-import-admin-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationDatabasePath,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-19T17:00:00.000Z',
  }).close();

  let tickMs = Date.parse('2026-08-19T18:00:00.000Z');
  const now = (): Date => new Date(tickMs += 1_000);
  const setClock = (iso: string): void => {
    tickMs = Math.max(tickMs, Date.parse(iso));
  };

  const world: World = {
    migrationDatabasePath,
    setClock,
    ebayListOrders: [],
    ebayOrderDetails: new Map(),
    ebayUrls: [],
    shopifyScopes: ['read_products', 'read_orders', 'read_inventory', 'write_orders'],
    ordersByTag: new Map(),
    ordersBySourceIdentifier: new Map(),
    variantsBySku: new Map(),
    orderCreateCalls: [],
    orderCreateBehavior: { mode: 'success' },
    stdout: [],
    stderr: [],
    exitCodes: [],
    buildProgram: () => buildOrderImportAdminProgram(),
    run: async () => undefined,
    lastStdout: () => {
      expect(world.stdout.length).toBeGreaterThan(0);
      return JSON.parse(world.stdout[world.stdout.length - 1]!) as Record<string, any>;
    },
    lastStderr: () => {
      expect(world.stderr.length).toBeGreaterThan(0);
      return JSON.parse(world.stderr[world.stderr.length - 1]!) as Record<string, any>;
    },
  };

  const ebayFetch: typeof fetch = async (input) => {
    const url = String(input);
    world.ebayUrls.push(url);
    if (url.startsWith('https://api.ebay.com/sell/fulfillment/v1/order?')) {
      return jsonResponse({ orders: world.ebayListOrders });
    }
    const single = url.match(/^https:\/\/api\.ebay\.com\/sell\/fulfillment\/v1\/order\/([^?/]+)$/);
    if (single) {
      const detail = world.ebayOrderDetails.get(decodeURIComponent(single[1]!));
      return detail ? jsonResponse(detail) : jsonResponse({ error: 'not found' }, 404);
    }
    throw new Error(`unexpected eBay URL: ${url}`);
  };

  const shopifyFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url !== SHOPIFY_URL) throw new Error(`unexpected Shopify URL: ${url}`);
    const body = JSON.parse(String(init?.body)) as {
      operationName: string;
      variables: Record<string, any>;
    };
    if (body.operationName === 'OrderImportPreflight') {
      return jsonResponse({
        data: {
          shop: {
            id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid,
            myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
          },
          currentAppInstallation: {
            accessScopes: world.shopifyScopes.map((handle) => ({ handle })),
          },
        },
      });
    }
    if (body.operationName === 'OrderImportOrdersByTag') {
      const match = /^tag:'(.+)'$/.exec(String(body.variables.query));
      const gids = match ? world.ordersByTag.get(match[1]!) ?? [] : [];
      return jsonResponse({ data: { orders: {
        nodes: gids.map((id) => ({ id, tags: [match![1]!], sourceIdentifier: null })),
        pageInfo: { hasNextPage: false },
      } } });
    }
    if (body.operationName === 'OrderImportOrdersBySourceIdentifier') {
      const match = /^source_identifier:(.+)$/.exec(String(body.variables.query));
      const gids = match ? world.ordersBySourceIdentifier.get(match[1]!) ?? [] : [];
      return jsonResponse({ data: { orders: {
        nodes: gids.map((id) => ({ id, tags: [], sourceIdentifier: match![1]! })),
        pageInfo: { hasNextPage: false },
      } } });
    }
    if (body.operationName === 'OrderImportVariantBySku') {
      const match = /^sku:'(.+)'$/.exec(String(body.variables.query));
      const gid = match ? world.variantsBySku.get(match[1]!) : undefined;
      return jsonResponse({
        data: {
          productVariants: { nodes: gid ? [{ id: gid, sku: match![1]! }] : [] },
        },
      });
    }
    if (body.operationName === 'OrderImportCreate') {
      world.orderCreateCalls.push(body.variables.order as Record<string, any>);
      const mode = world.orderCreateBehavior.mode;
      if (mode === 'transport_error') return jsonResponse({ error: 'boom' }, 500);
      if (mode === 'user_errors') {
        return jsonResponse({
          data: {
            orderCreate: {
              order: null,
              userErrors: [{ field: ['order'], message: 'rejected by fixture' }],
            },
          },
        });
      }
      const gid = `gid://shopify/Order/${9000 + world.orderCreateCalls.length}`;
      if (mode === 'success') {
        const tags = (body.variables.order as { tags: string[] }).tags;
        const tag = tags.find((value) => value.startsWith('eBay-'))!;
        world.ordersByTag.set(tag, [...(world.ordersByTag.get(tag) ?? []), gid]);
        const sourceIdentifier = (body.variables.order as { sourceIdentifier: string })
          .sourceIdentifier;
        world.ordersBySourceIdentifier.set(sourceIdentifier, [
          ...(world.ordersBySourceIdentifier.get(sourceIdentifier) ?? []), gid,
        ]);
      }
      return jsonResponse({ data: { orderCreate: { order: { id: gid }, userErrors: [] } } });
    }
    throw new Error(`unexpected Shopify operation: ${body.operationName}`);
  };

  const io: OrderImportAdminIo = {
    stdout: (message) => world.stdout.push(message),
    stderr: (message) => world.stderr.push(message),
    setExitCode: (code) => world.exitCodes.push(code),
  };
  world.buildProgram = () => buildOrderImportAdminProgram({
    createEbayAdapter: () => createEbayOrderReadAdapter({
      fetchImpl: ebayFetch,
      getAccessToken: async () => 'transient-ebay-test-token',
    }),
    createShopifyAdapter: () => createShopifyOrderAdapter({
      fetchImpl: shopifyFetch,
      getAccessToken: async () => 'shopify-offline-test-token',
    }),
    now,
    io,
  });
  world.run = async (argv: string[]): Promise<void> => {
    await world.buildProgram().parseAsync(argv, { from: 'user' });
  };
  return world;
}

async function establishOwnership(world: World): Promise<void> {
  await world.run(['establish-ownership',
    '--migration-store', world.migrationDatabasePath,
    '--confirm-scope', SCOPE_KEY,
    '--baseline-evidence', digest('marketplace-connect-order-import-baseline'),
    '--mc-disabled-evidence', digest('marketplace-connect-order-import-disabled-proof'),
  ]);
}

async function establishWatermark(world: World, boundary = BOUNDARY_UTC): Promise<void> {
  await world.run(['establish-watermark',
    '--migration-store', world.migrationDatabasePath,
    '--confirm-scope', SCOPE_KEY,
    '--boundary', boundary,
    '--accepted-evidence', digest('accepted-watermark-packet'),
  ]);
}

function ebayOrderIdentityKey(orderId: string): string {
  return deriveExternalIdentityKey({
    platform: 'ebay',
    kind: 'order',
    bindingKey: `ebay-order:${orderId}`,
    environment: MIGRATION_SCOPE.ebayEnvironment,
    sellerId: MIGRATION_SCOPE.ebaySellerId,
    marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
    externalId: orderId,
  });
}

function expectMigrationError(operation: () => unknown, code: MigrationStoreError['code']): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationStoreError);
  expect((caught as MigrationStoreError).code).toBe(code);
}

describe('order-import operator CLI', () => {
  it('establishes the ownership chain idempotently and the watermark under the clamp', async () => {
    const world = createWorld();

    await establishOwnership(world);
    expect(world.lastStdout()).toMatchObject({
      command: 'establish-ownership',
      status: 'established',
      version: 3,
      externalWritesPerformed: 0,
    });

    // Idempotent continuation: a second run is already-established.
    await establishOwnership(world);
    expect(world.lastStdout()).toMatchObject({
      status: 'already-established',
      version: 3,
    });

    // Two-hour-old boundary violates the store's one-hour no-backfill clamp;
    // the fixed store error is surfaced verbatim.
    world.setClock('2026-08-19T20:00:00.000Z');
    await establishWatermark(world, '2026-08-19T18:00:00.000Z');
    expect(world.lastStderr()).toMatchObject({
      command: 'establish-watermark',
      status: 'denied',
      code: 'MIGRATION_STORE_INVALID_INPUT',
    });
    expect(String(world.lastStderr().storeMessage)).toMatch(/one-hour no-backfill clamp/);

    // A thirty-minute-old boundary satisfies the clamp.
    await establishWatermark(world, '2026-08-19T19:30:00.000Z');
    expect(world.lastStdout()).toMatchObject({
      command: 'establish-watermark',
      status: 'established',
      eventField: 'creationDate',
      boundaryMode: 'exclusive',
      boundaryExclusiveUtc: '2026-08-19T19:30:00.000Z',
    });

    // One watermark per scope forever.
    await establishWatermark(world, '2026-08-19T19:45:00.000Z');
    expect(world.lastStderr()).toMatchObject({ code: 'MIGRATION_STORE_CONFLICT' });
  });

  it('poll records eligible and permanently-ineligible observations and never a PII byte', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');

    world.ebayListOrders = [
      ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'),
      ebayOrderFixture(PRE_ORDER_ID, '2026-08-19T17:30:00.000Z'),
      ebayOrderFixture(EQUAL_ORDER_ID, BOUNDARY_UTC),
    ];
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);
    const polled = world.lastStdout();
    expect(polled).toMatchObject({
      command: 'poll',
      status: 'polled',
      watermarkBoundaryExclusiveUtc: BOUNDARY_UTC,
      counts: {
        fetched: 3,
        recordedEligible: 1,
        recordedPermanentlyIneligible: 2,
        skippedAlreadyObserved: 0,
      },
      externalCommerceWritesAttempted: 0,
    });
    expect(polled.eligibleOrders).toEqual([
      { orderId: ORDER_ID, creationDateUtc: '2026-08-19T18:00:30.000Z' },
    ]);
    // The poll filter starts exactly at the watermark boundary.
    expect(world.ebayUrls[0]).toContain(`filter=creationdate:%5B${BOUNDARY_UTC}..%5D`);
    expect(world.ebayUrls[0]).toContain('limit=10');

    // At-or-before-boundary orders can NEVER produce an import intent.
    const store = openMigrationStore({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      for (const deniedOrderId of [PRE_ORDER_ID, EQUAL_ORDER_ID]) {
        expectMigrationError(() => store.createIdempotencyIntent({
          action: 'import_shopify_order',
          sourceIdentityKey: ebayOrderIdentityKey(deniedOrderId),
          targetIdentityKey: null,
          desiredStateDigest: digest(`denied:${deniedOrderId}`),
          createdAtUtc: '2026-08-19T18:20:00.000Z',
          audit: {
            eventId: `intent:denied:${deniedOrderId}`,
            occurredAtUtc: '2026-08-19T18:20:00.000Z',
          },
        }), 'WATERMARK_REQUIRED');
      }
      expect(store.getCounts()).toMatchObject({
        order_observations: 3,
        order_observation_resolutions: 2,
        idempotency_intents: 0,
      });
      expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    } finally {
      store.close();
    }

    // A second poll of the same provider window skips gracefully.
    world.setClock('2026-08-19T18:21:00.000Z');
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);
    expect(world.lastStdout()).toMatchObject({
      status: 'polled',
      counts: {
        fetched: 3,
        recordedEligible: 0,
        recordedPermanentlyIneligible: 0,
        skippedAlreadyObserved: 3,
      },
    });
    expect((world.lastStdout().skipped as Array<Record<string, unknown>>)
      .every((entry) => entry.status === 'SKIPPED_ALREADY_OBSERVED')).toBe(true);

    // A new order cannot be recorded while the previous page still has an
    // unresolved eligible observation: fail closed, never silently drop.
    world.ebayListOrders.push(ebayOrderFixture(LATER_ORDER_ID, '2026-08-19T18:10:00.000Z'));
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);
    expect(world.lastStdout()).toMatchObject({
      status: 'blocked',
      code: 'POLL_PREVIOUS_PAGE_UNRESOLVED',
    });
    expect(world.exitCodes.at(-1)).toBe(1);

    // No fixture PII anywhere: not in the durable bytes, not in the output.
    const rawBytes = fs.readFileSync(world.migrationDatabasePath).toString('utf8');
    const emitted = world.stdout.join('\n') + world.stderr.join('\n');
    for (const pii of [PII_FULL_NAME, PII_STREET, PII_EMAIL, PII_PHONE, 'fixture_buyer']) {
      expect(rawBytes).not.toContain(pii);
      expect(emitted).not.toContain(pii);
    }
  });

  it('imports exactly one order end to end and persists no PII byte', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    world.variantsBySku.set(SKU, VARIANT_GID);
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    const imported = world.lastStdout();
    expect(imported).toMatchObject({
      command: 'import',
      status: 'imported-and-reconciled',
      orderId: ORDER_ID,
      outcome: 'resolved_existing',
      providerDispatchReported: true,
      userErrorsReported: false,
      orderLinkId: `link:${ORDER_ID}`,
      externalCommerceWritesAttempted: 1,
    });
    expect(imported.shopifyOrderGid).toMatch(/^gid:\/\/shopify\/Order\//);

    // Exactly one orderCreate with the durable dedup tags and resolved line.
    expect(world.orderCreateCalls).toHaveLength(1);
    const createInput = world.orderCreateCalls[0]!;
    expect(createInput.tags).toEqual(['eBay', `eBay-${ORDER_ID}`]);
    expect(createInput.sourceIdentifier).toBe(ORDER_ID);
    expect(createInput.financialStatus).toBe('PAID');
    expect(createInput.sourceName).toBe('ebay');
    expect(String(createInput.note)).toContain(ORDER_ID);
    expect(createInput.lineItems).toEqual([{
      variantId: VARIANT_GID,
      quantity: 1,
      priceSet: { shopMoney: { amount: '119.95', currencyCode: 'USD' } },
    }]);
    // Shipping details passed through to the ONE provider call only.
    expect(createInput.shippingAddress).toMatchObject({ address1: PII_STREET });

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expect(store.getJobStatus(imported.jobId as string)).toMatchObject({
        state: 'resolved_existing',
        responsibility: 'orderImport',
        attemptOutcome: 'outcome_unknown',
      });
      expect(store.getCounts()).toMatchObject({
        idempotency_intents: 1,
        action_approvals: 1,
        approval_consumptions: 1,
        execution_jobs: 1,
        intent_attempts: 1,
        attempt_resolutions: 1,
        order_links: 1,
        reconciliation_runs: 1,
      });
      expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    } finally {
      store.close();
    }

    // NO PII persisted: the raw migration-store bytes contain none of the
    // fixture buyer strings, and neither does any CLI output.
    const rawBytes = fs.readFileSync(world.migrationDatabasePath).toString('utf8');
    const emitted = world.stdout.join('\n') + world.stderr.join('\n');
    for (const pii of [PII_FULL_NAME, PII_STREET, PII_EMAIL, PII_PHONE, 'fixture_buyer']) {
      expect(rawBytes).not.toContain(pii);
      expect(emitted).not.toContain(pii);
    }

    // Replay of an imported order is denied before any provider call.
    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    expect(world.lastStderr()).toMatchObject({ command: 'import', code: 'IMPORT_ALREADY_LINKED' });
    expect(world.orderCreateCalls).toHaveLength(1);

    // The next poll advances the fully resolved page and records new orders.
    world.setClock('2026-08-19T18:30:00.000Z');
    world.ebayListOrders.push(ebayOrderFixture(LATER_ORDER_ID, '2026-08-19T18:12:00.000Z'));
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);
    expect(world.lastStdout()).toMatchObject({
      status: 'polled',
      counts: { recordedEligible: 1, skippedAlreadyObserved: 1 },
    });

    // The store denies any second intent for the imported order forever.
    const writable = openMigrationStore({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expectMigrationError(() => writable.createIdempotencyIntent({
        action: 'import_shopify_order',
        sourceIdentityKey: ebayOrderIdentityKey(ORDER_ID),
        targetIdentityKey: null,
        desiredStateDigest: digest('replay-must-not-create-second-intent'),
        createdAtUtc: '2026-08-19T18:40:00.000Z',
        audit: { eventId: 'intent:replay-denied', occurredAtUtc: '2026-08-19T18:40:00.000Z' },
      }), 'WATERMARK_REQUIRED');
    } finally {
      writable.close();
    }
  });

  it('links a Marketplace Connect source-identified Shopify order without any intent', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    world.variantsBySku.set(SKU, VARIANT_GID);
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);

    // Marketplace Connect (or anything else) already created this order.
    world.ordersBySourceIdentifier.set(ORDER_ID, ['gid://shopify/Order/7777']);
    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    expect(world.lastStdout()).toMatchObject({
      command: 'import',
      status: 'DEDUP_LINKED_EXISTING',
      orderId: ORDER_ID,
      linkId: `link:${ORDER_ID}`,
      shopifyOrderGid: 'gid://shopify/Order/7777',
      externalCommerceWritesAttempted: 0,
    });
    expect(world.orderCreateCalls).toHaveLength(0);

    const store = openMigrationStore({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expect(store.getCounts()).toMatchObject({
        idempotency_intents: 0,
        execution_jobs: 0,
        order_links: 1,
      });
      // The schema itself denies any future intent for the linked order.
      expectMigrationError(() => store.createIdempotencyIntent({
        action: 'import_shopify_order',
        sourceIdentityKey: ebayOrderIdentityKey(ORDER_ID),
        targetIdentityKey: null,
        desiredStateDigest: digest('post-dedup-intent-denied'),
        createdAtUtc: '2026-08-19T18:20:00.000Z',
        audit: { eventId: 'intent:post-dedup', occurredAtUtc: '2026-08-19T18:20:00.000Z' },
      }), 'WATERMARK_REQUIRED');
    } finally {
      store.close();
    }

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    expect(world.lastStderr()).toMatchObject({ code: 'IMPORT_ALREADY_LINKED' });
  });

  it('denies conflicting source-id and tag matches before any intent or write', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);
    world.ordersBySourceIdentifier.set(ORDER_ID, ['gid://shopify/Order/7777']);
    world.ordersByTag.set(`eBay-${ORDER_ID}`, ['gid://shopify/Order/8888']);

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    expect(world.lastStderr()).toMatchObject({
      command: 'import', code: 'IMPORT_SHOPIFY_DUPLICATE_AMBIGUOUS',
    });
    expect(world.orderCreateCalls).toHaveLength(0);
    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getCounts()).toMatchObject({ idempotency_intents: 0, execution_jobs: 0 });
    store.close();
  });

  it('fails closed before any intent when write_orders is missing', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    world.variantsBySku.set(SKU, VARIANT_GID);
    // The current production app version is read-only.
    world.shopifyScopes = ['read_products', 'read_orders', 'read_inventory', 'read_fulfillments'];
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    expect(world.lastStderr()).toMatchObject({
      command: 'import',
      code: 'IMPORT_SHOPIFY_WRITE_SCOPE_MISSING',
    });
    expect(world.orderCreateCalls).toHaveLength(0);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expect(store.getCounts()).toMatchObject({
        idempotency_intents: 0,
        action_approvals: 0,
        execution_jobs: 0,
        intent_attempts: 0,
      });
    } finally {
      store.close();
    }
  });

  it('denies an unresolvable SKU before any write and any intent', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    // No variant registered for the SKU.
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    expect(world.lastStderr()).toMatchObject({ command: 'import', code: 'IMPORT_SKU_UNRESOLVED' });
    expect(world.orderCreateCalls).toHaveLength(0);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expect(store.getCounts()).toMatchObject({ idempotency_intents: 0, execution_jobs: 0 });
    } finally {
      store.close();
    }
  });

  it('requires the literal --confirm-lightspeed acknowledgement', async () => {
    const world = createWorld();
    // Commander enforces the required literal flag before the action runs.
    const program = world.buildProgram()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    for (const command of program.commands) {
      command.exitOverride();
      command.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    }
    await expect(program.parseAsync(
      ['import', '--migration-store', world.migrationDatabasePath, '--order-id', ORDER_ID],
      { from: 'user' },
    )).rejects.toThrowError(/confirm-lightspeed/);
    expect(world.orderCreateCalls).toHaveLength(0);
  });

  it('leaves orderCreate userErrors unresolved; only --accept-absent terminalizes', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    world.variantsBySku.set(SKU, VARIANT_GID);
    world.orderCreateBehavior.mode = 'user_errors';
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    const imported = world.lastStdout();
    expect(imported).toMatchObject({
      command: 'import',
      status: 'dispatched-unresolved',
      outcome: 'unresolved',
      providerDispatchReported: false,
      userErrorsReported: true,
      exceptionCode: 'ORDER_IMPORT_STATE_NOT_YET_OBSERVED',
    });
    expect(world.exitCodes.at(-1)).toBe(1);
    const jobId = imported.jobId as string;
    const attemptId = imported.attemptId as string;

    const readState = (): Record<string, unknown> | null => {
      const store = openMigrationStoreReadOnly({
        databasePath: world.migrationDatabasePath,
        expectedScope: MIGRATION_SCOPE,
      });
      try {
        return store.getJobStatus(jobId);
      } finally {
        store.close();
      }
    };
    expect(readState()).toMatchObject({ state: 'reconciliation_required' });

    // Reconcile without the explicit acknowledgement stays unresolved.
    await world.run(['reconcile', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--job-id', jobId, '--attempt-id', attemptId]);
    expect(world.lastStdout()).toMatchObject({
      command: 'reconcile',
      status: 'unresolved',
      outcome: 'unresolved',
      externalWritesPerformed: 0,
    });
    expect(readState()).toMatchObject({ state: 'reconciliation_required' });

    // Only the explicit operator acknowledgement records confirmed_missing.
    await world.run(['reconcile', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--job-id', jobId, '--attempt-id', attemptId,
      '--accept-absent']);
    expect(world.lastStdout()).toMatchObject({
      command: 'reconcile',
      status: 'reconciled',
      outcome: 'confirmed_missing',
    });
    expect(readState()).toMatchObject({ state: 'confirmed_missing' });

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expect(store.getCounts()).toMatchObject({ order_links: 0, attempt_resolutions: 1 });
      expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    } finally {
      store.close();
    }
  });

  it('resolves a created-but-not-yet-indexed order through reconcile once it appears', async () => {
    const world = createWorld();
    await establishOwnership(world);
    await establishWatermark(world);
    world.setClock('2026-08-19T18:05:00.000Z');
    world.ebayListOrders = [ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z')];
    world.ebayOrderDetails.set(ORDER_ID, ebayOrderFixture(ORDER_ID, '2026-08-19T18:00:30.000Z'));
    world.variantsBySku.set(SKU, VARIANT_GID);
    world.orderCreateBehavior.mode = 'created_not_indexed';
    await world.run(['poll', '--migration-store', world.migrationDatabasePath,
      '--max-orders', '10']);

    await world.run(['import', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID, '--confirm-lightspeed']);
    const imported = world.lastStdout();
    expect(imported).toMatchObject({ status: 'dispatched-unresolved', outcome: 'unresolved' });

    // The created order becomes visible to the tag search later.
    world.ordersByTag.set(`eBay-${ORDER_ID}`, ['gid://shopify/Order/9001']);
    await world.run(['reconcile', '--migration-store', world.migrationDatabasePath,
      '--order-id', ORDER_ID,
      '--job-id', imported.jobId as string,
      '--attempt-id', imported.attemptId as string]);
    expect(world.lastStdout()).toMatchObject({
      command: 'reconcile',
      status: 'reconciled',
      outcome: 'resolved_existing',
      shopifyOrderGid: 'gid://shopify/Order/9001',
      orderLinkId: `link:${ORDER_ID}`,
    });

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    try {
      expect(store.getJobStatus(imported.jobId as string)).toMatchObject({
        state: 'resolved_existing',
      });
      expect(store.getCounts()).toMatchObject({ order_links: 1 });
    } finally {
      store.close();
    }
  });

  it('exchanges the transient token with exactly the fulfillment scope pair, fail closed', async () => {
    const auth = Object.freeze({
      shopifyAccessToken: 'shopify-token',
      ebayRefreshToken: 'ebay-refresh-token',
      ebayAppId: 'app-id',
      ebayCertId: 'cert-id',
    });
    const requestedScopes: string[] = [];
    const exchangeFetch = (scopeEcho: string): typeof fetch => async (input, init) => {
      expect(String(input)).toBe('https://api.ebay.com/identity/v1/oauth2/token');
      const params = new URLSearchParams(String(init?.body));
      requestedScopes.push(params.get('scope') ?? '');
      return jsonResponse({
        access_token: 'transient-user-token',
        expires_in: 7200,
        token_type: 'User Access Token',
        scope: scopeEcho,
      });
    };

    const token = await exchangeOrderImportEbayToken(
      auth,
      exchangeFetch(EBAY_ORDER_TOKEN_SCOPES.join(' ')),
    );
    expect(token).toEqual({ accessToken: 'transient-user-token', expiresIn: 7200 });
    expect(requestedScopes[0]).toBe(
      'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    );

    // A broader or different scope echo fails closed: the token is unusable.
    await expect(exchangeOrderImportEbayToken(
      auth,
      exchangeFetch(`${EBAY_ORDER_TOKEN_SCOPES.join(' ')} https://api.ebay.com/oauth/api_scope/sell.inventory`),
    )).rejects.toMatchObject({ code: 'ORDER_READ_AUTHORITY_UNAVAILABLE' });
    let caught: unknown;
    try {
      await exchangeOrderImportEbayToken(auth, exchangeFetch('https://api.ebay.com/oauth/api_scope'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EbayOrderReadError);
  });

  it('keeps the CLI free of server-mount, legacy-order, and out-of-adapter fetch usage', () => {
    const sourceRoot = path.dirname(new URL('..', import.meta.url).pathname);
    const read = (relative: string): string =>
      fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
    const program = read('order-import-admin/program.ts');
    const entry = read('order-import-admin/index.ts');
    const storeReader = read('order-import-admin/store-reader.ts');
    const ebayAdapter = read('order-import-admin/ebay-order-adapter.ts');
    const shopifyAdapter = read('order-import-admin/shopify-order-adapter.ts');
    const serverIndex = read('server/index.ts');

    // The server never mounts or imports the order-import slice.
    expect(serverIndex).not.toMatch(/order-import-admin/);

    // The slice never touches the legacy order/sync writers or token manager.
    const sliceSources = [program, entry, storeReader, ebayAdapter, shopifyAdapter].join('\n');
    expect(sliceSources).not.toMatch(
      /from ['"][^'"]*(?:\/sync\/|order-sync|order-safety|product-sync|inventory-sync|price-sync|sync-helper|shopify\/orders\.js|token-manager)[^'"]*['"]/,
    );

    // fetch is used only inside the two bounded adapter files.
    expect(program).not.toMatch(/fetch\s*\(/);
    expect(entry).not.toMatch(/fetch\s*\(/);
    expect(storeReader).not.toMatch(/fetch\s*\(/);

    // The store reader is strictly query-only: no write statement exists.
    expect(storeReader).not.toMatch(/INSERT|UPDATE|DELETE|REPLACE|CREATE TABLE/i);
  });
});
