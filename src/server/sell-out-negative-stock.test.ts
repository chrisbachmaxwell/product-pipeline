/**
 * Incident #176 regression (L98): a sold item whose Shopify available
 * quantity is NEGATIVE (oversold in Shopify: a second sale, a POS sale past
 * zero, a draft order on a zero-stock item) must be ended on eBay exactly
 * like one at zero.
 *
 * Before the fix the draft basis serialized only non-negative quantities, so
 * -1 became a null source value; the alignment manifest then denied
 * PLAN_SOURCE_VALUE_INVALID and the sweep skipped the row on every pass —
 * no END dispatch, no ledger row, no END_DISPATCH_REJECTED — while the
 * watchdog's `available <= 0` test correctly raised OVERSELL_EXPOSURE.
 *
 * Everything runs against a real on-disk migration store and the real
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
import { deriveAlignmentManifest } from '../price-inventory-admin/manifest.js';
import { createTradingAlignDispatchAdapter } from '../price-inventory-admin/trading-dispatch-adapter.js';
import { buildPriceInventoryAdminProgram } from '../price-inventory-admin/program.js';
import type { PriceInventoryDispatchAdapter } from '../price-inventory-admin/dispatch-adapter.js';
import { deriveListingDraftBasis } from './listing-draft-service.js';
import type { ListingWorkspaceDto } from './listing-workspace-reader.js';
import type { LiveListingCatalogSnapshot } from './live-listing-catalog.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000888888';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000888888';
const PRODUCT_GID = 'gid://shopify/Product/10310708222222';
const SKU = 'NEG-STOCK-U416';
const LISTING_ID = '146052671777';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** One live legacy Trading-managed listing (no Inventory item, no Offer). */
function tradingWorkspace(shopifyAvailable: number | null, ebayActive = true): ListingWorkspaceDto {
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-10-09T02:59:00.000Z',
      detailObservedAtUtc: '2026-10-09T03:00:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU, title: 'Canon 85mm',
        variantTitle: 'Default', productStatus: 'ARCHIVED', primaryImageUrl: null,
        imageCount: 1, available: shopifyAvailable,
        price: { amount: '349.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'active', listingId: LISTING_ID, offerId: null,
        url: `https://www.ebay.com/itm/${LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 0,
        offerCount: 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
      lastVerifiedAtUtc: '2026-10-09T02:59:00.000Z',
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
        observedAtUtc: '2026-10-09T03:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 2 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: null },
      actual: {
        lifecycle: { status: ebayActive ? 'ACTIVE' : 'COMPLETED', active: ebayActive,
          format: 'FIXED_PRICE', duration: 'GTC', startAtUtc: null, endAtUtc: null },
        content: { title: 'Canon 85mm', descriptionHtml: '<p>Used</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg'] },
        category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '349.95', currency: 'USD' }, totalQuantity: 1,
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

describe('sell-out guard on negative Shopify stock (incident #176, L98)', () => {
  it('derives a zero alignment target from negative stock, and keeps unknown stock unknown', () => {
    const negative = deriveListingDraftBasis(tradingWorkspace(-1));
    expect(negative.source.quantity).toBe('0');
    // The sweep's END condition is exactly `after === 0`.
    expect(deriveAlignmentManifest({ basis: negative, field: 'quantity' }).manifest.after)
      .toBe('0');
    expect(deriveListingDraftBasis(tradingWorkspace(0)).source.quantity).toBe('0');
    expect(deriveListingDraftBasis(tradingWorkspace(2)).source.quantity).toBe('2');
    // Uncounted stock is a data problem, never a sell-out: it must still
    // fail closed rather than end a listing.
    expect(deriveListingDraftBasis(tradingWorkspace(null)).source.quantity).toBeNull();
    expect(() => deriveAlignmentManifest({
      basis: deriveListingDraftBasis(tradingWorkspace(null)), field: 'quantity',
    })).toThrow();
  });

  it('the --end-at-zero sweep ENDS a live Trading listing whose Shopify stock is -1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-out-negative-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const migrationStore = path.join(root, 'migration-state.sqlite');
    createMigrationStore({
      databasePath: migrationStore,
      scope: MIGRATION_SCOPE,
      createdAtUtc: '2026-08-01T00:00:00.000Z',
    }).close();

    let current = tradingWorkspace(-1);
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      const callName = (init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME'] ?? '';
      calls.push(callName);
      if (callName === 'EndFixedPriceItem') current = tradingWorkspace(-1, false);
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
        readWorkspace: async () => current,
        createAdapter: () => inventoryAdapter,
        createTradingAdapter: () => createTradingAlignDispatchAdapter({
          fetchImpl: fakeFetch,
          getAccessToken: async () => 'test-iaf-token',
        }),
        getSnapshot: async () =>
          ({ rows: [current.catalog] }) as unknown as LiveListingCatalogSnapshot,
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

    const summary = JSON.parse(stdout.at(-1)!) as Record<string, unknown>;
    expect(summary).toMatchObject({ status: 'swept', aligned: 1, failed: 0 });
    expect((summary.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      sku: SKU,
      dispatchMode: 'ended_at_zero',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
    });
    expect(calls).toEqual(['EndFixedPriceItem']);
  });
});
