import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatListingPrice, formatListingQuantity, formatVerifiedAt, isHistoricalBackfillProtected, isLiveCatalogResponse, isMigrationPolicyAvailable, LISTING_FILTERS, listingActionLabel, listingAttentionText, listingFilterOptions, listingSkuLabel, listingStatusLabel, listingStatusTone, verifiedEbayListingUrl, verifiedListingImageUrl, verifiedShopifyProductUrl, } from './operator-ui';
import { isListingWorkspaceResponse } from './hooks/useListingWorkspace';
const listing = (overrides = {}) => ({
    id: 'shopify-variant:gid://shopify/ProductVariant/1',
    shopify: {
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/1',
        sku: 'CAN3570-U119',
        title: 'Canon 35-70mm',
        variantTitle: 'Default Title',
        productStatus: 'ACTIVE',
        primaryImageUrl: 'https://cdn.shopify.com/example.jpg',
        imageCount: 6,
        available: 1,
        price: { amount: '39.95', currency: 'USD' },
    },
    ebay: {
        sku: 'CAN3570-U119',
        state: 'active',
        listingId: '147502608418',
        offerId: null,
        url: 'https://www.ebay.com/itm/147502608418',
        activeMatchCount: 1,
        inventoryItemCount: 0,
        offerCount: 0,
        unpublishedArtifactCount: 0,
    },
    lifecycleStatus: 'active',
    lastVerifiedAtUtc: '2026-08-13T17:30:00.000Z',
    audit: {
        verified: true,
        evidenceState: 'live_verified',
        unresolvedCount: 0,
        attentionReasons: [],
        recoverySupported: false,
        currentRemoteStateVerified: true,
    },
    ...overrides,
});
const response = (overrides = {}) => ({
    schemaVersion: 3,
    data: [listing()],
    total: 1,
    limit: 25,
    offset: 0,
    source: 'shopify-admin-graphql+ebay-active-listings',
    evidenceKind: 'live_read',
    authoritative: true,
    remoteReadPerformed: true,
    externalWritesPerformed: 0,
    observedAtUtc: '2026-08-13T17:30:00.000Z',
    summary: { active: 1, notListed: 0, attention: 0, unknown: 0, totalInStock: 1, totalVisible: 1 },
    coverage: {
        shopify: {
            source: 'shopify-admin-graphql',
            storeDomain: 'usedcameragear.myshopify.com',
            shopId: 'gid://shopify/Shop/1',
            observedAtUtc: '2026-08-13T17:30:00.000Z',
            paginationComplete: true,
            variantPageCount: 1,
            totalVariantsCaptured: 1,
            positiveStockVariants: 1,
            excludedZeroInventory: 0,
            excludedUnknownInventory: 0,
            productStatusCounts: { ACTIVE: 1 },
        },
        ebay: {
            source: 'ebay-trading-api+ebay-inventory-api',
            marketplaceId: 'EBAY_US',
            sellerAccountVerified: true,
            observedAtUtc: '2026-08-13T17:30:00.000Z',
            trading: { paginationComplete: true, pageCount: 1, activeListingCount: 1 },
            inventory: {
                inventoryItemsComplete: true,
                inventoryItemPageCount: 1,
                inventoryItemCount: 0,
                offersComplete: true,
                offerPageCount: 1,
                offerCount: 0,
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
    freshness: { state: 'fresh', ageMs: 0, maxAgeMs: 300_000 },
    ...overrides,
});
describe('stocked listings operator UI', () => {
    it('uses one compact filter for all four operator states', () => {
        expect(LISTING_FILTERS).toEqual([
            { label: 'All', value: 'all' },
            { label: 'Needs attention', value: 'attention' },
            { label: 'Not listed', value: 'not_listed' },
            { label: 'Active', value: 'active' },
            { label: 'Unknown', value: 'unknown' },
        ]);
        expect(listingFilterOptions(response().summary)).toEqual([
            { label: 'All (1)', value: 'all' },
            { label: 'Needs attention (0)', value: 'attention' },
            { label: 'Not listed (0)', value: 'not_listed' },
            { label: 'Active (1)', value: 'active' },
            { label: 'Unknown (0)', value: 'unknown' },
        ]);
    });
    it('keeps truthful temporal labels and review-only actions', () => {
        expect(listingStatusLabel('active')).toBe('Active');
        expect(listingStatusLabel('not_listed')).toBe('Not listed');
        expect(listingStatusLabel('unknown')).toBe('Unknown');
        expect(listingStatusLabel('attention')).toBe('Needs attention');
        expect(listingActionLabel('active')).toBe('View');
        expect(listingActionLabel('not_listed')).toBe('Review');
        expect(listingActionLabel('attention')).toBe('Details');
        expect(listingStatusTone('attention')).toBe('critical');
        expect(verifiedEbayListingUrl('147502608418', 'https://www.ebay.com/itm/147502608418')).toBe('https://www.ebay.com/itm/147502608418');
        expect(verifiedEbayListingUrl('147502608418', 'https://evil.test/itm/147502608418')).toBeNull();
    });
    it('formats source price, inventory, SKU, and update time without inventing values', () => {
        expect(formatListingPrice(listing().shopify?.price ?? null)).toBe('$39.95');
        expect(listing().shopify?.available).toBe(1);
        expect(listingSkuLabel('')).toBe('Missing SKU');
        expect(formatVerifiedAt('not-a-date')).toBe('Update unavailable');
        expect(formatVerifiedAt('2026-08-13T17:30:00.000Z')).toMatch(/^Updated /);
        expect(formatListingQuantity(null)).toBe('—');
    });
    it('supports eBay-only rows and rejects stale-state lies', () => {
        const ebayOnly = listing({
            id: 'ebay-listing:147502608418:sku:CAN3570-U119',
            shopify: null,
            lifecycleStatus: 'attention',
            ebay: { ...listing().ebay, state: 'attention' },
            audit: {
                ...listing().audit,
                unresolvedCount: 1,
                attentionReasons: ['ebay_active_without_shopify_variant'],
            },
        });
        expect(isLiveCatalogResponse(response({
            data: [ebayOnly],
            summary: { active: 0, notListed: 0, attention: 1, unknown: 0, totalInStock: 1, totalVisible: 1 },
        }))).toBe(true);
        expect(isLiveCatalogResponse(response({
            authoritative: false,
            freshness: { state: 'stale', ageMs: 300_001, maxAgeMs: 300_000 },
        }))).toBe(false);
        const refreshFailedRow = listing({
            lifecycleStatus: 'unknown',
            ebay: { ...listing().ebay, state: 'unknown' },
            audit: {
                ...listing().audit,
                verified: false,
                evidenceState: 'stale',
                unresolvedCount: 1,
                attentionReasons: ['source_refresh_failed'],
                currentRemoteStateVerified: false,
            },
        });
        expect(isLiveCatalogResponse(response({
            authoritative: false,
            freshness: { state: 'refresh_failed', ageMs: 1_000, maxAgeMs: 300_000 },
            data: [refreshFailedRow],
            summary: {
                active: 0, notListed: 0, attention: 0, unknown: 1,
                totalInStock: 1, totalVisible: 1,
            },
        }))).toBe(true);
        expect(listingAttentionText(refreshFailedRow)).toBe('Current state unavailable');
    });
    it('shows the first authoritative reason for attention', () => {
        expect(listingAttentionText(listing())).toBeNull();
        expect(listingAttentionText(listing({
            lifecycleStatus: 'attention',
            ebay: { ...listing().ebay, state: 'attention', activeMatchCount: 2 },
            audit: {
                ...listing().audit,
                unresolvedCount: 1,
                attentionReasons: ['ebay_multiple_active_matches'],
            },
        }))).toBe('Multiple active matches');
        expect(listingAttentionText(listing({
            lifecycleStatus: 'attention',
            ebay: { ...listing().ebay, state: 'attention', unpublishedArtifactCount: 1 },
            audit: {
                ...listing().audit,
                unresolvedCount: 1,
                attentionReasons: ['ebay_unpublished_artifact'],
            },
        }))).toBe('eBay inventory needs review');
    });
    it('fails closed on malformed, incomplete, empty, or inconsistent catalog responses', () => {
        expect(isLiveCatalogResponse(response())).toBe(true);
        expect(isLiveCatalogResponse(response({ data: [], total: 0 }))).toBe(true);
        expect(isLiveCatalogResponse(response({
            data: [],
            total: 0,
            summary: { active: 0, notListed: 0, attention: 0, unknown: 0, totalInStock: 0, totalVisible: 0 },
            coverage: {
                ...response().coverage,
                shopify: { ...response().coverage.shopify, positiveStockVariants: 0 },
            },
        }))).toBe(true);
        expect(isLiveCatalogResponse(response({
            summary: { active: 1, notListed: 1, attention: 0, unknown: 0, totalInStock: 1, totalVisible: 1 },
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            coverage: {
                ...response().coverage,
                ebay: {
                    ...response().coverage.ebay,
                    inventory: {
                        ...response().coverage.ebay.inventory,
                        offersComplete: false,
                    },
                },
            },
        }))).toBe(false);
        const stockItem = listing().shopify;
        expect(stockItem).not.toBeNull();
        expect(isLiveCatalogResponse(response({
            data: [listing({ shopify: { ...stockItem, available: 0 } })],
            coverage: {
                ...response().coverage,
                shopify: { ...response().coverage.shopify, positiveStockVariants: 0 },
            },
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({ ebay: { ...listing().ebay, activeMatchCount: Number.NaN } })],
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({ ebay: { ...listing().ebay, unpublishedArtifactCount: 1 } })],
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({
                    ebay: {
                        ...listing().ebay,
                        inventoryItemCount: 1,
                        offerCount: 0,
                        offerId: null,
                    },
                })],
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({
                    ebay: {
                        ...listing().ebay,
                        inventoryItemCount: 99,
                        offerCount: 99,
                        offerId: 'offer-99',
                    },
                })],
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({
                    ebay: {
                        ...listing().ebay,
                        inventoryItemCount: 1,
                        offerCount: 1,
                        offerId: '234942877011',
                    },
                })],
        }))).toBe(true);
        expect(isLiveCatalogResponse(response({
            data: [listing(), listing()],
            total: 2,
            summary: { active: 2, notListed: 0, attention: 0, unknown: 0, totalInStock: 2, totalVisible: 2 },
            coverage: {
                ...response().coverage,
                shopify: { ...response().coverage.shopify, positiveStockVariants: 2 },
            },
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({
                    lifecycleStatus: 'attention',
                    ebay: { ...listing().ebay, state: 'attention' },
                    audit: {
                        ...listing().audit,
                        unresolvedCount: 1,
                        attentionReasons: ['unknown_reason'],
                    },
                })],
            summary: { active: 0, notListed: 0, attention: 1, unknown: 0, totalInStock: 1, totalVisible: 1 },
        }))).toBe(false);
        expect(isLiveCatalogResponse(response({
            data: [listing({
                    lifecycleStatus: 'not_listed',
                    ebay: {
                        ...listing().ebay,
                        state: 'not_listed',
                        listingId: null,
                        offerId: null,
                        url: null,
                        activeMatchCount: 0,
                        offerCount: 1,
                        unpublishedArtifactCount: 1,
                    },
                })],
            summary: { active: 0, notListed: 1, attention: 0, unknown: 0, totalInStock: 1, totalVisible: 1 },
        }))).toBe(false);
    });
    it('queries exact IDs, never carries stale filtered rows, and treats exact-ID misses as unavailable', () => {
        const hookSource = readFileSync(fileURLToPath(new URL('./hooks/useAuthoritativeListings.ts', import.meta.url)), 'utf8');
        expect(hookSource).toContain("searchParams.set('id', params.id)");
        expect(hookSource).not.toMatch(/keepPreviousData|placeholderData/);
        expect(hookSource).toContain('query.data && listing');
    });
    it('keeps desktop table and mobile card paths with no commerce mutation surface', () => {
        const listingsSource = readFileSync(fileURLToPath(new URL('./pages/Listings.tsx', import.meta.url)), 'utf8');
        expect(listingsSource).toContain('operator-listings-desktop');
        expect(listingsSource).toContain('operator-listings-mobile');
        expect(listingsSource).toContain("content: 'Review next'");
        expect(listingsSource).toContain('row.ebay.inventoryItemCount === 0');
        expect(listingsSource).toContain('row.ebay.offerCount === 0');
        expect(listingsSource).toContain('row.ebay.unpublishedArtifactCount === 0');
        expect(listingsSource).not.toMatch(/\buseMutation\b|\bpublish\b|\bPOST\b|\bonPublish\b/i);
        expect(listingsSource).not.toMatch(/>\s*Refresh\s*</);
    });
    it('renders compact unavailable states instead of empty success claims', () => {
        for (const page of ['Dashboard', 'Listings', 'ListingDetail', 'Issues', 'Settings']) {
            const pageSource = readFileSync(fileURLToPath(new URL(`./pages/${page}.tsx`, import.meta.url)), 'utf8');
            expect(pageSource).toMatch(/Unavailable|unavailable/);
        }
    });
    it('renders only verified HTTPS image hosts', () => {
        expect(verifiedListingImageUrl('https://cdn.shopify.com/example.jpg')).toBe('https://cdn.shopify.com/example.jpg');
        expect(verifiedListingImageUrl('http://cdn.shopify.com/example.jpg')).toBeNull();
        expect(verifiedListingImageUrl('https://cdn.shopify.com.evil.test/example.jpg')).toBeNull();
        expect(verifiedListingImageUrl(null)).toBeNull();
    });
    it('keeps migration safety badges fail closed', () => {
        expect(isMigrationPolicyAvailable({
            phase: 'marketplace-connect-incumbent',
            effectiveMode: 'shadow-read-only',
            historicalBackfillAllowed: false,
        })).toBe(true);
        expect(isMigrationPolicyAvailable({ historicalBackfillAllowed: false })).toBe(false);
        expect(isHistoricalBackfillProtected({ historicalBackfillAllowed: false })).toBe(true);
        expect(isHistoricalBackfillProtected(undefined)).toBe(false);
    });
    it('scopes migration safety copy to provider writes and local draft eligibility', () => {
        const source = readFileSync(fileURLToPath(new URL('./components/MigrationSafety.tsx', import.meta.url)), 'utf8');
        expect(source).toContain('Shopify and eBay writes remain blocked');
        expect(source).toContain('Local draft availability is shown on each listing.');
        expect(source).toContain('Provider writes');
        expect(source).not.toContain('ProductPipeline remains observation-only');
        expect(source).not.toContain('No write action is available');
    });
    it('validates the listing workspace identity and remains read only', () => {
        const catalog = listing();
        const workspace = {
            schemaVersion: 1,
            evidence: {
                catalogObservedAtUtc: '2026-08-13T17:30:00.000Z',
                detailObservedAtUtc: null,
                freshness: 'live',
                backgroundRefreshSeconds: 60,
                remoteReadPerformed: false,
                externalWritesPerformed: 0,
            },
            catalog: {
                ...catalog,
                lifecycleStatus: 'not_listed',
                ebay: {
                    ...catalog.ebay,
                    state: 'not_listed',
                    listingId: null,
                    offerId: null,
                    url: null,
                    activeMatchCount: 0,
                },
            },
            mapping: {
                state: 'shopify_only',
                joinKey: 'exact_raw_sku',
                shopifyProductId: catalog.shopify?.productId ?? null,
                shopifyVariantId: catalog.shopify?.variantId ?? null,
                inventorySku: catalog.shopify?.sku ?? null,
                offerId: null,
                listingId: null,
                managementModel: 'none',
                ownership: {
                    listing: 'unverified',
                    mapping: 'unverified',
                    price: 'marketplace_connect',
                    inventory: 'marketplace_connect',
                },
                editMode: 'read_only',
            },
            ebayDetail: null,
        };
        expect(isListingWorkspaceResponse(workspace, catalog.id)).toBe(true);
        expect(isListingWorkspaceResponse({
            ...workspace,
            mapping: { ...workspace.mapping, editMode: 'write' },
        }, catalog.id)).toBe(false);
        expect(verifiedShopifyProductUrl('gid://shopify/Product/123')).toBe('https://admin.shopify.com/store/usedcameragear/products/123');
        expect(verifiedShopifyProductUrl('gid://shopify/Order/123')).toBeNull();
    });
    it('accepts a SKU-less eBay exception without inventing remote detail', () => {
        const catalog = listing({
            id: 'ebay-listing:147502608418:sku:(missing)',
            shopify: null,
            ebay: {
                ...listing().ebay,
                sku: '',
                state: 'attention',
                offerId: null,
            },
            lifecycleStatus: 'attention',
            audit: {
                ...listing().audit,
                unresolvedCount: 1,
                attentionReasons: ['ebay_active_without_sku'],
            },
        });
        const workspace = {
            schemaVersion: 1,
            evidence: {
                catalogObservedAtUtc: '2026-08-13T17:30:00.000Z',
                detailObservedAtUtc: null,
                freshness: 'live',
                backgroundRefreshSeconds: 60,
                remoteReadPerformed: false,
                externalWritesPerformed: 0,
            },
            catalog,
            mapping: {
                state: 'ebay_only_unmapped',
                joinKey: 'exact_raw_sku',
                shopifyProductId: null,
                shopifyVariantId: null,
                inventorySku: null,
                offerId: null,
                listingId: '147502608418',
                managementModel: 'none',
                ownership: {
                    listing: 'unverified',
                    mapping: 'unverified',
                    price: 'marketplace_connect',
                    inventory: 'marketplace_connect',
                },
                editMode: 'read_only',
            },
            ebayDetail: null,
        };
        expect(isListingWorkspaceResponse(workspace, catalog.id)).toBe(true);
        expect(isListingWorkspaceResponse({
            ...workspace,
            mapping: { ...workspace.mapping, listingId: '999999999999' },
        }, catalog.id)).toBe(false);
    });
    it('labels only price and inventory as Marketplace Connect owned', () => {
        const source = readFileSync(fileURLToPath(new URL('./pages/ListingDetail.tsx', import.meta.url)), 'utf8');
        expect(source).toContain('Owner unverified');
        expect(source).toContain('Price · Marketplace Connect');
        expect(source).toContain('Quantity · Marketplace Connect');
        expect(source).not.toMatch(/<Badge[^>]*>Marketplace Connect<\/Badge>/u);
    });
});
