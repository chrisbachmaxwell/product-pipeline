import type { AuthoritativeListingItem, AuthoritativeListingStatus, AuthoritativeListingsResponse } from './hooks/useAuthoritativeListings';
export type ListingFilter = 'all' | AuthoritativeListingStatus;
export declare const LISTING_FILTERS: Array<{
    label: string;
    value: ListingFilter;
}>;
export declare const listingFilterOptions: (summary: AuthoritativeListingsResponse["summary"] | undefined) => Array<{
    label: string;
    value: ListingFilter;
}>;
export declare const listingStatusLabel: (status: AuthoritativeListingStatus) => string;
export declare const listingStatusTone: (status: AuthoritativeListingStatus) => "critical" | "success" | "attention" | "info";
export declare const listingActionLabel: (status: AuthoritativeListingStatus) => "View" | "Review" | "Details";
export declare const listingSkuLabel: (sku: string) => string;
export declare const formatListingPrice: (price: NonNullable<AuthoritativeListingItem["shopify"]>["price"] | null) => string;
export declare const formatWorkspaceMoney: (money: {
    value: string;
    currency: string;
} | null) => string;
export declare const formatListingQuantity: (value: number | null) => string;
export declare const formatVerifiedAt: (value: string | null | undefined) => string;
export declare const verifiedEbayListingUrl: (listingId: string | null, value: string | null) => string | null;
export declare const isLiveCatalogResponse: (response: AuthoritativeListingsResponse | undefined) => boolean;
export declare const listingAttentionText: (listing: AuthoritativeListingItem) => string | null;
export declare const listingDisplayTitle: (listing: AuthoritativeListingItem) => string;
export declare const listingDisplaySku: (listing: AuthoritativeListingItem) => string;
export declare const descriptionSummary: (value: string | null, maximum?: number) => string;
export declare const verifiedShopifyProductUrl: (productId: string | null) => string | null;
export declare const isMigrationPolicyAvailable: (migration: {
    phase?: string;
    effectiveMode?: string;
    historicalBackfillAllowed?: boolean;
} | undefined) => boolean;
export declare const isHistoricalBackfillProtected: (migration: {
    historicalBackfillAllowed?: boolean;
} | undefined) => boolean;
export declare const verifiedListingImageUrl: (value: string | null) => string | null;
