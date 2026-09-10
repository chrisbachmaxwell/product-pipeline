import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';
export const useAuthoritativeListings = (params) => useQuery({
    queryKey: ['authoritative-listings-v3', params],
    queryFn: () => {
        const searchParams = new URLSearchParams();
        if (params?.limit)
            searchParams.set('limit', String(params.limit));
        if (params?.offset)
            searchParams.set('offset', String(params.offset));
        if (params?.search)
            searchParams.set('search', params.search);
        if (params?.status)
            searchParams.set('status', params.status);
        if (params?.ready)
            searchParams.set('ready', '1');
        if (params?.id)
            searchParams.set('id', params.id);
        const query = searchParams.toString();
        return apiClient.get(`/authoritative-listings${query ? `?${query}` : ''}`);
    },
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // Keep showing the previous page while a new search/filter/page loads:
    // without this every keystroke blanked the table into a spinner.
    placeholderData: keepPreviousData,
});
export const useAuthoritativeListing = (id) => {
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
