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
/** One selectable node in the drill-down browser. */
export type EbayCategoryBrowseNode = Readonly<{
    id: string;
    name: string;
    leaf: boolean;
    childCount: number;
}>;
/**
 * One browse level: the children of `parentId` (top level when null), plus
 * the root-first breadcrumb of the parent itself so the UI can render and
 * unwind the path without a second call.
 */
export type EbayCategoryBrowseDto = Readonly<{
    parentId: string | null;
    breadcrumb: readonly Readonly<{
        id: string;
        name: string;
    }>[];
    children: readonly EbayCategoryBrowseNode[];
}>;
type BrowseIndex = Readonly<{
    childrenByParent: ReadonlyMap<string, readonly EbayCategoryBrowseNode[]>;
    parentById: ReadonlyMap<string, string>;
    nameById: ReadonlyMap<string, string>;
}>;
type FetchLike = typeof fetch;
type UnknownRecord = Record<string, unknown>;
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
 * Project the full category tree into the compact browse index. Malformed
 * individual nodes are dropped exactly like malformed suggestions; only a
 * structurally invalid tree, an implausible depth, or an implausible node
 * count fails the whole read. The 4 MB source body is discarded once this
 * returns — only ids, names, parent links and child counts are retained.
 */
declare function buildBrowseIndex(body: UnknownRecord): BrowseIndex;
/** Absent/empty means the top level; anything else must be an exact id. */
export declare function validateEbayCategoryParentId(value: unknown): string | null;
export type EbayCategoryBrowse = (parentId: unknown) => Promise<EbayCategoryBrowseDto>;
/**
 * Top-down category browsing served entirely from the in-process index: one
 * tree fetch on first use, then zero provider calls per level. An unknown
 * parent id yields an empty level rather than an error, so a stale saved id
 * can never break the picker.
 */
export declare function createEbayCategoryBrowse(dependencies: Readonly<{
    getAccessToken: () => Promise<string>;
    fetchImpl?: FetchLike;
}>): EbayCategoryBrowse;
/**
 * Production instance backed by the existing transient eBay read token
 * (already minted with `api_scope`; no new scope is requested).
 */
export declare const searchEbayCategories: EbayCategorySearch;
/** Production browse instance sharing the same token provider. */
export declare const browseEbayCategories: EbayCategoryBrowse;
export declare const EBAY_CATEGORY_SEARCH_TESTING: Readonly<{
    MIN_QUERY_CHARACTERS: 2;
    MAX_QUERY_CHARACTERS: 100;
    MAX_SUGGESTIONS: 25;
    MAX_ANCESTORS: 10;
    MAX_CACHED_QUERIES: 500;
    QUERY_CACHE_TTL_MS: number;
    MAX_RESPONSE_BYTES: number;
    REQUEST_TIMEOUT_MS: 15000;
    FULL_TREE_MAX_RESPONSE_BYTES: number;
    MAX_TREE_NODES: 50000;
    MAX_TREE_DEPTH: 12;
    MAX_BROWSE_CHILDREN: 1000;
    buildBrowseIndex: typeof buildBrowseIndex;
}>;
export {};
