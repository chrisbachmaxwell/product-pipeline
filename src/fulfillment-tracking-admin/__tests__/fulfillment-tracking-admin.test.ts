import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  createMigrationStore,
  deriveScopeKey,
  openMigrationStore,
  sha256Digest,
  type Digest,
  type IntegrationScope,
  type MigrationStore,
} from '../../migration-store/index.js';
import { buildFulfillmentTrackingAdminProgram } from '../program.js';
import type { ShopifyFulfillmentReader } from '../shopify-fulfillment-reader.js';
import {
  buildShippingFulfillmentBody,
  createEbayFulfillmentAdapter,
  type EbayFulfillmentAdapter,
} from '../ebay-fulfillment-adapter.js';
import type {
  EbayFulfillmentOrder,
  FulfillmentManifest,
  ShopifyFulfillmentOrder,
} from '../manifest.js';

const SCOPE: IntegrationScope = {
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'production',
  ebaySellerId: 'usedcameragear',
  ebayMarketplaceId: 'EBAY_US',
};
const SHOPIFY_ORDER_GID = 'gid://shopify/Order/1000000001';
const SHOPIFY_FULFILLMENT_GID = 'gid://shopify/Fulfillment/9001';
const EBAY_ORDER_ID = '12-34567-89012';
const TRACKING = '1Z999AA10123456784';
const roots: string[] = [];
const stores: MigrationStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function digest(label: string): Digest {
  return sha256Digest(label);
}

function shopifyFixture(partial = false): ShopifyFulfillmentOrder {
  return {
    orderGid: SHOPIFY_ORDER_GID,
    lineItems: [
      { lineItemGid: 'gid://shopify/LineItem/1', quantity: 1 },
      { lineItemGid: 'gid://shopify/LineItem/2', quantity: 2 },
    ],
    fulfillments: [{
      fulfillmentGid: SHOPIFY_FULFILLMENT_GID,
      status: 'SUCCESS',
      createdAtUtc: '2026-08-25T18:00:00.000Z',
      tracking: [{ company: 'UPS', number: TRACKING }],
      lineItems: partial
        ? [{ lineItemGid: 'gid://shopify/LineItem/1', quantity: 1 }]
        : [
          { lineItemGid: 'gid://shopify/LineItem/1', quantity: 1 },
          { lineItemGid: 'gid://shopify/LineItem/2', quantity: 2 },
        ],
    }],
  };
}

function ebayFixture(): EbayFulfillmentOrder {
  return {
    orderId: EBAY_ORDER_ID,
    fulfillmentStatus: 'NOT_STARTED',
    lineItems: [
      { lineItemId: 'line-1', quantity: 1 },
      { lineItemId: 'line-2', quantity: 2 },
    ],
    shippingFulfillments: [],
  };
}

type World = {
  databasePath: string;
  shopify: ShopifyFulfillmentOrder;
  ebay: EbayFulfillmentOrder;
  writes: FulfillmentManifest[];
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  run: (args: string[]) => Promise<void>;
};

function createWorld(input: { partial?: boolean } = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-tracking-admin-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const databasePath = path.join(root, 'migration-state.sqlite');
  const store = createMigrationStore({
    databasePath,
    scope: SCOPE,
    createdAtUtc: '2026-08-25T17:00:00.000Z',
  });
  store.close();
  const world: World = {
    databasePath,
    shopify: shopifyFixture(input.partial),
    ebay: ebayFixture(),
    writes: [],
    stdout: [],
    stderr: [],
    exitCodes: [],
    run: async () => {},
  };
  const shopifyReader: ShopifyFulfillmentReader = {
    getOrder: async () => world.shopify,
  };
  const ebayAdapter: EbayFulfillmentAdapter = {
    getOrder: async () => world.ebay,
    createShippingFulfillment: async (manifest) => {
      world.writes.push(manifest);
      world.ebay = {
        ...world.ebay,
        fulfillmentStatus: 'FULFILLED',
        shippingFulfillments: [{
          fulfillmentId: 'fulfillment-1',
          trackingNumber: manifest.trackingNumber,
          shippingCarrierCode: manifest.shippingCarrierCode,
          shippedDate: manifest.shippedDate,
          lineItems: manifest.lineItems,
        }],
      };
    },
  };
  let nowMs = Date.parse('2026-08-25T18:00:00.000Z');
  let id = 0;
  world.run = async (args: string[]) => {
    const program = buildFulfillmentTrackingAdminProgram({
      shopifyReader,
      ebayAdapter,
      now: () => new Date(nowMs++),
      uuid: () => `uuid-${++id}`,
      io: {
        stdout: (message) => world.stdout.push(message),
        stderr: (message) => world.stderr.push(message),
        setExitCode: (code) => world.exitCodes.push(code),
      },
    });
    await program.parseAsync(['node', 'fulfillment-tracking-admin', ...args]);
  };
  return world;
}

