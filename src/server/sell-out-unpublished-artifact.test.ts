/**
 * Incident #252 regression (L129): OVERSELL_EXPOSURE for 20201-U263. Shopify
 * was at 0 and eBay listing 147655602507 was still live. The catalog
 * classified the row 'attention' with the single reason
 * `ebay_unpublished_artifact`: a stray Inventory item or unpublished/stale
 * Offer for the same SKU sat beside the one live listing. The --end-at-zero
 * sweep scanned only 'active' rows, so it never tried to END the listing.
 * This was gap (i) that L104 left uncovered.
 *
 * The catalog runs for real here. Its row drives the real sweep against a
 * real on-disk migration store, with the real bounded Trading adapter over a
 * captured, network-free transport.
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
import { deriveListingDraftBasis, deriveSellOutEndBasis } from './listing-draft-service.js';
import type { ListingWorkspaceDto } from './listing-workspace-reader.js';
import {
  buildLiveListingCatalogSnapshot,
  isSellOutEndOnlyRow,
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
const SKU = '20201-U263';
const LISTING_ID = '147655602507';
const OBSERVED = '2026-11-10T23:30:00.000Z';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function variant(id: number, overrides: Partial<CapturedShopifyVariant> = {}): CapturedShopifyVariant {
  return {
    productId: `gid://shopify/Product/2031070822${id}`,
    variantId: `gid://shopify/ProductVariant/6539600088${id}`,
    sku: SKU,
    title: 'Nikon Lens Hood *USED*',
    variantTitle: 'Default Title',
    productStatus: 'ARCHIVED',
    productTags: [],
    primaryImageUrl: null,
    imageCount: 1,
    available: 0,
    price: { amount: '29.00', currency: 'USD' },
    ...overrides,
  };
}

type Residue = { inventoryItems: number; offers: CapturedEbayOffer[] };
/** A stray Inventory item (for example from a failed create) and no offer. */
const STRAY_ITEM: Residue = { inventoryItems: 1, offers: [] };

function catalog(variants: CapturedShopifyVariant[], residue: Residue = STRAY_ITEM): LiveListingCatalogSnapshot {
  const inventoryItems = Array.from({ length: residue.inventoryItems }, () => ({ sku: SKU }));
  return buildLiveListingCatalogSnapshot({
    observedAtUtc: OBSERVED,
    shopifyVariants: variants,
    ebayActiveListings: [{ listingId: LISTING_ID, sku: SKU }],
    ebayInventoryItems: inventoryItems,
    ebayOffers: residue.offers,
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
        productStatusCounts: { ARCHIVED: variants.length },
      },
      ebay: {
        source: 'ebay-trading-api+ebay-inventory-api',
        marketplaceId: 'EBAY_US',
        sellerAccountVerified: true,
        observedAtUtc: OBSERVED,
        trading: { paginationComplete: true, pageCount: 1, activeListingCount: 1 },
        inventory: {
          inventoryItemsComplete: true, inventoryItemPageCount: 1,
          inventoryItemCount: inventoryItems.length,
          offersComplete: true, offerPageCount: 1, offerCount: residue.offers.length,
          unpublishedArtifactsChecked: true,
        },
      },
    },
  });
}

