import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

export type AuthoritativeListingStatus = 'attention' | 'ready' | 'active' | 'ended';

export interface AuthoritativeListingItem {
  id: string;
  shopify: {
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    primaryImageUrl: string | null;
    imageCount: number;
  };
  ebay: {
    listingId: string;
    offerId: string;
    url: string;
  };
  price: {
    amount: string;
    currency: 'USD';
  } | null;
  lifecycleStatus: AuthoritativeListingStatus;
  lastVerifiedAtUtc: string;
  audit: {
    verified: boolean;
    evidenceState: 'verified' | 'invalid' | 'unavailable';
    unresolvedCount: number;
    recoverySupported: boolean;
    currentRemoteStateVerified: boolean;
  };
}

export interface AuthoritativeListingsResponse {
  schemaVersion: 1;
  data: AuthoritativeListingItem[];
  total: number;
  limit: number;
  offset: number;
  source: 'production-listing-audit-ledger';
  evidenceKind: 'verified_snapshot';
  authoritative: false;
  remoteReadPerformed: false;
  externalWritesPerformed: 0;
}

export const useAuthoritativeListings = (params?: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: AuthoritativeListingStatus;
}) =>
  useQuery({
    queryKey: ['authoritative-listings', params],
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.offset) searchParams.set('offset', String(params.offset));
      if (params?.search) searchParams.set('search', params.search);
      if (params?.status) searchParams.set('status', params.status);
      const query = searchParams.toString();
      return apiClient.get<AuthoritativeListingsResponse>(
        `/authoritative-listings${query ? `?${query}` : ''}`,
      );
    },
  });

export const useAuthoritativeListing = (id: string | undefined) =>
  useQuery({
    queryKey: ['authoritative-listing', id],
    queryFn: async () => {
      const query = new URLSearchParams({ limit: '1', offset: '0', search: id ?? '' });
      const response = await apiClient.get<AuthoritativeListingsResponse>(
        `/authoritative-listings?${query.toString()}`,
      );
      const listing = response.data.find((item) => item.id === id);
      if (!listing) throw new Error('Listing not found');
      return { listing, evidence: response };
    },
    enabled: Boolean(id),
  });
