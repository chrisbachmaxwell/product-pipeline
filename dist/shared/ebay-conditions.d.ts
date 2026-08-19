/**
 * Fixed eBay listing-condition table. These are marketplace-wide constants,
 * not seller data: they are never fetched from eBay and never change at
 * runtime, so the listing editor can render them without any remote read.
 */
export type EbayConditionOption = Readonly<{
    id: string;
    label: string;
}>;
export declare const EBAY_CONDITIONS: readonly EbayConditionOption[];