function joinedRow(snapshot: LiveListingCatalogSnapshot): LiveListingCatalogRow {
  const rows = snapshot.rows.filter((row) => row.ebay.listingId === LISTING_ID);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/**
 * The workspace the sweep reads for one catalog row, as the real reader
 * projects it: an attention row maps to `attention`, and the management
 * model follows the row's bound offer id.
 */
function workspaceFor(row: LiveListingCatalogRow, ebayActive = true): ListingWorkspaceDto {
  const shopify = row.shopify!;
  const inventoryModel = row.ebay.offerId !== null;
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: OBSERVED,
      detailObservedAtUtc: '2026-11-10T23:30:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: row as unknown as ListingWorkspaceDto['catalog'],
    mapping: {
      state: row.lifecycleStatus === 'active' ? 'mapped' : 'attention', joinKey: 'exact_raw_sku',
      shopifyProductId: shopify.productId, shopifyVariantId: shopify.variantId,
      inventorySku: SKU, offerId: row.ebay.offerId, listingId: LISTING_ID,
      managementModel: inventoryModel ? 'inventory_offer' : 'legacy_trading',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item',
        observedAtUtc: '2026-11-10T23:30:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 2 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: shopify.productId, shopifyVariantId: shopify.variantId, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: row.ebay.offerId },
      actual: {
        lifecycle: { status: ebayActive ? 'ACTIVE' : 'COMPLETED', active: ebayActive,
          format: 'FIXED_PRICE', duration: 'GTC', startAtUtc: null, endAtUtc: null },
        content: { title: shopify.title, descriptionHtml: '<p>Used</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg'] },
        category: { primary: { id: '29967', name: 'Lens Hoods' }, secondary: null,
          storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Brand: ['Nikon'] },
        identifiers: { brand: 'Nikon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '29.00', currency: 'USD' }, totalQuantity: 1,
          soldQuantity: 0, availableQuantity: 1,
          availableQuantityBasis: 'reported', bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '6055555000', paymentPolicyId: '6066666000',
          returnPolicyId: '6077777000', paymentMethods: [], shippingType: null,
          domesticServices: [], internationalServices: [], returnsAccepted: true,
          returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: inventoryModel
        ? { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
          exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
            offer: true, offerToListing: true }, lifecycleAligned: true,
          inventoryItem: { sku: SKU } as never,
          offer: { offerId: row.ebay.offerId!, sku: SKU, marketplaceId: 'EBAY_US',
            merchantLocationKey: 'main' } as never }
        : { model: 'legacy_trading', controlApi: 'trading', joinKey: 'exact_raw_sku',
          exactBindings: { seller: true, listing: true, sku: true, inventoryItem: false,
            offer: false, offerToListing: false }, lifecycleAligned: true,
          inventoryItem: null, offer: null },
    },
  } as ListingWorkspaceDto;
}

