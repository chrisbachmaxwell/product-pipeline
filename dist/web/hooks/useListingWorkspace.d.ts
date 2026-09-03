import type { AuthoritativeListingItem } from './useAuthoritativeListings';
export interface WorkspaceMoney {
    value: string;
    currency: string;
}
export interface WorkspaceContent {
    title: string | null;
    descriptionHtml: string | null;
    imageUrls: readonly string[];
}
export interface WorkspaceCondition {
    id: string | null;
    name: string | null;
    description: string | null;
    descriptors: ReadonlyArray<{
        name: string;
        values: readonly string[];
        additionalInfo: string | null;
    }>;
}
export interface WorkspaceIdentifiers {
    brand: string | null;
    mpn: string | null;
    upc: readonly string[];
    ean: readonly string[];
    isbn: readonly string[];
    epid: string | null;
}
export interface EbayListingDetail {
    schemaVersion: 1;
    evidence: {
        source: 'ebay-trading-get-item' | 'ebay-trading-get-item+ebay-inventory-detail';
        observedAtUtc: string;
        complete: true;
        remoteReadPerformed: true;
        externalWritesPerformed: 0;
        requestCount: 2 | 4;
    };
    identity: {
        sellerId: 'usedcameragear';
        marketplaceId: 'EBAY_US';
        mappingState: 'mapped' | 'ebay_only_unmapped';
        shopifyProductId: string | null;
        shopifyVariantId: string | null;
        sku: string;
        listingId: string;
        publicListingUrl: string | null;
        offerId: string | null;
    };
    actual: {
        lifecycle: {
            status: string;
            active: boolean;
            format: string | null;
            duration: string | null;
            startAtUtc: string | null;
            endAtUtc: string | null;
        };
        content: WorkspaceContent;
        category: {
            primary: {
                id: string;
                name: string | null;
            };
            secondary: {
                id: string;
                name: string | null;
            } | null;
            storeCategories: ReadonlyArray<{
                id: string;
                name: string | null;
            }>;
        };
        condition: WorkspaceCondition;
        aspects: Readonly<Record<string, readonly string[]>>;
        identifiers: WorkspaceIdentifiers;
        commerce: {
            price: WorkspaceMoney | null;
            totalQuantity: number | null;
            soldQuantity: number | null;
            availableQuantity: number | null;
            availableQuantityBasis: 'reported' | 'total_minus_sold' | 'unavailable';
            bestOfferEnabled: boolean | null;
        };
        policies: {
            fulfillmentPolicyId: string | null;
            paymentPolicyId: string | null;
            returnPolicyId: string | null;
            paymentMethods: readonly string[];
            shippingType: string | null;
            domesticServices: readonly string[];
            internationalServices: readonly string[];
            returnsAccepted: boolean | null;
            returnPeriod: string | null;
            returnShippingCostPayer: string | null;
        };
        location: {
            publicLocation: string | null;
            countryCode: string | null;
        };
    };
    management: {
        model: 'legacy_trading' | 'inventory_offer';
        controlApi: 'trading' | 'inventory';
        joinKey: 'exact_raw_sku';
        exactBindings: {
            seller: true;
            listing: true;
            sku: true;
            inventoryItem: boolean;
            offer: boolean;
            offerToListing: boolean;
        };
        lifecycleAligned: boolean;
        inventoryItem: {
            sku: string;
            content: WorkspaceContent;
            condition: WorkspaceCondition;
            aspects: Readonly<Record<string, readonly string[]>>;
            identifiers: WorkspaceIdentifiers;
            shipToLocationQuantity: number | null;
        } | null;
        offer: {
            offerId: string;
            sku: string;
            marketplaceId: string;
            status: string;
            listingStatus: string;
            listingOnHold: boolean | null;
            soldQuantity: number | null;
            format: string | null;
            duration: string | null;
            descriptionHtml: string | null;
            primaryCategoryId: string;
            secondaryCategoryId: string | null;
            storeCategoryNames: readonly string[];
            price: WorkspaceMoney | null;
            availableQuantity: number | null;
            quantityLimitPerBuyer: number | null;
            bestOfferEnabled: boolean | null;
            autoAcceptPrice: WorkspaceMoney | null;
            autoDeclinePrice: WorkspaceMoney | null;
            fulfillmentPolicyId: string | null;
            paymentPolicyId: string | null;
            returnPolicyId: string | null;
            merchantLocationKey: string | null;
            includeCatalogProductDetails: boolean | null;
        } | null;
    };
}
export interface ListingWorkspaceResponse {
    schemaVersion: 1;
    evidence: {
        catalogObservedAtUtc: string;
        detailObservedAtUtc: string | null;
        freshness: 'live';
        backgroundRefreshSeconds: 60;
        remoteReadPerformed: boolean;
        externalWritesPerformed: 0;
    };
    catalog: AuthoritativeListingItem;
    mapping: {
        state: 'mapped' | 'shopify_only' | 'ebay_only_unmapped' | 'attention';
        joinKey: 'exact_raw_sku';
        shopifyProductId: string | null;
        shopifyVariantId: string | null;
        inventorySku: string | null;
        offerId: string | null;
        listingId: string | null;
        managementModel: 'inventory_offer' | 'legacy_trading' | 'none';
        ownership: {
            listing: 'unverified';
            mapping: 'unverified';
            price: 'marketplace_connect';
            inventory: 'marketplace_connect';
        };
        editMode: 'read_only';
    };
    ebayDetail: EbayListingDetail | null;
}
export declare const isListingWorkspaceResponse: (value: unknown, expectedCatalogId?: string) => value is ListingWorkspaceResponse;
export declare const useListingWorkspace: (id: string | undefined) => import("@tanstack/react-query").UseQueryResult<ListingWorkspaceResponse, Error>;
