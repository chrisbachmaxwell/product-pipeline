import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAllowlistedListingHtml } from '../listing-html';
import { apiClient } from './useApi';
import type { ListingWorkspaceResponse } from './useListingWorkspace';

export interface ListingDraftField<T = string | null> {
  shopify: T;
  ebay: T;
  draft: T;
  editable: boolean;
}

export interface ListingDraftResponse {
  schemaVersion: 1;
  mode: 'local_draft_only';
  catalogId: string;
  identity: {
    shopifyProductGid: string;
    shopifyVariantGid: string;
    rawSku: string;
    ebaySellerId: 'usedcameragear';
    ebayMarketplaceId: 'EBAY_US';
    managementModel: 'inventory_api' | 'trading_api' | 'unmanaged' | 'unknown';
    ebayInventorySku: string | null;
    ebayOfferId: string | null;
    ebayListingId: string | null;
  };
  base: {
    catalogObservedAtUtc: string;
    detailObservedAtUtc: string | null;
    sourceDigest: `sha256:${string}`;
    ebayDigest: `sha256:${string}`;
  };
  revision: null | {
    revisionId: string;
    revisionNumber: number;
    revisionDigest: `sha256:${string}`;
    state: 'draft';
    createdAtUtc: string;
  };
  sections: {
    listing: {
      title: ListingDraftField;
      category: ListingDraftField;
      condition: ListingDraftField;
      conditionDescription: ListingDraftField;
      price: ListingDraftField;
      quantity: ListingDraftField;
    };
    content: {
      description: ListingDraftField;
      images: ListingDraftField;
      itemSpecifics: ListingDraftField;
      identifiers: ListingDraftField;
    };
    delivery: {
      fulfillmentPolicyId: ListingDraftField;
      paymentPolicyId: ListingDraftField;
      returnPolicyId: ListingDraftField;
      merchantLocation: ListingDraftField;
    };
  };
  capabilities: {
    saveDraft: boolean;
    previewChanges: boolean;
    apply: false;
    publish: false;
  };
  externalWritesPerformed: 0;
}

export interface ListingDraftSaveInput {
  schemaVersion: 1;
  action: 'save_local_draft';
  catalogId: string;
  expectedRevisionDigest: `sha256:${string}` | null;
  base: {
    sourceDigest: `sha256:${string}`;
    ebayDigest: `sha256:${string}`;
  };
  draft: {
    title: string | null;
    category: string | null;
    condition: string | null;
    conditionDescription: string | null;
    description: string | null;
    images: string | null;
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    merchantLocation: string | null;
  };
}

const positiveDecimalId = (value: string): boolean =>
  /^[1-9]\d{0,31}$/u.test(value);
const safeMerchantKey = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
// Plain text, or HTML restricted to the strict attribute-free allowlist
// (see src/web/listing-html.ts). The field stays a single string.
const safeDescription = (value: string): boolean => value.length <= 20_000
  && value.trim().length > 0
  && value.trim() === value
  && isAllowlistedListingHtml(value)
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);

export const isListingDraftSaveInput = (value: unknown): value is ListingDraftSaveInput => {
  if (!record(value) || value.schemaVersion !== 1 || value.action !== 'save_local_draft'
    || typeof value.catalogId !== 'string'
    || !(value.expectedRevisionDigest === null || digest(value.expectedRevisionDigest))
    || !record(value.base) || !digest(value.base.sourceDigest) || !digest(value.base.ebayDigest)
    || Object.keys(value.base).length !== 2 || !record(value.draft)
    || Object.keys(value.draft).sort().join(',') !== [
      'category', 'condition', 'conditionDescription', 'description',
      'fulfillmentPolicyId', 'images', 'merchantLocation', 'paymentPolicyId',
      'returnPolicyId', 'title',
    ].sort().join(',')) return false;
  const title = value.draft.title;
  const description = value.draft.description;
  if (!stringOrNull(title) || !stringOrNull(value.draft.category)
    || !stringOrNull(value.draft.condition) || !stringOrNull(value.draft.conditionDescription)
    || !stringOrNull(description) || !stringOrNull(value.draft.images)
    || !stringOrNull(value.draft.fulfillmentPolicyId)
    || !stringOrNull(value.draft.paymentPolicyId)
    || !stringOrNull(value.draft.returnPolicyId)
    || !stringOrNull(value.draft.merchantLocation)) return false;
  if (title !== null && (title.trim() !== title || title.length === 0 || title.length > 80)) return false;
  if (description !== null && !safeDescription(description)) return false;
  for (const id of [value.draft.category, value.draft.condition,
    value.draft.fulfillmentPolicyId, value.draft.paymentPolicyId,
    value.draft.returnPolicyId]) {
    if (id !== null && !positiveDecimalId(id)) return false;
  }
  if (value.draft.conditionDescription !== null
    && (value.draft.conditionDescription.trim().length === 0
      || value.draft.conditionDescription.trim() !== value.draft.conditionDescription
      || value.draft.conditionDescription.length > 1_000)) return false;
  if (value.draft.merchantLocation !== null && !safeMerchantKey(value.draft.merchantLocation)) {
    return false;
  }
  if (value.draft.images !== null) {
    const images = parseDraftImages(value.draft.images);
    if (images.length === 0 || canonicalDraftImages(images) !== value.draft.images) return false;
  }
  return true;
};

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const digest = (value: unknown): value is `sha256:${string}` =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));
const field = (value: unknown): value is ListingDraftField => record(value)
  && stringOrNull(value.shopify) && stringOrNull(value.ebay) && stringOrNull(value.draft)
  && typeof value.editable === 'boolean';

