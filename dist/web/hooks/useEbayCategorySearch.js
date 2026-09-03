import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';
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
export const normalizeEbayCategoryQuery = (raw) => {
    const normalized = raw.trim().replace(/\s+/gu, ' ').toLowerCase();
    if (normalized.length < EBAY_CATEGORY_QUERY_MIN_LENGTH)
        return null;
    if (normalized.length > EBAY_CATEGORY_QUERY_MAX_LENGTH)
        return null;
    if (/^\d+$/u.test(normalized))
        return null;
    return normalized;
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlankString = (value) => typeof value === 'string' && value.trim() !== '';
export const normalizeEbayCategorySearchResponse = (value) => {
    if (!record(value) || !Array.isArray(value.categories))
        return [];
    const seen = new Set();
    const results = [];
    for (const item of value.categories) {
        if (results.length >= MAX_RESULTS)
            break;
        if (!record(item) || !nonBlankString(item.id) || !nonBlankString(item.name))
            continue;
        const id = item.id.trim();
        if (seen.has(id))
            continue;
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
const NO_RESULTS = [];
/**
 * Debounced live search over eBay's full category tree. A request only
 * fires once the typed text normalizes to a searchable query (>= 2 chars,
 * not pure-numeric) and 300ms have passed since the last keystroke.
 */
export const useEbayCategorySearch = (rawText) => {
    const query = normalizeEbayCategoryQuery(rawText);
    const [debouncedQuery, setDebouncedQuery] = useState(null);
    useEffect(() => {
        if (query === null) {
            setDebouncedQuery(null);
            return undefined;
        }
        const timer = setTimeout(() => setDebouncedQuery(query), EBAY_CATEGORY_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);
    const search = useQuery({
        queryKey: ['ebay-category-search-v1', debouncedQuery],
        queryFn: async () => normalizeEbayCategorySearchResponse(await apiClient.get(`/ebay-category-search?q=${encodeURIComponent(debouncedQuery ?? '')}`)),
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
