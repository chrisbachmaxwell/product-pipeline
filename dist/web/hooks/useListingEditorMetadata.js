import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const idString = (value) => typeof value === 'string' && value.trim() !== '';
const usageCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
const conditionList = (value) => Array.isArray(value)
    ? value.flatMap((item) => record(item) && idString(item.id) && idString(item.label)
        ? [{ id: item.id.trim(), label: item.label.trim() }]
        : [])
    : [];
const categoryList = (value) => Array.isArray(value)
    ? value.flatMap((item) => record(item) && idString(item.id)
        ? [{
                id: item.id.trim(),
                name: idString(item.name) ? item.name.trim() : null,
                usageCount: usageCount(item.usageCount),
            }]
        : [])
    : [];
const idUsageList = (value) => Array.isArray(value)
    ? value.flatMap((item) => record(item) && idString(item.id)
        ? [{ id: item.id.trim(), usageCount: usageCount(item.usageCount) }]
        : [])
    : [];
export const normalizeListingEditorMetadata = (value) => {
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
const EMPTY_METADATA = {
    conditions: [],
    categories: [],
    policies: { fulfillment: [], payment: [], return: [] },
    merchantLocations: [],
};
export const emptyListingEditorMetadata = () => EMPTY_METADATA;
/** Read-only editor metadata; presentation aid only — never blocks editing. */
export const useListingEditorMetadata = () => useQuery({
    queryKey: ['listing-editor-metadata-v1'],
    queryFn: async () => normalizeListingEditorMetadata(await apiClient.get('/listing-editor-metadata')),
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
});
