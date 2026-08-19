import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createShadowApiRouter, SHADOW_API_GET_PATHS } from './shadow-api.js';
import { buildListingEditorMetadata, LISTING_EDITOR_METADATA_TESTING, } from '../listing-editor-metadata.js';
import { buildLiveListingCatalogSnapshot, } from '../live-listing-catalog.js';
import { LIVE_LISTING_CATALOG_SOURCE_TESTING } from '../live-listing-catalog-source.js';
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
async function requestJson(router, pathname) {
    const app = express();
    app.use(router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Test server address unavailable');
        return await new Promise((resolve, reject) => {
            const request = http.get({ hostname: '127.0.0.1', port: address.port, path: pathname }, (response) => {
                let raw = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { raw += chunk; });
                response.on('end', () => {
                    try {
                        resolve({
                            status: response.statusCode ?? 0,
                            headers: response.headers,
                            body: JSON.parse(raw),
                        });
                    }
                    catch (error) {
                        reject(error);
                    }
                });
            });
            request.on('error', reject);
        });
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (!error || error.code === 'ERR_SERVER_NOT_RUNNING')
                    resolve();
                else
                    reject(error);
            });
        });
    }
}
/** Enriched per-listing detail in the exact enriched-listing-detail.ts shape. */
function enrichedDetail(input) {
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
function snapshotWithRows(rows, editorFacets) {
    return {
        observedAtUtc: new Date().toISOString(),
        rows,
        ...(editorFacets === undefined ? {} : { editorFacets }),
    };
}
/** Full census-built snapshot so the builder's coverage invariants stay honest. */
function builtSnapshot(input) {
    const observedAtUtc = new Date().toISOString();
    return buildLiveListingCatalogSnapshot({
        observedAtUtc,
        shopifyVariants: input.variants,
        ebayActiveListings: input.listings,
        ebayInventoryItems: input.variants.map((variant) => ({ sku: variant.sku })),
        ebayOffers: input.offers,
        coverage: {
            shopify: {
                source: 'shopify-admin-graphql', storeDomain: 'usedcameragear.myshopify.com',
                shopId: 'gid://shopify/Shop/86254518563', observedAtUtc,
                paginationComplete: true, variantPageCount: 1,
                totalVariantsCaptured: input.variants.length,
                positiveStockVariants: input.variants.filter((variant) => variant.available !== null && variant.available > 0).length,
                excludedZeroInventory: input.variants.filter((variant) => variant.available !== null && variant.available <= 0).length,
                excludedUnknownInventory: input.variants.filter((variant) => variant.available === null).length,
                productStatusCounts: { ACTIVE: input.variants.length },
            },
            ebay: {
                source: 'ebay-trading-api+ebay-inventory-api', marketplaceId: 'EBAY_US',
                sellerAccountVerified: true, observedAtUtc,
                trading: {
                    paginationComplete: true, pageCount: 1,
                    activeListingCount: new Set(input.listings.map((listing) => listing.listingId)).size,
                },
                inventory: {
                    inventoryItemsComplete: true, inventoryItemPageCount: 1,
                    inventoryItemCount: input.variants.length,
                    offersComplete: true, offerPageCount: 1, offerCount: input.offers.length,
                    unpublishedArtifactsChecked: true,
                },
            },
        },
    });
}
function activeVariant(sku, suffix) {
    return {
        productId: `gid://shopify/Product/1${suffix}`,
        variantId: `gid://shopify/ProductVariant/2${suffix}`,
        sku,
        title: `Camera ${suffix}`,
        variantTitle: 'Default Title',
        productStatus: 'ACTIVE',
        primaryImageUrl: null,
        imageCount: 1,
        available: 1,
        price: { amount: '39.95', currency: 'USD' },
    };
}
function fixtureSnapshot() {
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
        expect(metadata.categories[0].id).toBe('id0000');
        expect(metadata.categories[499].id).toBe('id0499');
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
    it('populates all facets from census-captured Trading and offer facet data', async () => {
        const snapshot = builtSnapshot({
            variants: [activeVariant('SKU-A', '01'), activeVariant('SKU-B', '02')],
            listings: [
                {
                    listingId: '147502608418',
                    sku: 'SKU-A',
                    primaryCategoryId: '30088',
                    primaryCategoryName: 'Battery Grips',
                    fulfillmentPolicyId: '297085892011',
                    paymentPolicyId: '297085893011',
                    returnPolicyId: '305862667011',
                },
                // Trading item exposed no facets; the offer census fills them in.
                { listingId: '247502608419', sku: 'SKU-B' },
            ],
            offers: [
                {
                    offerId: 'OFFER-A', sku: 'SKU-A', status: 'PUBLISHED',
                    listingId: '147502608418', listingStatus: 'ACTIVE',
                    // Trading category id wins; the offer's is ignored for this listing.
                    categoryId: '99999',
                    merchantLocationKey: 'warehouse-1',
                },
                {
                    offerId: 'OFFER-B', sku: 'SKU-B', status: 'PUBLISHED',
                    listingId: '247502608419', listingStatus: 'ACTIVE',
                    categoryId: '11724',
                    fulfillmentPolicyId: '297085892011',
                    paymentPolicyId: '297085893011',
                    returnPolicyId: '111111111011',
                    merchantLocationKey: 'warehouse-1',
                },
            ],
        });
        const router = createShadowApiRouter({ getSnapshot: async () => snapshot });
        const response = await requestJson(router, ENDPOINT);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            conditions: EXPECTED_CONDITIONS,
            categories: [
                { id: '11724', name: null, usageCount: 1 },
                { id: '30088', name: 'Battery Grips', usageCount: 1 },
            ],
            policies: {
                fulfillment: [{ id: '297085892011', usageCount: 2 }],
                payment: [{ id: '297085893011', usageCount: 2 }],
                return: [
                    { id: '111111111011', usageCount: 1 },
                    { id: '305862667011', usageCount: 1 },
                ],
            },
            merchantLocations: [{ id: 'warehouse-1', usageCount: 2 }],
        });
        // The row-serving endpoint on the same snapshot must never expose facets.
        const rowsResponse = await requestJson(router, '/api/authoritative-listings');
        expect(rowsResponse.status).toBe(200);
        expect(JSON.stringify(rowsResponse.body)).not.toMatch(/297085892011|297085893011|305862667011|warehouse-1|policyId|merchantLocation|editorFacets|ebayDetail|30088/i);
    });
    it('extracts only validated facets from captured Trading item bodies', () => {
        expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.tradingListingFacets({
            ItemID: '147502608418',
            SKU: 'SKU-A',
            PrimaryCategory: { CategoryID: '30088', CategoryName: 'Battery Grips' },
            SellerProfiles: {
                SellerShippingProfile: { ShippingProfileID: '297085892011' },
                SellerPaymentProfile: { PaymentProfileID: 297085893011 },
                SellerReturnProfile: { ReturnProfileID: '305862667011' },
            },
        })).toEqual({
            primaryCategoryId: '30088',
            primaryCategoryName: 'Battery Grips',
            fulfillmentPolicyId: '297085892011',
            paymentPolicyId: '297085893011',
            returnPolicyId: '305862667011',
        });
        expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.tradingListingFacets({
            ItemID: '147502608418',
            PrimaryCategory: { CategoryID: 'not-digits', CategoryName: 'x'.repeat(257) },
            SellerProfiles: {
                SellerShippingProfile: { ShippingProfileID: '12.5' },
                SellerPaymentProfile: 'not-a-record',
            },
        })).toEqual({});
        expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.tradingListingFacets({ ItemID: '1' })).toEqual({});
    });
    it('extracts only validated facets from captured offer bodies', () => {
        expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.offerListingFacets({
            offerId: 'OFFER-A',
            categoryId: '11724',
            listingPolicies: {
                fulfillmentPolicyId: '297085892011',
                paymentPolicyId: '297085893011',
                returnPolicyId: '305862667011',
            },
            merchantLocationKey: 'warehouse-1',
        })).toEqual({
            categoryId: '11724',
            fulfillmentPolicyId: '297085892011',
            paymentPolicyId: '297085893011',
            returnPolicyId: '305862667011',
            merchantLocationKey: 'warehouse-1',
        });
        expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.offerListingFacets({
            offerId: 'OFFER-B',
            categoryId: 99.5,
            listingPolicies: 'not-a-record',
            merchantLocationKey: '   ',
        })).toEqual({});
    });
    it('drops malformed snapshot facet observations without failing the request', () => {
        const metadata = buildListingEditorMetadata(snapshotWithRows([], [
            {
                listingId: '1', categoryId: '30088', categoryName: 'Battery Grips',
                fulfillmentPolicyId: '297085892011', paymentPolicyId: null,
                returnPolicyId: null, merchantLocationKey: 'warehouse-1',
            },
            'not-a-record',
            {
                listingId: '2', categoryId: 42, categoryName: 7,
                fulfillmentPolicyId: 'x'.repeat(257), paymentPolicyId: '   ',
                returnPolicyId: undefined, merchantLocationKey: ['warehouse-1'],
            },
        ]));
        expect(metadata.categories).toEqual([
            { id: '30088', name: 'Battery Grips', usageCount: 1 },
        ]);
        expect(metadata.policies).toEqual({
            fulfillment: [{ id: '297085892011', usageCount: 1 }],
            payment: [],
            return: [],
        });
        expect(metadata.merchantLocations).toEqual([{ id: 'warehouse-1', usageCount: 1 }]);
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
