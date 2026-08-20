import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

export interface ListingDescriptionPreviewResponse {
  templateVersion: string;
  html: string;
}

const isListingDescriptionPreviewResponse = (
  value: unknown,
): value is ListingDescriptionPreviewResponse =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof (value as { templateVersion?: unknown }).templateVersion === 'string'
  && typeof (value as { html?: unknown }).html === 'string'
  && (value as { html: string }).html.length > 0;

/**
 * Fetches the fully rendered branded eBay description page for a catalog row.
 * The server renders from the last saved draft revision (or current live
 * values when no draft exists). Display-only: this is the only call made.
 *
 * Fetch is on demand — pass `enabled: true` when the preview modal opens.
 * Results are never kept longer than a minute (staleTime 0 forces a fresh
 * fetch on each open, so a just-saved draft is always reflected).
 */
export const useListingDescriptionPreview = (
  catalogId: string | undefined,
  options: { enabled: boolean },
) =>
  useQuery({
    queryKey: ['listing-description-preview-v1', catalogId],
    queryFn: async () => {
      const response = await apiClient.get<unknown>(
        `/listing-description-preview?id=${encodeURIComponent(catalogId ?? '')}`,
      );
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
