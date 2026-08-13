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
declare function captureShopify(accessToken: string): Promise<{
    variants: CapturedShopifyVariant[];
    coverage: Omit<LiveListingCatalogSnapshot['coverage']['shopify'], never>;
}>;
declare function tradingCall(accessToken: string, callName: 'GetUser' | 'GetMyeBaySelling', body: string): Promise<Record<string, any>>;
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
}>): () => Promise<LiveListingCatalogSnapshot>;
export declare const getLiveListingCatalogSnapshot: () => Promise<LiveListingCatalogSnapshot>;
export type LiveListingCatalogRouteDependencies = Readonly<{
    getSnapshot: () => Promise<LiveListingCatalogSnapshot>;
}>;
export declare const LIVE_LISTING_CATALOG_SOURCE_TESTING: Readonly<{
    catalogPhase: typeof catalogPhase;
    captureShopify: typeof captureShopify;
    tradingCall: typeof tradingCall;
    captureTrading: typeof captureTrading;
    captureInventory: typeof captureInventory;
}>;
export {};
