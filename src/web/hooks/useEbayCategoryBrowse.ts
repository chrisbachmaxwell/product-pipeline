import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

/**
 * Locally declared contract for GET /api/ebay-category-browse?parent=<id>.
 * Deliberately not imported from server code: the picker treats the payload
 * as untrusted and normalizes it defensively. When the request fails the
 * picker keeps working from search, used-category metadata, and free numeric
 * entry, so this data is a presentation aid only.
 */
export interface EbayCategoryBrowseNode {
  id: string;
  name: string;
  /** False when the node has children to drill into. */
  leaf: boolean;
  childCount: number;
}

export interface EbayCategoryBrowseCrumb {
  id: string;
  name: string;
}

export interface EbayCategoryBrowseLevel {
  parentId: string | null;
  /** Root-first ancestors of the current level, including its parent. */
  breadcrumb: EbayCategoryBrowseCrumb[];
  children: EbayCategoryBrowseNode[];
}

const MAX_CHILDREN = 1_000;
const MAX_CRUMBS = 12;

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export const normalizeEbayCategoryBrowseResponse = (
  value: unknown,
): EbayCategoryBrowseLevel => {
  const empty: EbayCategoryBrowseLevel = { parentId: null, breadcrumb: [], children: [] };
  if (!record(value)) return empty;

  const breadcrumb: EbayCategoryBrowseCrumb[] = [];
  if (Array.isArray(value.breadcrumb)) {
    for (const item of value.breadcrumb) {
      if (breadcrumb.length >= MAX_CRUMBS) break;
      if (!record(item) || !nonBlankString(item.id) || !nonBlankString(item.name)) continue;
      breadcrumb.push({ id: item.id.trim(), name: item.name.trim() });
    }
  }

  const children: EbayCategoryBrowseNode[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.children)) {
    for (const item of value.children) {
      if (children.length >= MAX_CHILDREN) break;
      if (!record(item) || !nonBlankString(item.id) || !nonBlankString(item.name)) continue;
      const id = item.id.trim();
      if (seen.has(id)) continue;
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

const EMPTY_LEVEL: EbayCategoryBrowseLevel = { parentId: null, breadcrumb: [], children: [] };

export interface EbayCategoryBrowseState {
  level: EbayCategoryBrowseLevel;
  isLoading: boolean;
  isError: boolean;
}

/**
 * One level of eBay's category tree for the drill-down picker. The server
 * fetches the whole tree once and serves every level from memory, so
 * drilling costs no provider call and levels are cached aggressively here.
 * `enabled` lets the picker avoid fetching until the browse UI is actually
 * shown.
 */
export const useEbayCategoryBrowse = (
  parentId: string | null,
  enabled: boolean,
): EbayCategoryBrowseState => {
  const browse = useQuery({
    queryKey: ['ebay-category-browse-v1', parentId ?? ''],
    queryFn: async () => normalizeEbayCategoryBrowseResponse(
      await apiClient.get<unknown>(
        `/ebay-category-browse?parent=${encodeURIComponent(parentId ?? '')}`,
      ),
    ),
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
