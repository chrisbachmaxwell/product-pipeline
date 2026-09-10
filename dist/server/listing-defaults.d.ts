import { buildListingEditorMetadata } from './listing-editor-metadata.js';
import type { EbayCategorySearch } from './ebay-category-search.js';
/**
 * Automatic draft defaults, so a ready-to-list item needs review, not data
 * entry: condition from the store's own `condition-…` Shopify tag, the
 * operator's published grading language as the condition description, the
 * most-used delivery policies, and eBay's top category suggestion for the
 * title. All of it lands in the draft's SOURCE layer, so an operator
 * override on any individual listing still wins.
 */
export type ListingDefaults = Readonly<{
    conditionId: string | null;
    conditionDescription: string | null;
    categoryId: string | null;
    categoryName: string | null;
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    merchantLocationKey: string | null;
}>;
export declare function conditionFromTags(productTags: readonly string[] | undefined): {
    id: string;
    description: string;
} | null;
/** Strip the store's title decorations before asking eBay for categories. */
export declare function categoryQueryFromTitle(title: string): string;
export declare function createListingDefaultsReader(dependencies?: Readonly<{
    getSnapshot?: () => Promise<Parameters<typeof buildListingEditorMetadata>[0]>;
    getSweepObservations?: () => readonly unknown[];
    searchCategories?: EbayCategorySearch;
    now?: () => number;
}>): (input: Readonly<{
    title: string;
    productTags: readonly string[] | undefined;
}>) => Promise<ListingDefaults>;
