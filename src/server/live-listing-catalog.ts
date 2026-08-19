export type LiveListingStatus = 'active' | 'not_listed' | 'attention' | 'unknown';

export type ListingAttentionReason =
  | 'shopify_product_not_active'
  | 'shopify_sku_missing'
  | 'shopify_sku_duplicate'
  | 'shopify_sku_near_collision'
  | 'ebay_sku_near_collision'
  | 'ebay_multiple_active_matches'
  | 'ebay_unpublished_artifact'
  | 'ebay_inventory_coverage_unavailable'
  | 'ebay_active_without_shopify_variant'
  | 'ebay_active_without_sku'
  | 'shopify_inventory_not_positive'
  | 'source_snapshot_stale'
  | 'source_refresh_failed';

export type CapturedShopifyVariant = Readonly<{
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  variantTitle: string;
  productStatus: string;
  primaryImageUrl: string | null;
  imageCount: number;
  available: number | null;
  price: Readonly<{ amount: string; currency: string }>;
}>;

export type CapturedEbayActiveListing = Readonly<{
  listingId: string;
  sku: string;
  /**
   * Optional editor facets already present in the bulk Trading census
   * response. Keys are only set when the capture validated a value; they are
   * never required, so pre-existing captures and fixtures stay byte-identical.
   */
  primaryCategoryId?: string;
  primaryCategoryName?: string;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
}>;

export type CapturedEbayInventoryItem = Readonly<{ sku: string }>;

export type CapturedEbayOffer = Readonly<{
  offerId: string;
  sku: string;
  status: string | null;
  listingId: string | null;
  listingStatus: string | null;
  /** Optional editor facets already present in the bulk getOffers response. */
  categoryId?: string;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  merchantLocationKey?: string;
}>;

/**
 * Per-active-listing editor facet observation aggregated by the listing
 * editor metadata endpoint. Deliberately kept OFF the catalog rows so the
 * row-serving consumers (/api/authoritative-listings, /api/listing-workspace)
 * remain byte-identical and never expose policy or location identifiers.
 */
export type ListingEditorFacetObservation = Readonly<{
  listingId: string;
  categoryId: string | null;
  categoryName: string | null;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocationKey: string | null;
}>;

export type LiveCatalogCoverage = Readonly<{
  shopify: Readonly<{
    source: 'shopify-admin-graphql';
    storeDomain: string;
    shopId: string;
    observedAtUtc: string;
    paginationComplete: true;
    variantPageCount: number;
    totalVariantsCaptured: number;
    positiveStockVariants: number;
    excludedZeroInventory: number;
    excludedUnknownInventory: number;
    productStatusCounts: Readonly<Record<string, number>>;
  }>;
  ebay: Readonly<{
    source: 'ebay-trading-api+ebay-inventory-api';
    marketplaceId: 'EBAY_US';
    sellerAccountVerified: true;
    observedAtUtc: string;
    trading: Readonly<{
      paginationComplete: true;
      pageCount: number;
      activeListingCount: number;
    }>;
    inventory: Readonly<{
      inventoryItemsComplete: true;
      inventoryItemPageCount: number;
      inventoryItemCount: number;
      offersComplete: true;
      offerPageCount: number;
      offerCount: number;
      unpublishedArtifactsChecked: true;
    }>;
  }>;
  join: Readonly<{
    key: 'exact_raw_sku';
    missingShopifySkuCount: number;
    duplicateShopifySkuCount: number;
    shopifyNearCollisionCount: number;
    ebayNearCollisionCount: number;
    ambiguousActiveMatchCount: number;
    unpublishedArtifactSkuCount: number;
    zeroStockActiveShopifyCount: number;
    unmatchedEbaySkuCount: number;
    unmatchedEbayListingCount: number;
  }>;
}>;

