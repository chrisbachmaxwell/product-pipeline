/**
 * The store's condition-… tag vocabulary mapped to eBay condition ids and
 * the published grading chart's buyer-facing language. Single source of
 * truth for BOTH the draft auto-defaults (listing-defaults.ts) and the
 * catalog's ready-queue completeness flag (live-listing-catalog.ts) — a
 * ready row whose tags map to nothing here cannot auto-fill a condition
 * and will fail create preflight until the operator tags it or picks one.
 */
export declare const CONDITION_BY_TAG: Readonly<Record<string, {
    id: string;
    description: string;
}>>;
export declare function conditionFromTags(productTags: readonly string[] | undefined): {
    id: string;
    description: string;
} | null;
