import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

export type AuthoritativeListingStatus = 'active' | 'not_listed' | 'attention' | 'unknown';
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

export interface AuthoritativeListingItem {
  id: string;
  shopify: {
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    variantTitle: string;
    productStatus: string;
    primaryImageUrl: string | null;
    imageCount: number;
    available: number | null;
    price: {
      amount: string;
      currency: string;
    };
  } | null;
  ebay: {
    sku: string;
    state: AuthoritativeListingStatus;
    listingId: string | null;
    offerId: string | null;
    url: string | null;
    activeMatchCount: number;
    inventoryItemCount: number;
    offerCount: number;
    unpublishedArtifactCount: number;
  };
  lifecycleStatus: AuthoritativeListingStatus;
  lastVerifiedAtUtc: string;
  audit: {
    verified: boolean;
    evidenceState: 'live_verified' | 'stale';
    unresolvedCount: number;
    attentionReasons: ListingAttentionReason[];
    recoverySupported: false;
    currentRemoteStateVerified: boolean;
  };
}

export interface AuthoritativeListingsResponse {
  schemaVersion: 3;
  data: AuthoritativeListingItem[];
  total: number;
  limit: number;
  offset: number;
  source: 'shopify-admin-graphql+ebay-active-listings';
  evidenceKind: 'live_read';
  authoritative: boolean;
  remoteReadPerformed: true;
  externalWritesPerformed: 0;
  observedAtUtc: string;
  summary: {
    active: number;
    notListed: number;
    attention: number;
    unknown: number;
    totalInStock: number;
    totalVisible: number;
  };
  coverage: {
    shopify: {
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
      productStatusCounts: Record<string, number>;
    };
    ebay: {
      source: 'ebay-trading-api+ebay-inventory-api';
      marketplaceId: 'EBAY_US';
      sellerAccountVerified: true;
      observedAtUtc: string;
      trading: {
        paginationComplete: true;
        pageCount: number;
        activeListingCount: number;
      };
      inventory: {
        inventoryItemsComplete: true;
        inventoryItemPageCount: number;
        inventoryItemCount: number;
        offersComplete: true;
        offerPageCount: number;
        offerCount: number;
        unpublishedArtifactsChecked: true;
      };
    };
    join: {
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
    };
  };
  freshness: {
    state: 'fresh' | 'stale' | 'refresh_failed';
    ageMs: number;
    maxAgeMs: number;
  };
}

export const useAuthoritativeListings = (params?: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: AuthoritativeListingStatus;
  id?: string;
}) =>
  useQuery({
    queryKey: ['authoritative-listings-v3', params],
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.offset) searchParams.set('offset', String(params.offset));
      if (params?.search) searchParams.set('search', params.search);
      if (params?.status) searchParams.set('status', params.status);
      if (params?.id) searchParams.set('id', params.id);
      const query = searchParams.toString();
      return apiClient.get<AuthoritativeListingsResponse>(
        `/authoritative-listings${query ? `?${query}` : ''}`,
      );
    },
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

export const useAuthoritativeListing = (id: string | undefined) => {
  const query = useAuthoritativeListings({ limit: 1, offset: 0, id });
  const listing = query.data?.data.find((item) => item.id === id);
  return {
    ...query,
    data: query.data && listing
      ? {
          listing,
          evidence: query.data,
        }
      : undefined,
  };
};
