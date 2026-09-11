import { buildListingEditorMetadata } from './listing-editor-metadata.js';
import { conditionFromTags } from '../shared/condition-tags.js';

export { conditionFromTags } from '../shared/condition-tags.js';
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

/**
 * The store's grading scale (usedcameragear.com Item Condition Chart) mapped
 * to eBay's used-condition IDs, with the chart's own buyer-facing language
 * as the condition description. eBay grades: 2750 Like New · 3000 Excellent
 * · 4000 Very Good · 5000 Good · 6000 Acceptable · 7000 For parts.
 */
/** Strip the store's title decorations before asking eBay for categories. */
export function categoryQueryFromTitle(title: string): string {
  return title
    .replace(/\(#[^)]*\)/gu, ' ')
    .replace(/\*[^*]*\*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
}

const CATEGORY_CACHE = new Map<string, { categoryId: string; categoryName: string; atMs: number }>();
const CATEGORY_CACHE_TTL_MS = 24 * 60 * 60_000;
const CATEGORY_CACHE_MAX = 500;

export function createListingDefaultsReader(dependencies: Readonly<{
  getSnapshot?: () => Promise<Parameters<typeof buildListingEditorMetadata>[0]>;
  getSweepObservations?: () => readonly unknown[];
  searchCategories?: EbayCategorySearch;
  now?: () => number;
}> = {}): (input: Readonly<{
  title: string;
  productTags: readonly string[] | undefined;
}>) => Promise<ListingDefaults> {
  // Runtime singletons load lazily: importing them at module top created an
  // import cycle through the workspace reader.
  const getSnapshot = dependencies.getSnapshot
    ?? (async () => (await import('./live-listing-catalog-source.js'))
      .getLiveListingCatalogSnapshot());
  const getSweepObservations = dependencies.getSweepObservations ?? null;
  const searchCategories = dependencies.searchCategories
    ?? (async (query: unknown) => (await import('./ebay-category-search.js'))
      .searchEbayCategories(query));
  const now = dependencies.now ?? Date.now;

  return async ({ title, productTags }) => {
    // Condition: purely local, from the store's own tag.
    const condition = conditionFromTags(productTags);

    // Policies: the most-used option for each slot, from the same facet data
    // the editor's dropdowns already show ("used on 115 listings").
    let fulfillmentPolicyId: string | null = null;
    let paymentPolicyId: string | null = null;
    let returnPolicyId: string | null = null;
    let merchantLocationKey: string | null = null;
    try {
      const observations = getSweepObservations ? getSweepObservations() : [];
      const metadata = buildListingEditorMetadata(await getSnapshot(), observations);
      fulfillmentPolicyId = metadata.policies.fulfillment[0]?.id ?? null;
      paymentPolicyId = metadata.policies.payment[0]?.id ?? null;
      returnPolicyId = metadata.policies.return[0]?.id ?? null;
      merchantLocationKey = metadata.merchantLocations[0]?.id ?? null;
    } catch {
      // Facet data unavailable — the operator picks manually, as before.
    }

    // Category: eBay's top suggestion for the cleaned title, cached a day.
    let categoryId: string | null = null;
    let categoryName: string | null = null;
    const query = categoryQueryFromTitle(title);
    if (query.length >= 3) {
      const cached = CATEGORY_CACHE.get(query);
      if (cached && now() - cached.atMs < CATEGORY_CACHE_TTL_MS) {
        categoryId = cached.categoryId;
        categoryName = cached.categoryName;
      } else {
        try {
          const result = await searchCategories(query);
          const top = result.categories[0];
          if (top) {
            categoryId = top.id;
            categoryName = top.name;
            if (CATEGORY_CACHE.size >= CATEGORY_CACHE_MAX) {
              const oldest = CATEGORY_CACHE.keys().next().value;
              if (oldest !== undefined) CATEGORY_CACHE.delete(oldest);
            }
            CATEGORY_CACHE.set(query, { categoryId, categoryName, atMs: now() });
          }
        } catch {
          // Suggestion unavailable — the operator picks manually, as before.
        }
      }
    }

    return Object.freeze({
      conditionId: condition?.id ?? null,
      conditionDescription: condition?.description ?? null,
      categoryId,
      categoryName,
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
      merchantLocationKey,
    });
  };
}
