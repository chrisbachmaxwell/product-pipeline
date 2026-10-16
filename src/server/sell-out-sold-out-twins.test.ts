/**
 * Incident #196 regression (L104): OVERSELL_EXPOSURE for 4147C002-U303 —
 * Shopify at 0, eBay listing 147600048072 still live, and no
 * END_DISPATCH_REJECTED alongside it, so the END was never ATTEMPTED.
 *
 * The gap L98 named as (a): the watchdog flags any row with a live listing
 * and stock <= 0 regardless of lifecycle, while the --end-at-zero sweep scans
 * only `lifecycleStatus === 'active'` rows. A SKU-ambiguity flag (a second
 * sellable Shopify variant with the same SKU, or a case-variant twin) turned
 * a sold-out row into 'attention' even when EVERY holder was sold out — no
 * twin could sell, nothing to disambiguate — so the one listing that had to
 * end was invisible to the guard on every pass.
 *
 * The catalog runs for real here (buildLiveListingCatalogSnapshot); its row
 * then drives the real sweep against a real on-disk migration store and the
 * real bounded Trading adapter over a captured, network-free transport.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveScopeKey,
  type IntegrationScope,
} from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import { createTradingAlignDispatchAdapter } from '../price-inventory-admin/trading-dispatch-adapter.js';
import { buildPriceInventoryAdminProgram } from '../price-inventory-admin/program.js';
import type { PriceInventoryDispatchAdapter } from '../price-inventory-admin/dispatch-adapter.js';
import { evaluateIncidentCandidates } from './incident-watchdog.js';
import type { ListingWorkspaceDto } from './listing-workspace-reader.js';
import {
  buildLiveListingCatalogSnapshot,
  type CapturedShopifyVariant,
  type LiveListingCatalogRow,
  type LiveListingCatalogSnapshot,
} from './live-listing-catalog.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const SKU = '4147C002-U303';
const LISTING_ID = '147600048072';
const OBSERVED = '2026-10-16T19:00:00.000Z';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function variant(id: number, overrides: Partial<CapturedShopifyVariant> = {}): CapturedShopifyVariant {
  return {
    productId: `gid://shopify/Product/1031070822${id}`,
    variantId: `gid://shopify/ProductVariant/5539600088${id}`,
    sku: SKU,
    title: 'Canon EOS R5 Mirrorless Camera Body *USED*',
    variantTitle: 'Default Title',
    productStatus: 'ACTIVE',
    productTags: [],
    primaryImageUrl: null,
    imageCount: 1,
    available: 0,
    price: { amount: '2199.00', currency: 'USD' },
    ...overrides,
  };
}

function catalog(variants: CapturedShopifyVariant[]): LiveListingCatalogSnapshot {
  const active = [{ listingId: LISTING_ID, sku: SKU }];
  return buildLiveListingCatalogSnapshot({
    observedAtUtc: OBSERVED,
    shopifyVariants: variants,
    ebayActiveListings: active,
    ebayInventoryItems: [],
    ebayOffers: [],
    coverage: {
      shopify: {
        source: 'shopify-admin-graphql',
        storeDomain: 'usedcameragear.myshopify.com',
        shopId: 'gid://shopify/Shop/86254518563',
        observedAtUtc: OBSERVED,
        paginationComplete: true,
        variantPageCount: 1,
        totalVariantsCaptured: variants.length,
        positiveStockVariants: variants.filter((entry) =>
          entry.available !== null && entry.available > 0).length,
        excludedZeroInventory: variants.filter((entry) =>
          entry.available !== null && entry.available <= 0).length,
        excludedUnknownInventory: variants.filter((entry) => entry.available === null).length,
        productStatusCounts: { ACTIVE: variants.length },
      },
      ebay: {
        source: 'ebay-trading-api+ebay-inventory-api',
        marketplaceId: 'EBAY_US',
        sellerAccountVerified: true,
        observedAtUtc: OBSERVED,
        trading: { paginationComplete: true, pageCount: 1, activeListingCount: 1 },
        inventory: {
          inventoryItemsComplete: true, inventoryItemPageCount: 1, inventoryItemCount: 0,
          offersComplete: true, offerPageCount: 0, offerCount: 0,
          unpublishedArtifactsChecked: true,
        },
      },
    },
  });
}

function joinedRows(snapshot: LiveListingCatalogSnapshot): LiveListingCatalogRow[] {
  return snapshot.rows.filter((row) => row.ebay.listingId === LISTING_ID);
}

/** The workspace the sweep reads for one catalog row: a live Trading listing. */
function workspaceFor(row: LiveListingCatalogRow, ebayActive = true): ListingWorkspaceDto {
  const shopify = row.shopify!;
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: OBSERVED,
      detailObservedAtUtc: '2026-10-16T19:00:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: row as unknown as ListingWorkspaceDto['catalog'],
    mapping: {
      state: 'mapped', joinKey: 'exact_raw_sku',
      shopifyProductId: shopify.productId, shopifyVariantId: shopify.variantId,
      inventorySku: SKU, offerId: null, listingId: LISTING_ID,
      managementModel: 'legacy_trading',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item',
        observedAtUtc: '2026-10-16T19:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 2 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: shopify.productId, shopifyVariantId: shopify.variantId, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: null },
      actual: {
        lifecycle: { status: ebayActive ? 'ACTIVE' : 'COMPLETED', active: ebayActive,
          format: 'FIXED_PRICE', duration: 'GTC', startAtUtc: null, endAtUtc: null },
        content: { title: shopify.title, descriptionHtml: '<p>Used</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg'] },
        category: { primary: { id: '31388', name: 'Digital Cameras' }, secondary: null,
          storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '2199.00', currency: 'USD' }, totalQuantity: 1,
          soldQuantity: 0, availableQuantity: 1,
          availableQuantityBasis: 'reported', bestOfferEnabled: false },
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

/** One --end-at-zero sweep over `snapshot`; returns the summary and eBay calls. */
async function sweep(snapshot: LiveListingCatalogSnapshot): Promise<{
  summary: Record<string, unknown>;
  calls: string[];
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-out-twins-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const migrationStore = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationStore,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-01T00:00:00.000Z',
  }).close();

  const ended = new Set<string>();
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const callName = (init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME'] ?? '';
    calls.push(callName);
    if (callName === 'EndFixedPriceItem') ended.add(LISTING_ID);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><${callName}Response xmlns="urn:ebay:apis:eBLBaseComponents">`
      + `<Ack>Success</Ack></${callName}Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } },
    );
  };
  const unexpected = async (): Promise<never> => {
    throw new Error('inventory adapter must not be called for a trading target');
  };
  const inventoryAdapter: PriceInventoryDispatchAdapter = Object.freeze({
    updateOfferPrice: unexpected,
    updateOfferQuantity: unexpected,
    withdrawOffer: unexpected,
    getOfferBySku: async () => null,
    publishOffer: unexpected,
  });
  const stdout: string[] = [];
  const run = async (argv: string[]): Promise<void> => {
    await buildPriceInventoryAdminProgram({
      readWorkspace: async (catalogId) => {
        const row = snapshot.rows.find((candidate) => candidate.id === catalogId)!;
        return workspaceFor(row, !ended.has(LISTING_ID));
      },
      createAdapter: () => inventoryAdapter,
      createTradingAdapter: () => createTradingAlignDispatchAdapter({
        fetchImpl: fakeFetch,
        getAccessToken: async () => 'test-iaf-token',
      }),
      getSnapshot: async () => snapshot,
      io: { stdout: (line) => stdout.push(line), stderr: () => {}, setExitCode: () => {} },
    }).parseAsync(argv, { from: 'user' });
  };

  await run(['establish-ownership',
    '--migration-store', migrationStore,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--responsibility', 'inventory',
    '--baseline-evidence', `sha256:${'a'.repeat(64)}`,
    '--mc-disabled-evidence', `sha256:${'b'.repeat(64)}`,
  ]);
  await run(['align-sweep',
    '--migration-store', migrationStore,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--field', 'quantity',
    '--confirm-sweep',
    '--end-at-zero',
  ]);
  return { summary: JSON.parse(stdout.at(-1)!) as Record<string, unknown>, calls };
}

