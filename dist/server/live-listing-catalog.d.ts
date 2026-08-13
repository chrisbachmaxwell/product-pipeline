export type LiveListingStatus = 'active' | 'not_listed' | 'attention';
export type ListingAttentionReason = 'shopify_product_not_active' | 'shopify_sku_missing' | 'shopify_sku_duplicate' | 'shopify_sku_near_collision' | 'ebay_sku_near_collision' | 'ebay_multiple_active_matches' | 'ebay_unpublished_artifact' | 'ebay_inventory_coverage_unavailable';
export type CapturedShopifyVariant = Readonly<{
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    variantTitle: string;
    productStatus: string;
    primaryImageUrl: string | null;
    imageCount: number;
    available: number;
    price: Readonly<{
        amount: string;
        currency: string;
    }>;
}>;
export type CapturedEbayActiveListing = Readonly<{
    listingId: string;
    sku: string;
}>;
export type CapturedEbayInventoryItem = Readonly<{
    sku: string;
}>;
export type CapturedEbayOffer = Readonly<{
    offerId: string;
    sku: string;
    status: string | null;
    listingId: string | null;
    listingStatus: string | null;
}>;
export type LiveCatalogCoverage = Readonly<{
    shopify: Readonly<{
        source: 'shopify-admin-graphql';
        storeDomain: string;
        shopId: string;
        observedAtUtc: string;
        paginationComplete: true;
        variantPageCount: number;
        totalVariantsCaptured: number;
        positiveStockVariants: number;
        excludedZeroInventory: number;
        excludedUnknownInventory: number;
        productStatusCounts: Readonly<Record<string, number>>;
    }>;
    ebay: Readonly<{
        source: 'ebay-trading-api+ebay-inventory-api';
        marketplaceId: 'EBAY_US';
        sellerAccountVerified: true;
        observedAtUtc: string;
        trading: Readonly<{
            paginationComplete: true;
            pageCount: number;
            activeListingCount: number;
        }>;
        inventory: Readonly<{
            inventoryItemsComplete: true;
            inventoryItemPageCount: number;
            inventoryItemCount: number;
            offersComplete: true;
            offerPageCount: number;
            offerCount: number;
            unpublishedArtifactsChecked: true;
        }>;
    }>;
    join: Readonly<{
        key: 'exact_raw_sku';
        missingShopifySkuCount: number;
        duplicateShopifySkuCount: number;
        shopifyNearCollisionCount: number;
        ebayNearCollisionCount: number;
        ambiguousActiveMatchCount: number;
        unpublishedArtifactSkuCount: number;
    }>;
}>;
export type LiveListingCatalogRow = Readonly<{
    id: string;
    shopify: Readonly<{
        productId: string;
        variantId: string;
        sku: string;
        title: string;
        variantTitle: string;
        productStatus: string;
        primaryImageUrl: string | null;
        imageCount: number;
        available: number;
        price: Readonly<{
            amount: string;
            currency: string;
        }>;
    }>;
    ebay: Readonly<{
        state: LiveListingStatus;
        listingId: string | null;
        offerId: string | null;
        url: string | null;
        activeMatchCount: number;
        inventoryItemCount: number;
        offerCount: number;
        unpublishedArtifactCount: number;
    }>;
    lifecycleStatus: LiveListingStatus;
    lastVerifiedAtUtc: string;
    audit: Readonly<{
        verified: true;
        evidenceState: 'live_verified';
        unresolvedCount: number;
        attentionReasons: readonly ListingAttentionReason[];
        recoverySupported: false;
        currentRemoteStateVerified: true;
    }>;
}>;
export type LiveListingCatalogSnapshot = Readonly<{
    observedAtUtc: string;
    rows: readonly LiveListingCatalogRow[];
    summary: Readonly<{
        active: number;
        notListed: number;
        attention: number;
        totalInStock: number;
    }>;
    coverage: LiveCatalogCoverage;
}>;
export type LiveListingCatalogPage = Readonly<{
    schemaVersion: 2;
    data: readonly LiveListingCatalogRow[];
    total: number;
    limit: number;
    offset: number;
    summary: LiveListingCatalogSnapshot['summary'];
    source: 'shopify-admin-graphql+ebay-active-listings';
    evidenceKind: 'live_read';
    authoritative: true;
    remoteReadPerformed: true;
    externalWritesPerformed: 0;
    observedAtUtc: string;
    coverage: LiveCatalogCoverage;
}>;
export declare class LiveListingCatalogError extends Error {
    constructor();
}
export declare function buildLiveListingCatalogSnapshot(input: Readonly<{
    observedAtUtc: string;
    shopifyVariants: readonly CapturedShopifyVariant[];
    ebayActiveListings: readonly CapturedEbayActiveListing[];
    ebayInventoryItems: readonly CapturedEbayInventoryItem[];
    ebayOffers: readonly CapturedEbayOffer[];
    coverage: Omit<LiveCatalogCoverage, 'join'>;
}>): LiveListingCatalogSnapshot;
export declare function projectLiveListingCatalogPage(snapshot: LiveListingCatalogSnapshot, input: Readonly<{
    limit: number;
    offset: number;
    search?: string;
    status?: LiveListingStatus;
    id?: string;
}>): LiveListingCatalogPage;
