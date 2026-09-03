import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';
const isListingDescriptionPreviewResponse = (value) => value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.templateVersion === 'string'
    && typeof value.html === 'string'
    && value.html.length > 0;
/**
 * Fetches the fully rendered branded eBay description page for a catalog row.
 * The server renders from the last saved draft revision (or current live
 * values when no draft exists). Display-only: this is the only call made.
 *
 * Fetch is on demand — pass `enabled: true` when the preview modal opens.
 * Results are never kept longer than a minute (staleTime 0 forces a fresh
 * fetch on each open, so a just-saved draft is always reflected).
 */
export const useListingDescriptionPreview = (catalogId, options) => useQuery({
    queryKey: ['listing-description-preview-v1', catalogId],
    queryFn: async () => {
        const response = await apiClient.get(`/listing-description-preview?id=${encodeURIComponent(catalogId ?? '')}`);
        if (!isListingDescriptionPreviewResponse(response)) {
            throw new Error('Description preview is unavailable');
        }
        return response;
    },
    enabled: options.enabled && Boolean(catalogId),
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
});