export type LiveListingCatalogRow = Readonly<{
  id: string;
  shopify: Readonly<{
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    variantTitle: string;
    productStatus: string;
    primaryImageUrl: string | null;
    imageCount: number;
    available: number | null;
    price: Readonly<{ amount: string; currency: string }>;
  }> | null;
  ebay: Readonly<{
    sku: string;
    state: LiveListingStatus;
    listingId: string | null;
    offerId: string | null;
    url: string | null;
    activeMatchCount: number;
    inventoryItemCount: number;
    offerCount: number;
    unpublishedArtifactCount: number;
  }>;
  lifecycleStatus: LiveListingStatus;
  lastVerifiedAtUtc: string;
  audit: Readonly<{
    verified: boolean;
    evidenceState: 'live_verified' | 'stale';
    unresolvedCount: number;
    attentionReasons: readonly ListingAttentionReason[];
    recoverySupported: false;
    currentRemoteStateVerified: boolean;
  }>;
}>;

export type LiveListingCatalogSnapshot = Readonly<{
  observedAtUtc: string;
  rows: readonly LiveListingCatalogRow[];
  /** Additive; absent on hand-built snapshots. Never served through row projections. */
  editorFacets?: readonly ListingEditorFacetObservation[];
  summary: Readonly<{
    active: number;
    notListed: number;
    attention: number;
    unknown: number;
    totalInStock: number;
    totalVisible: number;
  }>;
  coverage: LiveCatalogCoverage;
}>;

export const MAX_LIVE_LISTING_SNAPSHOT_AGE_MS = 5 * 60_000;

export type LiveListingCatalogPage = Readonly<{
  schemaVersion: 3;
  data: readonly LiveListingCatalogRow[];
  total: number;
  limit: number;
  offset: number;
  summary: LiveListingCatalogSnapshot['summary'];
  source: 'shopify-admin-graphql+ebay-active-listings';
  evidenceKind: 'live_read';
  authoritative: boolean;
  remoteReadPerformed: true;
  externalWritesPerformed: 0;
  observedAtUtc: string;
  freshness: Readonly<{
    state: 'fresh' | 'stale' | 'refresh_failed';
    ageMs: number;
    maxAgeMs: number;
  }>;
  coverage: LiveCatalogCoverage;
}>;

export class LiveListingCatalogError extends Error {
  constructor() {
    super('Live listing catalog is unavailable');
    this.name = 'LiveListingCatalogError';
  }
}

function normalizedSku(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}

function duplicateExactSkus(values: readonly { sku: string }[]): Set<string> {
  const groups = groupBy(values.filter((value) => value.sku !== ''), (value) => value.sku);
  return new Set([...groups].filter(([, group]) => group.length > 1).map(([sku]) => sku));
}

function nearCollisionSkus(values: readonly { sku: string }[]): Set<string> {
  const groups = groupBy(values.filter((value) => value.sku !== ''), (value) => normalizedSku(value.sku));
  const collisions = new Set<string>();
  for (const group of groups.values()) {
    if (new Set(group.map((value) => value.sku)).size > 1) {
      for (const value of group) collisions.add(value.sku);
    }
  }
  return collisions;
}

function crossSourceNearCollisionShopifySkus(
  shopifyValues: readonly { sku: string }[],
  ebayValues: readonly { sku: string }[],
): Set<string> {
  const ebayRawByNormalized = new Map<string, Set<string>>();
  for (const value of ebayValues) {
    if (value.sku === '') continue;
    const key = normalizedSku(value.sku);
    const rawValues = ebayRawByNormalized.get(key) ?? new Set<string>();
    rawValues.add(value.sku);
    ebayRawByNormalized.set(key, rawValues);
  }

  const affectedShopifySkus = new Set<string>();
  for (const value of shopifyValues) {
    if (value.sku === '') continue;
    const ebayRawValues = ebayRawByNormalized.get(normalizedSku(value.sku));
    if (ebayRawValues && [...ebayRawValues].some((rawSku) => rawSku !== value.sku)) {
      affectedShopifySkus.add(value.sku);
    }
  }
  return affectedShopifySkus;
}

/**
 * One facet observation per unique active listing, merged from the bulk
 * Trading census (preferred, carries the category name) and the bulk offer
 * census (offer categoryId, listing policies, merchant location). Listings
 * where neither capture exposed any facet are omitted entirely.
 */
