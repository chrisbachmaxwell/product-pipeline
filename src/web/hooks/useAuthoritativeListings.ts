import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

export type AuthoritativeListingStatus = 'active' | 'not_listed' | 'attention';
export type ListingAttentionReason =
  | 'shopify_product_not_active'
  | 'shopify_sku_missing'
  | 'shopify_sku_duplicate'
  | 'shopify_sku_near_collision'
  | 'ebay_sku_near_collision'
  | 'ebay_multiple_active_matches'
  | 'ebay_unpublished_artifact'
  | 'ebay_inventory_coverage_unavailable';

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
    available: number;
    price: {
      amount: string;
      currency: string;
    };
  };
  ebay: {
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
    verified: true;
    evidenceState: 'live_verified';
    unresolvedCount: number;
    attentionReasons: ListingAttentionReason[];
    recoverySupported: false;
    currentRemoteStateVerified: true;
  };
}

export interface AuthoritativeListingsResponse {
  schemaVersion: 2;
  data: AuthoritativeListingItem[];
  total: number;
  limit: number;
  offset: number;
  source: 'shopify-admin-graphql+ebay-active-listings';
  evidenceKind: 'live_read';
  authoritative: true;
  remoteReadPerformed: true;
  externalWritesPerformed: 0;
  observedAtUtc: string;
  summary: {
    active: number;
    notListed: number;
    attention: number;
    totalInStock: number;
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
    };
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
    queryKey: ['authoritative-listings-v2', params],
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
