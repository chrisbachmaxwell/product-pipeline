import type {
  AuthoritativeListingItem,
  AuthoritativeListingStatus,
  AuthoritativeListingsResponse,
} from './hooks/useAuthoritativeListings';

export type ListingFilter = 'all' | AuthoritativeListingStatus;

export const LISTING_FILTERS: Array<{ label: string; value: ListingFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Fix needed', value: 'attention' },
  { label: 'Not on eBay', value: 'not_listed' },
  { label: 'On eBay', value: 'active' },
  { label: 'Checking', value: 'unknown' },
];

export const listingFilterOptions = (
  summary: AuthoritativeListingsResponse['summary'] | undefined,
): Array<{ label: string; value: ListingFilter }> => {
  if (!summary) return LISTING_FILTERS;
  const counts: Record<ListingFilter, number> = {
    all: summary.totalVisible,
    attention: summary.attention,
    not_listed: summary.notListed,
    active: summary.active,
    unknown: summary.unknown,
  };
  return LISTING_FILTERS.map((option) => ({
    ...option,
    label: `${option.label} (${counts[option.value]})`,
  }));
};

// The column is literally titled "eBay", so every label answers exactly
// "what is this item's eBay situation?" — the operator asked "most say
// Active, is that active on eBay?" and the answer must be in the label.
export const listingStatusLabel = (
  status: AuthoritativeListingStatus,
  readyToList?: boolean,
): string => {
  if (status === 'active') return 'On eBay';
  if (status === 'not_listed') return readyToList ? 'Ready to list' : 'Not on eBay';
  if (status === 'unknown') return 'Checking…';
  return 'Fix needed';
};

export const listingStatusTone = (
  status: AuthoritativeListingStatus,
  readyToList?: boolean,
): 'critical' | 'success' | 'attention' | 'info' | undefined => {
  if (status === 'attention') return 'critical';
  if (status === 'active') return 'success';
  if (status === 'unknown') return 'attention';
  // Plain gray for merely-not-listed; blue for the ready queue.
  return readyToList ? 'info' : undefined;
};

export const listingActionLabel = (
  status: AuthoritativeListingStatus,
  readyToList?: boolean,
): 'View' | 'Review' | 'Details' | 'Publish' => {
  if (status === 'active') return 'View';
  if (status === 'not_listed') return readyToList ? 'Publish' : 'Review';
  return 'Details';
};

export const listingSkuLabel = (sku: string): string => sku.trim() || 'Missing SKU';

export const formatListingPrice = (
  price: NonNullable<AuthoritativeListingItem['shopify']>['price'] | null,
): string => {
  if (!price) return '—';
  const amount = Number(price.amount);
  if (!Number.isFinite(amount) || !price.currency) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency,
  }).format(amount);
};

export const formatWorkspaceMoney = (
  money: { value: string; currency: string } | null,
): string => formatListingPrice(money ? { amount: money.value, currency: money.currency } : null);

export const formatListingQuantity = (value: number | null): string =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '—';

