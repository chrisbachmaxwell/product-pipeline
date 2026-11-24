/**
 * Incident #259 regression (L133): OVERSELL_EXPOSURE for KFNIKFGFX-UNSN —
 * Shopify at 0, eBay listing 147695941538 still live, and the catalog row
 * classified 'attention' with reason `ebay_unpublished_artifact`.
 *
 * Leftover eBay Inventory data for the SKU (an item-only residue or an
 * unpublished offer from an earlier create attempt) sat beside the ONE live
 * listing. The artifact reason made the row 'attention', and the
 * --end-at-zero sweep scans only 'active' rows, so the sold-out listing was
 * structurally unreachable. With the SKU sold out everywhere and exactly one
 * live listing there is nothing to disambiguate: the END target is the exact
 * listing id.
 *
 * The catalog runs for real; its row drives the real sweep (and the real
 * draft-basis gate) against a real on-disk migration store and the real
 * bounded Trading adapter over a captured, network-free transport.
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
  type CapturedEbayInventoryItem,
  type CapturedEbayOffer,
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
const SKU = 'KFNIKFGFX-UNSN';
const LISTING_ID = '147695941538';
const OBSERVED = '2026-11-24T17:00:00.000Z';

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

function catalog(
  variants: CapturedShopifyVariant[],
  ebayInventoryItems: CapturedEbayInventoryItem[] = [{ sku: SKU }],
  ebayOffers: CapturedEbayOffer[] = [],
): LiveListingCatalogSnapshot {
  const active = [{ listingId: LISTING_ID, sku: SKU }];
  return buildLiveListingCatalogSnapshot({
    observedAtUtc: OBSERVED,
    shopifyVariants: variants,
    ebayActiveListings: active,
    ebayInventoryItems,
    ebayOffers,
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
          inventoryItemsComplete: true, inventoryItemPageCount: 1,
          inventoryItemCount: ebayInventoryItems.length,
          offersComplete: true, offerPageCount: ebayOffers.length > 0 ? 1 : 0,
          offerCount: ebayOffers.length,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-out-artifact-'));
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

describe('sell-out guard beside leftover eBay Inventory data (incident #259, L133)', () => {
  const unpublishedOffer: CapturedEbayOffer = {
    offerId: '9900112233', sku: SKU, status: 'UNPUBLISHED', listingId: null, listingStatus: null,
  };

  it('a sold-out row with one live listing and leftover data is active, counts kept truthful', () => {
    for (const [items, offers] of [
      [[{ sku: SKU }], []],
      [[{ sku: SKU }], [unpublishedOffer]],
      [[], [unpublishedOffer]],
    ] as Array<[CapturedEbayInventoryItem[], CapturedEbayOffer[]]>) {
      const rows = joinedRows(catalog([variant(1, { available: 0 })], items, offers));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ lifecycleStatus: 'active' });
      expect(rows[0]!.audit.attentionReasons).toEqual([]);
      expect(rows[0]!.ebay.offerId).toBeNull();
      expect(rows[0]!.ebay.unpublishedArtifactCount).toBe(items.length + offers.length);
    }
  });

  it('a row WITH stock (or uncounted stock) keeps the artifact flag', () => {
    for (const available of [1, null]) {
      const rows = joinedRows(catalog([variant(1, { available })]));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ lifecycleStatus: 'attention' });
      expect(rows[0]!.audit.attentionReasons).toContain('ebay_unpublished_artifact');
    }
  });

  it('a sold-out SKU with a still-sellable twin keeps the flag (the ambiguity is real)', () => {
    const rows = joinedRows(catalog([
      variant(1, { available: 0 }),
      variant(2, { available: 1 }),
    ]));
    expect(rows.every((row) => row.lifecycleStatus === 'attention')).toBe(true);
  });

  it('the --end-at-zero sweep ENDS the sold-out listing beside leftover data', async () => {
    const { summary, calls } = await sweep(catalog(
      [variant(1, { available: 0 })],
      [{ sku: SKU }],
      [unpublishedOffer],
    ));
    expect(summary).toMatchObject({ status: 'swept', aligned: 1, failed: 0 });
    expect((summary.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      sku: SKU,
      dispatchMode: 'ended_at_zero',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
    });
    expect(calls).toEqual(['EndFixedPriceItem']);
  });

  it('once the listing has ended, the leftover data is flagged for cleanup again', () => {
    const snapshot = buildLiveListingCatalogSnapshot({
      ...catalogInputWithoutListing(),
    });
    const row = snapshot.rows.find((candidate) => candidate.ebay.sku === SKU)!;
    expect(row.lifecycleStatus).toBe('attention');
    expect(row.audit.attentionReasons).toContain('ebay_unpublished_artifact');
  });

  it('a stocked row with leftover data is never attempted by the sweep', async () => {
    const { calls } = await sweep(catalog([variant(1, { available: 1 })]));
    expect(calls).toEqual([]);
  });
});

function catalogInputWithoutListing(): Parameters<typeof buildLiveListingCatalogSnapshot>[0] {
  const base = catalog([variant(1, { available: 0 })]);
  return {
    observedAtUtc: OBSERVED,
    shopifyVariants: [variant(1, { available: 0 })],
    ebayActiveListings: [],
    ebayInventoryItems: [{ sku: SKU }],
    ebayOffers: [],
    coverage: {
      ...base.coverage,
      ebay: {
        ...base.coverage.ebay,
        trading: { ...base.coverage.ebay.trading, activeListingCount: 0 },
      },
    } as Parameters<typeof buildLiveListingCatalogSnapshot>[0]['coverage'],
  };
}