function buildEditorFacets(
  activeListings: readonly CapturedEbayActiveListing[],
  offers: readonly CapturedEbayOffer[],
): readonly ListingEditorFacetObservation[] {
  const offersByListingId = new Map<string, CapturedEbayOffer>();
  for (const offer of offers) {
    if (offer.listingId !== null && !offersByListingId.has(offer.listingId)) {
      offersByListingId.set(offer.listingId, offer);
    }
  }
  const observations = new Map<string, ListingEditorFacetObservation>();
  for (const listing of activeListings) {
    if (observations.has(listing.listingId)) continue;
    const offer = offersByListingId.get(listing.listingId);
    const categoryId = listing.primaryCategoryId ?? offer?.categoryId ?? null;
    const observation: ListingEditorFacetObservation = Object.freeze({
      listingId: listing.listingId,
      categoryId,
      categoryName: listing.primaryCategoryId !== undefined
        ? listing.primaryCategoryName ?? null
        : null,
      fulfillmentPolicyId: listing.fulfillmentPolicyId ?? offer?.fulfillmentPolicyId ?? null,
      paymentPolicyId: listing.paymentPolicyId ?? offer?.paymentPolicyId ?? null,
      returnPolicyId: listing.returnPolicyId ?? offer?.returnPolicyId ?? null,
      merchantLocationKey: offer?.merchantLocationKey ?? null,
    });
    if (observation.categoryId !== null
      || observation.fulfillmentPolicyId !== null
      || observation.paymentPolicyId !== null
      || observation.returnPolicyId !== null
      || observation.merchantLocationKey !== null) {
      observations.set(listing.listingId, observation);
    }
  }
  return Object.freeze([...observations.values()]);
}

function requireUnique<T>(values: readonly T[], key: (value: T) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) throw new LiveListingCatalogError();
    seen.add(identity);
  }
}

