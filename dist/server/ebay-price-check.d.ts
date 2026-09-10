export declare const PRICE_CHECK_FAILURE_CODES: readonly ["PRICE_CHECK_AUTH_UNAVAILABLE", "PRICE_CHECK_READ_FAILED", "PRICE_CHECK_NO_RESULTS"];
export type PriceCheckFailureCode = (typeof PRICE_CHECK_FAILURE_CODES)[number];
export declare class PriceCheckError extends Error {
    readonly code: PriceCheckFailureCode;
    constructor(code: PriceCheckFailureCode);
}
export type PriceCheckComp = Readonly<{
    title: string;
    price: Readonly<{
        value: number;
        currency: string;
    }>;
    condition: string | null;
}>;
export type PriceCheckResult = Readonly<{
    query: string;
    conditionFilter: PriceCheckCondition;
    median: number;
    currency: string;
    sampleSize: number;
    comps: readonly PriceCheckComp[];
}>;
/** Browse API `conditions` filter values this reader will ever request. */
export type PriceCheckCondition = 'USED' | 'NEW';
type FetchLike = typeof fetch;
/**
 * Derive the comp search query from one store listing title: store-inventory
 * suffixes like `(#12345)` and asterisk-wrapped condition banners like
 * `*USED*` / `*OPEN BOX*` are stripped, unsafe characters and extra
 * whitespace are collapsed, and the remainder (the brand/model tokens) is
 * capped at a whole-word boundary.
 */
export declare function derivePriceCheckQuery(title: string): string;
/**
 * Map an optional operator/store condition hint onto the fixed Browse filter
 * allowlist. Anything unrecognized falls back to USED — the store sells used
 * gear, and an unexpected hint must never widen the request shape.
 */
export declare function derivePriceCheckCondition(hint: string | null | undefined): PriceCheckCondition;
/** Median of the sample, rounded to cents; even counts average the middle pair. */
export declare function medianPrice(values: readonly number[]): number;
/**
 * Application-token provider for Browse reads: `client_credentials` exchange
 * of the same runtime app credentials the user-token path uses, base
 * `api_scope` only, cached in-process until shortly before expiry. The token
 * never leaves this module except in the Authorization header and is never
 * logged or persisted.
 */
export declare function createApplicationEbayTokenProvider(dependencies?: Readonly<{
    loadCredentials?: () => Promise<Readonly<{
        appId?: string;
        certId?: string;
    }>>;
    fetchImpl?: FetchLike;
    now?: () => number;
}>): () => Promise<string>;
export type PriceCheck = (title: string, conditionHint?: string | null) => Promise<PriceCheckResult>;
export declare function createPriceCheck(dependencies: Readonly<{
    getAccessToken: () => Promise<string>;
    fetchImpl?: FetchLike;
    now?: () => number;
}>): PriceCheck;
/** Production instance: application token from the same runtime credentials. */
export declare const checkListingPrice: PriceCheck;
export declare const EBAY_PRICE_CHECK_TESTING: Readonly<{
    MAX_RESPONSE_BYTES: number;
    REQUEST_TIMEOUT_MS: 15000;
    SEARCH_LIMIT: 20;
    MAX_COMPS: 10;
    MAX_QUERY_CHARACTERS: 80;
    MAX_COMP_TITLE_CHARACTERS: 120;
    MAX_COMP_CONDITION_CHARACTERS: 40;
    CACHE_TTL_MS: number;
    MAX_CACHED_QUERIES: 200;
}>;
export {};