/** One align-sweep over `snapshot`; returns the summary and every eBay call. */
async function sweep(snapshot: LiveListingCatalogSnapshot, flags: {
  field?: 'quantity' | 'price';
  endAtZero?: boolean;
} = {}): Promise<{ summary: Record<string, unknown>; calls: string[] }> {
  const field = flags.field ?? 'quantity';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-out-artifact-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const migrationStore = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationStore,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-01T00:00:00.000Z',
  }).close();

  let ended = false;
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const callName = (init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME'] ?? '';
    calls.push(callName);
    if (callName === 'EndFixedPriceItem') ended = true;
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><${callName}Response xmlns="urn:ebay:apis:eBLBaseComponents">`
      + `<Ack>Success</Ack></${callName}Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } },
    );
  };
  const record = (name: string) => async (input: Record<string, unknown>): Promise<void> => {
    calls.push(`${name}:${JSON.stringify(input)}`);
    if (name === 'withdrawOffer') ended = true;
  };
  const inventoryAdapter: PriceInventoryDispatchAdapter = Object.freeze({
    updateOfferPrice: record('updateOfferPrice'),
    updateOfferQuantity: record('updateOfferQuantity'),
    withdrawOffer: record('withdrawOffer'),
    getOfferBySku: async () => null,
    publishOffer: record('publishOffer'),
  }) as unknown as PriceInventoryDispatchAdapter;
  const stdout: string[] = [];
  const run = async (argv: string[]): Promise<void> => {
    await buildPriceInventoryAdminProgram({
      readWorkspace: async (catalogId) => {
        const row = snapshot.rows.find((candidate) => candidate.id === catalogId)!;
        return workspaceFor(row, !ended);
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
    '--responsibility', field === 'price' ? 'price' : 'inventory',
    '--baseline-evidence', `sha256:${'a'.repeat(64)}`,
    '--mc-disabled-evidence', `sha256:${'b'.repeat(64)}`,
  ]);
  await run(['align-sweep',
    '--migration-store', migrationStore,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--field', field,
    '--confirm-sweep',
    ...(flags.endAtZero === false ? [] : ['--end-at-zero']),
  ]);
  return { summary: JSON.parse(stdout.at(-1)!) as Record<string, unknown>, calls };
}

describe('sell-out guard on a live listing beside leftover eBay residue (incident #252, L129)', () => {
  it('the incident shape: one live listing, a stray Inventory item, Shopify at 0', () => {
    const row = joinedRow(catalog([variant(1)]));
    expect(row.lifecycleStatus).toBe('attention');
    // The residue stays visible: Publish-All recovery and the UI rely on it.
    expect(row.audit.attentionReasons).toEqual(['ebay_unpublished_artifact']);
    expect(row.ebay).toMatchObject({ activeMatchCount: 1, offerId: null, unpublishedArtifactCount: 1 });
    expect(isSellOutEndOnlyRow(row)).toBe(true);
  });

  it('the --end-at-zero sweep ENDS the Trading listing, exactly once and by listing id', async () => {
    const { summary, calls } = await sweep(catalog([variant(1)]));
    expect(summary).toMatchObject({ status: 'swept', aligned: 1, failed: 0 });
    expect((summary.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      sku: SKU,
      dispatchMode: 'ended_at_zero',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
    });
    expect(calls).toEqual(['EndFixedPriceItem']);
  });

  it('negative Shopify stock is sold out too', async () => {
    const { calls } = await sweep(catalog([variant(1, { available: -2 })]));
    expect(calls).toEqual(['EndFixedPriceItem']);
  });

  it('an Inventory-model listing beside a stray unpublished Offer ends by withdrawing the BOUND offer', async () => {
    const snapshot = catalog([variant(1)], {
      inventoryItems: 1,
      offers: [
        { offerId: '9000000001', sku: SKU, status: 'PUBLISHED', listingId: LISTING_ID, listingStatus: 'ACTIVE' },
        { offerId: '9000000002', sku: SKU, status: 'UNPUBLISHED', listingId: null, listingStatus: null },
      ],
    });
    const row = joinedRow(snapshot);
    expect(row.audit.attentionReasons).toEqual(['ebay_unpublished_artifact']);
    expect(row.ebay.offerId).toBe('9000000001');
    const { summary, calls } = await sweep(snapshot);
    expect(summary).toMatchObject({ aligned: 1, failed: 0 });
    expect(calls).toEqual([`withdrawOffer:${JSON.stringify({ sku: SKU, offerId: '9000000001' })}`]);
  });

  it('selection only: without --end-at-zero, or on a price sweep, the row is never touched', async () => {
    expect((await sweep(catalog([variant(1)]), { endAtZero: false })).calls).toEqual([]);
    expect((await sweep(catalog([variant(1)]), { field: 'price', endAtZero: false })).calls).toEqual([]);
  });

  it('the residue row is still refused by the draft/revise basis', () => {
    const row = joinedRow(catalog([variant(1)]));
    expect(() => deriveListingDraftBasis(workspaceFor(row))).toThrow();
    expect(deriveSellOutEndBasis(workspaceFor(row)).identity).toMatchObject({
      managementModel: 'trading_api', ebayListingId: LISTING_ID, ebayOfferId: null,
    });
  });

  it('stays out of the END path when Shopify could still sell, or stock is unknown', async () => {
    // Positive stock beside residue: no END, and the END-only basis refuses it.
    const stocked = joinedRow(catalog([variant(1, { productStatus: 'ACTIVE', available: 1 })]));
    expect(isSellOutEndOnlyRow(stocked)).toBe(false);
    expect(() => deriveSellOutEndBasis(workspaceFor(stocked))).toThrow();
    expect((await sweep(catalog([variant(1, { productStatus: 'ACTIVE', available: 1 })]))).calls)
      .toEqual([]);
    // Unknown stock is a data problem (two reasons), never an END.
    const unknown = joinedRow(catalog([variant(1, { available: null })]));
    expect(isSellOutEndOnlyRow(unknown)).toBe(false);
    // A sellable twin with stock: the ambiguity is real (L104), so no END.
    const twinSnapshot = catalog([
      variant(1, { productStatus: 'ACTIVE' }),
      variant(2, { productStatus: 'ACTIVE', available: 1 }),
    ]);
    expect(twinSnapshot.rows.some((row) => isSellOutEndOnlyRow(row))).toBe(false);
    expect((await sweep(twinSnapshot)).calls).toEqual([]);
  });

  it('the END-only basis refuses a live detail whose exact bindings fail', () => {
    const row = joinedRow(catalog([variant(1)]));
    const workspace = workspaceFor(row);
    const foreign = {
      ...workspace,
      ebayDetail: {
        ...workspace.ebayDetail!,
        identity: { ...workspace.ebayDetail!.identity, listingId: '147600000000' },
      },
    } as ListingWorkspaceDto;
    expect(() => deriveSellOutEndBasis(foreign)).toThrow();
    expect(() => deriveSellOutEndBasis({ ...workspace, ebayDetail: null })).toThrow();
  });

  it('the watchdog detail now points at the sweep summary, not at "never attempted"', () => {
    const snapshot = catalog([variant(1)]);
    const oversell = evaluateIncidentCandidates({
      snapshot, signals: null, nowMs: Date.parse(OBSERVED),
    }).find((candidate) => candidate.code === 'OVERSELL_EXPOSURE');
    expect(oversell?.sku).toBe(SKU);
    expect(oversell?.detail).toContain('END-only target (L129)');
    expect(oversell?.detail).not.toContain('never attempted');
  });
});
