export declare const EBAY_LISTING_DETAIL_SELLER_ID = "usedcameragear";
export declare const EBAY_LISTING_DETAIL_MARKETPLACE_ID = "EBAY_US";
export declare const ENRICHED_LISTING_DETAIL_FAILURE_CODES: readonly ["INVALID_REQUEST", "REMOTE_READ_FAILED", "RESPONSE_TOO_LARGE", "INVALID_RESPONSE", "SELLER_MISMATCH", "LISTING_MISMATCH", "SKU_MISMATCH", "OFFER_MISMATCH"];
export type EnrichedListingDetailFailureCode = (typeof ENRICHED_LISTING_DETAIL_FAILURE_CODES)[number];
export declare class EnrichedListingDetailError extends Error {
    readonly code: EnrichedListingDetailFailureCode;
    constructor(code: EnrichedListingDetailFailureCode);
}
export type EbayListingManagementBinding = Readonly<{
    model: 'legacy_trading';
    offerId?: never;
}> | Readonly<{
    model: 'inventory_offer';
    offerId: string;
}>;
type EnrichedListingDetailRequestBase = Readonly<{
    accessToken: string;
    sellerId: string;
    marketplaceId: string;
    sku: string;
    listingId: string;
    management: EbayListingManagementBinding;
}>;
export type EnrichedListingDetailRequest = EnrichedListingDetailRequestBase & (Readonly<{
    mappingState: 'mapped';
    shopifyProductId: string;
    shopifyVariantId: string;
}> | Readonly<{
    mappingState: 'ebay_only_unmapped';
    shopifyProductId: null;
    shopifyVariantId: null;
}>);
export type ListingMoney = Readonly<{
    value: string;
    currency: string;
}>;
export type ListingCategory = Readonly<{
    id: string;
    name: string | null;
}>;
export type ListingConditionDescriptor = Readonly<{
    name: string;
    values: readonly string[];
    additionalInfo: string | null;
}>;
export type ListingIdentifiers = Readonly<{
    brand: string | null;
    mpn: string | null;
    upc: readonly string[];
    ean: readonly string[];
    isbn: readonly string[];
    epid: string | null;
}>;
export type ListingContent = Readonly<{
    title: string | null;
    descriptionHtml: string | null;
    imageUrls: readonly string[];
}>;
export type ListingCondition = Readonly<{
    id: string | null;
    name: string | null;
    description: string | null;
    descriptors: readonly ListingConditionDescriptor[];
}>;
export type ListingActualDetail = Readonly<{
    lifecycle: Readonly<{
        status: string;
        active: boolean;
        format: string | null;
        duration: string | null;
        startAtUtc: string | null;
        endAtUtc: string | null;
    }>;
    content: ListingContent;
    category: Readonly<{
        primary: ListingCategory;
        secondary: ListingCategory | null;
        storeCategories: readonly ListingCategory[];
    }>;
    condition: ListingCondition;
    aspects: Readonly<Record<string, readonly string[]>>;
    identifiers: ListingIdentifiers;
    commerce: Readonly<{
        price: ListingMoney | null;
        totalQuantity: number | null;
        soldQuantity: number | null;
        availableQuantity: number | null;
        availableQuantityBasis: 'reported' | 'total_minus_sold' | 'unavailable';
        bestOfferEnabled: boolean | null;
    }>;
    policies: Readonly<{
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
    }>;
    location: Readonly<{
        publicLocation: string | null;
        countryCode: string | null;
    }>;
}>;
export type InventoryItemControl = Readonly<{
    sku: string;
    content: ListingContent;
    condition: ListingCondition;
    aspects: Readonly<Record<string, readonly string[]>>;
    identifiers: ListingIdentifiers;
    shipToLocationQuantity: number | null;
}>;
export type InventoryOfferControl = Readonly<{
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
    price: ListingMoney | null;
    availableQuantity: number | null;
    quantityLimitPerBuyer: number | null;
    bestOfferEnabled: boolean | null;
    autoAcceptPrice: ListingMoney | null;
    autoDeclinePrice: ListingMoney | null;
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    merchantLocationKey: string | null;
    includeCatalogProductDetails: boolean | null;
}>;
export type EnrichedListingDetail = Readonly<{
    schemaVersion: 1;
    evidence: Readonly<{
        source: 'ebay-trading-get-item' | 'ebay-trading-get-item+ebay-inventory-detail';
        observedAtUtc: string;
        complete: true;
        remoteReadPerformed: true;
        externalWritesPerformed: 0;
        requestCount: 2 | 4;
    }>;
    identity: Readonly<{
        sellerId: typeof EBAY_LISTING_DETAIL_SELLER_ID;
        marketplaceId: typeof EBAY_LISTING_DETAIL_MARKETPLACE_ID;
        mappingState: 'mapped' | 'ebay_only_unmapped';
        shopifyProductId: string | null;
        shopifyVariantId: string | null;
        sku: string;
        listingId: string;
        publicListingUrl: string | null;
        offerId: string | null;
    }>;
    actual: ListingActualDetail;
    management: Readonly<{
        model: 'legacy_trading' | 'inventory_offer';
        controlApi: 'trading' | 'inventory';
        joinKey: 'exact_raw_sku';
        exactBindings: Readonly<{
            seller: true;
            listing: true;
            sku: true;
            inventoryItem: boolean;
            offer: boolean;
            offerToListing: boolean;
        }>;
        lifecycleAligned: boolean;
        inventoryItem: InventoryItemControl | null;
        offer: InventoryOfferControl | null;
    }>;
}>;
type FetchLike = typeof fetch;
type UnknownRecord = Record<string, unknown>;
type TradingSelection = Readonly<{
    actual: ListingActualDetail;
    publicListingUrl: string | null;
}>;
export declare function parseTradingItemDetail(response: UnknownRecord, expected: Readonly<{
    sellerId: string;
    listingId: string;
    sku: string;
}>): TradingSelection;
export declare function parseInventoryItemControl(body: UnknownRecord, expectedSku: string): InventoryItemControl;
export declare function parseInventoryOfferControl(body: UnknownRecord, expected: Readonly<{
    offerId: string;
    sku: string;
    listingId: string;
    marketplaceId: string;
}>): InventoryOfferControl;
export declare function createEnrichedListingDetailReader(dependencies?: Readonly<{
    fetchImpl?: FetchLike;
    now?: () => Date;
}>): (input: EnrichedListingDetailRequest) => Promise<EnrichedListingDetail>;
export declare const ENRICHED_LISTING_DETAIL_TESTING: Readonly<{
    MAX_RESPONSE_BYTES: number;
    MAX_DESCRIPTION_CHARACTERS: 500000;
    MAX_DESCRIPTION_UTF8_BYTES: 2000000;
    REQUEST_TIMEOUT_MS: 20000;
}>;
export {};
