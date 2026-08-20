import { getLiveListingCatalogSnapshot } from './live-listing-catalog-source.js';
import { readListingWorkspace, } from './listing-workspace-reader.js';
/**
 * Background used-facet enrichment sweep for the listing editor metadata
 * endpoint.
 *
 * The bulk Trading census (`GetMyeBaySelling` ActiveList) omits
 * `PrimaryCategory`/`SellerProfiles` for the seller's legacy listings, so the
 * snapshot-derived `editorFacets` observations are nearly empty in
 * production. The per-listing Trading `GetItem` read the workspace already
 * performs DOES return the primary category (id + name) and seller-profile
 * ids, so this module re-uses that exact existing read path — one
 * `readListingWorkspace(rowId)` per active listing, no new call shapes — to
 * aggregate the same facet observation shape `editorFacets` uses.
 *
 * Strictly read-only and strictly non-blocking:
 * - No sweep runs on server boot and no timer runs when nothing is asked
 *   for. The first metadata request finding an empty or expired cache starts
 *   one background sweep; concurrent requests coalesce onto it.
 * - A metadata request NEVER waits on a sweep. It merges whatever aggregate
 *   the cache currently holds (possibly nothing; possibly the previous
 *   aggregate while a refresh runs) into the snapshot-derived facets.
 * - Per-listing read failures are skipped; they never fail the sweep. A
 *   failed snapshot read aborts the sweep without caching, so the next
 *   request retries.
 * - At most 150 listings per sweep, at most 3 detail reads in flight, and
 *   the completed aggregate is cached in memory for 6 hours.
 */
const SWEEP_TTL_MS = 6 * 60 * 60_000;
const MAX_SWEEP_LISTINGS = 150;
const SWEEP_CONCURRENCY = 3;
const MAX_FACET_STRING_LENGTH = 256;
const NO_OBSERVATIONS = Object.freeze([]);
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/** Same conservative safe-string gate the metadata aggregation applies. */
function safeFacetString(value) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_FACET_STRING_LENGTH
        || value.trim().length === 0
        || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value))
        return null;
    return value;
}
/**
 * Project one workspace DTO's enriched eBay detail into the exact
 * `editorFacets` observation shape, dropping any absent or unsafe field.
 * Returns null when the detail is missing, unidentifiable, or carries no
 * facet at all.
 */
function observationFromWorkspace(dto) {
    const detail = asRecord(asRecord(dto)?.ebayDetail);
    if (detail === null)
        return null;
    const listingId = safeFacetString(asRecord(detail.identity)?.listingId);
    if (listingId === null)
        return null;
    const actual = asRecord(detail.actual);
    const offer = asRecord(asRecord(detail.management)?.offer);
    const primaryCategory = asRecord(asRecord(actual?.category)?.primary);
    const policies = asRecord(actual?.policies);
    const categoryId = safeFacetString(primaryCategory?.id);
    const observation = Object.freeze({
        listingId,
        categoryId,
        categoryName: categoryId === null ? null : safeFacetString(primaryCategory?.name),
        fulfillmentPolicyId: safeFacetString(policies?.fulfillmentPolicyId)
            ?? safeFacetString(offer?.fulfillmentPolicyId),
        paymentPolicyId: safeFacetString(policies?.paymentPolicyId)
            ?? safeFacetString(offer?.paymentPolicyId),
        returnPolicyId: safeFacetString(policies?.returnPolicyId)
            ?? safeFacetString(offer?.returnPolicyId),
        merchantLocationKey: safeFacetString(offer?.merchantLocationKey),
    });
    return observation.categoryId !== null
        || observation.fulfillmentPolicyId !== null
        || observation.paymentPolicyId !== null
        || observation.returnPolicyId !== null
        || observation.merchantLocationKey !== null
        ? observation
        : null;
}
/**
 * Active listing identities from the cached census snapshot: catalog row ids
 * whose row is bound to exactly one active eBay listing, deduplicated by
 * listing id, capped at the per-sweep bound.
 */
function collectSweepIdentities(snapshot) {
    if (!Array.isArray(snapshot?.rows))
        return [];
    const identities = [];
    const seenListingIds = new Set();
    for (const rawRow of snapshot.rows) {
        if (identities.length >= MAX_SWEEP_LISTINGS)
            break;
        const row = asRecord(rawRow);
        const rowId = safeFacetString(row?.id);
        const listingId = safeFacetString(asRecord(row?.ebay)?.listingId);
        if (row === null || rowId === null || listingId === null)
            continue;
        if (row.lifecycleStatus !== 'active')
            continue;
        if (seenListingIds.has(listingId))
            continue;
        seenListingIds.add(listingId);
        identities.push(rowId);
    }
    return identities;
}
export function createEditorFacetSweep(dependencies) {
    const now = dependencies.now ?? Date.now;
    let cache = null;
    let sweepInFlight = null;
    async function runSweep() {
        let identities;
        try {
            identities = collectSweepIdentities(await dependencies.getSnapshot());
        }
        catch {
            // Snapshot unavailable: abort without caching so the next request retries.
            return;
        }
        const observations = [];
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, identities.length) }, async () => {
            while (nextIndex < identities.length) {
                const identity = identities[nextIndex];
                nextIndex += 1;
                try {
                    const observation = observationFromWorkspace(await dependencies.readListingDetail(identity));
                    if (observation !== null)
                        observations.push(observation);
                }
                catch {
                    // Per-listing failure: skip this listing, never fail the sweep.
                }
            }
        });
        await Promise.all(workers);
        cache = {
            observations: Object.freeze(observations),
            expiresAt: now() + SWEEP_TTL_MS,
        };
    }
    return Object.freeze({
        getObservations: () => {
            try {
                const expired = cache === null || cache.expiresAt <= now();
                if (expired && sweepInFlight === null) {
                    sweepInFlight = runSweep()
                        .catch(() => undefined)
                        .finally(() => { sweepInFlight = null; });
                }
                return cache?.observations ?? NO_OBSERVATIONS;
            }
            catch {
                return NO_OBSERVATIONS;
            }
        },
        settle: async () => {
            while (sweepInFlight !== null)
                await sweepInFlight;
        },
    });
}
/**
 * Production sweep bound to the same cached census snapshot and the same
 * per-listing workspace read path the workspace endpoint uses. Constructing
 * it performs no work: the first metadata request drives the first sweep.
 */
export const editorFacetSweep = createEditorFacetSweep({
    getSnapshot: getLiveListingCatalogSnapshot,
    readListingDetail: readListingWorkspace,
});
export const EDITOR_FACET_SWEEP_TESTING = Object.freeze({
    SWEEP_TTL_MS,
    MAX_SWEEP_LISTINGS,
    SWEEP_CONCURRENCY,
    collectSweepIdentities,
    observationFromWorkspace,
});
