import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { createShadowApiRouter, SHADOW_API_GET_PATHS } from './shadow-api.js';
import {
  buildListingEditorMetadata,
  LISTING_EDITOR_METADATA_TESTING,
} from '../listing-editor-metadata.js';
import {
  buildLiveListingCatalogSnapshot,
  type LiveListingCatalogSnapshot,
} from '../live-listing-catalog.js';
import { EBAY_CONDITIONS } from '../../shared/ebay-conditions.js';

const ENDPOINT = '/api/listing-editor-metadata';

const EXPECTED_CONDITIONS = [
  { id: '1000', label: 'New' },
  { id: '1500', label: 'New other (see details)' },
  { id: '1750', label: 'New with defects' },
  { id: '2000', label: 'Certified - Refurbished' },
  { id: '2500', label: 'Seller refurbished' },
  { id: '2750', label: 'Like New' },
  { id: '3000', label: 'Used' },
  { id: '4000', label: 'Very Good' },
  { id: '5000', label: 'Good' },
  { id: '6000', label: 'Acceptable' },
  { id: '7000', label: 'For parts or not working' },
];

async function requestJson(router: Router, pathname: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}> {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
    return await new Promise((resolve, reject) => {
      const request = http.get(
        { hostname: '127.0.0.1', port: address.port, path: pathname },
        (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { raw += chunk; });
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: JSON.parse(raw) as Record<string, any>,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(error);
      });
    });
  }
}

/** Enriched per-listing detail in the exact enriched-listing-detail.ts shape. */
function enrichedDetail(input: Readonly<{
  categoryId?: unknown;
  categoryName?: unknown;
  fulfillmentPolicyId?: unknown;
  paymentPolicyId?: unknown;
  returnPolicyId?: unknown;
  offerFulfillmentPolicyId?: unknown;
  merchantLocationKey?: unknown;
}>): Record<string, unknown> {
  return {
    actual: {
      category: {
        primary: { id: input.categoryId ?? null, name: input.categoryName ?? null },
      },
      policies: {
        fulfillmentPolicyId: input.fulfillmentPolicyId ?? null,
        paymentPolicyId: input.paymentPolicyId ?? null,
        returnPolicyId: input.returnPolicyId ?? null,
      },
    },
    management: {
      offer: {
        fulfillmentPolicyId: input.offerFulfillmentPolicyId ?? null,
        merchantLocationKey: input.merchantLocationKey ?? null,
      },
    },
  };
}

function snapshotWithRows(rows: readonly unknown[]): LiveListingCatalogSnapshot {
  return {
    observedAtUtc: new Date().toISOString(),
    rows,
  } as unknown as LiveListingCatalogSnapshot;
}

function fixtureSnapshot(): LiveListingCatalogSnapshot {
  return snapshotWithRows([
    { ebayDetail: enrichedDetail({
      categoryId: '30088',
      fulfillmentPolicyId: '297085892011',
      paymentPolicyId: '297085893011',
      returnPolicyId: '305862667011',
      merchantLocationKey: 'warehouse-1',
    }) },
    { ebayDetail: enrichedDetail({
      categoryId: '30088',
      categoryName: 'Battery Grips',
      fulfillmentPolicyId: '297085892011',
      paymentPolicyId: '297085893011',
      returnPolicyId: '305862667011',
      merchantLocationKey: 'warehouse-1',
    }) },
    { ebayDetail: enrichedDetail({
      categoryId: '11724',
      categoryName: 'Film Cameras',
      fulfillmentPolicyId: '297085892011',
      paymentPolicyId: '297085893011',
      returnPolicyId: '111111111011',
      merchantLocationKey: 'warehouse-2',
    }) },
    // A row whose SellerProfiles policy id is absent but whose offer carries one.
    { ebayDetail: enrichedDetail({
      categoryId: '11725',
      categoryName: 'Lenses',
      offerFulfillmentPolicyId: '888888888011',
    }) },
    // A production-shaped row without enriched detail contributes nothing.
    { id: 'shopify-variant:gid://shopify/ProductVariant/1', ebay: { sku: 'A-1' } },
    // Unsafe or malformed values are dropped, never escaped or echoed.
    { ebayDetail: enrichedDetail({
      categoryId: 'bad\u0000id',
      categoryName: 'ignored',
      fulfillmentPolicyId: 42,
      paymentPolicyId: 'x'.repeat(257),
      returnPolicyId: '   ',
      merchantLocationKey: 'bad\u001Fkey',
    }) },
    { ebayDetail: 'not-a-record' },
  ]);
}

