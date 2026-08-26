/**
 * Contract tests for the isolated price/inventory alignment operator CLI on
 * an inventory-model target. Everything runs against a real on-disk
 * migration-state store and the real bounded bulk_update_price_quantity
 * adapter; only the live workspace read and the HTTP transport are faked.
 * No network access of any kind occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveScopeKey,
  openMigrationStoreReadOnly,
  type IntegrationScope,
} from '../../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import { deriveListingDraftBasis } from '../../server/listing-draft-service.js';
import type { ListingWorkspaceDto } from '../../server/listing-workspace-reader.js';
import {
  deriveAlignmentManifest,
  AlignmentManifestError,
} from '../manifest.js';
import {
  buildBulkUpdateBody,
  createPriceInventoryDispatchAdapter,
  AlignDispatchError,
} from '../dispatch-adapter.js';
import {
  buildPriceInventoryAdminProgram,
  type PriceInventoryAdminIo,
} from '../program.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000563491';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000563491';
const PRODUCT_GID = 'gid://shopify/Product/10310708035875';
const SKU = 'CAN3570-U119';
const LISTING_ID = '147502608418';
const OFFER_ID = '234942877011';
const EVIDENCE_A = `sha256:${'a'.repeat(64)}`;
const EVIDENCE_B = `sha256:${'b'.repeat(64)}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A live workspace read for one fully-bound inventory-model listing, with
 * the Shopify source price and eBay observed price independently settable
 * so drift can exist, move, or be absent.
 */