export const isListingDraftResponse = (
  value: unknown,
  expectedCatalogId?: string,
): value is ListingDraftResponse => {
  if (!record(value) || value.schemaVersion !== 1 || value.mode !== 'local_draft_only'
    || typeof value.catalogId !== 'string'
    || (expectedCatalogId !== undefined && value.catalogId !== expectedCatalogId)
    || !record(value.identity) || typeof value.identity.shopifyProductGid !== 'string'
    || typeof value.identity.shopifyVariantGid !== 'string'
    || typeof value.identity.rawSku !== 'string'
    || value.identity.ebaySellerId !== 'usedcameragear'
    || value.identity.ebayMarketplaceId !== 'EBAY_US'
    || !['inventory_api', 'trading_api', 'unmanaged', 'unknown']
      .includes(String(value.identity.managementModel))
    || !stringOrNull(value.identity.ebayInventorySku)
    || !stringOrNull(value.identity.ebayOfferId) || !stringOrNull(value.identity.ebayListingId)
    || !record(value.base) || !timestamp(value.base.catalogObservedAtUtc)
    || !(value.base.detailObservedAtUtc === null || timestamp(value.base.detailObservedAtUtc))
    || !digest(value.base.sourceDigest) || !digest(value.base.ebayDigest)
    || !record(value.sections) || !record(value.sections.listing)
    || !record(value.sections.content) || !record(value.sections.delivery)
    || !field(value.sections.listing.title) || !field(value.sections.listing.category)
    || !field(value.sections.listing.condition)
    || !field(value.sections.listing.conditionDescription)
    || !field(value.sections.listing.price) || !field(value.sections.listing.quantity)
    || !field(value.sections.content.description) || !field(value.sections.content.images)
    || !field(value.sections.content.itemSpecifics) || !field(value.sections.content.identifiers)
    || !field(value.sections.delivery.fulfillmentPolicyId)
    || !field(value.sections.delivery.paymentPolicyId)
    || !field(value.sections.delivery.returnPolicyId)
    || !field(value.sections.delivery.merchantLocation)
    || !record(value.capabilities) || typeof value.capabilities.saveDraft !== 'boolean'
    || typeof value.capabilities.previewChanges !== 'boolean'
    || value.capabilities.apply !== false || value.capabilities.publish !== false
    || value.externalWritesPerformed !== 0) return false;

  const revision = value.revision;
  if (revision !== null && (!record(revision) || typeof revision.revisionId !== 'string'
    || !Number.isSafeInteger(revision.revisionNumber) || Number(revision.revisionNumber) < 1
    || !digest(revision.revisionDigest) || revision.state !== 'draft'
    || !timestamp(revision.createdAtUtc))) return false;

  const price = value.sections.listing.price;
  const quantity = value.sections.listing.quantity;
  const itemSpecifics = value.sections.content.itemSpecifics;
  const identifiers = value.sections.content.identifiers;
  if (price.editable || quantity.editable || itemSpecifics.editable || identifiers.editable) return false;
  const draftDescription = value.sections.content.description.draft;
  if (draftDescription !== null && (
    draftDescription.length > 20_000
    || !isAllowlistedListingHtml(draftDescription)
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(draftDescription)
  )) return false;
  if (value.capabilities.saveDraft && (
    value.identity.rawSku.trim() === ''
    || value.identity.shopifyProductGid === ''
    || value.identity.shopifyVariantGid === ''
  )) return false;
  return true;
};

