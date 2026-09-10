import { buildListingEditorMetadata } from './listing-editor-metadata.js';
/**
 * The store's grading scale (usedcameragear.com Item Condition Chart) mapped
 * to eBay's used-condition IDs, with the chart's own buyer-facing language
 * as the condition description. eBay grades: 2750 Like New · 3000 Excellent
 * · 4000 Very Good · 5000 Good · 6000 Acceptable · 7000 For parts.
 */
const CONDITION_BY_TAG = Object.freeze({
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
/** Strip the store's title decorations before asking eBay for categories. */
export function categoryQueryFromTitle(title) {
    return title
        .replace(/\(#[^)]*\)/gu, ' ')
        .replace(/\*[^*]*\*/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 120);
}
const CATEGORY_CACHE = new Map();
const CATEGORY_CACHE_TTL_MS = 24 * 60 * 60_000;
const CATEGORY_CACHE_MAX = 500;
export function createListingDefaultsReader(dependencies = {}) {
    // Runtime singletons load lazily: importing them at module top created an
    // import cycle through the workspace reader.
    const getSnapshot = dependencies.getSnapshot
        ?? (async () => (await import('./live-listing-catalog-source.js'))
            .getLiveListingCatalogSnapshot());
    const getSweepObservations = dependencies.getSweepObservations ?? null;
    const searchCategories = dependencies.searchCategories
        ?? (async (query) => (await import('./ebay-category-search.js'))
            .searchEbayCategories(query));
    const now = dependencies.now ?? Date.now;
    return async ({ title, productTags }) => {
        // Condition: purely local, from the store's own tag.
        const condition = conditionFromTags(productTags);
        // Policies: the most-used option for each slot, from the same facet data
        // the editor's dropdowns already show ("used on 115 listings").
        let fulfillmentPolicyId = null;
        let paymentPolicyId = null;
        let returnPolicyId = null;
        let merchantLocationKey = null;
        try {
            const observations = getSweepObservations
                ? getSweepObservations()
                : (await import('./listing-editor-facet-sweep.js')).editorFacetSweep.getObservations();
            const metadata = buildListingEditorMetadata(await getSnapshot(), observations);
            fulfillmentPolicyId = metadata.policies.fulfillment[0]?.id ?? null;
            paymentPolicyId = metadata.policies.payment[0]?.id ?? null;
            returnPolicyId = metadata.policies.return[0]?.id ?? null;
            merchantLocationKey = metadata.merchantLocations[0]?.id ?? null;
        }
        catch {
            // Facet data unavailable — the operator picks manually, as before.
        }
        // Category: eBay's top suggestion for the cleaned title, cached a day.
        let categoryId = null;
        let categoryName = null;
        const query = categoryQueryFromTitle(title);
        if (query.length >= 3) {
            const cached = CATEGORY_CACHE.get(query);
            if (cached && now() - cached.atMs < CATEGORY_CACHE_TTL_MS) {
                categoryId = cached.categoryId;
                categoryName = cached.categoryName;
            }
            else {
                try {
                    const result = await searchCategories(query);
                    const top = result.categories[0];
                    if (top) {
                        categoryId = top.id;
                        categoryName = top.name;
                        if (CATEGORY_CACHE.size >= CATEGORY_CACHE_MAX) {
                            const oldest = CATEGORY_CACHE.keys().next().value;
                            if (oldest !== undefined)
                                CATEGORY_CACHE.delete(oldest);
                        }
                        CATEGORY_CACHE.set(query, { categoryId, categoryName, atMs: now() });
                    }
                }
                catch {
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
