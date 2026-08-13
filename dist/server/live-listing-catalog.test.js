import { describe, expect, it, vi } from 'vitest';
import { buildLiveListingCatalogSnapshot, projectLiveListingCatalogPage, } from './live-listing-catalog.js';
import { createLiveListingCatalogCache, createTransientEbayTokenProvider, exchangeRuntimeEbayToken, hasUnresolvedLiveListingRefreshFailure, LIVE_LISTING_CATALOG_SOURCE_TESTING, LISTING_CATALOG_FAILURE_CODES, } from './live-listing-catalog-source.js';
const observedAtUtc = '2026-08-13T20:00:00.000Z';
function variant(overrides = {}) {
    return {
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/1',
        sku: 'SAFE-SKU',
        title: 'Camera',
        variantTitle: 'Default Title',
        productStatus: 'ACTIVE',
        primaryImageUrl: null,
        imageCount: 0,
        available: 1,
        price: { amount: '10.00', currency: 'USD' },
        ...overrides,
    };
}
function active(listingId = '100', sku = 'SAFE-SKU') {
    return { listingId, sku };
}
function item(sku = 'SAFE-SKU') {
    return { sku };
}
function offer(overrides = {}) {
    return {
        offerId: 'OFFER-1',
        sku: 'SAFE-SKU',
        status: 'PUBLISHED',
        listingId: '100',
        listingStatus: 'ACTIVE',
        ...overrides,
    };
}
function snapshot(input = {}) {
    const variants = input.variants ?? [variant()];
    const activeListings = input.active ?? [];
    const items = input.items ?? [];
    const offers = input.offers ?? [];
    return buildLiveListingCatalogSnapshot({
        observedAtUtc,
        shopifyVariants: variants,
        ebayActiveListings: activeListings,
        ebayInventoryItems: items,
        ebayOffers: offers,
        coverage: {
            shopify: {
                source: 'shopify-admin-graphql',
                storeDomain: 'usedcameragear.myshopify.com',
                shopId: 'gid://shopify/Shop/86254518563',
                observedAtUtc,
                paginationComplete: true,
                variantPageCount: 1,
                totalVariantsCaptured: variants.length,
                positiveStockVariants: variants.filter((entry) => entry.available !== null && entry.available > 0).length,
                excludedZeroInventory: variants.filter((entry) => entry.available !== null && entry.available <= 0).length,
                excludedUnknownInventory: variants.filter((entry) => entry.available === null).length,
                productStatusCounts: { ACTIVE: variants.length },
            },
            ebay: {
                source: 'ebay-trading-api+ebay-inventory-api',
                marketplaceId: 'EBAY_US',
                sellerAccountVerified: true,
                observedAtUtc,
                trading: {
                    paginationComplete: true,
                    pageCount: activeListings.length > 0 ? 1 : 0,
                    activeListingCount: new Set(activeListings.map((entry) => entry.listingId)).size,
                },
                inventory: {
                    inventoryItemsComplete: true,
                    inventoryItemPageCount: 1,
                    inventoryItemCount: items.length,
                    offersComplete: true,
                    offerPageCount: items.length,
                    offerCount: offers.length,
                    unpublishedArtifactsChecked: true,
                },
            },
        },
    });
}
describe('live listing catalog truth reducer', () => {
    it.each([
        ['not_listed', [], [], []],
        ['attention', [], [item()], []],
        ['attention', [], [], [offer({ listingId: null, status: 'UNPUBLISHED', listingStatus: null })]],
        ['active', [active()], [], []],
        ['active', [active()], [item()], [offer()]],
        ['attention', [active()], [item()], [offer(), offer({ offerId: 'OFFER-2', listingId: null, status: 'UNPUBLISHED' })]],
        ['attention', [active()], [item()], []],
        ['attention', [active()], [item()], [offer({ status: 'UNPUBLISHED', listingStatus: null })]],
        ['attention', [active()], [item()], [offer({ listingStatus: null })]],
        ['attention', [active('100'), active('101')], [], []],
    ])('classifies %s for the exact active/artifact matrix', (expected, activeRows, items, offers) => {
        expect(snapshot({ active: [...activeRows], items: [...items], offers: [...offers] }).rows[0])
            .toMatchObject({ lifecycleStatus: expected });
    });
    it('marks missing, duplicate, nonactive, same-source, and cross-source near-collision SKUs attention', () => {
        const missing = snapshot({ variants: [variant({ sku: '   ' })] }).rows[0];
        expect(missing.audit.attentionReasons).toContain('shopify_sku_missing');
        const duplicate = snapshot({ variants: [
                variant(),
                variant({ variantId: 'gid://shopify/ProductVariant/2' }),
            ] });
        expect(duplicate.rows.every((row) => row.audit.attentionReasons.includes('shopify_sku_duplicate')))
            .toBe(true);
        const near = snapshot({ active: [active('100', 'safe-sku')] }).rows[0];
        expect(near.audit.attentionReasons).toContain('ebay_sku_near_collision');
        const shopifyOnlyNear = snapshot({ variants: [
                variant({ sku: 'ABC' }),
                variant({ variantId: 'gid://shopify/ProductVariant/2', sku: 'abc' }),
            ] });
        expect(shopifyOnlyNear.rows.every((row) => row.audit.attentionReasons.includes('shopify_sku_near_collision'))).toBe(true);
        expect(shopifyOnlyNear.rows.every((row) => !row.audit.attentionReasons.includes('ebay_sku_near_collision'))).toBe(true);
        expect(shopifyOnlyNear.coverage.join.ebayNearCollisionCount).toBe(0);
        const draft = snapshot({ variants: [variant({ productStatus: 'DRAFT' })] }).rows[0];
        expect(draft.audit.attentionReasons).toContain('shopify_product_not_active');
    });
    it('fails closed on repeated stable IDs and count mismatches', () => {
        expect(() => snapshot({ active: [active(), active()] })).toThrow();
        expect(() => snapshot({ offers: [offer(), offer()] })).toThrow();
    });
    it('keeps zero-stock active Shopify rows visible as attention', () => {
        const built = snapshot({
            variants: [variant({ available: 0 })],
            active: [active()],
        });
        expect(built.rows).toHaveLength(1);
        expect(built.rows[0]).toMatchObject({
            lifecycleStatus: 'attention',
            shopify: { available: 0 },
            audit: { attentionReasons: ['shopify_inventory_not_positive'] },
        });
        expect(built.coverage.join.zeroStockActiveShopifyCount).toBe(1);
    });
    it('adds unmatched and SKU-less active eBay listings to the union as attention', () => {
        const built = snapshot({
            variants: [variant()],
            active: [active('200', 'EBAY-ONLY'), active('201', '')],
        });
        expect(built.rows).toHaveLength(3);
        expect(built.rows.filter((row) => row.shopify === null)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'ebay-listing:200:sku:EBAY-ONLY',
                audit: expect.objectContaining({
                    attentionReasons: ['ebay_active_without_shopify_variant'],
                }),
            }),
            expect.objectContaining({
                id: 'ebay-listing:201:sku:(missing)',
                audit: expect.objectContaining({ attentionReasons: ['ebay_active_without_sku'] }),
            }),
        ]));
        expect(built.coverage.join).toMatchObject({
            unmatchedEbaySkuCount: 1,
            unmatchedEbayListingCount: 2,
        });
    });
    it('never treats missing Shopify and eBay SKUs as a mapping', () => {
        const built = snapshot({
            variants: [variant({ sku: '' })],
            active: [active('201', '')],
        });
        const shopifyRow = built.rows.find((row) => row.shopify !== null);
        const ebayRow = built.rows.find((row) => row.shopify === null);
        expect(shopifyRow).toMatchObject({
            lifecycleStatus: 'attention',
            ebay: { activeMatchCount: 0, listingId: null },
        });
        expect(ebayRow).toMatchObject({
            id: 'ebay-listing:201:sku:(missing)',
            lifecycleStatus: 'attention',
        });
    });
    it('uses a unique stable row ID for each unmatched SKU in one variation listing', () => {
        const built = snapshot({
            active: [active('202', 'EBAY-A'), active('202', 'EBAY-B')],
        });
        const ebayOnly = built.rows.filter((row) => row.shopify === null);
        expect(ebayOnly.map((row) => row.id)).toEqual([
            'ebay-listing:202:sku:EBAY-A',
            'ebay-listing:202:sku:EBAY-B',
        ]);
        expect(new Set(built.rows.map((row) => row.id)).size).toBe(built.rows.length);
        expect(built.coverage.join).toMatchObject({
            unmatchedEbaySkuCount: 2,
            unmatchedEbayListingCount: 1,
        });
    });
    it('returns full summary independent of page/filter and supports exact row IDs', () => {
        const built = snapshot({ variants: [
                variant(),
                variant({ variantId: 'gid://shopify/ProductVariant/2', sku: 'SECOND' }),
            ] });
        const page = projectLiveListingCatalogPage(built, {
            limit: 1,
            offset: 0,
            status: 'not_listed',
            id: 'shopify-variant:gid://shopify/ProductVariant/2',
            nowEpochMs: Date.parse(observedAtUtc),
        });
        expect(page).toMatchObject({
            schemaVersion: 3,
            total: 1,
            summary: { notListed: 2, totalInStock: 2, totalVisible: 2, unknown: 0 },
            authoritative: true,
            evidenceKind: 'live_read',
            remoteReadPerformed: true,
            externalWritesPerformed: 0,
        });
    });
    it('downgrades every stale row to unknown and never presents stale active or not-listed truth', () => {
        const built = snapshot({ active: [active()] });
        const page = projectLiveListingCatalogPage(built, {
            limit: 100,
            offset: 0,
            nowEpochMs: Date.parse(observedAtUtc) + 300_001,
            maxAgeMs: 300_000,
        });
        expect(page).toMatchObject({
            authoritative: false,
            freshness: { state: 'stale', ageMs: 300_001, maxAgeMs: 300_000 },
            summary: { active: 0, notListed: 0, attention: 0, unknown: 1 },
        });
        expect(page.data[0]).toMatchObject({
            lifecycleStatus: 'unknown',
            ebay: { state: 'unknown' },
            audit: {
                verified: false,
                evidenceState: 'stale',
                currentRemoteStateVerified: false,
                attentionReasons: ['source_snapshot_stale'],
            },
        });
    });
    it('immediately downgrades rows to unknown after a known refresh failure', () => {
        const built = snapshot({ active: [active()] });
        const page = projectLiveListingCatalogPage(built, {
            limit: 100,
            offset: 0,
            nowEpochMs: Date.parse(observedAtUtc) + 1_000,
            refreshFailed: true,
        });
        expect(page).toMatchObject({
            authoritative: false,
            freshness: { state: 'refresh_failed', ageMs: 1_000 },
            summary: { active: 0, notListed: 0, attention: 0, unknown: 1 },
            data: [{
                    lifecycleStatus: 'unknown',
                    audit: { attentionReasons: ['source_refresh_failed'] },
                }],
        });
    });
});
describe('live catalog caching boundaries', () => {
    it('single-flights captures, reuses within TTL, and recaptures only after expiry', async () => {
        let now = 0;
        let captures = 0;
        const built = snapshot();
        const cache = createLiveListingCatalogCache(async () => {
            captures += 1;
            await Promise.resolve();
            return built;
        }, { now: () => now, ttlMs: 60_000 });
        const [first, second] = await Promise.all([cache(), cache()]);
        expect(first).toBe(second);
        expect(captures).toBe(1);
        await cache();
        expect(captures).toBe(1);
        now = 60_001;
        await cache();
        expect(captures).toBe(2);
    });
    it('never caches failed captures', async () => {
        let attempts = 0;
        const cache = createLiveListingCatalogCache(async () => {
            attempts += 1;
            if (attempts === 1)
                throw new Error('unavailable');
            return snapshot();
        });
        await expect(cache()).rejects.toThrow('unavailable');
        await expect(cache()).resolves.toBeDefined();
        expect(attempts).toBe(2);
    });
    it('retains the last successful snapshot after an explicit refresh failure', async () => {
        let attempts = 0;
        const built = snapshot();
        const cache = createLiveListingCatalogCache(async () => {
            attempts += 1;
            if (attempts === 1)
                return built;
            throw new Error('refresh unavailable');
        });
        await expect(cache()).resolves.toBe(built);
        expect(cache.status()).toMatchObject({
            hasSuccessfulSnapshot: true,
            observedAtUtc,
            refreshInFlight: false,
        });
        await expect(cache.refresh()).rejects.toThrow('refresh unavailable');
        expect(cache.status()).toMatchObject({
            hasSuccessfulSnapshot: true,
            observedAtUtc,
            refreshInFlight: false,
        });
        expect(hasUnresolvedLiveListingRefreshFailure(cache.status())).toBe(true);
    });
    it('returns the last successful snapshot when an expired-cache refresh fails', async () => {
        let now = 0;
        let attempts = 0;
        const built = snapshot();
        const cache = createLiveListingCatalogCache(async () => {
            attempts += 1;
            if (attempts === 1)
                return built;
            throw new Error('refresh unavailable');
        }, { now: () => now, ttlMs: 60_000 });
        await expect(cache()).resolves.toBe(built);
        now = 60_001;
        await expect(cache()).resolves.toBe(built);
        expect(attempts).toBe(2);
    });
    it('clears the unresolved refresh-failure state only after a complete success', async () => {
        let attempts = 0;
        const built = snapshot();
        const cache = createLiveListingCatalogCache(async () => {
            attempts += 1;
            if (attempts === 2)
                throw new Error('refresh unavailable');
            return built;
        });
        await cache.refresh();
        await expect(cache.refresh()).rejects.toThrow('refresh unavailable');
        expect(hasUnresolvedLiveListingRefreshFailure(cache.status())).toBe(true);
        await cache.refresh();
        expect(hasUnresolvedLiveListingRefreshFailure(cache.status())).toBe(false);
    });
    it('single-flights transient token refresh and never returns auth material except access authority', async () => {
        let now = 0;
        let refreshes = 0;
        const auth = {
            shopifyAccessToken: 'shop-secret',
            ebayRefreshToken: 'refresh-secret',
            ebayAppId: 'app-secret',
            ebayCertId: 'cert-secret',
        };
        const provider = createTransientEbayTokenProvider({
            loadAuth: async () => auth,
            exchange: async () => {
                refreshes += 1;
                await Promise.resolve();
                return { accessToken: 'transient-access', expiresIn: 7_200 };
            },
            now: () => now,
        });
        await expect(Promise.all([provider(), provider()])).resolves.toEqual([
            'transient-access', 'transient-access',
        ]);
        expect(refreshes).toBe(1);
        now = 7_200_000 - 299_000;
        await provider();
        expect(refreshes).toBe(2);
    });
});
describe('strict live source parsers', () => {
    const originalFetch = globalThis.fetch;
    const jsonResponse = (body) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
    const xmlResponse = (body) => new Response(body, { status: 200 });
    const shopifyPreflight = {
        data: {
            shop: {
                id: 'gid://shopify/Shop/86254518563',
                myshopifyDomain: 'usedcameragear.myshopify.com',
                currencyCode: 'USD',
            },
            currentAppInstallation: {
                accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }],
            },
        },
    };
    const shopifyNode = (id, sku, inventoryQuantity = 1) => ({
        id: `gid://shopify/ProductVariant/${id}`,
        sku,
        title: 'Default',
        price: '1.00',
        inventoryQuantity,
        updatedAt: observedAtUtc,
        image: null,
        product: {
            id: `gid://shopify/Product/${id}`,
            title: `Product ${id}`,
            status: 'ACTIVE',
            updatedAt: observedAtUtc,
            mediaCount: { count: 0 },
            featuredMedia: null,
        },
    });
    it('logs only a fixed allowlisted phase code and keeps upstream details redacted', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.catalogPhase('SHOPIFY_CAPTURE_FAILED', async () => { throw new Error('Bearer secret-value at /private/url'); })).rejects.toThrow('Live listing catalog is unavailable');
            const output = log.mock.calls.flat().join(' ');
            expect(output).toContain('LISTING_CATALOG_SHOPIFY_CAPTURE_FAILED');
            expect(output).not.toMatch(/secret-value|private\/url|Bearer/i);
            expect(LISTING_CATALOG_FAILURE_CODES).toEqual([
                'AUTH_READ_FAILED',
                'TOKEN_REFRESH_FAILED',
                'SHOPIFY_CAPTURE_FAILED',
                'TRADING_CAPTURE_FAILED',
                'INVENTORY_CAPTURE_FAILED',
                'PROJECTION_FAILED',
            ]);
        }
        finally {
            log.mockRestore();
        }
    });
    it('captures complete multi-page Shopify variants including nonpositive inventory', async () => {
        globalThis.fetch = (async (_url, init) => {
            const request = JSON.parse(String(init?.body));
            if (request.operationName === 'RuntimeListingCatalogPreflight') {
                return jsonResponse(shopifyPreflight);
            }
            const after = request.variables?.after ?? null;
            return jsonResponse({ data: { productVariants: after === null ? {
                        nodes: [shopifyNode(1, 'FIRST')],
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                    } : {
                        nodes: [shopifyNode(2, 'NEGATIVE', -1), shopifyNode(3, 'SECOND')],
                        pageInfo: { hasNextPage: false, endCursor: null },
                    } } });
        });
        try {
            const result = await LIVE_LISTING_CATALOG_SOURCE_TESTING.captureShopify('authority');
            expect(result.variants.map((entry) => entry.sku)).toEqual(['FIRST', 'NEGATIVE', 'SECOND']);
            expect(result.coverage).toMatchObject({
                variantPageCount: 2,
                totalVariantsCaptured: 3,
                positiveStockVariants: 2,
                excludedZeroInventory: 1,
                excludedUnknownInventory: 0,
            });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('fails Shopify capture on duplicate pagination identity, overlong SKU, and page-cap exhaustion', async () => {
        const run = async (mode) => {
            let variantPage = 0;
            globalThis.fetch = (async (_url, init) => {
                const request = JSON.parse(String(init?.body));
                if (request.operationName === 'RuntimeListingCatalogPreflight') {
                    return jsonResponse(shopifyPreflight);
                }
                variantPage += 1;
                if (mode === 'overlong-sku') {
                    return jsonResponse({ data: { productVariants: {
                                nodes: [shopifyNode(1, 'X'.repeat(129))],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            } } });
                }
                if (mode === 'duplicate-id') {
                    return jsonResponse({ data: { productVariants: {
                                nodes: [shopifyNode(1, `PAGE-${variantPage}`)],
                                pageInfo: variantPage === 1
                                    ? { hasNextPage: true, endCursor: 'cursor-1' }
                                    : { hasNextPage: false, endCursor: null },
                            } } });
                }
                return jsonResponse({ data: { productVariants: {
                            nodes: [shopifyNode(variantPage, `PAGE-${variantPage}`)],
                            pageInfo: { hasNextPage: true, endCursor: `cursor-${variantPage}` },
                        } } });
            });
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.captureShopify('authority'))
                .rejects.toThrow('Live listing catalog is unavailable');
        };
        try {
            await run('duplicate-id');
            await run('overlong-sku');
            await run('page-cap');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('retains negative Shopify inventory and reports it as nonpositive', async () => {
        let call = 0;
        globalThis.fetch = (async () => {
            call += 1;
            const body = call === 1
                ? { data: {
                        shop: { id: 'gid://shopify/Shop/86254518563', myshopifyDomain: 'usedcameragear.myshopify.com', currencyCode: 'USD' },
                        currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }] },
                    } }
                : { data: { productVariants: {
                            nodes: [{
                                    id: 'gid://shopify/ProductVariant/1', sku: 'NEGATIVE', title: 'Default',
                                    price: '1.00', inventoryQuantity: -2, updatedAt: observedAtUtc, image: null,
                                    product: { id: 'gid://shopify/Product/1', title: 'Negative', status: 'ACTIVE', updatedAt: observedAtUtc, mediaCount: { count: 0 }, featuredMedia: null },
                                }],
                            pageInfo: { hasNextPage: false, endCursor: null },
                        } } };
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        try {
            const result = await LIVE_LISTING_CATALOG_SOURCE_TESTING.captureShopify('authority');
            expect(result.variants).toEqual([expect.objectContaining({ sku: 'NEGATIVE', available: -2 })]);
            expect(result.coverage).toMatchObject({ totalVariantsCaptured: 1, excludedZeroInventory: 1 });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it.each([
        ['Warning', undefined],
        ['Failure', undefined],
        ['Success', { ShortMessage: 'partial' }],
    ])('rejects Trading Ack=%s and any Errors element', async (ack, errors) => {
        globalThis.fetch = (async () => new Response(`<?xml version="1.0"?><GetUserResponse><Ack>${ack}</Ack>${errors ? '<Errors><ShortMessage>partial</ShortMessage></Errors>' : ''}</GetUserResponse>`, { status: 200 }));
        try {
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.tradingCall('authority', 'GetUser', '<GetUserRequest/>')).rejects.toThrow('Live listing catalog is unavailable');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it.each(['usedcam-0', 'other-seller'])('rejects wrong or stale Trading seller identity %s', async (sellerId) => {
        globalThis.fetch = (async () => new Response(`<?xml version="1.0"?><GetUserResponse><Ack>Success</Ack><User><UserID>${sellerId}</UserID></User></GetUserResponse>`, { status: 200 }));
        try {
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.captureTrading('authority'))
                .rejects.toThrow('Live listing catalog is unavailable');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('captures a complete multi-page Trading active-listing census', async () => {
        globalThis.fetch = (async (_url, init) => {
            const headers = init?.headers;
            if (headers['X-EBAY-API-CALL-NAME'] === 'GetUser') {
                return xmlResponse('<?xml version="1.0"?><GetUserResponse><Ack>Success</Ack><User><UserID>usedcameragear</UserID></User></GetUserResponse>');
            }
            const page = Number(String(init?.body).match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1]);
            const listingId = page === 1 ? '100' : '101';
            const sku = page === 1 ? 'FIRST' : 'SECOND';
            return xmlResponse(`<?xml version="1.0"?><GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray><Item><ItemID>${listingId}</ItemID><SKU>${sku}</SKU></Item></ItemArray><PaginationResult><TotalNumberOfPages>2</TotalNumberOfPages><TotalNumberOfEntries>2</TotalNumberOfEntries></PaginationResult></ActiveList></GetMyeBaySellingResponse>`);
        });
        try {
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.captureTrading('authority'))
                .resolves.toEqual({
                listings: [{ listingId: '100', sku: 'FIRST' }, { listingId: '101', sku: 'SECOND' }],
                pageCount: 2,
                activeListingCount: 2,
            });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('rejects repeated Trading listing IDs and inconsistent pagination totals', async () => {
        for (const mode of ['duplicate', 'drift']) {
            globalThis.fetch = (async (_url, init) => {
                const headers = init?.headers;
                if (headers['X-EBAY-API-CALL-NAME'] === 'GetUser') {
                    return xmlResponse('<?xml version="1.0"?><GetUserResponse><Ack>Success</Ack><User><UserID>usedcameragear</UserID></User></GetUserResponse>');
                }
                const page = Number(String(init?.body).match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1]);
                const totalEntries = mode === 'drift' && page === 2 ? 3 : 2;
                const listingId = mode === 'duplicate' ? '100' : String(99 + page);
                return xmlResponse(`<?xml version="1.0"?><GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray><Item><ItemID>${listingId}</ItemID><SKU>SKU-${page}</SKU></Item></ItemArray><PaginationResult><TotalNumberOfPages>2</TotalNumberOfPages><TotalNumberOfEntries>${totalEntries}</TotalNumberOfEntries></PaginationResult></ActiveList></GetMyeBaySellingResponse>`);
            });
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.captureTrading('authority'))
                .rejects.toThrow('Live listing catalog is unavailable');
        }
        globalThis.fetch = originalFetch;
    });
    it('captures complete Inventory items and per-SKU Offers across pages', async () => {
        globalThis.fetch = (async (rawUrl) => {
            const url = new URL(String(rawUrl));
            const offset = Number(url.searchParams.get('offset'));
            if (url.pathname.endsWith('/inventory_item')) {
                return jsonResponse(offset === 0 ? {
                    total: 2,
                    inventoryItems: [{ sku: 'FIRST' }],
                    next: 'https://api.ebay.com/sell/inventory/v1/inventory_item?limit=200&offset=1',
                } : { total: 2, inventoryItems: [{ sku: 'SECOND' }] });
            }
            const sku = url.searchParams.get('sku');
            if (sku === 'SECOND')
                return jsonResponse({ total: 0, offers: [] });
            return jsonResponse(offset === 0 ? {
                total: 2,
                offers: [{
                        offerId: 'OFFER-1', sku: 'FIRST', marketplaceId: 'EBAY_US', status: 'PUBLISHED',
                        listing: { listingId: '100', listingStatus: 'ACTIVE' },
                    }],
                next: 'https://api.ebay.com/sell/inventory/v1/offer?sku=FIRST&marketplace_id=EBAY_US&limit=25&offset=1',
            } : {
                total: 2,
                offers: [{
                        offerId: 'OFFER-2', sku: 'FIRST', marketplaceId: 'EBAY_US', status: 'UNPUBLISHED',
                    }],
            });
        });
        try {
            const result = await LIVE_LISTING_CATALOG_SOURCE_TESTING.captureInventory('authority');
            expect(result).toMatchObject({ itemPages: 2, offerPages: 3 });
            expect(result.items).toEqual([{ sku: 'FIRST' }, { sku: 'SECOND' }]);
            expect(result.offers.map((entry) => entry.offerId)).toEqual(['OFFER-1', 'OFFER-2']);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it.each([
        ['partial-items', 'EBAY_US', 'OFFER-1'],
        ['wrong-marketplace', 'EBAY_GB', 'OFFER-1'],
        ['duplicate-offer', 'EBAY_US', 'OFFER-1'],
        ['wrong-next', 'EBAY_US', 'OFFER-1'],
    ])('rejects incomplete or ambiguous Inventory coverage: %s', async (mode, marketplace, offerId) => {
        globalThis.fetch = (async (rawUrl) => {
            const url = new URL(String(rawUrl));
            const offset = Number(url.searchParams.get('offset'));
            if (url.pathname.endsWith('/inventory_item')) {
                if (mode === 'partial-items')
                    return jsonResponse({ total: 2, inventoryItems: [{ sku: 'FIRST' }] });
                return jsonResponse({ total: 1, inventoryItems: [{ sku: 'FIRST' }] });
            }
            if (mode === 'wrong-next' && offset === 0) {
                return jsonResponse({
                    total: 2,
                    offers: [{ offerId, sku: 'FIRST', marketplaceId: marketplace }],
                    next: 'https://api.ebay.com/sell/inventory/v1/offer?sku=OTHER&marketplace_id=EBAY_US&limit=25&offset=1',
                });
            }
            const id = mode === 'duplicate-offer' ? offerId : `OFFER-${offset + 1}`;
            const body = {
                total: mode === 'duplicate-offer' ? 2 : 1,
                offers: [{ offerId: id, sku: 'FIRST', marketplaceId: marketplace }],
                ...(mode === 'duplicate-offer' && offset === 0 ? {
                    next: 'https://api.ebay.com/sell/inventory/v1/offer?sku=FIRST&marketplace_id=EBAY_US&limit=25&offset=1',
                } : {}),
            };
            return jsonResponse(body);
        });
        try {
            await expect(LIVE_LISTING_CATALOG_SOURCE_TESTING.captureInventory('authority'))
                .rejects.toThrow('Live listing catalog is unavailable');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('requests exactly base and sell.inventory and validates the eBay token envelope', async () => {
        let capturedBody = '';
        const auth = {
            shopifyAccessToken: 'shop-authority',
            ebayRefreshToken: 'refresh-authority',
            ebayAppId: 'app-id',
            ebayCertId: 'cert-id',
        };
        const fetchImpl = (async (_url, init) => {
            capturedBody = String(init?.body ?? '');
            return new Response(JSON.stringify({
                access_token: 'transient',
                expires_in: 7200,
                token_type: 'User Access Token',
            }), { status: 200 });
        });
        await expect(exchangeRuntimeEbayToken(auth, fetchImpl)).resolves.toEqual({
            accessToken: 'transient', expiresIn: 7200,
        });
        const parsed = new URLSearchParams(capturedBody);
        expect(parsed.get('scope')?.split(' ')).toEqual([
            'https://api.ebay.com/oauth/api_scope',
            'https://api.ebay.com/oauth/api_scope/sell.inventory',
        ]);
        expect(parsed.get('grant_type')).toBe('refresh_token');
        const wrongType = (async () => new Response(JSON.stringify({
            access_token: 'transient', expires_in: 7200, token_type: 'Bearer',
        }), { status: 200 }));
        await expect(exchangeRuntimeEbayToken(auth, wrongType)).rejects.toThrow('Live listing catalog is unavailable');
    });
});
