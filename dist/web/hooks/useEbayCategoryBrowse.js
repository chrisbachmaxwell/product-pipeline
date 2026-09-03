import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';
const MAX_CHILDREN = 1_000;
const MAX_CRUMBS = 12;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlankString = (value) => typeof value === 'string' && value.trim() !== '';
export const normalizeEbayCategoryBrowseResponse = (value) => {
    const empty = { parentId: null, breadcrumb: [], children: [] };
    if (!record(value))
        return empty;
    const breadcrumb = [];
    if (Array.isArray(value.breadcrumb)) {
        for (const item of value.breadcrumb) {
            if (breadcrumb.length >= MAX_CRUMBS)
                break;
            if (!record(item) || !nonBlankString(item.id) || !nonBlankString(item.name))
                continue;
            breadcrumb.push({ id: item.id.trim(), name: item.name.trim() });
        }
    }
    const children = [];
    const seen = new Set();
    if (Array.isArray(value.children)) {
        for (const item of value.children) {
            if (children.length >= MAX_CHILDREN)
                break;
            if (!record(item) || !nonBlankString(item.id) || !nonBlankString(item.name))
                continue;
            const id = item.id.trim();
            if (seen.has(id))
                continue;
            seen.add(id);
            children.push({
                id,
                name: item.name.trim(),
                leaf: item.leaf === true,
                childCount: typeof item.childCount === 'number' && Number.isFinite(item.childCount)
                    ? Math.max(0, Math.trunc(item.childCount))
                    : 0,
            });
        }
    }
    return {
        parentId: nonBlankString(value.parentId) ? value.parentId.trim() : null,
        breadcrumb,
        children,
    };
};
const EMPTY_LEVEL = { parentId: null, breadcrumb: [], children: [] };
/**
 * One level of eBay's category tree for the drill-down picker. The server
 * fetches the whole tree once and serves every level from memory, so
 * drilling costs no provider call and levels are cached aggressively here.
 * `enabled` lets the picker avoid fetching until the browse UI is actually
 * shown.
 */
export const useEbayCategoryBrowse = (parentId, enabled) => {
    const browse = useQuery({
        queryKey: ['ebay-category-browse-v1', parentId ?? ''],
        queryFn: async () => normalizeEbayCategoryBrowseResponse(await apiClient.get(`/ebay-category-browse?parent=${encodeURIComponent(parentId ?? '')}`)),
        enabled,
        staleTime: 60 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        placeholderData: keepPreviousData,
    });
    return {
        level: browse.data ?? EMPTY_LEVEL,
        isLoading: enabled && browse.isFetching,
        isError: enabled && browse.isError,
    };
};