async function establishOwnership(world: World): Promise<void> {
  const store = openMigrationStore({ databasePath: world.databasePath, expectedScope: SCOPE });
  const shopifyOrder = store.registerIdentity({
    platform: 'shopify',
    kind: 'order',
    bindingKey: `shopify-order:${SHOPIFY_ORDER_GID}`,
    storeDomain: SCOPE.shopifyStoreDomain,
    externalGid: SHOPIFY_ORDER_GID,
  }, { eventId: 'identity:shopify-order', occurredAtUtc: '2026-08-25T17:59:59.000Z' });
  const ebayOrder = store.registerIdentity({
    platform: 'ebay',
    kind: 'order',
    bindingKey: `ebay-order:${EBAY_ORDER_ID}`,
    environment: SCOPE.ebayEnvironment,
    sellerId: SCOPE.ebaySellerId,
    marketplaceId: SCOPE.ebayMarketplaceId,
    externalId: EBAY_ORDER_ID,
  }, { eventId: 'identity:ebay-order', occurredAtUtc: '2026-08-25T17:59:59.001Z' });
  store.linkObservedExistingOrder({
    linkId: 'order-link:fixture',
    ebayOrderIdentityKey: ebayOrder.identityKey,
    shopifyOrderIdentityKey: shopifyOrder.identityKey,
    evidenceDigest: digest('exact-order-link-evidence'),
    linkedAtUtc: '2026-08-25T17:59:59.002Z',
    audit: { eventId: 'order-link:fixture', occurredAtUtc: '2026-08-25T17:59:59.002Z' },
  });
  store.close();
  await world.run([
    'establish-ownership',
    '--migration-store', world.databasePath,
    '--confirm-scope', deriveScopeKey(SCOPE),
    '--baseline-evidence', digest('mc-fulfillment-baseline'),
    '--mc-disabled-evidence', digest('mc-fulfillment-disabled'),
  ]);
}

async function preflight(world: World): Promise<string> {
  await world.run([
    'preflight',
    '--shopify-order-gid', SHOPIFY_ORDER_GID,
    '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
    '--ebay-order-id', EBAY_ORDER_ID,
  ]);
  const output = JSON.parse(world.stdout.at(-1) ?? '{}') as Record<string, unknown>;
  return String(output.manifestDigest);
}

