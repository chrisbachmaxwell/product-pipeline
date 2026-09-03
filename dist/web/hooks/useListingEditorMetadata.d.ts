/**
 * Locally declared contract for GET /api/listing-editor-metadata.
 * Deliberately not imported from server code: the editor treats the
 * payload as untrusted and normalizes it defensively. When the request
 * fails or a list comes back empty, the draft editor degrades to plain
 * text inputs, so this data is a presentation aid only.
 */
export interface ListingEditorCondition {
    id: string;
    label: string;
}
export interface ListingEditorCategory {
    id: string;
    name: string | null;
    usageCount: number;
}
export interface ListingEditorIdUsage {
    id: string;
    usageCount: number;
}
export interface ListingEditorMetadata {
    conditions: ListingEditorCondition[];
    categories: ListingEditorCategory[];
    policies: {
        fulfillment: ListingEditorIdUsage[];
        payment: ListingEditorIdUsage[];
        return: ListingEditorIdUsage[];
    };
    merchantLocations: ListingEditorIdUsage[];
}
export declare const normalizeListingEditorMetadata: (value: unknown) => ListingEditorMetadata;
export declare const emptyListingEditorMetadata: () => ListingEditorMetadata;
/** Read-only editor metadata; presentation aid only — never blocks editing. */
export declare const useListingEditorMetadata: () => import("@tanstack/react-query").UseQueryResult<ListingEditorMetadata, Error>;