export const canonicalDraftImages = (value: readonly string[]): string =>
  JSON.stringify(value);

const DRAFT_IMAGE_HOSTS = new Set([
  'cdn.shopify.com',
  'i.ebayimg.com',
  'thumbs.ebaystatic.com',
  'secureir.ebaystatic.com',
  'i.ebaystatic.com',
]);

export const verifiedDraftImageUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    const allowedQueryKeys = url.hostname.toLowerCase() === 'cdn.shopify.com'
      ? new Set(['v', 'width', 'height', 'crop', 'format'])
      : new Set<string>();
    const queryKeys = [...url.searchParams.keys()];
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hash === ''
      && DRAFT_IMAGE_HOSTS.has(url.hostname.toLowerCase())
      && new Set(queryKeys).size === queryKeys.length
      && queryKeys.every((key) => allowedQueryKeys.has(key))
      && [...url.searchParams.values()].every((queryValue) =>
        queryValue.length > 0 && queryValue.length <= 64
        && /^[a-zA-Z0-9._-]+$/u.test(queryValue))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

export const parseDraftImages = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 24
      || !parsed.every((item) => typeof item === 'string')) return [];
    const safe: string[] = [];
    for (const item of parsed) {
      try {
        const url = new URL(item);
        const verified = verifiedDraftImageUrl(url.toString());
        if (!verified || safe.includes(verified)) continue;
        safe.push(verified);
      } catch {
        continue;
      }
    }
    return safe;
  } catch {
    return [];
  }
};

export const effectiveDraftImages = (fieldValue: ListingDraftField): string[] =>
  parseDraftImages(fieldValue.draft ?? fieldValue.ebay ?? fieldValue.shopify);

export const draftFieldValue = (value: ListingDraftField): string =>
  value.draft ?? '';

export const inheritedFieldValue = (value: ListingDraftField): string =>
  value.ebay ?? value.shopify ?? '';

export const isListingDraftBoundToWorkspace = (
  draft: ListingDraftResponse,
  workspace: ListingWorkspaceResponse,
): boolean => {
  const shopify = workspace.catalog.shopify;
  if (!shopify || draft.catalogId !== workspace.catalog.id || shopify.sku.trim() === '') return false;
  const expectedModel = workspace.mapping.managementModel === 'inventory_offer'
    ? 'inventory_api'
    : workspace.mapping.managementModel === 'legacy_trading'
      ? 'trading_api'
      : 'unmanaged';
  const expectedInventorySku = workspace.mapping.managementModel === 'inventory_offer'
    ? workspace.mapping.inventorySku
    : null;
  return draft.identity.shopifyProductGid === shopify.productId
    && draft.identity.shopifyVariantGid === shopify.variantId
    && draft.identity.rawSku === shopify.sku
    && draft.identity.ebayInventorySku === expectedInventorySku
    && draft.identity.ebayOfferId === workspace.mapping.offerId
    && draft.identity.ebayListingId === workspace.mapping.listingId
    && draft.identity.managementModel === expectedModel;
};

export const useListingDraft = (catalogId: string | undefined) => useQuery({
  queryKey: ['listing-draft-v1', catalogId],
  queryFn: () => apiClient.get<ListingDraftResponse>(
    `/listing-draft?id=${encodeURIComponent(catalogId ?? '')}`,
  ),
  enabled: Boolean(catalogId),
  staleTime: 0,
  refetchOnWindowFocus: true,
});

export const useSaveListingDraft = (catalogId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ListingDraftSaveInput) => {
      if (!isListingDraftSaveInput(input)) throw new Error('Draft input is invalid');
      const response = await apiClient.post<ListingDraftResponse>('/listing-draft', input);
      if (!isListingDraftResponse(response, input.catalogId)) {
        throw new Error('Saved draft response is unavailable');
      }
      return response;
    },
    onSuccess: (response) => {
      queryClient.setQueryData(['listing-draft-v1', catalogId], response);
      void queryClient.invalidateQueries({ queryKey: ['listing-draft-v1', catalogId] });
    },
  });
};
