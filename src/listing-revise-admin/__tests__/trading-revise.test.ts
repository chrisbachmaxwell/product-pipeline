/**
 * Contract tests for the Trading-model listing-revise dispatch extension.
 * Everything runs against real on-disk listing-control and migration-state
 * stores and the real bounded Trading adapter; only the live workspace read
 * and the HTTP transport are faked. No network access of any kind occurs.
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
  buildListingReviseAdminProgram,
  type ListingReviseAdminIo,
} from '../program.js';
import type { ListingReviseDispatchAdapter } from '../dispatch-adapter.js';
import {
  buildReviseFixedPriceItemXml,
  createTradingDispatchAdapter,
  TradingDispatchError,
} from '../trading-dispatch-adapter.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000999999';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000999999';
const PRODUCT_GID = 'gid://shopify/Product/10310708111111';
const SKU = 'NIK5018-U204';
const LISTING_ID = '146052671394';
const NO_PRICE_OR_QUANTITY = /<\/?(?:StartPrice|Quantity)\b/iu;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A live workspace read for one legacy Trading-managed listing: exact-SKU
 * mapped listing with no Inventory item, no Offer, no offer bindings — the
 * exact shape the draft-eligibility trading_api branch requires.
 */
function tradingWorkspace(options: { ebayTitle?: string } = {}): ListingWorkspaceDto {
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-19T15:59:00.000Z',
      detailObservedAtUtc: '2026-08-19T16:00:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU, title: 'Shopify New',
        variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null,
        imageCount: 1, available: 1, price: { amount: '129.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'active', listingId: LISTING_ID, offerId: null,
        url: `https://www.ebay.com/itm/${LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 0,
        offerCount: 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
      lastVerifiedAtUtc: '2026-08-19T15:59:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: 'mapped', joinKey: 'exact_raw_sku',
      shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
      inventorySku: SKU, offerId: null, listingId: LISTING_ID,
      managementModel: 'legacy_trading',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item',
        observedAtUtc: '2026-08-19T16:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 2 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: null },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: options.ebayTitle ?? 'eBay Trading Old',
          descriptionHtml: '<p>Legacy &amp; loved</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg'] },
        category: { primary: { id: '78997', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Mount: ['Nikon F'], Brand: ['Nikon'] },
        identifiers: { brand: 'Nikon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '129.95', currency: 'USD' }, totalQuantity: 1, soldQuantity: 0,
          availableQuantity: 1, availableQuantityBasis: 'reported', bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '6055555000', paymentPolicyId: '6066666000',
          returnPolicyId: '6077777000', paymentMethods: [], shippingType: null,
          domesticServices: [], internationalServices: [], returnsAccepted: true,
          returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'legacy_trading', controlApi: 'trading', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: false,
          offer: false, offerToListing: false }, lifecycleAligned: true,
        inventoryItem: null, offer: null },
    },
  };
}

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

type TradingWorld = {
  migrationDatabasePath: string;
  revision: ListingRevision;
  setWorkspace: (dto: ListingWorkspaceDto) => void;
  requests: CapturedRequest[];
  inventoryAdapterCalls: string[];
  setResponseAck: (ack: string) => void;
  revisedWorkspace: () => ListingWorkspaceDto;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  run: (argv: string[]) => Promise<void>;
};

async function createTradingWorld(draft: {
  title: string | null;
  merchantLocation: string | null;
} = { title: 'Trading Operator Title', merchantLocation: null }): Promise<TradingWorld> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-revise-admin-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  const draftDatabasePath = path.join(root, 'listing-control.sqlite');
  initializeListingControlStore({
    databasePath: draftDatabasePath,
    scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-19T15:00:00.000Z',
  }).close();

  let current = tradingWorkspace();
  const revisedWorkspace = (): ListingWorkspaceDto =>
    tradingWorkspace({ ebayTitle: draft.title ?? 'eBay Trading Old' });
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
    draft: { title: draft.title, category: null, condition: null,
      conditionDescription: null, description: null, images: null,
      fulfillmentPolicyId: null, paymentPolicyId: null, returnPolicyId: null,
      merchantLocation: draft.merchantLocation },
  }), 'shopify-user:operator');
  const draftStore = openListingControlStoreReadOnly({
    databasePath: draftDatabasePath, expectedScope: LISTING_DRAFT_SCOPE,
  });
  const revision = draftStore.getLatestRevision(VARIANT_GID);
  draftStore.close();
  if (!revision) throw new Error('trading revision fixture was not created');

  const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationDatabasePath,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-19T15:00:00.000Z',
  }).close();

  // The real bounded Trading adapter over a captured, network-free transport.
  const requests: CapturedRequest[] = [];
  let responseAck = 'Success';
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: String(init?.body ?? ''),
    });
    if (responseAck === 'Success') current = revisedWorkspace();
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<ReviseFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
      + `<Ack>${responseAck}</Ack>`
      + '</ReviseFixedPriceItemResponse>',
      { status: 200, headers: { 'Content-Type': 'text/xml' } },
    );
  };
  const tradingAdapter = createTradingDispatchAdapter({
    fetchImpl: fakeFetch,
    getAccessToken: async () => 'test-iaf-token',
  });

  // The Inventory-API adapter must never be touched by a trading dispatch.
  const inventoryAdapterCalls: string[] = [];
  const unexpected = (name: string) => async (): Promise<never> => {
    inventoryAdapterCalls.push(name);
    throw new Error('inventory adapter must not be called for a trading target');
  };
  const inventoryAdapter: ListingReviseDispatchAdapter = Object.freeze({
    getInventoryItem: unexpected('getInventoryItem'),
    getOffer: unexpected('getOffer'),
    putInventoryItem: unexpected('putInventoryItem'),
    putOffer: unexpected('putOffer'),
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
      createAdapter: () => inventoryAdapter,
      createTradingAdapter: () => tradingAdapter,
      io,
    }).parseAsync(argv, { from: 'user' });
  };

  return {
    migrationDatabasePath,
    revision,
    setWorkspace: (dto) => { current = dto; },
    requests,
    inventoryAdapterCalls,
    setResponseAck: (ack) => { responseAck = ack; },
    revisedWorkspace,
    stdout,
    stderr,
    exitCodes,
    run,
  };
}

function targetArguments(revisionDigest: string): string[] {
  return [
    '--catalog-id', CATALOG_ID,
    '--sku', SKU,
    '--listing-id', LISTING_ID,
    '--offer-id', 'none',
    '--revision-digest', revisionDigest,
  ];
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe('trading-model listing-revise dispatch', () => {
  it('dispatches one approved trading revision through one bounded ReviseFixedPriceItem POST', async () => {
    const world = await createTradingWorld();
    const scopeKey = deriveScopeKey(MIGRATION_SCOPE);

    await world.run(['establish-ownership',
      '--migration-store', world.migrationDatabasePath,
      '--confirm-scope', scopeKey,
      '--evidence-digest', `sha256:${'a'.repeat(64)}`,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({ status: 'established', version: 2 });

    // The literal offer id "none" names the offer-less trading target;
    // preflight succeeds without any provider access.
    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({ command: 'preflight', status: 'preview' });
    expect(world.exitCodes.at(-1)).toBe(2);
    expect(world.requests).toHaveLength(0);
    const manifestDigest = preview.manifestDigest as string;
    expect(manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      command: 'dispatch',
      status: 'dispatched-and-reconciled',
      effect: 'revised_state_observed',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
      externalCommerceWritesAttempted: 1,
    });
    const dispatched = lastJson(world.stdout);

    // Exactly one bounded Trading POST with the exact call headers.
    expect(world.inventoryAdapterCalls).toHaveLength(0);
    expect(world.requests).toHaveLength(1);
    const request = world.requests[0]!;
    expect(request.url).toBe('https://api.ebay.com/ws/api.dll');
    expect(request.headers['X-EBAY-API-CALL-NAME']).toBe('ReviseFixedPriceItem');
    expect(request.headers['X-EBAY-API-COMPATIBILITY-LEVEL']).toBe('1349');
    expect(request.headers['X-EBAY-API-SITEID']).toBe('0');
    expect(request.headers['X-EBAY-API-IAF-TOKEN']).toBe('test-iaf-token');
    // The XML carries only the ItemID plus the changed field — and can never
    // carry a price or quantity element.
    expect(request.body).toContain(`<ItemID>${LISTING_ID}</ItemID>`);
    expect(request.body).toContain('<Title>Trading Operator Title</Title>');
    expect(request.body).not.toMatch(NO_PRICE_OR_QUANTITY);

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

    // Replaying after a successful dispatch is denied by the freshness gate.
    await world.run(['dispatch', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_BASE_STALE' });
    expect(world.requests).toHaveLength(1);
  });

  it('denies merchant_location overrides on a trading target as unsupported', async () => {
    const world = await createTradingWorld({ title: null, merchantLocation: 'warehouse-9' });
    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    expect(lastJson(world.stderr)).toMatchObject({
      command: 'preflight', status: 'denied', code: 'REVISE_UNSUPPORTED_FIELD',
    });
    expect(world.requests).toHaveLength(0);
  });

  it('requires the literal offer id "none" for an offer-less trading target', async () => {
    const world = await createTradingWorld();
    await world.run(['preflight',
      '--catalog-id', CATALOG_ID,
      '--sku', SKU,
      '--listing-id', LISTING_ID,
      '--offer-id', '234942877011',
      '--revision-digest', world.revision.revisionDigest,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'REVISE_EXACT_TARGET_MISMATCH' });
    expect(world.requests).toHaveLength(0);
  });

  it('records a provider-rejected trading dispatch as a durable confirmed_missing outcome', async () => {
    const world = await createTradingWorld();
    const scopeKey = deriveScopeKey(MIGRATION_SCOPE);
    await world.run(['establish-ownership',
      '--migration-store', world.migrationDatabasePath,
      '--confirm-scope', scopeKey,
      '--evidence-digest', `sha256:${'a'.repeat(64)}`,
    ]);
    await world.run(['preflight', ...targetArguments(world.revision.revisionDigest)]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    world.setResponseAck('Failure');
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
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();
  });

  it('escapes every XML text value and never serializes price or quantity', () => {
    const xml = buildReviseFixedPriceItemXml({
      listingId: LISTING_ID,
      changes: [
        { field: 'title', after: 'Nikon & Canon <50mm> "prime" \'lens\'' },
        { field: 'condition_description', after: 'Mint' },
        { field: 'description', after: 'Plain text body' },
        { field: 'images', after: JSON.stringify([
          'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
          'https://i.ebayimg.com/images/g/def/s-l1600.jpg',
        ]) },
        { field: 'category', after: '78997' },
        { field: 'fulfillment_policy', after: '6055555000' },
        { field: 'payment_policy', after: '6066666000' },
        { field: 'return_policy', after: '6077777000' },
      ],
    });
    expect(xml).toContain(`<ItemID>${LISTING_ID}</ItemID>`);
    expect(xml).toContain(
      '<Title>Nikon &amp; Canon &lt;50mm&gt; &quot;prime&quot; &#39;lens&#39;</Title>',
    );
    expect(xml).toContain(
      '<PictureDetails>'
      + '<PictureURL>https://i.ebayimg.com/images/g/abc/s-l1600.jpg</PictureURL>'
      + '<PictureURL>https://i.ebayimg.com/images/g/def/s-l1600.jpg</PictureURL>'
      + '</PictureDetails>',
    );
    expect(xml).toContain('<PrimaryCategory><CategoryID>78997</CategoryID></PrimaryCategory>');
    expect(xml).toContain(
      '<SellerProfiles>'
      + '<SellerShippingProfile><ShippingProfileID>6055555000</ShippingProfileID></SellerShippingProfile>'
      + '<SellerPaymentProfile><PaymentProfileID>6066666000</PaymentProfileID></SellerPaymentProfile>'
      + '<SellerReturnProfile><ReturnProfileID>6077777000</ReturnProfileID></SellerReturnProfile>'
      + '</SellerProfiles>',
    );
    expect(xml).not.toMatch(NO_PRICE_OR_QUANTITY);

    // Never-dispatchable and non-Trading fields fail closed at serialization.
    for (const field of ['price', 'quantity', 'merchant_location', 'condition'] as const) {
      expect(() => buildReviseFixedPriceItemXml({
        listingId: LISTING_ID,
        changes: [{ field, after: 'value' }],
      })).toThrow(TradingDispatchError);
    }
    expect(() => buildReviseFixedPriceItemXml({ listingId: 'not-an-item-id', changes: [
      { field: 'title', after: 'x' },
    ] })).toThrow(TradingDispatchError);
  });
});
