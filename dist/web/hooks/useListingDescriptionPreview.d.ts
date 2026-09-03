export interface ListingDescriptionPreviewResponse {
    templateVersion: string;
    html: string;
}
/**
 * Fetches the fully rendered branded eBay description page for a catalog row.
 * The server renders from the last saved draft revision (or current live
 * values when no draft exists). Display-only: this is the only call made.
 *
 * Fetch is on demand — pass `enabled: true` when the preview modal opens.
 * Results are never kept longer than a minute (staleTime 0 forces a fresh
 * fetch on each open, so a just-saved draft is always reflected).
 */
export declare const useListingDescriptionPreview: (catalogId: string | undefined, options: {
    enabled: boolean;
}) => import("@tanstack/react-query").UseQueryResult<ListingDescriptionPreviewResponse, Error>;
