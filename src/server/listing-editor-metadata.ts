import { EBAY_CONDITIONS, type EbayConditionOption } from '../shared/ebay-conditions.js';
import type { LiveListingCatalogSnapshot } from './live-listing-catalog.js';

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
 *
 * A third, optional source may be merged in by the caller: the background
 * used-facet enrichment sweep (see listing-editor-facet-sweep.ts), which
 * aggregates the same observation shape from per-listing detail reads.
 * Sweep observations are merged with the snapshot observations per listing
 * id, the sweep's data winning on category names, and each listing is still
 * counted exactly once. This function itself remains synchronous and
 * performs zero remote reads — the sweep runs (or not) entirely outside it.
 */

const MAX_FACET_ENTRIES = 500;
const MAX_FACET_STRING_LENGTH = 256;

export type ListingEditorCategoryOption = Readonly<{
  id: string;
  name: string | null;
  usageCount: number;
}>;

export type ListingEditorUsageOption = Readonly<{
  id: string;
  usageCount: number;
}>;

export type ListingEditorMetadataDto = Readonly<{
  conditions: readonly EbayConditionOption[];
  categories: readonly ListingEditorCategoryOption[];
  policies: Readonly<{
    fulfillment: readonly ListingEditorUsageOption[];
    payment: readonly ListingEditorUsageOption[];
    return: readonly ListingEditorUsageOption[];
  }>;
  merchantLocations: readonly ListingEditorUsageOption[];
}>;

export class ListingEditorMetadataError extends Error {
  constructor() {
    super('Listing editor metadata is unavailable');
    this.name = 'ListingEditorMetadataError';
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

/**
 * Conservative safe-string gate for ids and names surfaced to the editor:
 * non-empty, bounded, and free of control, line-separator, and delete
 * characters. Anything else is dropped rather than escaped.
 */
function safeFacetString(value: unknown): string | null {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_FACET_STRING_LENGTH
    || value.trim().length === 0
    || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)) return null;
  return value;
}