export function buildLiveListingCatalogSnapshot(input: Readonly<{
  observedAtUtc: string;
  shopifyVariants: readonly CapturedShopifyVariant[];
  ebayActiveListings: readonly CapturedEbayActiveListing[];
  ebayInventoryItems: readonly CapturedEbayInventoryItem[];
  ebayOffers: readonly CapturedEbayOffer[];
  coverage: Omit<LiveCatalogCoverage, 'join'>;
}>): LiveListingCatalogSnapshot {
  if (Number.isNaN(new Date(input.observedAtUtc).getTime())) throw new LiveListingCatalogError();
  const positiveStockVariants = input.shopifyVariants.filter((variant) =>
    variant.available !== null && variant.available > 0).length;
  const nonpositiveStockVariants = input.shopifyVariants.filter((variant) =>
    variant.available !== null && variant.available <= 0).length;
  const unknownStockVariants = input.shopifyVariants.filter((variant) =>
    variant.available === null).length;
  if (input.coverage.shopify.totalVariantsCaptured !== input.shopifyVariants.length
    || input.coverage.shopify.positiveStockVariants !== positiveStockVariants
    || input.coverage.shopify.excludedZeroInventory !== nonpositiveStockVariants
    || input.coverage.shopify.excludedUnknownInventory !== unknownStockVariants
    || input.coverage.ebay.trading.activeListingCount
      !== new Set(input.ebayActiveListings.map((value) => value.listingId)).size
    || input.coverage.ebay.inventory.inventoryItemCount !== input.ebayInventoryItems.length
    || input.coverage.ebay.inventory.offerCount !== input.ebayOffers.length
    || input.shopifyVariants.some((variant) => variant.available !== null
      && !Number.isInteger(variant.available))) throw new LiveListingCatalogError();
  requireUnique(input.shopifyVariants, (value) => value.variantId);
  requireUnique(input.ebayActiveListings, (value) => `${value.listingId}\u0000${value.sku}`);
  requireUnique(input.ebayInventoryItems, (value) => value.sku);
  requireUnique(input.ebayOffers, (value) => value.offerId);

  const duplicateShopify = duplicateExactSkus(input.shopifyVariants);
  const nearShopify = nearCollisionSkus(input.shopifyVariants);
  const ebaySkuValues = [
    ...input.ebayActiveListings,
    ...input.ebayInventoryItems,
    ...input.ebayOffers,
  ];
  const nearEbay = nearCollisionSkus(ebaySkuValues);
  const crossSourceNear = crossSourceNearCollisionShopifySkus(
    input.shopifyVariants,
    ebaySkuValues,
  );
  const activeBySku = groupBy(input.ebayActiveListings, (value) => value.sku);
  const inventoryBySku = groupBy(input.ebayInventoryItems, (value) => value.sku);
  const offersBySku = groupBy(input.ebayOffers, (value) => value.sku);

  let missingShopifySkuCount = 0;
  let ambiguousActiveMatchCount = 0;
  let unpublishedArtifactSkuCount = 0;
  let zeroStockActiveShopifyCount = 0;

  const shopifyRows = input.shopifyVariants.flatMap((variant): LiveListingCatalogRow[] => {
    const reasons = new Set<ListingAttentionReason>();
    if (variant.productStatus.toUpperCase() !== 'ACTIVE') reasons.add('shopify_product_not_active');
    if (variant.sku.trim() === '') {
      reasons.add('shopify_sku_missing');
      missingShopifySkuCount += 1;
    }
    if (duplicateShopify.has(variant.sku)) reasons.add('shopify_sku_duplicate');
    if (nearShopify.has(variant.sku)) reasons.add('shopify_sku_near_collision');
    if (nearEbay.has(variant.sku) || crossSourceNear.has(variant.sku)) {
      reasons.add('ebay_sku_near_collision');
    }

    const skuCanJoin = variant.sku !== '';
    const activeMatches = skuCanJoin ? activeBySku.get(variant.sku) ?? [] : [];
    const inventoryItems = skuCanJoin ? inventoryBySku.get(variant.sku) ?? [] : [];
    const offers = skuCanJoin ? offersBySku.get(variant.sku) ?? [] : [];
    if (activeMatches.length > 1) {
      reasons.add('ebay_multiple_active_matches');
      ambiguousActiveMatchCount += 1;
    }

    const activeListing = activeMatches.length === 1 ? activeMatches[0]! : null;
    const shouldInclude = (variant.available !== null && variant.available > 0)
      || activeMatches.length > 0
      || inventoryItems.length > 0
      || offers.length > 0;
    if (!shouldInclude) return [];
    if (activeMatches.length > 0 && (variant.available === null || variant.available <= 0)) {
      reasons.add('shopify_inventory_not_positive');
      zeroStockActiveShopifyCount += 1;
    }
    const compatiblePublishedOffer = activeListing !== null
      && inventoryItems.length === 1
      && offers.length === 1
      && offers[0]!.status === 'PUBLISHED'
      && offers[0]!.listingId === activeListing.listingId
      && offers[0]!.listingStatus === 'ACTIVE';
    const artifactsAreExpected = activeMatches.length === 1
      && ((inventoryItems.length === 0 && offers.length === 0) || compatiblePublishedOffer);
    const unpublishedArtifactCount = artifactsAreExpected
      ? 0
      : inventoryItems.length + offers.length;
    if ((inventoryItems.length > 0 || offers.length > 0) && !artifactsAreExpected) {
      reasons.add('ebay_unpublished_artifact');
      unpublishedArtifactSkuCount += 1;
    }

    const lifecycleStatus: LiveListingStatus = reasons.size > 0
      ? 'attention'
      : activeMatches.length === 1
        ? 'active'
        : 'not_listed';
    const matchingOffer = activeListing
      ? offers.find((offer) => offer.listingId === activeListing.listingId) ?? null
      : null;

    return [Object.freeze({
      id: `shopify-variant:${variant.variantId}`,
      shopify: Object.freeze({ ...variant, price: Object.freeze({ ...variant.price }) }),
      ebay: Object.freeze({
        sku: variant.sku,
        state: lifecycleStatus,
        listingId: activeListing?.listingId ?? null,
        offerId: matchingOffer?.offerId ?? null,
        url: activeListing ? `https://www.ebay.com/itm/${activeListing.listingId}` : null,
        activeMatchCount: activeMatches.length,
        inventoryItemCount: inventoryItems.length,
        offerCount: offers.length,
        unpublishedArtifactCount,
      }),
      lifecycleStatus,
      lastVerifiedAtUtc: input.observedAtUtc,
      audit: Object.freeze({
        verified: true as const,
        evidenceState: 'live_verified' as const,
        unresolvedCount: reasons.size,
        attentionReasons: Object.freeze([...reasons].sort()),
        recoverySupported: false as const,
        currentRemoteStateVerified: true as const,
      }),
    })];
  });

  const shopifyRawSkus = new Set(input.shopifyVariants
    .map((variant) => variant.sku)
    .filter((sku) => sku !== ''));
  const unmatchedActiveBySku = groupBy(input.ebayActiveListings.filter((listing) =>
    listing.sku === '' || !shopifyRawSkus.has(listing.sku)), (listing) => listing.sku);
  const unmatchedRows = [...unmatchedActiveBySku.entries()].flatMap(([sku, activeMatches]) => {
    const byListingId = groupBy(activeMatches, (listing) => listing.listingId);
    return [...byListingId.values()].map((listingMatches): LiveListingCatalogRow => {
      const activeListing = listingMatches[0]!;
      const inventoryItems = sku === '' ? [] : inventoryBySku.get(sku) ?? [];
      const offers = sku === '' ? [] : offersBySku.get(sku) ?? [];
      const matchingOffer = offers.find((candidate) => candidate.listingId === activeListing.listingId)
        ?? null;
      const reasons: ListingAttentionReason[] = [
        sku === '' ? 'ebay_active_without_sku' : 'ebay_active_without_shopify_variant',
      ];
      return Object.freeze({
        id: `ebay-listing:${activeListing.listingId}:sku:${encodeURIComponent(sku || '(missing)')}`,
        shopify: null,
        ebay: Object.freeze({
          sku,
          state: 'attention' as const,
          listingId: activeListing.listingId,
          offerId: matchingOffer?.offerId ?? null,
          url: `https://www.ebay.com/itm/${activeListing.listingId}`,
          activeMatchCount: 1,
          inventoryItemCount: inventoryItems.length,
          offerCount: offers.length,
          unpublishedArtifactCount: 0,
        }),
        lifecycleStatus: 'attention' as const,
        lastVerifiedAtUtc: input.observedAtUtc,
        audit: Object.freeze({
          verified: true,
          evidenceState: 'live_verified' as const,
          unresolvedCount: reasons.length,
          attentionReasons: Object.freeze(reasons),
          recoverySupported: false as const,
          currentRemoteStateVerified: true,
        }),
      });
    });
  });

  const rows = [...shopifyRows, ...unmatchedRows].sort((left, right) =>
    (left.shopify?.title ?? (left.ebay.sku || `eBay ${left.ebay.listingId ?? ''}`))
      .localeCompare(right.shopify?.title ?? (right.ebay.sku || `eBay ${right.ebay.listingId ?? ''}`))
    || (left.shopify?.sku ?? left.ebay.sku).localeCompare(right.shopify?.sku ?? right.ebay.sku)
    || left.id.localeCompare(right.id));

  const summary = Object.freeze({
    active: rows.filter((row) => row.lifecycleStatus === 'active').length,
    notListed: rows.filter((row) => row.lifecycleStatus === 'not_listed').length,
    attention: rows.filter((row) => row.lifecycleStatus === 'attention').length,
    unknown: 0,
    totalInStock: rows.filter((row) => typeof row.shopify?.available === 'number'
      && row.shopify.available > 0).length,
    totalVisible: rows.length,
  });
  const coverage: LiveCatalogCoverage = Object.freeze({
    ...input.coverage,
    join: Object.freeze({
      key: 'exact_raw_sku' as const,
      missingShopifySkuCount,
      duplicateShopifySkuCount: duplicateShopify.size,
      shopifyNearCollisionCount: nearShopify.size,
      ebayNearCollisionCount: new Set(input.shopifyVariants
        .filter((variant) => nearEbay.has(variant.sku) || crossSourceNear.has(variant.sku))
        .map((variant) => variant.sku)).size,
      ambiguousActiveMatchCount,
      unpublishedArtifactSkuCount,
      zeroStockActiveShopifyCount,
      unmatchedEbaySkuCount: new Set(input.ebayActiveListings
        .filter((listing) => listing.sku !== '' && !shopifyRawSkus.has(listing.sku))
        .map((listing) => listing.sku)).size,
      unmatchedEbayListingCount: new Set(input.ebayActiveListings
        .filter((listing) => listing.sku === '' || !shopifyRawSkus.has(listing.sku))
        .map((listing) => listing.listingId)).size,
    }),
  });

  return Object.freeze({
    observedAtUtc: input.observedAtUtc,
    rows: Object.freeze(rows),
    editorFacets: buildEditorFacets(input.ebayActiveListings, input.ebayOffers),
    summary,
    coverage,
  });
}

