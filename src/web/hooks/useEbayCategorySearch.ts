import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

/**
 * Locally declared contract for GET /api/ebay-category-search?q=<text>.
 * Deliberately not imported from server code: the picker treats the payload
 * as untrusted and normalizes it defensively. When the request fails the
 * category picker keeps working from used-category metadata and free
 * numeric entry, so this data is a presentation aid only.
 */
export interface EbayCategorySearchResult {
  id: string;
  name: string;
  /** Full tree path, e.g. "Electronics > Cameras & Photo > …". */
  path: string;
  leaf: boolean;
}

export const EBAY_CATEGORY_QUERY_MIN_LENGTH = 2;
export const EBAY_CATEGORY_QUERY_MAX_LENGTH = 100;
export const EBAY_CATEGORY_SEARCH_DEBOUNCE_MS = 300;
const MAX_RESULTS = 25;

/**
 * Normalizes raw picker text into the query string sent to the endpoint,
 * or null when the text must not trigger a search: blank or too short
 * (< 2 chars), longer than the endpoint accepts (> 100 chars), or
 * pure-numeric input — digits are direct category-id entry, never a search.
 * Normalization (trim, collapse whitespace, lowercase) also serves as the
 * react-query cache key, so retyping an equivalent query reuses the cache.
 */
export const normalizeEbayCategoryQuery = (raw: string): string | null => {
  const normalized = raw.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (normalized.length < EBAY_CATEGORY_QUERY_MIN_LENGTH) return null;
  if (normalized.length > EBAY_CATEGORY_QUERY_MAX_LENGTH) return null;
  if (/^\d+$/u.test(normalized)) return null;
  return normalized;
};

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export const normalizeEbayCategorySearchResponse = (
  value: unknown,
): EbayCategorySearchResult[] => {
  if (!record(value) || !Array.isArray(value.categories)) return [];
  const seen = new Set<string>();
  const results: EbayCategorySearchResult[] = [];
  for (const item of value.categories) {
    if (results.length >= MAX_RESULTS) break;
    if (!record(item) || !nonBlankString(item.id) || !nonBlankString(item.name)) continue;
    const id = item.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      name: item.name.trim(),
      path: nonBlankString(item.path) ? item.path.trim() : '',
      leaf: item.leaf === true,
    });
  }
  return results;
};

const NO_RESULTS: EbayCategorySearchResult[] = [];

export interface EbayCategorySearchState {
  /** Normalized current query, or null when the input is not searchable. */
  query: string | null;
  /** Latest available results (may briefly lag the query while fetching). */
  results: EbayCategorySearchResult[];
  /** True while waiting out the debounce or while the request is in flight. */
  isSearching: boolean;
  /** True when the most recent fired search failed. */
  isError: boolean;
}

/**
 * Debounced live search over eBay's full category tree. A request only
 * fires once the typed text normalizes to a searchable query (>= 2 chars,
 * not pure-numeric) and 300ms have passed since the last keystroke.
 */
export const useEbayCategorySearch = (rawText: string): EbayCategorySearchState => {
  const query = normalizeEbayCategoryQuery(rawText);
  const [debouncedQuery, setDebouncedQuery] = useState<string | null>(null);

  useEffect(() => {
    if (query === null) {
      setDebouncedQuery(null);
      return undefined;
    }
    const timer = setTimeout(
      () => setDebouncedQuery(query),
      EBAY_CATEGORY_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    queryKey: ['ebay-category-search-v1', debouncedQuery],
    queryFn: async () => normalizeEbayCategorySearchResponse(
      await apiClient.get<unknown>(
        `/ebay-category-search?q=${encodeURIComponent(debouncedQuery ?? '')}`,
      ),
    ),
    enabled: debouncedQuery !== null,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  return {
    query,
    results: query !== null && search.data ? search.data : NO_RESULTS,
    isSearching: query !== null && (debouncedQuery !== query || search.isFetching),
    isError: query !== null && debouncedQuery !== null && search.isError,
  };
};
