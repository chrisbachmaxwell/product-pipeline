import { EBAY_CONDITIONS, type EbayConditionOption } from '../shared/ebay-conditions.js';
import type { LiveListingCatalogSnapshot } from './live-listing-catalog.js';

/**
 * Read-only aggregation of listing-editor picker metadata from the
 * already-cached live listing catalog snapshot. This module performs zero
 * remote reads and zero writes: it only projects whatever enriched per-listing
 * detail the cached snapshot rows already carry.
 *
 * The current snapshot rows (see live-listing-catalog.ts) do not embed the
 * enriched eBay detail (category, seller-profile policy ids, merchant
 * location key). When a row does carry that detail — under the same
 * `ebayDetail` key the listing workspace DTO uses, with the exact shape
 * produced by enriched-listing-detail.ts — it is aggregated here; rows
 * without it simply contribute nothing, so absent facets fail closed to
 * empty arrays rather than triggering any new provider request.
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

export function buildListingEditorMetadata(
  snapshot: LiveListingCatalogSnapshot,
): ListingEditorMetadataDto {
  if (!Array.isArray(snapshot?.rows)) throw new ListingEditorMetadataError();
  const rows: readonly unknown[] = snapshot.rows;
  const categories = new Map<string, { name: string | null; usageCount: number }>();
  const fulfillment = new Map<string, number>();
  const payment = new Map<string, number>();
  const returnPolicies = new Map<string, number>();
  const merchantLocations = new Map<string, number>();

  for (const rawRow of rows) {
    const detail = asRecord(asRecord(rawRow)?.ebayDetail);
    if (detail === null) continue;
    const actual = asRecord(detail.actual);
    const offer = asRecord(asRecord(detail.management)?.offer);

    const primaryCategory = asRecord(asRecord(actual?.category)?.primary);
    const categoryId = safeFacetString(primaryCategory?.id);
    if (categoryId !== null) {
      const name = safeFacetString(primaryCategory?.name);
      const existing = categories.get(categoryId);
      if (existing === undefined) {
        categories.set(categoryId, { name, usageCount: 1 });
      } else {
        existing.usageCount += 1;
        if (existing.name === null) existing.name = name;
      }
    }

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
