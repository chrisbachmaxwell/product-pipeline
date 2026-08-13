import type {
  AuthoritativeListingItem,
  AuthoritativeListingStatus,
  AuthoritativeListingsResponse,
} from './hooks/useAuthoritativeListings';

export type ListingFilter = 'all' | AuthoritativeListingStatus;

export const LISTING_FILTERS: Array<{ label: string; value: ListingFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Needs attention', value: 'attention' },
  { label: 'Not listed', value: 'not_listed' },
  { label: 'Active', value: 'active' },
];

export const listingFilterOptions = (
  summary: AuthoritativeListingsResponse['summary'] | undefined,
): Array<{ label: string; value: ListingFilter }> => {
  if (!summary) return LISTING_FILTERS;
  const counts: Record<ListingFilter, number> = {
    all: summary.totalInStock,
    attention: summary.attention,
    not_listed: summary.notListed,
    active: summary.active,
  };
  return LISTING_FILTERS.map((option) => ({
    ...option,
    label: `${option.label} (${counts[option.value]})`,
  }));
};

export const listingStatusLabel = (status: AuthoritativeListingStatus): string => {
  if (status === 'active') return 'Active when checked';
  if (status === 'not_listed') return 'Not listed when checked';
  return 'Needs attention';
};

export const listingStatusTone = (
  status: AuthoritativeListingStatus,
): 'critical' | 'success' | 'attention' => {
  if (status === 'attention') return 'critical';
  if (status === 'active') return 'success';
  return 'attention';
};

export const listingActionLabel = (
  status: AuthoritativeListingStatus,
): 'View' | 'Review' | 'Details' => {
  if (status === 'active') return 'View';
  if (status === 'not_listed') return 'Review';
  return 'Details';
};

export const listingSkuLabel = (sku: string): string => sku.trim() || 'Missing SKU';

export const formatListingPrice = (price: AuthoritativeListingItem['shopify']['price']): string => {
  const amount = Number(price.amount);
  if (!Number.isFinite(amount) || !price.currency) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency,
  }).format(amount);
};

export const formatVerifiedAt = (value: string | null | undefined): string => {
  if (!value) return 'Not checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not checked';
  return `Checked ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)}`;
};

