export declare const EBAY_CATEGORY_SEARCH_FAILURE_CODES: readonly ["INVALID_QUERY", "AUTHORITY_UNAVAILABLE", "REMOTE_READ_FAILED", "INVALID_RESPONSE"];
export type EbayCategorySearchFailureCode = (typeof EBAY_CATEGORY_SEARCH_FAILURE_CODES)[number];
export declare class EbayCategorySearchError extends Error {
    readonly code: EbayCategorySearchFailureCode;
    constructor(code: EbayCategorySearchFailureCode);
}
export type EbayCategorySuggestion = Readonly<{
    id: string;
    name: string;
    path: string;
    leaf: boolean;
}>;
export type EbayCategorySearchDto = Readonly<{
    categories: readonly EbayCategorySuggestion[];
}>;
type FetchLike = typeof fetch;
/**
 * Trimmed 2–100 character query with no control, line-separator, or delete
 * characters. Anything else is an INVALID_QUERY (route: 400), never echoed.
 */
export declare function validateEbayCategoryQuery(value: unknown): string;
export type EbayCategorySearch = (query: unknown) => Promise<EbayCategorySearchDto>;
export declare function createEbayCategorySearch(dependencies: Readonly<{
    getAccessToken: () => Promise<string>;
    fetchImpl?: FetchLike;
    now?: () => number;
}>): EbayCategorySearch;
/**
 * Production instance backed by the existing transient eBay read token
 * (already minted with `api_scope`; no new scope is requested).
 */
export declare const searchEbayCategories: EbayCategorySearch;
export declare const EBAY_CATEGORY_SEARCH_TESTING: Readonly<{
    MIN_QUERY_CHARACTERS: 2;
    MAX_QUERY_CHARACTERS: 100;
    MAX_SUGGESTIONS: 25;
    MAX_ANCESTORS: 10;
    MAX_CACHED_QUERIES: 500;
    QUERY_CACHE_TTL_MS: number;
    MAX_RESPONSE_BYTES: number;
    REQUEST_TIMEOUT_MS: 15000;
}>;
export {};
