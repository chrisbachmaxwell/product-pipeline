/**
 * The store's condition-… tag vocabulary mapped to eBay condition ids and
 * the published grading chart's buyer-facing language. Single source of
 * truth for BOTH the draft auto-defaults (listing-defaults.ts) and the
 * catalog's ready-queue completeness flag (live-listing-catalog.ts) — a
 * ready row whose tags map to nothing here cannot auto-fill a condition
 * and will fail create preflight until the operator tags it or picks one.
 */
export type DerivedCondition = Readonly<{
    id: string;
    description: string | null;
}>;
export declare const CONDITION_BY_TAG: Readonly<Record<string, DerivedCondition>>;
export declare function conditionFromTags(productTags: readonly string[] | undefined): DerivedCondition | null;
/**
 * Title-marker fallback for products the team activated without a
 * condition-… tag (operator ask 2026-09-17: "figure out why and make
 * changes… but get them all up"). Used-gear titles carry the store's own
 * markers ("*USED*", "*FOR PARTS*"), so a missing tag does not need to block
 * publishing for those items. Genuinely new products use the explicit
 * `condition-new` tag instead of a title inference:
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
export declare function conditionFromTitle(title: string | null | undefined): DerivedCondition | null;
/**
 * Tag first, title-marker fallback second — with two safety rules on top:
 * a *FOR PARTS* title outranks any tag (never sell a parts item as
 * functional), and graded ids clamp to their eBay-safe equivalent while the
 * grade language stays in the description. The one derivation both the
 * draft auto-defaults and the ready-queue completeness flag must share.
 */
export declare function deriveCondition(productTags: readonly string[] | undefined, title: string | null | undefined): DerivedCondition | null;
