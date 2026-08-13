import { describe, expect, it, vi } from 'vitest';
import { createListingWorkspaceReader, ListingWorkspaceReaderError, } from './listing-workspace-reader.js';
const now = Date.parse('2026-08-13T22:00:00.000Z');
const observedAtUtc = '2026-08-13T21:59:00.000Z';
const productId = 'gid://shopify/Product/10310708035875';
const variantId = 'gid://shopify/ProductVariant/55396000563491';
const sku = 'CAN3570-U119';
const listingId = '147502608418';
const offerId = '234942877011';
const rowId = `shopify-variant:${variantId}`;
function row(overrides = {}) {
    return {
        id: rowId,
        shopify: {
            productId,
            variantId,
            sku,
            title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
            variantTitle: 'Default Title',
            productStatus: 'ACTIVE',
            primaryImageUrl: null,
            imageCount: 6,
            available: 1,
            price: { amount: '39.95', currency: 'USD' },
        },
        ebay: {
            sku,
            state: 'active',
            listingId,
            offerId,
            url: `https://www.ebay.com/itm/${listingId}`,
            activeMatchCount: 1,
            inventoryItemCount: 1,
            offerCount: 1,
            unpublishedArtifactCount: 0,
        },
        lifecycleStatus: 'active',
        lastVerifiedAtUtc: observedAtUtc,
        audit: {
            verified: true,
            evidenceState: 'live_verified',
            unresolvedCount: 0,
            attentionReasons: [],
            recoverySupported: false,
            currentRemoteStateVerified: true,
        },
        ...overrides,
    };
}
function snapshot(rows = [row()]) {
    return {
        observedAtUtc,
        rows,
        summary: {
            active: rows.filter((entry) => entry.lifecycleStatus === 'active').length,
            notListed: rows.filter((entry) => entry.lifecycleStatus === 'not_listed').length,
            attention: rows.filter((entry) => entry.lifecycleStatus === 'attention').length,
            unknown: rows.filter((entry) => entry.lifecycleStatus === 'unknown').length,
            totalInStock: rows.filter((entry) => (entry.shopify?.available ?? 0) > 0).length,
            totalVisible: rows.length,
        },
        coverage: {
            shopify: {
                source: 'shopify-admin-graphql',
                storeDomain: 'usedcameragear.myshopify.com',
                shopId: 'gid://shopify/Shop/86254518563',
                observedAtUtc,
                paginationComplete: true,
                variantPageCount: 1,
                totalVariantsCaptured: rows.filter((entry) => entry.shopify !== null).length,
                positiveStockVariants: rows.filter((entry) => (entry.shopify?.available ?? 0) > 0).length,
                excludedZeroInventory: 0,
                excludedUnknownInventory: 0,
                productStatusCounts: { ACTIVE: 1 },
            },
            ebay: {
                source: 'ebay-trading-api+ebay-inventory-api',
                marketplaceId: 'EBAY_US',
                sellerAccountVerified: true,
                observedAtUtc,
                trading: { paginationComplete: true, pageCount: 1, activeListingCount: 1 },
                inventory: {
                    inventoryItemsComplete: true,
                    inventoryItemPageCount: 1,
                    inventoryItemCount: 1,
                    offersComplete: true,
                    offerPageCount: 1,
                    offerCount: 1,
                    unpublishedArtifactsChecked: true,
                },
            },
            join: {
                key: 'exact_raw_sku',
                missingShopifySkuCount: 0,
                duplicateShopifySkuCount: 0,
                shopifyNearCollisionCount: 0,
                ebayNearCollisionCount: 0,
                ambiguousActiveMatchCount: 0,
                unpublishedArtifactSkuCount: 0,
                zeroStockActiveShopifyCount: 0,
                unmatchedEbaySkuCount: 0,
                unmatchedEbayListingCount: 0,
            },
        },
    };
}
function detail(input) {
    return {
        schemaVersion: 1,
        evidence: {
            source: input.management.model === 'inventory_offer'
                ? 'ebay-trading-get-item+ebay-inventory-detail'
                : 'ebay-trading-get-item',
            observedAtUtc: '2026-08-13T22:00:01.000Z',
            complete: true,
            remoteReadPerformed: true,
            externalWritesPerformed: 0,
            requestCount: input.management.model === 'inventory_offer' ? 4 : 2,
        },
        identity: {
            sellerId: 'usedcameragear',
            marketplaceId: 'EBAY_US',
            mappingState: input.mappingState,
            shopifyProductId: input.shopifyProductId,
            shopifyVariantId: input.shopifyVariantId,
            sku: input.sku,
            listingId: input.listingId,
            publicListingUrl: `https://www.ebay.com/itm/${input.listingId}`,
            offerId: input.management.model === 'inventory_offer' ? input.management.offerId : null,
        },
        actual: {
            lifecycle: {
                status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
                startAtUtc: null, endAtUtc: null,
            },
            content: { title: 'Canon 35-70mm', descriptionHtml: null, imageUrls: [] },
            category: { primary: { id: '3323', name: 'Camera Lenses' }, secondary: null, storeCategories: [] },
            condition: { id: '3000', name: 'Used', description: null, descriptors: [] },
            aspects: { Brand: ['Canon'] },
            identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
            commerce: {
                price: { value: '39.95', currency: 'USD' }, totalQuantity: 1, soldQuantity: 0,
                availableQuantity: 1, availableQuantityBasis: 'reported', bestOfferEnabled: null,
            },
            policies: {
                fulfillmentPolicyId: null, paymentPolicyId: null, returnPolicyId: null,
                paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
                returnsAccepted: null, returnPeriod: null, returnShippingCostPayer: null,
            },
            location: { publicLocation: 'Draper, Utah', countryCode: 'US' },
        },
        management: {
            model: input.management.model,
            controlApi: input.management.model === 'inventory_offer' ? 'inventory' : 'trading',
            joinKey: 'exact_raw_sku',
            exactBindings: {
                seller: true, listing: true, sku: true,
                inventoryItem: input.management.model === 'inventory_offer',
                offer: input.management.model === 'inventory_offer',
                offerToListing: input.management.model === 'inventory_offer',
            },
            lifecycleAligned: true,
            inventoryItem: null,
            offer: null,
        },
    };
}
function dependencies(source = snapshot()) {
    const getEbayAccessToken = vi.fn(async () => 'secret-transient-token');
    const readEbayDetail = vi.fn(async (input) => detail(input));
    return {
        dependencies: {
            getSnapshot: async () => source,
            getEbayAccessToken,
            readEbayDetail,
            now: () => now,
        },
        getEbayAccessToken,
        readEbayDetail,
    };
}
describe('read-only listing workspace reader', () => {
    it('returns a mapped Inventory workspace with exact bindings and no credential material', async () => {
        const harness = dependencies();
        const result = await createListingWorkspaceReader(harness.dependencies)(rowId);
        expect(result).toMatchObject({
            schemaVersion: 1,
            evidence: {
                catalogObservedAtUtc: observedAtUtc,
                detailObservedAtUtc: '2026-08-13T22:00:01.000Z',
                freshness: 'live',
                backgroundRefreshSeconds: 60,
                remoteReadPerformed: true,
                externalWritesPerformed: 0,
            },
            catalog: { id: rowId },
            mapping: {
                state: 'mapped', joinKey: 'exact_raw_sku',
                shopifyProductId: productId, shopifyVariantId: variantId,
                inventorySku: sku, offerId, listingId, managementModel: 'inventory_offer',
                ownership: {
                    listing: 'unverified', mapping: 'unverified',
                    price: 'marketplace_connect', inventory: 'marketplace_connect',
                },
                editMode: 'read_only',
            },
            ebayDetail: { identity: { sku, listingId, offerId } },
        });
        expect(harness.readEbayDetail).toHaveBeenCalledWith(expect.objectContaining({
            accessToken: 'secret-transient-token',
            sellerId: 'usedcameragear',
            marketplaceId: 'EBAY_US',
            mappingState: 'mapped',
            shopifyProductId: productId,
            shopifyVariantId: variantId,
            sku,
            listingId,
            management: { model: 'inventory_offer', offerId },
        }));
        expect(JSON.stringify(result)).not.toMatch(/secret-transient-token|accessToken|authorization/i);
    });
    it('returns Shopify-only state without requesting eBay authority', async () => {
        const shopifyOnly = row({
            ebay: {
                sku,
                state: 'not_listed',
                listingId: null,
                offerId: null,
                url: null,
                activeMatchCount: 0,
                inventoryItemCount: 0,
                offerCount: 0,
                unpublishedArtifactCount: 0,
            },
            lifecycleStatus: 'not_listed',
        });
        const harness = dependencies(snapshot([shopifyOnly]));
        const result = await createListingWorkspaceReader(harness.dependencies)(rowId);
        expect(result.mapping).toMatchObject({
            state: 'shopify_only', managementModel: 'none', listingId: null, offerId: null,
            inventorySku: null,
        });
        expect(result.ebayDetail).toBeNull();
        expect(result.evidence.remoteReadPerformed).toBe(false);
        expect(harness.getEbayAccessToken).not.toHaveBeenCalled();
        expect(harness.readEbayDetail).not.toHaveBeenCalled();
    });
    it('reads an eBay-only legacy listing with null Shopify identity', async () => {
        const ebayOnlyId = `ebay-listing:${listingId}:sku:${encodeURIComponent(sku)}`;
        const ebayOnly = row({
            id: ebayOnlyId,
            shopify: null,
            ebay: { ...row().ebay, offerId: null, inventoryItemCount: 0, offerCount: 0 },
            lifecycleStatus: 'attention',
            audit: {
                ...row().audit,
                unresolvedCount: 1,
                attentionReasons: ['ebay_active_without_shopify_variant'],
            },
        });
        const harness = dependencies(snapshot([ebayOnly]));
        const result = await createListingWorkspaceReader(harness.dependencies)(ebayOnlyId);
        expect(result.mapping).toMatchObject({
            state: 'ebay_only_unmapped', shopifyProductId: null, shopifyVariantId: null,
            inventorySku: sku, managementModel: 'legacy_trading', listingId,
        });
        expect(harness.readEbayDetail).toHaveBeenCalledWith(expect.objectContaining({
            mappingState: 'ebay_only_unmapped',
            shopifyProductId: null,
            shopifyVariantId: null,
            management: { model: 'legacy_trading' },
        }));
    });
    it('does not call eBay detail when a listing lacks a nonblank exact raw SKU', async () => {
        const blankSkuRow = row({
            ebay: { ...row().ebay, sku: '   ', offerId: null, inventoryItemCount: 0, offerCount: 0 },
            lifecycleStatus: 'attention',
            audit: { ...row().audit, unresolvedCount: 1, attentionReasons: ['ebay_sku_near_collision'] },
        });
        const harness = dependencies(snapshot([blankSkuRow]));
        const result = await createListingWorkspaceReader(harness.dependencies)(rowId);
        expect(result.mapping).toMatchObject({
            state: 'attention', inventorySku: null, managementModel: 'none',
        });
        expect(result.ebayDetail).toBeNull();
        expect(result.evidence.remoteReadPerformed).toBe(false);
        expect(harness.getEbayAccessToken).not.toHaveBeenCalled();
    });
    it.each([
        ['', 'not_found'],
        [`${rowId} `, 'not_found'],
        ['missing-row', 'not_found'],
    ])('rejects an absent or inexact row ID %j as %s', async (requested, kind) => {
        const harness = dependencies();
        await expect(createListingWorkspaceReader(harness.dependencies)(requested))
            .rejects.toMatchObject({ name: 'ListingWorkspaceReaderError', kind });
        expect(harness.getEbayAccessToken).not.toHaveBeenCalled();
    });
    it.each([
        ['duplicate row identity', snapshot([row(), row()])],
        ['stale snapshot', { ...snapshot(), observedAtUtc: '2026-08-13T21:54:59.999Z' }],
        ['future snapshot', { ...snapshot(), observedAtUtc: '2026-08-13T22:00:00.001Z' }],
        ['unverified row', snapshot([row({ audit: { ...row().audit, verified: false } })])],
    ])('fails unavailable for %s before requesting a token', async (_name, source) => {
        const harness = dependencies(source);
        await expect(createListingWorkspaceReader(harness.dependencies)(rowId))
            .rejects.toMatchObject({ kind: 'unavailable' });
        expect(harness.getEbayAccessToken).not.toHaveBeenCalled();
    });
    it('fails before requesting a token when the newest background refresh failed', async () => {
        const harness = dependencies();
        const reader = createListingWorkspaceReader({
            ...harness.dependencies,
            getSnapshotStatus: () => ({
                hasSuccessfulSnapshot: true,
                observedAtUtc,
                lastSuccessAtEpochMs: now - 10_000,
                lastAttemptAtEpochMs: now - 1_000,
                lastFailureAtEpochMs: now - 1_000,
                expiresAtEpochMs: now + 50_000,
                refreshInFlight: false,
            }),
        });
        await expect(reader(rowId)).rejects.toMatchObject({ kind: 'unavailable' });
        expect(harness.getEbayAccessToken).not.toHaveBeenCalled();
        expect(harness.readEbayDetail).not.toHaveBeenCalled();
    });
    it('fails generically when token acquisition, detail read, or returned identity is wrong', async () => {
        const tokenFailure = dependencies();
        tokenFailure.getEbayAccessToken.mockRejectedValueOnce(new Error('Bearer secret upstream'));
        await expect(createListingWorkspaceReader(tokenFailure.dependencies)(rowId))
            .rejects.toEqual(new ListingWorkspaceReaderError('unavailable'));
        const mismatch = dependencies();
        mismatch.readEbayDetail.mockImplementationOnce(async (input) => ({
            ...detail(input),
            identity: { ...detail(input).identity, listingId: '999' },
        }));
        await expect(createListingWorkspaceReader(mismatch.dependencies)(rowId))
            .rejects.toMatchObject({ kind: 'unavailable', message: 'Listing workspace is unavailable' });
    });
});