describe('GET /api/listing-editor-metadata', () => {
  it('is registered on the shadow API GET allowlist', () => {
    expect(SHADOW_API_GET_PATHS).toContain(ENDPOINT);
  });

  it('serves the exact read-only DTO shape with no-store caching', async () => {
    const router = createShadowApiRouter({ getSnapshot: async () => fixtureSnapshot() });
    const response = await requestJson(router, ENDPOINT);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body).sort()).toEqual([
      'categories',
      'conditions',
      'merchantLocations',
      'policies',
    ]);
    expect(Object.keys(response.body.policies).sort()).toEqual([
      'fulfillment',
      'payment',
      'return',
    ]);
    for (const condition of response.body.conditions) {
      expect(Object.keys(condition).sort()).toEqual(['id', 'label']);
    }
    for (const categoryEntry of response.body.categories) {
      expect(Object.keys(categoryEntry).sort()).toEqual(['id', 'name', 'usageCount']);
    }
    for (const usageEntry of [
      ...response.body.policies.fulfillment,
      ...response.body.policies.payment,
      ...response.body.policies.return,
      ...response.body.merchantLocations,
    ]) {
      expect(Object.keys(usageEntry).sort()).toEqual(['id', 'usageCount']);
    }
    expect(JSON.stringify(response.body)).not.toMatch(/bad\\u0000id|bad\\u001Fkey|xxxxx/);
  });

  it('aggregates usage counts sorted by usage desc then id asc, backfilling names', async () => {
    const metadata = buildListingEditorMetadata(fixtureSnapshot());
    expect(metadata.categories).toEqual([
      { id: '30088', name: 'Battery Grips', usageCount: 2 },
      { id: '11724', name: 'Film Cameras', usageCount: 1 },
      { id: '11725', name: 'Lenses', usageCount: 1 },
    ]);
    expect(metadata.policies).toEqual({
      fulfillment: [
        { id: '297085892011', usageCount: 3 },
        { id: '888888888011', usageCount: 1 },
      ],
      payment: [{ id: '297085893011', usageCount: 3 }],
      return: [
        { id: '305862667011', usageCount: 2 },
        { id: '111111111011', usageCount: 1 },
      ],
    });
    expect(metadata.merchantLocations).toEqual([
      { id: 'warehouse-1', usageCount: 2 },
      { id: 'warehouse-2', usageCount: 1 },
    ]);
    expect(metadata.conditions).toEqual(EXPECTED_CONDITIONS);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.categories)).toBe(true);
    expect(Object.isFrozen(metadata.policies.fulfillment)).toBe(true);
  });

  it('keeps a category name null when no listing exposes a safe name', () => {
    const metadata = buildListingEditorMetadata(snapshotWithRows([
      { ebayDetail: enrichedDetail({ categoryId: '30088' }) },
      { ebayDetail: enrichedDetail({ categoryId: '30088', categoryName: '   ' }) },
    ]));
    expect(metadata.categories).toEqual([{ id: '30088', name: null, usageCount: 2 }]);
  });

  it('bounds every aggregated facet to 500 entries', () => {
    const rows = Array.from({ length: 510 }, (_value, index) => ({
      ebayDetail: enrichedDetail({
        categoryId: `id${String(index).padStart(4, '0')}`,
      }),
    }));
    const metadata = buildListingEditorMetadata(snapshotWithRows(rows));
    expect(LISTING_EDITOR_METADATA_TESTING.MAX_FACET_ENTRIES).toBe(500);
    expect(metadata.categories).toHaveLength(500);
    expect(metadata.categories[0]!.id).toBe('id0000');
    expect(metadata.categories[499]!.id).toBe('id0499');
  });

  it('returns empty facet arrays for a real snapshot that carries no enriched detail', async () => {
    const observedAtUtc = new Date().toISOString();
    const snapshot = buildLiveListingCatalogSnapshot({
      observedAtUtc,
      shopifyVariants: [{
        productId: 'gid://shopify/Product/10310708035875',
        variantId: 'gid://shopify/ProductVariant/55396000563491',
        sku: 'CAN3570-U119',
        title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
        variantTitle: 'Default Title',
        productStatus: 'ACTIVE',
        primaryImageUrl: null,
        imageCount: 6,
        available: 1,
        price: { amount: '39.95', currency: 'USD' },
      }],
      ebayActiveListings: [{ listingId: '147502608418', sku: 'CAN3570-U119' }],
      ebayInventoryItems: [{ sku: 'CAN3570-U119' }],
      ebayOffers: [{
        offerId: '234942877011', sku: 'CAN3570-U119', status: 'PUBLISHED',
        listingId: '147502608418', listingStatus: 'ACTIVE',
      }],
      coverage: {
        shopify: {
          source: 'shopify-admin-graphql', storeDomain: 'usedcameragear.myshopify.com',
          shopId: 'gid://shopify/Shop/86254518563', observedAtUtc,
          paginationComplete: true, variantPageCount: 1, totalVariantsCaptured: 1,
          positiveStockVariants: 1, excludedZeroInventory: 0, excludedUnknownInventory: 0,
          productStatusCounts: { ACTIVE: 1 },
        },
        ebay: {
          source: 'ebay-trading-api+ebay-inventory-api', marketplaceId: 'EBAY_US',
          sellerAccountVerified: true, observedAtUtc,
          trading: { paginationComplete: true, pageCount: 1, activeListingCount: 1 },
          inventory: {
            inventoryItemsComplete: true, inventoryItemPageCount: 1, inventoryItemCount: 1,
            offersComplete: true, offerPageCount: 1, offerCount: 1,
            unpublishedArtifactsChecked: true,
          },
        },
      },
    });
    const router = createShadowApiRouter({ getSnapshot: async () => snapshot });
    const response = await requestJson(router, ENDPOINT);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      conditions: EXPECTED_CONDITIONS,
      categories: [],
      policies: { fulfillment: [], payment: [], return: [] },
      merchantLocations: [],
    });
  });

  it('fails closed with a generic 503 when the cached snapshot read fails', async () => {
    const router = createShadowApiRouter({
      getSnapshot: async () => { throw new Error('Bearer secret-value source detail'); },
    });
    const response = await requestJson(router, ENDPOINT);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Listing editor metadata is unavailable' });
    expect(JSON.stringify(response)).not.toMatch(/secret-value|Bearer/);
  });

  it('fails closed without reading when no successful snapshot is held yet', async () => {
    let snapshotReads = 0;
    const router = createShadowApiRouter({
      getSnapshot: async () => {
        snapshotReads += 1;
        return fixtureSnapshot();
      },
      getSnapshotStatus: () => ({
        hasSuccessfulSnapshot: false,
        observedAtUtc: null,
        lastSuccessAtEpochMs: null,
        lastAttemptAtEpochMs: null,
        lastFailureAtEpochMs: null,
        expiresAtEpochMs: null,
        refreshInFlight: false,
      }),
    });
    const response = await requestJson(router, ENDPOINT);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Listing editor metadata is unavailable' });
    expect(snapshotReads).toBe(0);
  });

  it('exposes exactly the fixed 11-entry frozen eBay condition table', () => {
    expect(EBAY_CONDITIONS).toEqual(EXPECTED_CONDITIONS);
    expect(EBAY_CONDITIONS).toHaveLength(11);
    expect(Object.isFrozen(EBAY_CONDITIONS)).toBe(true);
    for (const condition of EBAY_CONDITIONS) {
      expect(Object.isFrozen(condition)).toBe(true);
    }
  });
});
