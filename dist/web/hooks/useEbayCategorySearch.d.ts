/**
 * Locally declared contract for GET /api/ebay-category-search?q=<text>.
 * Deliberately not imported from server code: the picker treats the payload
 * as untrusted and normalizes it defensively. When the request fails the
 * category picker keeps working from used-category metadata and free
 * numeric entry, so this data is a presentation aid only.
 */
export interface EbayCategorySearchResult {
    id: string;
    name: string;
    /** Full tree path, e.g. "Electronics > Cameras & Photo > …". */
    path: string;
    leaf: boolean;
}
export declare const EBAY_CATEGORY_QUERY_MIN_LENGTH = 2;
export declare const EBAY_CATEGORY_QUERY_MAX_LENGTH = 100;
export declare const EBAY_CATEGORY_SEARCH_DEBOUNCE_MS = 300;
/**
 * Normalizes raw picker text into the query string sent to the endpoint,
 * or null when the text must not trigger a search: blank or too short
 * (< 2 chars), longer than the endpoint accepts (> 100 chars), or
 * pure-numeric input — digits are direct category-id entry, never a search.
 * Normalization (trim, collapse whitespace, lowercase) also serves as the
 * react-query cache key, so retyping an equivalent query reuses the cache.
 */
export declare const normalizeEbayCategoryQuery: (raw: string) => string | null;
export declare const normalizeEbayCategorySearchResponse: (value: unknown) => EbayCategorySearchResult[];
export interface EbayCategorySearchState {
    /** Normalized current query, or null when the input is not searchable. */
    query: string | null;
    /** Latest available results (may briefly lag the query while fetching). */
    results: EbayCategorySearchResult[];
    /** True while waiting out the debounce or while the request is in flight. */
    isSearching: boolean;
    /** True when the most recent fired search failed. */
    isError: boolean;
}
/**
 * Debounced live search over eBay's full category tree. A request only
 * fires once the typed text normalizes to a searchable query (>= 2 chars,
 * not pure-numeric) and 300ms have passed since the last keystroke.
 */
export declare const useEbayCategorySearch: (rawText: string) => EbayCategorySearchState;
