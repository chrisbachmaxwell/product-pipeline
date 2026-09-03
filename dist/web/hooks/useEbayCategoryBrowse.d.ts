/**
 * Locally declared contract for GET /api/ebay-category-browse?parent=<id>.
 * Deliberately not imported from server code: the picker treats the payload
 * as untrusted and normalizes it defensively. When the request fails the
 * picker keeps working from search, used-category metadata, and free numeric
 * entry, so this data is a presentation aid only.
 */
export interface EbayCategoryBrowseNode {
    id: string;
    name: string;
    /** False when the node has children to drill into. */
    leaf: boolean;
    childCount: number;
}
export interface EbayCategoryBrowseCrumb {
    id: string;
    name: string;
}
export interface EbayCategoryBrowseLevel {
    parentId: string | null;
    /** Root-first ancestors of the current level, including its parent. */
    breadcrumb: EbayCategoryBrowseCrumb[];
    children: EbayCategoryBrowseNode[];
}
export declare const normalizeEbayCategoryBrowseResponse: (value: unknown) => EbayCategoryBrowseLevel;
export interface EbayCategoryBrowseState {
    level: EbayCategoryBrowseLevel;
    isLoading: boolean;
    isError: boolean;
}
/**
 * One level of eBay's category tree for the drill-down picker. The server
 * fetches the whole tree once and serves every level from memory, so
 * drilling costs no provider call and levels are cached aggressively here.
 * `enabled` lets the picker avoid fetching until the browse UI is actually
 * shown.
 */
export declare const useEbayCategoryBrowse: (parentId: string | null, enabled: boolean) => EbayCategoryBrowseState;
