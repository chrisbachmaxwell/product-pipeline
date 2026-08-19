import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';

/**
 * Locally declared contract for GET /api/listing-editor-metadata.
 * Deliberately not imported from server code: the editor treats the
 * payload as untrusted and normalizes it defensively. When the request
 * fails or a list comes back empty, the draft editor degrades to plain
 * text inputs, so this data is a presentation aid only.
 */
export interface ListingEditorCondition {
  id: string;
  label: string;
}

export interface ListingEditorCategory {
  id: string;
  name: string | null;
  usageCount: number;
}

export interface ListingEditorIdUsage {
  id: string;
  usageCount: number;
}

export interface ListingEditorMetadata {
  conditions: ListingEditorCondition[];
  categories: ListingEditorCategory[];
  policies: {
    fulfillment: ListingEditorIdUsage[];
    payment: ListingEditorIdUsage[];
    return: ListingEditorIdUsage[];
  };
  merchantLocations: ListingEditorIdUsage[];
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const idString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
const usageCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const conditionList = (value: unknown): ListingEditorCondition[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
      record(item) && idString(item.id) && idString(item.label)
        ? [{ id: item.id.trim(), label: item.label.trim() }]
        : [])
    : [];

const categoryList = (value: unknown): ListingEditorCategory[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
      record(item) && idString(item.id)
        ? [{
            id: item.id.trim(),
            name: idString(item.name) ? item.name.trim() : null,
            usageCount: usageCount(item.usageCount),
          }]
        : [])
    : [];

const idUsageList = (value: unknown): ListingEditorIdUsage[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
      record(item) && idString(item.id)
        ? [{ id: item.id.trim(), usageCount: usageCount(item.usageCount) }]
        : [])
    : [];

export const normalizeListingEditorMetadata = (value: unknown): ListingEditorMetadata => {
  const source = record(value) ? value : {};
  const policies = record(source.policies) ? source.policies : {};
  return {
    conditions: conditionList(source.conditions),
    categories: categoryList(source.categories),
    policies: {
      fulfillment: idUsageList(policies.fulfillment),
      payment: idUsageList(policies.payment),
      return: idUsageList(policies.return),
    },
    merchantLocations: idUsageList(source.merchantLocations),
  };
};

const EMPTY_METADATA: ListingEditorMetadata = {
  conditions: [],
  categories: [],
  policies: { fulfillment: [], payment: [], return: [] },
  merchantLocations: [],
};

export const emptyListingEditorMetadata = (): ListingEditorMetadata => EMPTY_METADATA;

/** Read-only editor metadata; presentation aid only — never blocks editing. */
export const useListingEditorMetadata = () => useQuery({
  queryKey: ['listing-editor-metadata-v1'],
  queryFn: async () => normalizeListingEditorMetadata(
    await apiClient.get<unknown>('/listing-editor-metadata'),
  ),
  staleTime: 5 * 60_000,
  retry: 1,
  refetchOnWindowFocus: false,
});
