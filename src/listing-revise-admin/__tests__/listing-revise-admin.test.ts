/**
 * Contract tests for the isolated listing-revise operator CLI. Everything
 * runs against real on-disk listing-control and migration-state stores; only
 * the live workspace read and the provider HTTP adapter are faked. No
 * network access of any kind occurs.
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
import {
  initializeListingControlStore,
  openListingControlStoreReadOnly,
  type ListingRevision,
} from '../../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import {
  createListingDraftService,
  parseSaveListingDraftRequest,
} from '../../server/listing-draft-service.js';
import type { ListingWorkspaceDto } from '../../server/listing-workspace-reader.js';
import {
  buildListingRevisePayloads,
  deriveListingReviseManifest,
  ListingReviseManifestError,
  ListingRevisePayloadError,
} from '../manifest.js';
import {
  buildListingReviseAdminProgram,
  type ListingReviseAdminIo,
} from '../program.js';
import type { ListingReviseDispatchAdapter } from '../dispatch-adapter.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000563491';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000563491';
const SKU = 'CAN3570-U119';
const LISTING_ID = '147502608418';
const OFFER_ID = '234942877011';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(options: { ebayTitle?: string } = {}): ListingWorkspaceDto {
  const productId = 'gid://shopify/Product/10310708035875';
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-14T21:59:00.000Z',
      detailObservedAtUtc: '2026-08-14T22:00:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId, variantId: VARIANT_GID, sku: SKU, title: 'Shopify New', variantTitle: 'Default',
        productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 1,
        price: { amount: '39.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'active', listingId: LISTING_ID, offerId: OFFER_ID,
        url: `https://www.ebay.com/itm/${LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
      lastVerifiedAtUtc: '2026-08-14T21:59:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: 'mapped', joinKey: 'exact_raw_sku',
      shopifyProductId: productId, shopifyVariantId: VARIANT_GID,
      inventorySku: SKU, offerId: OFFER_ID, listingId: LISTING_ID,
      managementModel: 'inventory_offer',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
        observedAtUtc: '2026-08-14T22:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: productId, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: OFFER_ID },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: options.ebayTitle ?? 'eBay Old',
          descriptionHtml: '<p>Safe &amp; clean</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'] },
        category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Mount: ['Canon EF'], Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '39.95', currency: 'USD' }, totalQuantity: 1, soldQuantity: 0,
          availableQuantity: 1, availableQuantityBasis: 'reported', bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
          paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
          returnsAccepted: true, returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
          offer: true, offerToListing: true }, lifecycleAligned: true,
        inventoryItem: { sku: SKU, content: { title: options.ebayTitle ?? 'eBay Old',
          descriptionHtml: null, imageUrls: [] }, condition: { id: '3000', name: 'Used',
          description: null, descriptors: [] }, aspects: {}, identifiers: { brand: 'Canon',
          mpn: null, upc: [], ean: [], isbn: [], epid: null }, shipToLocationQuantity: 1 },
        offer: { offerId: OFFER_ID, sku: SKU, marketplaceId: 'EBAY_US', status: 'PUBLISHED',
          listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0, format: 'FIXED_PRICE',
          duration: 'GTC', descriptionHtml: null, primaryCategoryId: '3323',
          secondaryCategoryId: null, storeCategoryNames: [], price: null, availableQuantity: 1,
          quantityLimitPerBuyer: null, bestOfferEnabled: false, autoAcceptPrice: null,
          autoDeclinePrice: null, fulfillmentPolicyId: '111', paymentPolicyId: '222',
          returnPolicyId: '333', merchantLocationKey: 'warehouse-1',
          includeCatalogProductDetails: false },
      },
    },
  };
}

function rawInventoryItem(): Record<string, unknown> {
  return {
    sku: SKU,
    product: { title: 'eBay Old', imageUrls: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'] },
    condition: 'USED_EXCELLENT',
    availability: { shipToLocationAvailability: { quantity: 1 } },
  };
}

function rawOffer(): Record<string, unknown> {
  return {
    offerId: OFFER_ID,
    sku: SKU,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    pricingSummary: { price: { value: '39.95', currency: 'USD' } },
    availableQuantity: 1,
    categoryId: '3323',
    listingPolicies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333' },
    merchantLocationKey: 'warehouse-1',
    listing: { listingId: LISTING_ID, listingStatus: 'ACTIVE' },
  };
}

type World = {
  draftDatabasePath: string;
  migrationDatabasePath: string;
  revision: ListingRevision;
  currentWorkspace: () => ListingWorkspaceDto;
  setWorkspace: (dto: ListingWorkspaceDto) => void;
  adapterCalls: string[];
  putItemPayloads: Array<Record<string, unknown>>;
  putOfferPayloads: Array<Record<string, unknown>>;
  failPuts: () => void;
  adapter: ListingReviseDispatchAdapter;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  io: ListingReviseAdminIo;
  run: (argv: string[]) => Promise<void>;
};

async function createWorld(): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-revise-admin-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  const draftDatabasePath = path.join(root, 'listing-control.sqlite');
  initializeListingControlStore({
    databasePath: draftDatabasePath,
    scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-14T21:00:00.000Z',
  }).close();

  let current = workspace();
  const service = createListingDraftService({
    readWorkspace: async () => current,
    databasePath: () => draftDatabasePath,
    writerInstanceReady: () => true,
  });
  const opened = await service.get(CATALOG_ID, true);
  await service.save(parseSaveListingDraftRequest({
    schemaVersion: 1, action: 'save_local_draft', catalogId: CATALOG_ID,
    expectedRevisionDigest: null,
    base: { sourceDigest: opened.base.sourceDigest, ebayDigest: opened.base.ebayDigest },
    draft: { title: 'Operator Title', category: null, condition: null,
      conditionDescription: null, description: null, images: null,
      fulfillmentPolicyId: null, paymentPolicyId: null, returnPolicyId: null,
      merchantLocation: null },
  }), 'shopify-user:operator');
  const draftStore = openListingControlStoreReadOnly({
    databasePath: draftDatabasePath, expectedScope: LISTING_DRAFT_SCOPE,
  });
  const revision = draftStore.getLatestRevision(VARIANT_GID);
  draftStore.close();
  if (!revision) throw new Error('revision fixture was not created');

  const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationDatabasePath,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-14T21:00:00.000Z',
  }).close();

  const adapterCalls: string[] = [];
  const putItemPayloads: Array<Record<string, unknown>> = [];
  const putOfferPayloads: Array<Record<string, unknown>> = [];
  let putsFail = false;
  const adapter: ListingReviseDispatchAdapter = Object.freeze({
    getInventoryItem: async () => {
      adapterCalls.push('getInventoryItem');
      return rawInventoryItem();
    },
    getOffer: async () => {
      adapterCalls.push('getOffer');
      return rawOffer();
    },
    putInventoryItem: async (_sku, payload) => {
      adapterCalls.push('putInventoryItem');
      if (putsFail) throw new Error('provider write failed');
      putItemPayloads.push(payload);
      current = workspace({ ebayTitle: 'Operator Title' });
    },
    putOffer: async (_offerId, payload) => {
      adapterCalls.push('putOffer');
      if (putsFail) throw new Error('provider write failed');
      putOfferPayloads.push(payload);
    },
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const io: ListingReviseAdminIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    setExitCode: (code) => exitCodes.push(code),
  };
  const run = async (argv: string[]): Promise<void> => {
    await buildListingReviseAdminProgram({
      readWorkspace: async () => current,
      draftDatabasePath: () => draftDatabasePath,
      createAdapter: () => adapter,
      io,
    }).parseAsync(argv, { from: 'user' });
  };

  return {
    draftDatabasePath,
    migrationDatabasePath,
    revision,
    currentWorkspace: () => current,
    setWorkspace: (dto) => { current = dto; },
    adapterCalls,
    putItemPayloads,
    putOfferPayloads,
    failPuts: () => { putsFail = true; },
    adapter,
    stdout,
    stderr,
    exitCodes,
    io,
    run,
  };
}

function targetArguments(revisionDigest: string): string[] {
  return [
    '--catalog-id', CATALOG_ID,
    '--sku', SKU,
    '--listing-id', LISTING_ID,
    '--offer-id', OFFER_ID,
    '--revision-digest', revisionDigest,
  ];
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe('listing-revise operator CLI', () => {
  it('dispatches one approved revision end to end with durable state and reconciliation', async () => {
    const world = await createWorld();
    const scopeKey = deriveScopeKey(MIGRATION_SCOPE);

    await world.run(['establish-ownership',
      '--migration-store', world.migrationDatabasePath,
      '--confirm-scope', scopeKey,
      '--evidence-digest', `sha256:${'a'.repeat(64)}`,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({ status: 'established', version: 2 });

    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({ command: 'preflight', status: 'preview' });
    expect(world.exitCodes.at(-1)).toBe(2);
    const manifestDigest = preview.manifestDigest as string;
    expect(manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Wrong manifest digest is an exact-approval mismatch: nothing dispatches.
    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', `sha256:${'b'.repeat(64)}`,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_MANIFEST_DIGEST_MISMATCH' });
    expect(world.adapterCalls).toHaveLength(0);

    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-and-reconciled',
      effect: 'revised_state_observed',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
      externalCommerceWritesAttempted: 1,
    });
    expect(world.adapterCalls).toEqual(['getInventoryItem', 'getOffer', 'putInventoryItem']);
    expect(world.putItemPayloads).toHaveLength(1);
    expect(world.putItemPayloads[0]).toMatchObject({
      product: expect.objectContaining({ title: 'Operator Title' }),
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: 'USED_EXCELLENT',
    });
    expect(world.putOfferPayloads).toHaveLength(0);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      listing_revise_observations: 1,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // Replaying after a successful dispatch is denied by the freshness gate:
    // the revised remote state no longer matches the draft's observed base.
    const callsBefore = world.adapterCalls.length;
    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_BASE_STALE' });
    expect(world.adapterCalls.length).toBe(callsBefore);
  });

  it('fails closed on stale remote state, wrong targets, and missing ownership', async () => {
    const world = await createWorld();

    // Ownership not established yet.
    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;
    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_OWNERSHIP_NOT_ESTABLISHED' });

    // Wrong exact target.
    await world.run(['preflight',
      '--catalog-id', CATALOG_ID,
      '--sku', 'WRONG-SKU',
      '--listing-id', LISTING_ID,
      '--offer-id', OFFER_ID,
      '--revision-digest', world.revision.revisionDigest,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_EXACT_TARGET_MISMATCH' });

    // The literal offer id "none" is reserved for Trading-model targets and
    // never selects an inventory-managed listing.
    await world.run(['preflight',
      '--catalog-id', CATALOG_ID,
      '--sku', SKU,
      '--listing-id', LISTING_ID,
      '--offer-id', 'none',
      '--revision-digest', world.revision.revisionDigest,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_EXACT_TARGET_MISMATCH' });

    // Remote drift after the draft was saved.
    world.setWorkspace(workspace({ ebayTitle: 'Changed Remotely' }));
    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_BASE_STALE' });
    expect(world.adapterCalls).toHaveLength(0);
  });

  it('leaves a failed provider dispatch as a durable confirmed_missing outcome', async () => {
    const world = await createWorld();
    const scopeKey = deriveScopeKey(MIGRATION_SCOPE);
    await world.run(['establish-ownership',
      '--migration-store', world.migrationDatabasePath,
      '--confirm-scope', scopeKey,
      '--evidence-digest', `sha256:${'a'.repeat(64)}`,
    ]);
    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    world.failPuts();
    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-unresolved',
      providerDispatchReported: false,
      effect: 'revised_state_absent',
      resolution: 'confirmed_missing',
    });
    expect(world.exitCodes.at(-1)).toBe(1);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'confirmed_missing',
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // The remote state is unchanged here, so a replay of the same manifest
    // reaches — and is denied by — the durable intent-uniqueness layer.
    const callsBefore = world.adapterCalls.length;
    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_INTENT_ALREADY_RECORDED' });
    expect(world.adapterCalls.length).toBe(callsBefore);
  });

  it('derives manifests only for inventory-managed targets and dispatchable fields', async () => {
    const world = await createWorld();
    const tradingRevision: ListingRevision = {
      ...world.revision,
      identity: { ...world.revision.identity, managementModel: 'trading_api', ebayOfferId: null },
    };
    expect(() => deriveListingReviseManifest(tradingRevision))
      .toThrow(ListingReviseManifestError);

    const { manifest } = deriveListingReviseManifest(world.revision);
    expect(manifest.changes).toEqual([
      { field: 'title', before: 'eBay Old', after: 'Operator Title' },
    ]);
    expect(manifest.preserved).toEqual({
      price: JSON.stringify({ amount: '39.95', currency: 'USD' }),
      quantity: '1',
    });

    // Payload binding must match the exact offer/listing identity.
    expect(() => buildListingRevisePayloads({
      manifest,
      rawInventoryItem: rawInventoryItem(),
      rawOffer: { ...rawOffer(), offerId: '999999' },
    })).toThrow(ListingRevisePayloadError);

    const payloads = buildListingRevisePayloads({
      manifest,
      rawInventoryItem: rawInventoryItem(),
      rawOffer: rawOffer(),
    });
    expect(payloads.inventoryItemChanged).toBe(true);
    expect(payloads.offerChanged).toBe(false);
    expect(payloads.inventoryItemPayload.product).toMatchObject({ title: 'Operator Title' });
    expect(JSON.stringify(payloads.offerPayload.pricingSummary))
      .toBe(JSON.stringify(rawOffer().pricingSummary));
  });

  it('keeps the CLI free of server-mount and legacy writer imports', () => {
    const sourceRoot = path.dirname(new URL('..', import.meta.url).pathname);
    const program = fs.readFileSync(path.join(sourceRoot, 'listing-revise-admin/program.ts'), 'utf8');
    const adapterSource = fs.readFileSync(
      path.join(sourceRoot, 'listing-revise-admin/dispatch-adapter.ts'), 'utf8');
    const tradingAdapterSource = fs.readFileSync(
      path.join(sourceRoot, 'listing-revise-admin/trading-dispatch-adapter.ts'), 'utf8');
    const manifestSource = fs.readFileSync(
      path.join(sourceRoot, 'listing-revise-admin/manifest.ts'), 'utf8');
    const serverIndex = fs.readFileSync(path.join(sourceRoot, 'server/index.ts'), 'utf8');
    // The server never mounts or imports the dispatch slice.
    expect(serverIndex).not.toMatch(/listing-revise-admin/);
    // The slice never touches legacy sync writers or order paths.
    expect(`${program}\n${adapterSource}\n${tradingAdapterSource}\n${manifestSource}`).not.toMatch(
      /from ['"][^'"]*(?:\/sync\/|order-sync|product-sync|inventory-sync|price-sync|token-manager)[^'"]*['"]/,
    );
    // Provider writes exist only in the adapter's two exact PUT paths.
    expect(program).not.toMatch(/fetch\s*\(/);
    expect(manifestSource).not.toMatch(/fetch\s*\(/);
  });
});