function workspace(options: {
  shopifyPrice?: string;
  ebayPrice?: string;
  shopifyAvailable?: number;
  ebayQuantity?: number;
} = {}): ListingWorkspaceDto {
  const shopifyPrice = options.shopifyPrice ?? '44.95';
  const ebayPrice = options.ebayPrice ?? '39.95';
  const shopifyAvailable = options.shopifyAvailable ?? 1;
  const ebayQuantity = options.ebayQuantity ?? 1;
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-19T21:59:00.000Z',
      detailObservedAtUtc: '2026-08-19T22:00:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU, title: 'Shopify New',
        variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null,
        imageCount: 1, available: shopifyAvailable,
        price: { amount: shopifyPrice, currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'active', listingId: LISTING_ID, offerId: OFFER_ID,
        url: `https://www.ebay.com/itm/${LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
      lastVerifiedAtUtc: '2026-08-19T21:59:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: 'mapped', joinKey: 'exact_raw_sku',
      shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
      inventorySku: SKU, offerId: OFFER_ID, listingId: LISTING_ID,
      managementModel: 'inventory_offer',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
        observedAtUtc: '2026-08-19T22:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: OFFER_ID },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: 'eBay Old',
          descriptionHtml: '<p>Safe &amp; clean</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'] },
        category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Mount: ['Canon EF'], Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: ebayPrice, currency: 'USD' }, totalQuantity: ebayQuantity,
          soldQuantity: 0, availableQuantity: ebayQuantity, availableQuantityBasis: 'reported',
          bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
          paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
          returnsAccepted: true, returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
          offer: true, offerToListing: true }, lifecycleAligned: true,
        inventoryItem: { sku: SKU, content: { title: 'eBay Old',
          descriptionHtml: null, imageUrls: [] }, condition: { id: '3000', name: 'Used',
          description: null, descriptors: [] }, aspects: {}, identifiers: { brand: 'Canon',
          mpn: null, upc: [], ean: [], isbn: [], epid: null },
        shipToLocationQuantity: ebayQuantity },
        offer: { offerId: OFFER_ID, sku: SKU, marketplaceId: 'EBAY_US', status: 'PUBLISHED',
          listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0, format: 'FIXED_PRICE',
          duration: 'GTC', descriptionHtml: null, primaryCategoryId: '3323',
          secondaryCategoryId: null, storeCategoryNames: [], price: null,
          availableQuantity: ebayQuantity,
          quantityLimitPerBuyer: null, bestOfferEnabled: false, autoAcceptPrice: null,
          autoDeclinePrice: null, fulfillmentPolicyId: '111', paymentPolicyId: '222',
          returnPolicyId: '333', merchantLocationKey: 'warehouse-1',
          includeCatalogProductDetails: false },
      },
    },
  };
}

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

type World = {
  migrationDatabasePath: string;
  setWorkspace: (dto: ListingWorkspaceDto) => void;
  requests: CapturedRequest[];
  setEntryStatusCode: (statusCode: number) => void;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  io: PriceInventoryAdminIo;
  run: (argv: string[]) => Promise<void>;
};

function createWorld(initial: ListingWorkspaceDto = workspace()): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'price-inventory-admin-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  let current = initial;
  const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationDatabasePath,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-01T00:00:00.000Z',
  }).close();

  // The real bounded adapter over a captured, network-free transport. A
  // successful provider entry flips only the dispatched eBay field to the
  // Shopify source value, simulating the remote effect landing without
  // contaminating the other responsibility.
  const requests: CapturedRequest[] = [];
  let entryStatusCode = 200;
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: String(init?.body ?? ''),
    });
    if (entryStatusCode === 200) {
      const shopify = current.catalog.shopify as {
        price: { amount: string };
        available: number;
      };
      const commerce = current.ebayDetail!.actual.commerce;
      const body = JSON.parse(String(init?.body ?? '')) as {
        requests: Array<Record<string, unknown>>;
      };
      const quantityDispatch = Object.hasOwn(
        body.requests[0] ?? {},
        'shipToLocationAvailability',
      );
      current = workspace({
        shopifyPrice: shopify.price.amount,
        ebayPrice: quantityDispatch
          ? commerce.price!.value
          : shopify.price.amount,
        shopifyAvailable: shopify.available,
        ebayQuantity: quantityDispatch
          ? shopify.available
          : commerce.availableQuantity!,
      });
    }
    return new Response(
      JSON.stringify({ responses: [{ statusCode: entryStatusCode }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const adapter = createPriceInventoryDispatchAdapter({
    fetchImpl: fakeFetch,
    getAccessToken: async () => 'test-inventory-token',
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const io: PriceInventoryAdminIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    setExitCode: (code) => exitCodes.push(code),
  };
  const run = async (argv: string[]): Promise<void> => {
    await buildPriceInventoryAdminProgram({
      readWorkspace: async () => current,
      createAdapter: () => adapter,
      io,
    }).parseAsync(argv, { from: 'user' });
  };

  return {
    migrationDatabasePath,
    setWorkspace: (dto) => { current = dto; },
    requests,
    setEntryStatusCode: (statusCode) => { entryStatusCode = statusCode; },
    stdout,
    stderr,
    exitCodes,
    io,
    run,
  };
}

function targetArguments(field: string): string[] {
  return [
    '--catalog-id', CATALOG_ID,
    '--sku', SKU,
    '--listing-id', LISTING_ID,
    '--offer-id', OFFER_ID,
    '--field', field,
  ];
}

function establishArguments(responsibility: string, migrationStore: string): string[] {
  return ['establish-ownership',
    '--migration-store', migrationStore,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--responsibility', responsibility,
    '--baseline-evidence', EVIDENCE_A,
    '--mc-disabled-evidence', EVIDENCE_B,
  ];
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe('price/inventory alignment operator CLI (inventory model)', () => {
  it('dispatches one approved price alignment end to end with durable state', async () => {
    const world = createWorld();

    await world.run(establishArguments('price', world.migrationDatabasePath));
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'established', responsibility: 'price', version: 3,
    });

    await world.run(['plan', ...targetArguments('price')]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({
      command: 'plan',
      status: 'preview',
      field: 'price',
      responsibility: 'price',
      drift: {
        before: JSON.stringify({ amount: '39.95', currency: 'USD' }),
        after: JSON.stringify({ amount: '44.95', currency: 'USD' }),
      },
      externalWritesPerformed: 0,
    });
    expect(world.exitCodes.at(-1)).toBe(2);
    expect(world.requests).toHaveLength(0);
    const manifestDigest = preview.manifestDigest as string;
    expect(manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Wrong manifest digest is an exact-approval mismatch: nothing dispatches.
    await world.run(['dispatch', ...targetArguments('price'),
      '--manifest-digest', `sha256:${'c'.repeat(64)}`,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_MANIFEST_DIGEST_MISMATCH' });
    expect(world.requests).toHaveLength(0);

    await world.run(['dispatch', ...targetArguments('price'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-and-reconciled',
      field: 'price',
      responsibility: 'price',
      effect: 'effect_observed',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
      externalCommerceWritesAttempted: 1,
    });

    // Exactly one bounded POST: one request entry, price only, zero
    // quantity/availability contamination.
    expect(world.requests).toHaveLength(1);
    const request = world.requests[0]!;
    expect(request.url).toBe('https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity');
    expect(request.headers.Authorization).toBe('Bearer test-inventory-token');
    const body = JSON.parse(request.body) as {
      requests: Array<Record<string, unknown>>;
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toEqual({
      sku: SKU,
      offers: [{ offerId: OFFER_ID, price: { value: '44.95', currency: 'USD' } }],
    });
    expect(request.body).not.toMatch(/quantity|availab/i);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      action_approvals: 1,
      approval_consumptions: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      target_effect_observations: 1,
      listing_revise_observations: 0,
      ownership_versions: 3,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // After the alignment landed there is no drift left: a fresh plan (and
    // therefore any replayed dispatch) fails closed before any store or
    // provider access.
    await world.run(['plan', ...targetArguments('price')]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'PLAN_NO_DRIFT' });
    expect(world.requests).toHaveLength(1);
  });

  it('dispatches one approved quantity alignment without price contamination', async () => {
    const world = createWorld(workspace({
      shopifyPrice: '44.95',
      ebayPrice: '44.95',
      shopifyAvailable: 3,
      ebayQuantity: 1,
    }));

    await world.run(establishArguments('inventory', world.migrationDatabasePath));
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'established', responsibility: 'inventory', version: 3,
    });

    await world.run(['plan', ...targetArguments('quantity')]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({
      command: 'plan',
      status: 'preview',
      field: 'quantity',
      responsibility: 'inventory',
      drift: { before: '1', after: '3' },
      externalWritesPerformed: 0,
    });
    expect(world.exitCodes.at(-1)).toBe(2);
    expect(world.requests).toHaveLength(0);
    const manifestDigest = preview.manifestDigest as string;

    await world.run(['dispatch', ...targetArguments('quantity'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-and-reconciled',
      field: 'quantity',
      responsibility: 'inventory',
      effect: 'effect_observed',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
      externalCommerceWritesAttempted: 1,
    });

    expect(world.requests).toHaveLength(1);
    const request = world.requests[0]!;
    expect(request.url).toBe('https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity');
    expect(request.headers.Authorization).toBe('Bearer test-inventory-token');
    expect(JSON.parse(request.body)).toEqual({
      requests: [{
        sku: SKU,
        shipToLocationAvailability: { quantity: 3 },
        offers: [{ offerId: OFFER_ID, availableQuantity: 3 }],
      }],
    });
    expect(request.body).not.toMatch(/price/i);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getCurrentOwnership('inventory')).toMatchObject({
      owner: 'product_pipeline', version: 3, singleWriterVerified: true,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing', responsibility: 'inventory',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      action_approvals: 1,
      approval_consumptions: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      target_effect_observations: 1,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    await world.run(['plan', ...targetArguments('quantity')]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'PLAN_NO_DRIFT' });
    expect(world.requests).toHaveLength(1);
  });

  it('records the marketplace_connect -> paused -> product_pipeline chain idempotently', async () => {
    const world = createWorld();

    await world.run(establishArguments('inventory', world.migrationDatabasePath));
    expect(lastJson(world.stdout)).toMatchObject({
      command: 'establish-ownership', status: 'established',
      responsibility: 'inventory', version: 3, externalWritesPerformed: 0,
    });

    // Re-running is an explicit no-op: the chain is already established.
    await world.run(establishArguments('inventory', world.migrationDatabasePath));
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'already-established', responsibility: 'inventory', version: 3,
    });

    // The chain is per responsibility: price is independent of inventory.
    await world.run(establishArguments('price', world.migrationDatabasePath));
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'established', responsibility: 'price', version: 3,
    });

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getCurrentOwnership('inventory')).toMatchObject({
      owner: 'product_pipeline', version: 3, singleWriterVerified: true,
    });
    expect(store.getCurrentOwnership('price')).toMatchObject({
      owner: 'product_pipeline', version: 3, singleWriterVerified: true,
    });
    expect(store.getCounts()).toMatchObject({ ownership_versions: 6 });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // Only price and inventory are establishable; the scope key is exact.
    await world.run(['establish-ownership',
      '--migration-store', world.migrationDatabasePath,
      '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
      '--responsibility', 'orderImport',
      '--baseline-evidence', EVIDENCE_A,
      '--mc-disabled-evidence', EVIDENCE_B,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_RESPONSIBILITY_INVALID' });
    await world.run(['establish-ownership',
      '--migration-store', world.migrationDatabasePath,
      '--confirm-scope', `sha256:${'d'.repeat(64)}`,
      '--responsibility', 'price',
      '--baseline-evidence', EVIDENCE_A,
      '--mc-disabled-evidence', EVIDENCE_B,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_SCOPE_CONFIRMATION_MISMATCH' });
  });

  it('fails closed on missing ownership, moved drift, no drift, and wrong targets', async () => {
    const world = createWorld();

    // Ownership not established yet: the mapped responsibility must be a
    // ProductPipeline single writer before any store or provider action.
    await world.run(['plan', ...targetArguments('price')]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;
    await world.run(['dispatch', ...targetArguments('price'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_OWNERSHIP_NOT_ESTABLISHED' });
    expect(world.requests).toHaveLength(0);

    // Establishing price ownership does not authorize a quantity dispatch.
    await world.run(establishArguments('price', world.migrationDatabasePath));
    const quantityWorld = workspace();
    (quantityWorld.catalog.shopify as { available: number }).available = 3;
    world.setWorkspace(quantityWorld);
    await world.run(['plan', ...targetArguments('quantity')]);
    const quantityDigest = lastJson(world.stdout).manifestDigest as string;
    await world.run(['dispatch', ...targetArguments('quantity'),
      '--manifest-digest', quantityDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_OWNERSHIP_NOT_ESTABLISHED' });
    expect(world.requests).toHaveLength(0);
    world.setWorkspace(workspace());

    // The drift moved between plan and dispatch: the manifest digest no
    // longer matches and nothing dispatches.
    world.setWorkspace(workspace({ ebayPrice: '42.00' }));
    await world.run(['dispatch', ...targetArguments('price'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_MANIFEST_DIGEST_MISMATCH' });
    expect(world.requests).toHaveLength(0);
    world.setWorkspace(workspace());

    // No drift: source and observed already agree.
    world.setWorkspace(workspace({ shopifyPrice: '39.95', ebayPrice: '39.95' }));
    await world.run(['plan', ...targetArguments('price')]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'PLAN_NO_DRIFT' });
    world.setWorkspace(workspace());

    // Wrong exact target and the reserved literal "none".
    await world.run(['plan',
      '--catalog-id', CATALOG_ID, '--sku', 'WRONG-SKU',
      '--listing-id', LISTING_ID, '--offer-id', OFFER_ID, '--field', 'price',
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_EXACT_TARGET_MISMATCH' });
    await world.run(['plan',
      '--catalog-id', CATALOG_ID, '--sku', SKU,
      '--listing-id', LISTING_ID, '--offer-id', 'none', '--field', 'price',
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_EXACT_TARGET_MISMATCH' });

    // Unknown field names fail closed.
    await world.run(['plan',
      '--catalog-id', CATALOG_ID, '--sku', SKU,
      '--listing-id', LISTING_ID, '--offer-id', OFFER_ID, '--field', 'title',
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'PLAN_FIELD_INVALID' });
    expect(world.requests).toHaveLength(0);
  });

  it('leaves a failed provider dispatch as confirmed_missing and denies the replay', async () => {
    const world = createWorld();
    await world.run(establishArguments('price', world.migrationDatabasePath));
    await world.run(['plan', ...targetArguments('price')]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    world.setEntryStatusCode(500);
    await world.run(['dispatch', ...targetArguments('price'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-unresolved',
      providerDispatchReported: false,
      effect: 'effect_absent',
      resolution: 'confirmed_missing',
      externalCommerceWritesAttempted: 1,
    });
    expect(world.exitCodes.at(-1)).toBe(1);
    expect(world.requests).toHaveLength(1);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'confirmed_missing',
    });
    expect(store.getCounts()).toMatchObject({
      target_effect_observations: 1,
      attempt_resolutions: 1,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // The drift is unchanged, so a replay of the same manifest reaches — and
    // is denied by — the durable intent-uniqueness layer before any call.
    await world.run(['dispatch', ...targetArguments('price'),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REALIGN_INTENT_ALREADY_RECORDED' });
    expect(world.requests).toHaveLength(1);
  });

  it('derives manifests only for valid drift and builds contamination-free bodies', () => {
    // A null Shopify source value can never be aligned.
    const noPrice = workspace();
    (noPrice.catalog.shopify as { price: unknown }).price = null;
    let caught: unknown;
    try {
      deriveAlignmentManifest({ basis: deriveListingDraftBasis(noPrice), field: 'price' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AlignmentManifestError);
    expect((caught as AlignmentManifestError).code).toBe('PLAN_SOURCE_VALUE_INVALID');

    // Price body: one request, one offer, price only.
    const priceBody = buildBulkUpdateBody('price', {
      sku: SKU, offerId: OFFER_ID, price: { value: '44.95', currency: 'USD' },
    });
    const parsedPrice = JSON.parse(priceBody) as { requests: Array<Record<string, unknown>> };
    expect(parsedPrice.requests).toHaveLength(1);
    expect(priceBody).not.toMatch(/quantity|availab/i);

    // Quantity body: item and offer quantity kept in agreement, no price key.
    const quantityBody = buildBulkUpdateBody('quantity', {
      sku: SKU, offerId: OFFER_ID, quantity: 3,
    });
    expect(JSON.parse(quantityBody)).toEqual({
      requests: [{
        sku: SKU,
        shipToLocationAvailability: { quantity: 3 },
        offers: [{ offerId: OFFER_ID, availableQuantity: 3 }],
      }],
    });
    expect(quantityBody).not.toMatch(/price/i);

    // Invalid targets and values fail closed at the adapter boundary.
    expect(() => buildBulkUpdateBody('price', {
      sku: 'bad sku with spaces', offerId: OFFER_ID,
      price: { value: '44.95', currency: 'USD' },
    })).toThrow(AlignDispatchError);
    expect(() => buildBulkUpdateBody('price', {
      sku: SKU, offerId: 'not-numeric',
      price: { value: '44.95', currency: 'USD' },
    })).toThrow(AlignDispatchError);
    expect(() => buildBulkUpdateBody('price', {
      sku: SKU, offerId: OFFER_ID, price: { value: '0', currency: 'USD' },
    })).toThrow(AlignDispatchError);
    expect(() => buildBulkUpdateBody('quantity', {
      sku: SKU, offerId: OFFER_ID, quantity: -1,
    })).toThrow(AlignDispatchError);
    expect(() => buildBulkUpdateBody('quantity', {
      sku: SKU, offerId: OFFER_ID, quantity: 1.5,
    })).toThrow(AlignDispatchError);
  });

  it('keeps the CLI free of server-mount, direct-fetch, and legacy writer imports', () => {
    const sourceRoot = path.dirname(new URL('..', import.meta.url).pathname);
    const program = fs.readFileSync(
      path.join(sourceRoot, 'price-inventory-admin/program.ts'), 'utf8');
    const manifestSource = fs.readFileSync(
      path.join(sourceRoot, 'price-inventory-admin/manifest.ts'), 'utf8');
    const adapterSource = fs.readFileSync(
      path.join(sourceRoot, 'price-inventory-admin/dispatch-adapter.ts'), 'utf8');
    const tradingAdapterSource = fs.readFileSync(
      path.join(sourceRoot, 'price-inventory-admin/trading-dispatch-adapter.ts'), 'utf8');
    const indexSource = fs.readFileSync(
      path.join(sourceRoot, 'price-inventory-admin/index.ts'), 'utf8');
    const serverIndex = fs.readFileSync(path.join(sourceRoot, 'server/index.ts'), 'utf8');
    // The server never mounts or imports the dispatch slice.
    expect(serverIndex).not.toMatch(/price-inventory-admin/);
    // The slice never touches legacy sync writers or order paths.
    expect(
      `${program}\n${manifestSource}\n${adapterSource}\n${tradingAdapterSource}\n${indexSource}`,
    ).not.toMatch(
      /from ['"][^'"]*(?:\/sync\/|order-sync|product-sync|inventory-sync|price-sync|token-manager)[^'"]*['"]/,
    );
    // Provider writes exist only inside the two bounded adapter modules.
    expect(program).not.toMatch(/fetch\s*\(/);
    expect(manifestSource).not.toMatch(/fetch\s*\(/);
    expect(indexSource).not.toMatch(/fetch\s*\(/);
  });
});
