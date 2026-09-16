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
/**
 * Title-marker fallback for products the team activated without a
 * condition-… tag (operator ask 2026-09-17: "figure out why and make
 * changes… but get them all up"). Every listing in this store is used gear
 * and titles carry the store's own markers ("*USED*", "*FOR PARTS*"), so a
 * missing tag never needs to block publishing:
 *
 * - "FOR PARTS" maps to eBay 7000 (parts/repair) with the grading chart's
 *   parts language.
 * - "USED" (which every used title carries) maps to eBay 3000 with a
 *   deliberately GENERIC used description — the fallback must never claim a
 *   specific grade the operator did not assign. Graded ids (2750/4000/…)
 *   stay tag-only: several categories refuse them (learned live: 30086 and
 *   31388), and only the operator can attest a grade.
 *
 * Tags always win: this is consulted only when no condition-… tag maps.
 */
export declare function conditionFromTitle(title: string | null | undefined): {
    id: string;
    description: string;
} | null;
/** Tag first, title-marker fallback second. The one derivation both the
 * draft auto-defaults and the ready-queue completeness flag must share. */
export declare function deriveCondition(productTags: readonly string[] | undefined, title: string | null | undefined): {
    id: string;
    description: string;
} | null;
