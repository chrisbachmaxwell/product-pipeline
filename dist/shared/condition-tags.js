/**
 * The store's condition-… tag vocabulary mapped to eBay condition ids and
 * the published grading chart's buyer-facing language. Single source of
 * truth for BOTH the draft auto-defaults (listing-defaults.ts) and the
 * catalog's ready-queue completeness flag (live-listing-catalog.ts) — a
 * ready row whose tags map to nothing here cannot auto-fill a condition
 * and will fail create preflight until the operator tags it or picks one.
 */
export const CONDITION_BY_TAG = Object.freeze({
    'like-new': {
        id: '2750',
        description: 'Like New Minus: looks like it just came out of the original box — '
            + '99–100% of original condition even under the most discerning eyes.',
    },
    'like-new-minus': {
        id: '2750',
        description: 'Like New Minus: looks like it just came out of the original box — '
            + '99–100% of original condition even under the most discerning eyes.',
    },
    'excellent-plus': {
        id: '3000',
        description: 'Excellent Plus: very little to no use, with any wear visible only '
            + 'under close inspection. 90–99% of original condition.',
    },
    excellent: {
        id: '3000',
        description: 'Excellent: normal signs of use appropriate to the age of the item. '
            + '75–90% of original condition. Fully functional.',
    },
    'excellent-minus': {
        id: '4000',
        description: 'Excellent Minus: clear signs of use but well cared for. '
            + 'Fully functional.',
    },
    'very-good': {
        id: '4000',
        description: 'Very Good: visible wear from regular use. Fully functional.',
    },
    good: {
        id: '5000',
        description: 'Good: heavy signs of use, fully operational.',
    },
    poor: {
        id: '6000',
        description: 'Poor: excessive signs of wear, brassing, or finish loss, but still '
            + 'fully operational. Heavy use is apparent.',
    },
    ugly: {
        id: '7000',
        description: 'Sold for parts or repair: inoperable or too worn to be counted on '
            + 'for reliable operation.',
    },
});
export function conditionFromTags(productTags) {
    for (const tag of productTags ?? []) {
        if (!tag.startsWith('condition-'))
            continue;
        const grade = tag.slice('condition-'.length).trim();
        const mapped = CONDITION_BY_TAG[grade];
        if (mapped)
            return mapped;
    }
    return null;
}
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
export function conditionFromTitle(title) {
    if (typeof title !== 'string')
        return null;
    if (/\bFOR PARTS\b/i.test(title))
        return CONDITION_BY_TAG.ugly;
    if (/\bUSED\b/.test(title)) {
        return {
            id: '3000',
            description: 'Used: fully functional with signs of use appropriate to its age. '
                + 'The photographs show the exact item for sale.',
        };
    }
    return null;
}
/**
 * eBay refuses graded used ids in category after category (learned live:
 * 5000 in 30086, 6000 in 31388 AND in the lens category 3323 — L63/L69).
 * The store's grade survives verbatim in the condition DESCRIPTION, so
 * clamping the id to the universally-accepted 3000 loses no buyer-facing
 * information while making every category publishable. 1000/1500/2000/3000/
 * 7000 pass everywhere this store lists; everything else clamps.
 */
const EBAY_SAFE_CONDITION_ID = Object.freeze({
    '2750': '3000',
    '4000': '3000',
    '5000': '3000',
    '6000': '3000',
});
/**
 * Tag first, title-marker fallback second — with two safety rules on top:
 * a *FOR PARTS* title outranks any tag (never sell a parts item as
 * functional), and graded ids clamp to their eBay-safe equivalent while the
 * grade language stays in the description. The one derivation both the
 * draft auto-defaults and the ready-queue completeness flag must share.
 */
export function deriveCondition(productTags, title) {
    if (typeof title === 'string' && /\bFOR PARTS\b/i.test(title)) {
        return CONDITION_BY_TAG.ugly;
    }
    const derived = conditionFromTags(productTags) ?? conditionFromTitle(title);
    if (derived === null)
        return null;
    return {
        id: EBAY_SAFE_CONDITION_ID[derived.id] ?? derived.id,
        description: derived.description,
    };
}