export const formatVerifiedAt = (value: string | null | undefined): string => {
  if (!value) return 'Update unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Update unavailable';
  return `Updated ${new Intl.DateTimeFormat('en-US', {
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
    response.summary?.unknown,
    response.summary?.totalInStock,
    response.summary?.totalVisible,
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
    response.coverage?.join?.zeroStockActiveShopifyCount,
    response.coverage?.join?.unmatchedEbaySkuCount,
    response.coverage?.join?.unmatchedEbayListingCount,
    response.freshness?.ageMs,
    response.freshness?.maxAgeMs,
  ];
  if (!counts.every((count) => Number.isInteger(count) && count >= 0)) return false;
  if (response.limit < 1 || response.limit > 100) return false;
  if (response.data.length > response.limit || response.data.length > response.total) return false;
  if (new Set(response.data.map((listing) => listing.id)).size !== response.data.length) return false;
  if (response.total > response.summary.totalVisible) return false;
  if (
    response.summary.totalVisible !==
    response.summary.active + response.summary.notListed + response.summary.attention
      + response.summary.unknown
    || response.summary.totalInStock > response.summary.totalVisible
  ) {
    return false;
  }

  const validStatuses = new Set<AuthoritativeListingStatus>([
    'active', 'not_listed', 'attention', 'unknown',
  ]);
  const validAttentionReasons = new Set<AuthoritativeListingItem['audit']['attentionReasons'][number]>([
    'shopify_product_not_active',
    'shopify_sku_missing',
    'shopify_sku_duplicate',
    'shopify_sku_near_collision',
    'ebay_sku_near_collision',
    'ebay_multiple_active_matches',
    'ebay_unpublished_artifact',
    'ebay_inventory_coverage_unavailable',
    'ebay_active_without_shopify_variant',
    'ebay_active_without_sku',
    'shopify_inventory_not_positive',
    'source_snapshot_stale',
    'source_refresh_failed',
  ]);
  const rowsValid = response.data.every((listing) => {
    const ebayCounts = [
      listing?.ebay?.activeMatchCount,
      listing?.ebay?.inventoryItemCount,
      listing?.ebay?.offerCount,
      listing?.ebay?.unpublishedArtifactCount,
      listing?.audit?.unresolvedCount,
    ];
    const shopifyValid = listing.shopify === null
      ? listing.id === `ebay-listing:${listing.ebay?.listingId}:sku:${encodeURIComponent(listing.ebay?.sku || '(missing)')}`
      : listing.id === `shopify-variant:${listing.shopify.variantId}` &&
        typeof listing.shopify.title === 'string' &&
        typeof listing.shopify.sku === 'string' &&
        (listing.shopify.available === null || Number.isInteger(listing.shopify.available));
    const freshRow = response.freshness.state === 'fresh';
    const commonValid =
      typeof listing?.id === 'string' &&
      shopifyValid &&
      typeof listing.ebay?.sku === 'string' &&
      validStatuses.has(listing.lifecycleStatus) &&
      listing.ebay?.state === listing.lifecycleStatus &&
      listing.audit?.verified === freshRow &&
      listing.audit.evidenceState === (freshRow ? 'live_verified' : 'stale') &&
      listing.audit.currentRemoteStateVerified === freshRow &&
      Array.isArray(listing.audit.attentionReasons) &&
      listing.audit.attentionReasons.every((reason) => validAttentionReasons.has(reason)) &&
      ebayCounts.every((count) => Number.isInteger(count) && count >= 0) &&
      !Number.isNaN(new Date(listing.lastVerifiedAtUtc).getTime());
    if (!commonValid) return false;

    if (listing.lifecycleStatus === 'unknown') {
      return !freshRow &&
        (listing.audit.attentionReasons.includes('source_snapshot_stale')
          || listing.audit.attentionReasons.includes('source_refresh_failed')) &&
        listing.audit.unresolvedCount > 0;
    }
    if (!freshRow || listing.shopify === null && listing.lifecycleStatus !== 'attention') return false;

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
      return listing.shopify !== null &&
        typeof listing.shopify.available === 'number' && listing.shopify.available > 0 &&
        listing.ebay.activeMatchCount === 0 &&
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
    response.schemaVersion === 3 &&
    response.source === 'shopify-admin-graphql+ebay-active-listings' &&
    response.evidenceKind === 'live_read' &&
    response.authoritative === (response.freshness.state === 'fresh') &&
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
    ((response.freshness.state === 'fresh' && response.summary.unknown === 0) ||
      (['stale', 'refresh_failed'].includes(response.freshness.state) &&
        response.summary.active === 0 &&
        response.summary.notListed === 0 &&
        response.summary.attention === 0 &&
        response.summary.unknown === response.summary.totalVisible)) &&
    !Number.isNaN(new Date(response.coverage.shopify.observedAtUtc).getTime()) &&
    !Number.isNaN(new Date(response.coverage.ebay.observedAtUtc).getTime()) &&
    !Number.isNaN(new Date(response.observedAtUtc).getTime());
};

export const listingAttentionText = (listing: AuthoritativeListingItem): string | null => {
  if (listing.lifecycleStatus === 'unknown') return 'Current state unavailable';
  if (listing.lifecycleStatus !== 'attention') return null;
  const labels: Record<AuthoritativeListingItem['audit']['attentionReasons'][number], string> = {
    shopify_product_not_active: 'Product is not active',
    shopify_sku_missing: 'SKU is missing',
    shopify_sku_duplicate: 'Duplicate Shopify SKU',
    shopify_sku_near_collision: 'Two products have almost the same SKU',
    ebay_sku_near_collision: 'An eBay listing has an almost-matching SKU',
    ebay_multiple_active_matches: 'More than one eBay listing uses this SKU',
    ebay_unpublished_artifact: 'Leftover eBay draft data to clean up',
    ebay_inventory_coverage_unavailable: 'Could not read eBay just now',
    ebay_active_without_shopify_variant: 'Live on eBay but missing from Shopify',
    ebay_active_without_sku: 'eBay listing has no SKU to match on',
    shopify_inventory_not_positive: 'Shopify does not track stock for this item',
    source_snapshot_stale: 'Status is a few minutes old',
    source_refresh_failed: 'Could not refresh just now',
  };
  return listing.audit.attentionReasons[0]
    ? labels[listing.audit.attentionReasons[0]]
    : 'Review required';
};

export const listingDisplayTitle = (listing: AuthoritativeListingItem): string =>
  listing.shopify?.title
  ?? (listing.ebay.sku.trim() ? listing.ebay.sku : null)
  ?? (listing.ebay.listingId ? `eBay listing ${listing.ebay.listingId}` : 'Unmapped eBay listing');

export const listingDisplaySku = (listing: AuthoritativeListingItem): string =>
  listing.shopify?.sku ?? listing.ebay.sku;

export const descriptionSummary = (value: string | null, maximum = 240): string => {
  if (!value) return '—';
  const plain = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  if (!plain) return '—';
  return plain.length <= maximum ? plain : `${plain.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
};

export const verifiedShopifyProductUrl = (productId: string | null): string | null => {
  if (!productId) return null;
  const match = /^gid:\/\/shopify\/Product\/(\d+)$/u.exec(productId);
  return match?.[1]
    ? `https://admin.shopify.com/store/usedcameragear/products/${match[1]}`
    : null;
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
