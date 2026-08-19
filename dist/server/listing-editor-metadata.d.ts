import { type EbayConditionOption } from '../shared/ebay-conditions.js';
import type { LiveListingCatalogSnapshot } from './live-listing-catalog.js';
export type ListingEditorCategoryOption = Readonly<{
    id: string;
    name: string | null;
    usageCount: number;
}>;
export type ListingEditorUsageOption = Readonly<{
    id: string;
    usageCount: number;
}>;
export type ListingEditorMetadataDto = Readonly<{
    conditions: readonly EbayConditionOption[];
    categories: readonly ListingEditorCategoryOption[];
    policies: Readonly<{
        fulfillment: readonly ListingEditorUsageOption[];
        payment: readonly ListingEditorUsageOption[];
        return: readonly ListingEditorUsageOption[];
    }>;
    merchantLocations: readonly ListingEditorUsageOption[];
}>;
export declare class ListingEditorMetadataError extends Error {
    constructor();
}
export declare function buildListingEditorMetadata(snapshot: LiveListingCatalogSnapshot): ListingEditorMetadataDto;
export declare const LISTING_EDITOR_METADATA_TESTING: Readonly<{
    MAX_FACET_ENTRIES: 500;
    MAX_FACET_STRING_LENGTH: 256;
}>;
