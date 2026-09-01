import { type LiveListingCatalogRow, type LiveListingCatalogSnapshot } from './live-listing-catalog.js';
import { type LiveListingCatalogCacheStatus } from './live-listing-catalog-source.js';
import { type EnrichedListingDetail, type EnrichedListingDetailRequest } from './enriched-listing-detail.js';
import { type ShopifyProductContent } from './shopify-product-content.js';
export type ListingWorkspaceMappingState = 'mapped' | 'shopify_only' | 'ebay_only_unmapped' | 'attention';
export type ListingWorkspaceDto = Readonly<{
    schemaVersion: 1;
    evidence: Readonly<{
        catalogObservedAtUtc: string;
        detailObservedAtUtc: string | null;
        freshness: 'live';
        backgroundRefreshSeconds: 60;
        remoteReadPerformed: boolean;
        externalWritesPerformed: 0;
    }>;
    catalog: LiveListingCatalogRow;
    mapping: Readonly<{
        state: ListingWorkspaceMappingState;
        joinKey: 'exact_raw_sku';
        shopifyProductId: string | null;
        shopifyVariantId: string | null;
        inventorySku: string | null;
        offerId: string | null;
        listingId: string | null;
        managementModel: 'inventory_offer' | 'legacy_trading' | 'none';
        ownership: Readonly<{
            listing: 'unverified';
            mapping: 'unverified';
            price: 'marketplace_connect';
            inventory: 'marketplace_connect';
        }>;
        editMode: 'read_only';
    }>;
    ebayDetail: EnrichedListingDetail | null;
    /**
     * Per-product Shopify description and media, read on demand for the draft
     * editor. Null when the read is unavailable or was not attempted — the
     * editor degrades to manual entry exactly as before, so a Shopify hiccup
     * can never block opening a draft.
     */
    shopifyContent?: ShopifyProductContent | null;
}>;
export declare class ListingWorkspaceReaderError extends Error {
    readonly kind: 'not_found' | 'unavailable';
    constructor(kind: 'not_found' | 'unavailable');
}
type ReadEbayDetail = (input: EnrichedListingDetailRequest) => Promise<EnrichedListingDetail>;
export type ListingWorkspaceReaderDependencies = Readonly<{
    getSnapshot: () => Promise<LiveListingCatalogSnapshot>;
    getSnapshotStatus?: () => LiveListingCatalogCacheStatus;
    getEbayAccessToken: () => Promise<string>;
    readEbayDetail: ReadEbayDetail;
    /**
     * Optional per-product Shopify description/media read. Omitted in tests and
     * in any caller that does not need draft defaults; a failure is swallowed
     * so it can never make a workspace unavailable.
     */
    readShopifyContent?: (productGid: string) => Promise<ShopifyProductContent>;
    now?: () => number;
    maximumSnapshotAgeMs?: number;
}>;
declare function resolveExactFreshRow(snapshot: LiveListingCatalogSnapshot, requestedRowId: string, now: number, maximumAgeMs: number): LiveListingCatalogRow;
declare function exactRawSku(row: LiveListingCatalogRow): string | null;
declare function mappingState(row: LiveListingCatalogRow): ListingWorkspaceMappingState;
declare function projectMapping(row: LiveListingCatalogRow): ListingWorkspaceDto['mapping'];
export declare function createListingWorkspaceReader(dependencies: ListingWorkspaceReaderDependencies): (rowId: string) => Promise<ListingWorkspaceDto>;
export declare const readListingWorkspace: (rowId: string) => Promise<ListingWorkspaceDto>;
export declare const LISTING_WORKSPACE_READER_TESTING: Readonly<{
    BACKGROUND_REFRESH_SECONDS: 60;
    MAX_ROW_ID_LENGTH: 512;
    exactRawSku: typeof exactRawSku;
    mappingState: typeof mappingState;
    projectMapping: typeof projectMapping;
    resolveExactFreshRow: typeof resolveExactFreshRow;
}>;
export {};