export function projectLiveListingCatalogPage(
  snapshot: LiveListingCatalogSnapshot,
  input: Readonly<{
    limit: number;
    offset: number;
    search?: string;
    status?: LiveListingStatus;
    id?: string;
    nowEpochMs?: number;
    maxAgeMs?: number;
    refreshFailed?: boolean;
  }>,
): LiveListingCatalogPage {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isInteger(input.offset) || input.offset < 0) throw new LiveListingCatalogError();
  const search = input.search?.trim().toLocaleLowerCase('en-US') ?? '';
  const exactId = input.id?.trim() ?? '';
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? MAX_LIVE_LISTING_SNAPSHOT_AGE_MS;
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw new LiveListingCatalogError();
  const observedEpochMs = new Date(snapshot.observedAtUtc).getTime();
  const ageMs = Math.max(0, nowEpochMs - observedEpochMs);
  const staleByAge = ageMs > maxAgeMs;
  const refreshFailed = input.refreshFailed === true;
  const unknown = staleByAge || refreshFailed;
  const unknownReason: ListingAttentionReason = refreshFailed
    ? 'source_refresh_failed'
    : 'source_snapshot_stale';
  const projectedRows: readonly LiveListingCatalogRow[] = unknown
    ? Object.freeze(snapshot.rows.map((row) => Object.freeze({
        ...row,
        ebay: Object.freeze({ ...row.ebay, state: 'unknown' as const }),
        lifecycleStatus: 'unknown' as const,
        audit: Object.freeze({
          ...row.audit,
          verified: false,
          evidenceState: 'stale' as const,
          unresolvedCount: row.audit.unresolvedCount + 1,
          attentionReasons: Object.freeze([
            ...new Set([...row.audit.attentionReasons, unknownReason]),
          ]),
          currentRemoteStateVerified: false,
        }),
      })))
    : snapshot.rows;
  const projectedSummary = unknown
    ? Object.freeze({
        active: 0,
        notListed: 0,
        attention: 0,
        unknown: projectedRows.length,
        totalInStock: snapshot.summary.totalInStock,
        totalVisible: projectedRows.length,
      })
    : snapshot.summary;
  const filtered = projectedRows.filter((row) => {
    if (exactId && row.id !== exactId) return false;
    if (input.status && row.lifecycleStatus !== input.status) return false;
    if (!search) return true;
    return [row.id, row.shopify?.productId, row.shopify?.variantId, row.shopify?.sku,
      row.shopify?.title, row.shopify?.variantTitle, row.ebay.sku,
      row.ebay.listingId, row.ebay.offerId]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase('en-US').includes(search));
  });
  return Object.freeze({
    schemaVersion: 3 as const,
    data: Object.freeze(filtered.slice(input.offset, input.offset + input.limit)),
    total: filtered.length,
    limit: input.limit,
    offset: input.offset,
    summary: projectedSummary,
    source: 'shopify-admin-graphql+ebay-active-listings' as const,
    evidenceKind: 'live_read' as const,
    authoritative: !unknown,
    remoteReadPerformed: true as const,
    externalWritesPerformed: 0 as const,
    observedAtUtc: snapshot.observedAtUtc,
    freshness: Object.freeze({
      state: refreshFailed
        ? 'refresh_failed' as const
        : staleByAge ? 'stale' as const : 'fresh' as const,
      ageMs,
      maxAgeMs,
    }),
    coverage: snapshot.coverage,
  });
}
