/**
 * The store's condition-… tag vocabulary mapped to eBay condition ids and
 * the published grading chart's buyer-facing language. Single source of
 * truth for BOTH the draft auto-defaults (listing-defaults.ts) and the
 * catalog's ready-queue completeness flag (live-listing-catalog.ts) — a
 * ready row whose tags map to nothing here cannot auto-fill a condition
 * and will fail create preflight until the operator tags it or picks one.
 */
export const CONDITION_BY_TAG: Readonly<Record<string, { id: string; description: string }>> = Object.freeze({
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

export function conditionFromTags(
  productTags: readonly string[] | undefined,
): { id: string; description: string } | null {
  for (const tag of productTags ?? []) {
    if (!tag.startsWith('condition-')) continue;
    const grade = tag.slice('condition-'.length).trim();
    const mapped = CONDITION_BY_TAG[grade];
    if (mapped) return mapped;
  }
  return null;
}

