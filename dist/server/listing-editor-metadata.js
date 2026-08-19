import { EBAY_CONDITIONS } from '../shared/ebay-conditions.js';
/**
 * Read-only aggregation of listing-editor picker metadata from the
 * already-cached live listing catalog snapshot. This module performs zero
 * remote reads and zero writes: it only projects whatever enriched per-listing
 * detail the cached snapshot rows already carry.
 *
 * Two cached sources are aggregated, both revalidated here before use:
 *
 * 1. `snapshot.editorFacets` — per-active-listing facet observations the
 *    census capture already extracts from the bulk Trading and getOffers
 *    response bodies (see buildEditorFacets in live-listing-catalog.ts).
 *    This is the production path. The observations deliberately live OFF
 *    the catalog rows so row-serving endpoints never expose policy or
 *    location identifiers.
 * 2. Rows carrying an optional `ebayDetail` payload (the listing-workspace
 *    key, in the exact enriched-listing-detail.ts shape), should a future
 *    snapshot embed per-row detail.
 *
 * Rows and observations without usable data simply contribute nothing, so
 * absent facets fail closed to empty arrays rather than triggering any new
 * provider request.
 */
const MAX_FACET_ENTRIES = 500;
const MAX_FACET_STRING_LENGTH = 256;
export class ListingEditorMetadataError extends Error {
    constructor() {
        super('Listing editor metadata is unavailable');
        this.name = 'ListingEditorMetadataError';
    }
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/**
 * Conservative safe-string gate for ids and names surfaced to the editor:
 * non-empty, bounded, and free of control, line-separator, and delete
 * characters. Anything else is dropped rather than escaped.
 */
function safeFacetString(value) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_FACET_STRING_LENGTH
        || value.trim().length === 0
        || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value))
        return null;
    return value;
}
function ascendingId(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function tally(counts, id) {
    if (id === null)
        return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
}
function usageList(counts) {
    return Object.freeze([...counts.entries()]
        .sort(([leftId, leftCount], [rightId, rightCount]) => rightCount - leftCount || ascendingId(leftId, rightId))
        .slice(0, MAX_FACET_ENTRIES)
        .map(([id, usageCount]) => Object.freeze({ id, usageCount })));
}
function categoryList(tallies) {
    return Object.freeze([...tallies.entries()]
        .sort(([leftId, left], [rightId, right]) => right.usageCount - left.usageCount || ascendingId(leftId, rightId))
        .slice(0, MAX_FACET_ENTRIES)
        .map(([id, entry]) => Object.freeze({
        id,
        name: entry.name,
        usageCount: entry.usageCount,
    })));
}
function tallyCategory(categories, id, name) {
    if (id === null)
        return;
    const existing = categories.get(id);
    if (existing === undefined) {
        categories.set(id, { name, usageCount: 1 });
    }
    else {
        existing.usageCount += 1;
        if (existing.name === null)
            existing.name = name;
    }
}
export function buildListingEditorMetadata(snapshot) {
    if (!Array.isArray(snapshot?.rows))
        throw new ListingEditorMetadataError();
    const rows = snapshot.rows;
    const categories = new Map();
    const fulfillment = new Map();
    const payment = new Map();
    const returnPolicies = new Map();
    const merchantLocations = new Map();
    const facetObservations = Array.isArray(snapshot.editorFacets)
        ? snapshot.editorFacets
        : [];
    for (const rawObservation of facetObservations) {
        const observation = asRecord(rawObservation);
        if (observation === null)
            continue;
        const categoryId = safeFacetString(observation.categoryId);
        tallyCategory(categories, categoryId, safeFacetString(observation.categoryName));
        tally(fulfillment, safeFacetString(observation.fulfillmentPolicyId));
        tally(payment, safeFacetString(observation.paymentPolicyId));
        tally(returnPolicies, safeFacetString(observation.returnPolicyId));
        tally(merchantLocations, safeFacetString(observation.merchantLocationKey));
    }
    for (const rawRow of rows) {
        const detail = asRecord(asRecord(rawRow)?.ebayDetail);
        if (detail === null)
            continue;
        const actual = asRecord(detail.actual);
        const offer = asRecord(asRecord(detail.management)?.offer);
        const primaryCategory = asRecord(asRecord(actual?.category)?.primary);
        tallyCategory(categories, safeFacetString(primaryCategory?.id), safeFacetString(primaryCategory?.name));
        const policies = asRecord(actual?.policies);
        tally(fulfillment, safeFacetString(policies?.fulfillmentPolicyId)
            ?? safeFacetString(offer?.fulfillmentPolicyId));
        tally(payment, safeFacetString(policies?.paymentPolicyId)
            ?? safeFacetString(offer?.paymentPolicyId));
        tally(returnPolicies, safeFacetString(policies?.returnPolicyId)
            ?? safeFacetString(offer?.returnPolicyId));
        tally(merchantLocations, safeFacetString(offer?.merchantLocationKey));
    }
    return Object.freeze({
        conditions: EBAY_CONDITIONS,
        categories: categoryList(categories),
        policies: Object.freeze({
            fulfillment: usageList(fulfillment),
            payment: usageList(payment),
            return: usageList(returnPolicies),
        }),
        merchantLocations: usageList(merchantLocations),
    });
}
export const LISTING_EDITOR_METADATA_TESTING = Object.freeze({
    MAX_FACET_ENTRIES,
    MAX_FACET_STRING_LENGTH,
});