describe('fulfillment tracking ceremony', () => {
  it('dispatches exactly one full-order shipping fulfillment and reconciles durably', async () => {
    const world = createWorld();
    await establishOwnership(world);
    expect(world.writes).toHaveLength(0);
    const manifestDigest = await preflight(world);
    expect(world.stdout.at(-1)).not.toContain(TRACKING);
    expect(world.exitCodes).toContain(2);

    await world.run([
      'dispatch',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
      '--ebay-order-id', EBAY_ORDER_ID,
      '--manifest-digest', manifestDigest,
      '--migration-store', world.databasePath,
    ]);

    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]).toMatchObject({
      shopifyOrderGid: SHOPIFY_ORDER_GID,
      ebayOrderId: EBAY_ORDER_ID,
      shippingCarrierCode: 'UPS',
      trackingNumber: TRACKING,
      lineItems: [{ lineItemId: 'line-1', quantity: 1 }, { lineItemId: 'line-2', quantity: 2 }],
    });
    const output = JSON.parse(world.stdout.at(-1) ?? '{}') as Record<string, unknown>;
    expect(output).toMatchObject({
      status: 'dispatched-and-reconciled',
      providerDispatchReported: true,
      effect: 'effect_observed',
      resolution: 'resolved_existing',
      externalCommerceWritesAttempted: 1,
    });
    expect(world.stdout.at(-1)).not.toContain(TRACKING);
    const store = (await import('../../migration-store/index.js')).openMigrationStore({
      databasePath: world.databasePath,
      expectedScope: SCOPE,
    });
    stores.push(store);
    expect(store.getCurrentOwnership('fulfillment')).toMatchObject({
      owner: 'product_pipeline',
      version: 3,
      singleWriterVerified: true,
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      target_effect_observations: 1,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
  });

  it('denies a partial Shopify shipment before any provider write', async () => {
    const world = createWorld({ partial: true });
    await world.run([
      'preflight',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
      '--ebay-order-id', EBAY_ORDER_ID,
    ]);
    expect(world.writes).toHaveLength(0);
    expect(world.stderr.at(-1)).toContain('FULFILLMENT_PARTIAL_DENIED');
  });

  it('denies a mismatched exact Shopify fulfillment GID', async () => {
    const world = createWorld();
    await world.run([
      'preflight',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', 'gid://shopify/Fulfillment/other',
      '--ebay-order-id', EBAY_ORDER_ID,
    ]);
    expect(world.writes).toHaveLength(0);
    expect(world.stderr.at(-1)).toContain('FULFILLMENT_ORDER_ID_MISMATCH');
  });

  it('denies dispatch before MC-off ownership evidence is established', async () => {
    const world = createWorld();
    const manifestDigest = await preflight(world);
    await world.run([
      'dispatch',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
      '--ebay-order-id', EBAY_ORDER_ID,
      '--manifest-digest', manifestDigest,
      '--migration-store', world.databasePath,
    ]);
    expect(world.writes).toHaveLength(0);
    expect(world.stderr.at(-1)).toContain('FULFILLMENT_OWNERSHIP_NOT_ESTABLISHED');
  });

  it('denies an arbitrary individually valid order pair without its durable link', async () => {
    const world = createWorld();
    await world.run([
      'establish-ownership',
      '--migration-store', world.databasePath,
      '--confirm-scope', deriveScopeKey(SCOPE),
      '--baseline-evidence', digest('mc-fulfillment-baseline'),
      '--mc-disabled-evidence', digest('mc-fulfillment-disabled'),
    ]);
    const manifestDigest = await preflight(world);
    await world.run([
      'dispatch',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
      '--ebay-order-id', EBAY_ORDER_ID,
      '--manifest-digest', manifestDigest,
      '--migration-store', world.databasePath,
    ]);
    expect(world.writes).toHaveLength(0);
    expect(world.stderr.at(-1)).toContain('FULFILLMENT_ORDER_LINK_REQUIRED');
  });

  it('permits only one fulfillment intent for an exact linked order pair', async () => {
    const world = createWorld();
    await establishOwnership(world);
    const firstDigest = await preflight(world);
    await world.run([
      'dispatch',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
      '--ebay-order-id', EBAY_ORDER_ID,
      '--manifest-digest', firstDigest,
      '--migration-store', world.databasePath,
    ]);
    world.shopify = {
      ...world.shopify,
      fulfillments: [{
        ...world.shopify.fulfillments[0],
        tracking: [{ company: 'UPS', number: '1Z999AA10123456785' }],
      }],
    };
    world.ebay = { ...world.ebay, fulfillmentStatus: 'NOT_STARTED', shippingFulfillments: [] };
    const secondDigest = await preflight(world);
    await world.run([
      'dispatch',
      '--shopify-order-gid', SHOPIFY_ORDER_GID,
      '--shopify-fulfillment-gid', SHOPIFY_FULFILLMENT_GID,
      '--ebay-order-id', EBAY_ORDER_ID,
      '--manifest-digest', secondDigest,
      '--migration-store', world.databasePath,
    ]);
    expect(world.writes).toHaveLength(1);
    expect(world.stderr.at(-1)).toContain('MIGRATION_STORE_CONFLICT');
  });

  it('keeps tracking out of output and builds only the bounded eBay payload', () => {
    const manifest: FulfillmentManifest = {
      schemaVersion: 1,
      scope: {
        shopifyStoreDomain: 'usedcameragear.myshopify.com',
        ebayEnvironment: 'production',
        ebaySellerId: 'usedcameragear',
        ebayMarketplaceId: 'EBAY_US',
      },
      shopifyOrderGid: SHOPIFY_ORDER_GID,
      ebayOrderId: EBAY_ORDER_ID,
      shopifyFulfillmentGid: 'gid://shopify/Fulfillment/9001',
      shippedDate: '2026-08-25T18:00:00.000Z',
      shippingCarrierCode: 'UPS',
      trackingNumber: TRACKING,
      lineItems: [{ lineItemId: 'line-1', quantity: 1 }],
    };
    expect(JSON.parse(buildShippingFulfillmentBody(manifest))).toEqual({
      lineItems: [{ lineItemId: 'line-1', quantity: 1 }],
      shippedDate: '2026-08-25T18:00:00.000Z',
      shippingCarrierCode: 'UPS',
      trackingNumber: TRACKING,
    });
  });

  it('allows only the exact eBay order GET and shipping-fulfillment POST paths', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const adapter = createEbayFulfillmentAdapter({
      getAccessToken: async () => 'transient-token',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: String(init?.method),
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (init?.method === 'POST') return new Response('', { status: 201 });
        if (String(url).endsWith('/shipping_fulfillment')) {
          return new Response(JSON.stringify({ fulfillments: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          orderId: EBAY_ORDER_ID,
          orderFulfillmentStatus: 'NOT_STARTED',
          lineItems: [{ lineItemId: 'line-1', quantity: 1 }],
        }), { status: 200 });
      }) as typeof fetch,
    });
    await adapter.getOrder(EBAY_ORDER_ID);
    await adapter.createShippingFulfillment({
      schemaVersion: 1,
      scope: {
        shopifyStoreDomain: 'usedcameragear.myshopify.com',
        ebayEnvironment: 'production',
        ebaySellerId: 'usedcameragear',
        ebayMarketplaceId: 'EBAY_US',
      },
      shopifyOrderGid: SHOPIFY_ORDER_GID,
      ebayOrderId: EBAY_ORDER_ID,
      shopifyFulfillmentGid: 'gid://shopify/Fulfillment/9001',
      shippedDate: '2026-08-25T18:00:00.000Z',
      shippingCarrierCode: 'UPS',
      trackingNumber: TRACKING,
      lineItems: [{ lineItemId: 'line-1', quantity: 1 }],
    });
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: `https://api.ebay.com/sell/fulfillment/v1/order/${EBAY_ORDER_ID}`,
        method: 'GET',
      },
      {
        url: `https://api.ebay.com/sell/fulfillment/v1/order/${EBAY_ORDER_ID}/shipping_fulfillment`,
        method: 'GET',
      },
      {
        url: `https://api.ebay.com/sell/fulfillment/v1/order/${EBAY_ORDER_ID}/shipping_fulfillment`,
        method: 'POST',
      },
    ]);
  });
});

describe('migration schema v4 fulfillment boundary', () => {
  it('publishes an explicit versioned migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    expect(SCHEMA_MIGRATIONS.at(-1)).toMatchObject({
      version: 4,
      name: 'fulfillment_tracking_slice_v4',
    });
  });

  it('does not mount the ceremony in the server or weaken legacy writers', () => {
    const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const server = fs.readFileSync(path.join(sourceRoot, 'server/index.ts'), 'utf8');
    const program = fs.readFileSync(
      path.join(sourceRoot, 'fulfillment-tracking-admin/program.ts'),
      'utf8',
    );
    expect(server).not.toMatch(/fulfillment-tracking-admin/);
    expect(program).not.toMatch(/sync\/fulfillment-sync|createShippingFulfillment.*ebay\/fulfillment/);
  });
});