describe('sell-out guard on sold-out SKU twins (incident #196, L104)', () => {
  it('a sold-out duplicate-SKU twin no longer hides the live listing: exactly one active row', () => {
    const snapshot = catalog([
      variant(1, { available: 0 }),
      variant(2, { available: -1, productStatus: 'DRAFT' }),
    ]);
    const rows = joinedRows(snapshot);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lifecycleStatus: 'active' });
    expect(rows[0]!.audit.attentionReasons).toEqual([]);
    // Lowest variant id keeps the join; the other twin has no eBay presence
    // and no stock, so it leaves the catalog like any sold-out variant.
    expect(rows[0]!.shopify!.variantId).toBe(variant(1).variantId);
    expect(snapshot.rows).toHaveLength(1);
  });

  it('a sold-out case-variant twin no longer hides the live listing', () => {
    const rows = joinedRows(catalog([
      variant(1, { available: 0 }),
      variant(2, { sku: SKU.toLowerCase(), available: 0 }),
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lifecycleStatus: 'active' });
  });

  it('a twin WITH stock (or uncounted) still flags: that ambiguity is real', () => {
    for (const twinAvailable of [1, null]) {
      const rows = joinedRows(catalog([
        variant(1, { available: 0 }),
        variant(2, { available: twinAvailable }),
      ]));
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.lifecycleStatus === 'attention'
        && row.audit.attentionReasons.includes('shopify_sku_duplicate'))).toBe(true);
    }
  });

  it('the --end-at-zero sweep ENDS the listing behind sold-out twins', async () => {
    const { summary, calls } = await sweep(catalog([
      variant(1, { available: 0 }),
      variant(2, { available: 0, productStatus: 'DRAFT' }),
    ]));
    expect(summary).toMatchObject({ status: 'swept', aligned: 1, failed: 0 });
    expect((summary.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      sku: SKU,
      dispatchMode: 'ended_at_zero',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
    });
    expect(calls).toEqual(['EndFixedPriceItem']);
  });

  it('an attention row is never attempted by the sweep — the gap the watchdog now names', async () => {
    const snapshot = catalog([
      variant(1, { available: 0 }),
      variant(2, { available: 1 }),
    ]);
    const { calls } = await sweep(snapshot);
    expect(calls).toEqual([]);

    const candidates = evaluateIncidentCandidates({
      snapshot, signals: null, nowMs: Date.parse(OBSERVED),
    });
    const oversell = candidates.find((candidate) => candidate.code === 'OVERSELL_EXPOSURE');
    expect(oversell?.sku).toBe(SKU);
    expect(oversell?.detail).toContain("classifies this row 'attention'");
    expect(oversell?.detail).toContain('shopify_sku_duplicate');
  });
});