function ascendingId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tally(counts: Map<string, number>, id: string | null): void {
  if (id === null) return;
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

function usageList(counts: Map<string, number>): readonly ListingEditorUsageOption[] {
  return Object.freeze([...counts.entries()]
    .sort(([leftId, leftCount], [rightId, rightCount]) =>
      rightCount - leftCount || ascendingId(leftId, rightId))
    .slice(0, MAX_FACET_ENTRIES)
    .map(([id, usageCount]) => Object.freeze({ id, usageCount })));
}

function categoryList(
  tallies: Map<string, { name: string | null; usageCount: number }>,
): readonly ListingEditorCategoryOption[] {
  return Object.freeze([...tallies.entries()]
    .sort(([leftId, left], [rightId, right]) =>
      right.usageCount - left.usageCount || ascendingId(leftId, rightId))
    .slice(0, MAX_FACET_ENTRIES)
    .map(([id, entry]) => Object.freeze({
      id,
      name: entry.name,
      usageCount: entry.usageCount,
    })));
}

function tallyCategory(
  categories: Map<string, { name: string | null; usageCount: number }>,
  id: string | null,
  name: string | null,
): void {
  if (id === null) return;
  const existing = categories.get(id);
  if (existing === undefined) {
    categories.set(id, { name, usageCount: 1 });
  } else {
    existing.usageCount += 1;
    if (existing.name === null) existing.name = name;
  }
}

type NormalizedFacetObservation = Readonly<{
  listingId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocationKey: string | null;
}>;

function normalizeFacetObservation(raw: unknown): NormalizedFacetObservation | null {
  const observation = asRecord(raw);
  if (observation === null) return null;
  const categoryId = safeFacetString(observation.categoryId);
  return Object.freeze({
    listingId: safeFacetString(observation.listingId),
    categoryId,
    categoryName: categoryId === null ? null : safeFacetString(observation.categoryName),
    fulfillmentPolicyId: safeFacetString(observation.fulfillmentPolicyId),
    paymentPolicyId: safeFacetString(observation.paymentPolicyId),
    returnPolicyId: safeFacetString(observation.returnPolicyId),
    merchantLocationKey: safeFacetString(observation.merchantLocationKey),
  });
}

/**
 * Per-listing merge of a snapshot-derived observation with a sweep-derived
 * one. The winner supplies each field; the category id and name always move
 * together, and the loser's name only backfills when it names the SAME
 * category id. Sweep data wins, so per-listing GetItem category names beat
 * nameless (or stale) bulk-census entries.
 */
function mergeFacetObservations(
  base: NormalizedFacetObservation,
  winner: NormalizedFacetObservation,
): NormalizedFacetObservation {
  const categorySource = winner.categoryId !== null ? winner : base;
  const categoryOther = winner.categoryId !== null ? base : winner;
  return Object.freeze({
    listingId: winner.listingId ?? base.listingId,
    categoryId: categorySource.categoryId,
    categoryName: categorySource.categoryName
      ?? (categoryOther.categoryId === categorySource.categoryId
        ? categoryOther.categoryName
        : null),
    fulfillmentPolicyId: winner.fulfillmentPolicyId ?? base.fulfillmentPolicyId,
    paymentPolicyId: winner.paymentPolicyId ?? base.paymentPolicyId,
    returnPolicyId: winner.returnPolicyId ?? base.returnPolicyId,
    merchantLocationKey: winner.merchantLocationKey ?? base.merchantLocationKey,
  });
}

export function buildListingEditorMetadata(
  snapshot: LiveListingCatalogSnapshot,
  sweepObservations: readonly unknown[] = [],
): ListingEditorMetadataDto {
  if (!Array.isArray(snapshot?.rows)) throw new ListingEditorMetadataError();
  const rows: readonly unknown[] = snapshot.rows;
  const categories = new Map<string, { name: string | null; usageCount: number }>();
  const fulfillment = new Map<string, number>();
  const payment = new Map<string, number>();
  const returnPolicies = new Map<string, number>();
  const merchantLocations = new Map<string, number>();

  const facetObservations: readonly unknown[] = Array.isArray(snapshot.editorFacets)
    ? snapshot.editorFacets
    : [];
  const safeSweepObservations: readonly unknown[] = Array.isArray(sweepObservations)
    ? sweepObservations
    : [];

  // Merge snapshot and sweep observations per listing id so a listing seen
  // by both sources is counted exactly once, with sweep fields winning.
  const observationsByListingId = new Map<string, NormalizedFacetObservation>();
  const unidentifiedObservations: NormalizedFacetObservation[] = [];
  const addObservation = (raw: unknown, sweepWins: boolean): void => {
    const observation = normalizeFacetObservation(raw);
    if (observation === null) return;
    if (observation.listingId === null) {
      unidentifiedObservations.push(observation);
      return;
    }
    const existing = observationsByListingId.get(observation.listingId);
    observationsByListingId.set(observation.listingId, existing === undefined
      ? observation
      : sweepWins
        ? mergeFacetObservations(existing, observation)
        : mergeFacetObservations(observation, existing));
  };
  for (const raw of facetObservations) addObservation(raw, false);
  for (const raw of safeSweepObservations) addObservation(raw, true);

  for (const observation of [...observationsByListingId.values(), ...unidentifiedObservations]) {
    tallyCategory(categories, observation.categoryId, observation.categoryName);
    tally(fulfillment, observation.fulfillmentPolicyId);
    tally(payment, observation.paymentPolicyId);
    tally(returnPolicies, observation.returnPolicyId);
    tally(merchantLocations, observation.merchantLocationKey);
  }

  for (const rawRow of rows) {
    const detail = asRecord(asRecord(rawRow)?.ebayDetail);
    if (detail === null) continue;
    const actual = asRecord(detail.actual);
    const offer = asRecord(asRecord(detail.management)?.offer);

    const primaryCategory = asRecord(asRecord(actual?.category)?.primary);
    tallyCategory(
      categories,
      safeFacetString(primaryCategory?.id),
      safeFacetString(primaryCategory?.name),
    );

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
