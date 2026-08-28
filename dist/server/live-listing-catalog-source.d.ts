import { type CapturedEbayActiveListing, type CapturedEbayInventoryItem, type CapturedEbayOffer, type CapturedShopifyVariant, type LiveListingCatalogSnapshot } from './live-listing-catalog.js';
export declare const LISTING_CATALOG_FAILURE_CODES: readonly ["AUTH_READ_FAILED", "TOKEN_REFRESH_FAILED", "SHOPIFY_CAPTURE_FAILED", "TRADING_CAPTURE_FAILED", "INVENTORY_CAPTURE_FAILED", "PROJECTION_FAILED"];
type ListingCatalogFailureCode = (typeof LISTING_CATALOG_FAILURE_CODES)[number];
type FetchLike = typeof fetch;
export type RuntimeAuthMaterial = Readonly<{
    shopifyAccessToken: string;
    ebayRefreshToken: string;
    ebayAppId: string;
    ebayCertId: string;
}>;
type TransientEbayToken = Readonly<{
    accessToken: string;
    expiresIn: number;
}>;
declare function catalogPhase<T>(code: ListingCatalogFailureCode, operation: () => Promise<T>): Promise<T>;
export declare function createTransientEbayTokenProvider(dependencies: Readonly<{
    loadAuth: () => Promise<RuntimeAuthMaterial>;
    exchange: (auth: RuntimeAuthMaterial) => Promise<TransientEbayToken>;
    now?: () => number;
}>): () => Promise<string>;
export declare function exchangeRuntimeEbayToken(auth: RuntimeAuthMaterial, fetchImpl?: FetchLike): Promise<TransientEbayToken>;
/**
 * Internal read-authority seam for exact eBay GET detail readers. Callers must
 * never return, persist, or log the token and must retain the same account and
 * method allowlists as this module.
 */
export declare function getRuntimeEbayReadToken(): Promise<string>;
/**
 * Accept a Shopify CDN image URL, or null when it is absent or not exactly
 * that shape.
 *
 * This previously required an empty query string, which rejected EVERY image
 * in the store: Shopify serves every CDN asset with a `?v=<epoch>`
 * cache-buster. Verified against Production — 0 of 156 image-bearing rows
 * resolved a URL — which made `preflight-create` deny
 * `CREATE_REQUIRED_FIELD_MISSING: images` for every possible listing, so no
 * listing could ever be created.
 *
 * The safety property is the pinned scheme and host, not the absence of a
 * query. The version parameter is benign and identifies the exact asset
 * revision, so it is preserved rather than stripped. It is accepted ONLY in
 * that exact shape — a single `v` key whose value is all digits; any other
 * parameter, any fragment, any other host or scheme still rejects.
 */
export declare function safeShopifyImageUrl(value: string | null | undefined): string | null;
declare function captureShopify(accessToken: string): Promise<{
    variants: CapturedShopifyVariant[];
    coverage: Omit<LiveListingCatalogSnapshot['coverage']['shopify'], never>;
}>;
declare function tradingCall(accessToken: string, callName: 'GetUser' | 'GetMyeBaySelling', body: string): Promise<Record<string, any>>;
type TradingListingFacets = Partial<Pick<CapturedEbayActiveListing, 'primaryCategoryId' | 'primaryCategoryName' | 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId'>>;
/** Facets the GetMyeBaySelling item body already carries; keys only when valid. */
declare function tradingListingFacets(item: Record<string, any>): TradingListingFacets;
type OfferListingFacets = Partial<Pick<CapturedEbayOffer, 'categoryId' | 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId' | 'merchantLocationKey'>>;
/** Facets the bulk getOffers body already carries natively; keys only when valid. */
declare function offerListingFacets(offer: Record<string, any>): OfferListingFacets;
declare function captureTrading(accessToken: string): Promise<{
    listings: CapturedEbayActiveListing[];
    pageCount: number;
    activeListingCount: number;
}>;
declare function captureInventory(accessToken: string): Promise<{
    items: CapturedEbayInventoryItem[];
    offers: CapturedEbayOffer[];
    itemPages: number;
    offerPages: number;
}>;
export declare function captureLiveListingCatalog(): Promise<LiveListingCatalogSnapshot>;
export declare function createLiveListingCatalogCache(capture: () => Promise<LiveListingCatalogSnapshot>, options?: Readonly<{
    now?: () => number;
    ttlMs?: number;
}>): (() => Promise<LiveListingCatalogSnapshot>) & {
    refresh: () => Promise<LiveListingCatalogSnapshot>;
    status: () => Readonly<{
        hasSuccessfulSnapshot: boolean;
        observedAtUtc: string | null;
        lastSuccessAtEpochMs: number | null;
        lastAttemptAtEpochMs: number | null;
        lastFailureAtEpochMs: number | null;
        expiresAtEpochMs: number | null;
        refreshInFlight: boolean;
    }>;
};
export type LiveListingCatalogCacheStatus = ReturnType<ReturnType<typeof createLiveListingCatalogCache>['status']>;
export declare function hasUnresolvedLiveListingRefreshFailure(status: LiveListingCatalogCacheStatus | null | undefined): boolean;
export declare const getLiveListingCatalogSnapshot: (() => Promise<LiveListingCatalogSnapshot>) & {
    refresh: () => Promise<LiveListingCatalogSnapshot>;
    status: () => Readonly<{
        hasSuccessfulSnapshot: boolean;
        observedAtUtc: string | null;
        lastSuccessAtEpochMs: number | null;
        lastAttemptAtEpochMs: number | null;
        lastFailureAtEpochMs: number | null;
        expiresAtEpochMs: number | null;
        refreshInFlight: boolean;
    }>;
};
export declare function startLiveListingCatalogRefresher(cache?: Readonly<{
    refresh: () => Promise<unknown>;
}>, options?: Readonly<{
    intervalMs?: number;
    setIntervalImpl?: typeof setInterval;
}>): () => void;
export type LiveListingCatalogRouteDependencies = Readonly<{
    getSnapshot: () => Promise<LiveListingCatalogSnapshot>;
    getSnapshotStatus?: () => LiveListingCatalogCacheStatus;
}>;
export declare const LIVE_LISTING_CATALOG_SOURCE_TESTING: Readonly<{
    catalogPhase: typeof catalogPhase;
    captureShopify: typeof captureShopify;
    tradingCall: typeof tradingCall;
    captureTrading: typeof captureTrading;
    captureInventory: typeof captureInventory;
    tradingListingFacets: typeof tradingListingFacets;
    offerListingFacets: typeof offerListingFacets;
    LIVE_CATALOG_REFRESH_INTERVAL_MS: 60000;
}>;
export {};
