export declare const LISTING_DESCRIPTION_TEMPLATE_VERSION = "ucg-branded-v1";
export type ListingDescriptionTemplateInput = Readonly<{
    templateVersion: typeof LISTING_DESCRIPTION_TEMPLATE_VERSION;
    title: string;
    bodyHtml: string;
    conditionId: string | null;
    conditionNote: string | null;
    imageUrls: readonly string[];
    sku: string;
}>;
export declare class ListingDescriptionTemplateError extends Error {
    readonly code: 'INVALID_INPUT' | 'OUTPUT_TOO_LARGE';
    constructor(code: 'INVALID_INPUT' | 'OUTPUT_TOO_LARGE');
}
/**
 * Render the complete branded description page for one listing. Throws
 * `ListingDescriptionTemplateError` (`INVALID_INPUT`) on any input that is
 * not exactly the documented shape, and `OUTPUT_TOO_LARGE` when the rendered
 * page would exceed the 400,000-byte bound.
 */
export declare function renderListingDescription(input: unknown): string;