export const verifiedEbayListingUrl = (
  listingId: string | null,
  value: string | null,
): string | null => {
  if (!listingId || !/^\d+$/.test(listingId) || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'www.ebay.com' &&
      url.pathname === `/itm/${listingId}` &&
      url.search === '' &&
      url.hash === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

export const isLiveCatalogResponse = (
  response: AuthoritativeListingsResponse | undefined,
): boolean => {
  if (!response || !Array.isArray(response.data)) return false;
  const counts = [
    response.total,
    response.limit,
    response.offset,
    response.summary?.active,
    response.summary?.notListed,
    response.summary?.attention,
    response.summary?.totalInStock,
    response.coverage?.shopify?.variantPageCount,
    response.coverage?.shopify?.totalVariantsCaptured,
    response.coverage?.shopify?.positiveStockVariants,
    response.coverage?.shopify?.excludedZeroInventory,
    response.coverage?.shopify?.excludedUnknownInventory,
    response.coverage?.ebay?.trading?.pageCount,
    response.coverage?.ebay?.trading?.activeListingCount,
    response.coverage?.ebay?.inventory?.inventoryItemPageCount,
    response.coverage?.ebay?.inventory?.inventoryItemCount,
    response.coverage?.ebay?.inventory?.offerPageCount,
    response.coverage?.ebay?.inventory?.offerCount,
    response.coverage?.join?.missingShopifySkuCount,
    response.coverage?.join?.duplicateShopifySkuCount,
    response.coverage?.join?.shopifyNearCollisionCount,
    response.coverage?.join?.ebayNearCollisionCount,
    response.coverage?.join?.ambiguousActiveMatchCount,
    response.coverage?.join?.unpublishedArtifactSkuCount,
  ];
  if (!counts.every((count) => Number.isInteger(count) && count >= 0)) return false;
  if (response.limit < 1 || response.limit > 100) return false;
  if (response.data.length > response.limit || response.data.length > response.total) return false;
  if (new Set(response.data.map((listing) => listing.id)).size !== response.data.length) return false;
  if (response.total > response.summary.totalInStock) return false;
  if (
    response.summary.totalInStock !==
    response.summary.active + response.summary.notListed + response.summary.attention
  ) {
    return false;
  }

  const validStatuses = new Set<AuthoritativeListingStatus>(['active', 'not_listed', 'attention']);
  const validAttentionReasons = new Set<AuthoritativeListingItem['audit']['attentionReasons'][number]>([
    'shopify_product_not_active',
    'shopify_sku_missing',
    'shopify_sku_duplicate',
    'shopify_sku_near_collision',
    'ebay_sku_near_collision',
    'ebay_multiple_active_matches',
    'ebay_unpublished_artifact',
    'ebay_inventory_coverage_unavailable',
  ]);
  const rowsValid = response.data.every((listing) => {
    const ebayCounts = [
      listing?.ebay?.activeMatchCount,
      listing?.ebay?.inventoryItemCount,
      listing?.ebay?.offerCount,
      listing?.ebay?.unpublishedArtifactCount,
      listing?.audit?.unresolvedCount,
    ];
    const commonValid =
      typeof listing?.id === 'string' &&
      listing.id === `shopify-variant:${listing.shopify?.variantId}` &&
      typeof listing.shopify?.title === 'string' &&
      typeof listing.shopify?.sku === 'string' &&
      typeof listing.shopify?.available === 'number' &&
      listing.shopify.available > 0 &&
      validStatuses.has(listing.lifecycleStatus) &&
      listing.ebay?.state === listing.lifecycleStatus &&
      listing.audit?.verified === true &&
      listing.audit.evidenceState === 'live_verified' &&
      listing.audit.currentRemoteStateVerified === true &&
      Array.isArray(listing.audit.attentionReasons) &&
      listing.audit.attentionReasons.every((reason) => validAttentionReasons.has(reason)) &&
      ebayCounts.every((count) => Number.isInteger(count) && count >= 0) &&
      !Number.isNaN(new Date(listing.lastVerifiedAtUtc).getTime());
    if (!commonValid) return false;

    if (listing.lifecycleStatus === 'active') {
      const validArtifactShape =
        (listing.ebay.inventoryItemCount === 0 &&
          listing.ebay.offerCount === 0 &&
          listing.ebay.offerId === null) ||
        (listing.ebay.inventoryItemCount === 1 &&
          listing.ebay.offerCount === 1 &&
          typeof listing.ebay.offerId === 'string' &&
          listing.ebay.offerId.length > 0);
      return listing.ebay.activeMatchCount === 1 &&
        validArtifactShape &&
        listing.ebay.unpublishedArtifactCount === 0 &&
        verifiedEbayListingUrl(listing.ebay.listingId, listing.ebay.url) !== null &&
        listing.audit.unresolvedCount === 0 &&
        listing.audit.attentionReasons.length === 0;
    }
    if (listing.lifecycleStatus === 'not_listed') {
      return listing.ebay.activeMatchCount === 0 &&
        listing.ebay.inventoryItemCount === 0 &&
        listing.ebay.offerCount === 0 &&
        listing.ebay.unpublishedArtifactCount === 0 &&
        listing.ebay.listingId === null &&
        listing.ebay.offerId === null &&
        listing.ebay.url === null &&
        listing.audit.unresolvedCount === 0 &&
        listing.audit.attentionReasons.length === 0;
    }
    return listing.audit.unresolvedCount > 0 && listing.audit.attentionReasons.length > 0;
  });

  return rowsValid &&
    response.schemaVersion === 2 &&
    response.source === 'shopify-admin-graphql+ebay-active-listings' &&
    response.evidenceKind === 'live_read' &&
    response.authoritative === true &&
    response.remoteReadPerformed === true &&
    response.externalWritesPerformed === 0 &&
    response.coverage.shopify.source === 'shopify-admin-graphql' &&
    response.coverage.shopify.paginationComplete === true &&
    response.coverage.shopify.positiveStockVariants === response.summary.totalInStock &&
    response.coverage.ebay.source === 'ebay-trading-api+ebay-inventory-api' &&
    response.coverage.ebay.marketplaceId === 'EBAY_US' &&
    response.coverage.ebay.sellerAccountVerified === true &&
    response.coverage.ebay.trading.paginationComplete === true &&
    response.coverage.ebay.inventory.inventoryItemsComplete === true &&
    response.coverage.ebay.inventory.offersComplete === true &&
    response.coverage.ebay.inventory.unpublishedArtifactsChecked === true &&
    response.coverage.join.key === 'exact_raw_sku' &&
    !Number.isNaN(new Date(response.coverage.shopify.observedAtUtc).getTime()) &&
    !Number.isNaN(new Date(response.coverage.ebay.observedAtUtc).getTime()) &&
    !Number.isNaN(new Date(response.observedAtUtc).getTime());
};

export const listingAttentionText = (listing: AuthoritativeListingItem): string | null => {
  if (listing.lifecycleStatus !== 'attention') return null;
  const labels: Record<AuthoritativeListingItem['audit']['attentionReasons'][number], string> = {
    shopify_product_not_active: 'Product is not active',
    shopify_sku_missing: 'SKU is missing',
    shopify_sku_duplicate: 'Duplicate Shopify SKU',
    shopify_sku_near_collision: 'Similar Shopify SKUs',
    ebay_sku_near_collision: 'Similar eBay SKUs',
    ebay_multiple_active_matches: 'Multiple active matches',
    ebay_unpublished_artifact: 'eBay inventory needs review',
    ebay_inventory_coverage_unavailable: 'eBay inventory could not be checked',
  };
  return listing.audit.attentionReasons[0]
    ? labels[listing.audit.attentionReasons[0]]
    : 'Review required';
};

export const isMigrationPolicyAvailable = (
  migration: {
    phase?: string;
    effectiveMode?: string;
    historicalBackfillAllowed?: boolean;
  } | undefined,
): boolean =>
  typeof migration?.phase === 'string' &&
  typeof migration.effectiveMode === 'string' &&
  typeof migration.historicalBackfillAllowed === 'boolean';

export const isHistoricalBackfillProtected = (
  migration: { historicalBackfillAllowed?: boolean } | undefined,
): boolean => migration?.historicalBackfillAllowed === false;

const VERIFIED_IMAGE_HOSTS = new Set([
  'cdn.shopify.com',
  'usedcameragear.com',
  'www.usedcameragear.com',
]);

export const verifiedListingImageUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && VERIFIED_IMAGE_HOSTS.has(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};
