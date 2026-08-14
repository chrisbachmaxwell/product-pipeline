import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './useApi';
import type { ListingDraftResponse } from './useListingDraft';

export type ListingProposalState =
  | 'not_prepared'
  | 'preparing'
  | 'ready'
  | 'blocked'
  | 'no_changes'
  | 'approved_local'
  | 'stale'
  | 'failed';

export type ListingProposalFieldKey =
  | 'title'
  | 'category'
  | 'condition'
  | 'conditionDescription'
  | 'price'
  | 'quantity'
  | 'description'
  | 'images'
  | 'itemSpecifics'
  | 'identifiers'
  | 'fulfillmentPolicyId'
  | 'paymentPolicyId'
  | 'returnPolicyId'
  | 'merchantLocation';

export interface ListingProposalField {
  key: ListingProposalFieldKey;
  section: 'listing' | 'content' | 'delivery';
  label: string;
  editable: boolean;
  currentShopify: string | null;
  currentEbay: string | null;
  proposed: string | null;
  source:
    | 'shopify'
    | 'ebay'
    | 'saved_draft'
    | 'business_rule'
    | 'agent_selection'
    | 'omit';
  decision: 'keep' | 'add' | 'change' | 'remove' | 'observe_only';
  confidence: 'high' | 'review' | 'blocked';
  reasonCode: string;
}

export interface ListingProposalWarning {
  code: string;
  severity: 'warning' | 'blocking';
  fieldKey: ListingProposalFieldKey | null;
  message: string;
}

export interface ListingProposalResponse {
  schemaVersion: 1;
  mode: 'local_ai_proposal_only';
  catalogId: string;
  identity: ListingDraftResponse['identity'];
  base: {
    catalogObservedAtUtc: string;
    detailObservedAtUtc: string | null;
    sourceDigest: `sha256:${string}`;
    ebayDigest: `sha256:${string}`;
    policyDigest: `sha256:${string}`;
  };
  state: ListingProposalState;
  eventDigest: `sha256:${string}` | null;
  proposal: null | {
    id: string;
    digest: `sha256:${string}`;
    generatedAtUtc: string;
    generator: {
      agentVersion: string;
      policyVersion: string;
      model: string;
    };
    summary: {
      changedFieldCount: number;
      blockedFieldCount: number;
    };
    fields: readonly ListingProposalField[];
    warnings: readonly ListingProposalWarning[];
    review: {
      status: 'unreviewed' | 'approved_local';
      reviewedAtUtc: string | null;
    };
  };
  capabilities: {
    generate: boolean;
    review: boolean;
    adjustLocal: boolean;
    approveLocal: boolean;
    apply: false;
    publish: false;
  };
  externalCommerceWritesPerformed: 0;
  aiRequestsPerformed: 0 | 1;
}

interface ListingProposalBaseCas {
  sourceDigest: `sha256:${string}`;
  ebayDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
}

export interface GenerateListingProposalInput {
  schemaVersion: 1;
  action: 'generate_local_proposal';
  catalogId: string;
  expectedRevisionDigest: `sha256:${string}` | null;
  base: ListingProposalBaseCas;
}

export interface ApproveListingProposalInput {
  schemaVersion: 1;
  action: 'approve_local_proposal';
  catalogId: string;
  proposalId: string;
  proposalDigest: `sha256:${string}`;
  expectedEventDigest: `sha256:${string}`;
  base: ListingProposalBaseCas;
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: UnknownRecord, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const stringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const digest = (value: unknown): value is `sha256:${string}` =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));
const safeSingleLine = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum
  && value.trim() === value
  && !/[\u0000-\u001F\u007F]/u.test(value);
const safeValue = (value: unknown): value is string | null => value === null || (
  typeof value === 'string'
  && Array.from(value).length <= 500_000
  && new TextEncoder().encode(value).byteLength <= 2_000_000
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
);
const nonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const proposalIdentity = (
  value: unknown,
): value is ListingDraftResponse['identity'] => record(value)
  && exactKeys(value, [
    'shopifyProductGid', 'shopifyVariantGid', 'rawSku', 'ebaySellerId',
    'ebayMarketplaceId', 'managementModel', 'ebayInventorySku', 'ebayOfferId',
    'ebayListingId',
  ])
  && typeof value.shopifyProductGid === 'string'
  && typeof value.shopifyVariantGid === 'string'
  && typeof value.rawSku === 'string'
  && value.ebaySellerId === 'usedcameragear'
  && value.ebayMarketplaceId === 'EBAY_US'
  && ['inventory_api', 'trading_api', 'unmanaged', 'unknown']
    .includes(String(value.managementModel))
  && stringOrNull(value.ebayInventorySku)
  && stringOrNull(value.ebayOfferId)
  && stringOrNull(value.ebayListingId);

const baseCas = (value: unknown): value is ListingProposalBaseCas => record(value)
  && exactKeys(value, ['sourceDigest', 'ebayDigest', 'policyDigest'])
  && digest(value.sourceDigest) && digest(value.ebayDigest) && digest(value.policyDigest);

const proposalField = (value: unknown): value is ListingProposalField => {
  if (!record(value)
    || !exactKeys(value, [
      'key', 'section', 'label', 'editable', 'currentShopify', 'currentEbay',
      'proposed', 'source', 'decision', 'confidence', 'reasonCode',
    ])
    || ![
      'title', 'category', 'condition', 'conditionDescription', 'price', 'quantity',
      'description', 'images', 'itemSpecifics', 'identifiers', 'fulfillmentPolicyId',
      'paymentPolicyId', 'returnPolicyId', 'merchantLocation',
    ].includes(String(value.key))
    || !['listing', 'content', 'delivery'].includes(String(value.section))
    || !safeSingleLine(value.label, 80) || typeof value.editable !== 'boolean'
    || !safeValue(value.currentShopify) || !safeValue(value.currentEbay)
    || !safeValue(value.proposed)
    || !['shopify', 'ebay', 'saved_draft', 'business_rule', 'agent_selection', 'omit']
      .includes(String(value.source))
    || !['keep', 'add', 'change', 'remove', 'observe_only'].includes(String(value.decision))
    || !['high', 'review', 'blocked'].includes(String(value.confidence))
    || !safeSingleLine(value.reasonCode, 80)) return false;

  const expectedSection = new Map<string, ListingProposalField['section']>([
    ['title', 'listing'], ['category', 'listing'], ['condition', 'listing'],
    ['conditionDescription', 'listing'], ['price', 'listing'], ['quantity', 'listing'],
    ['description', 'content'], ['images', 'content'], ['itemSpecifics', 'content'],
    ['identifiers', 'content'], ['fulfillmentPolicyId', 'delivery'],
    ['paymentPolicyId', 'delivery'], ['returnPolicyId', 'delivery'],
    ['merchantLocation', 'delivery'],
  ]);
  if (expectedSection.get(String(value.key)) !== value.section) return false;
  if (['price', 'quantity', 'itemSpecifics', 'identifiers'].includes(String(value.key))
    && (value.editable || value.decision !== 'observe_only')) return false;
  if (value.decision === 'observe_only' && value.editable) return false;
  if ((value.source === 'omit' || value.decision === 'remove') && value.proposed !== null) {
    return false;
  }
  return true;
};

const proposalWarning = (value: unknown): value is ListingProposalWarning => record(value)
  && exactKeys(value, ['code', 'severity', 'fieldKey', 'message'])
  && safeSingleLine(value.code, 80)
  && ['warning', 'blocking'].includes(String(value.severity))
  && (value.fieldKey === null || [
    'title', 'category', 'condition', 'conditionDescription', 'price', 'quantity',
    'description', 'images', 'itemSpecifics', 'identifiers', 'fulfillmentPolicyId',
    'paymentPolicyId', 'returnPolicyId', 'merchantLocation',
  ].includes(String(value.fieldKey)))
  && safeSingleLine(value.message, 240);

const proposalBody = (
  value: unknown,
): value is NonNullable<ListingProposalResponse['proposal']> => {
  if (!record(value) || !exactKeys(value, [
    'id', 'digest', 'generatedAtUtc', 'generator', 'summary', 'fields', 'warnings', 'review',
  ]) || !safeSingleLine(value.id, 160) || !digest(value.digest)
    || !timestamp(value.generatedAtUtc) || !record(value.generator)
    || !exactKeys(value.generator, ['agentVersion', 'policyVersion', 'model'])
    || !safeSingleLine(value.generator.agentVersion, 80)
    || !safeSingleLine(value.generator.policyVersion, 80)
    || !safeSingleLine(value.generator.model, 160) || !record(value.summary)
    || !exactKeys(value.summary, ['changedFieldCount', 'blockedFieldCount'])
    || !nonnegativeInteger(value.summary.changedFieldCount)
    || !nonnegativeInteger(value.summary.blockedFieldCount)
    || !Array.isArray(value.fields) || value.fields.length > 32
    || !value.fields.every(proposalField)
    || new Set(value.fields.map((field) => field.key)).size !== value.fields.length
    || !Array.isArray(value.warnings) || value.warnings.length > 32
    || !value.warnings.every(proposalWarning)
    || new Set(value.warnings.map(
      (warning) => `${warning.code}:${warning.fieldKey ?? 'proposal'}`,
    )).size !== value.warnings.length
    || !record(value.review)
    || !exactKeys(value.review, ['status', 'reviewedAtUtc'])
    || !['unreviewed', 'approved_local'].includes(String(value.review.status))
    || !(value.review.reviewedAtUtc === null || timestamp(value.review.reviewedAtUtc))) return false;

  const changed = value.fields.filter((field) =>
    ['add', 'change', 'remove'].includes(field.decision)).length;
  const blockedFields = value.fields.filter((field) => field.confidence === 'blocked').length;
  const blockingWarnings = value.warnings.filter((warning) => warning.severity === 'blocking').length;
  return value.summary.changedFieldCount === changed
    && value.summary.blockedFieldCount >= blockedFields
    && value.summary.blockedFieldCount <= blockedFields + blockingWarnings
    && (blockingWarnings === 0 || value.summary.blockedFieldCount > 0)
    && (value.review.status === 'approved_local') === (value.review.reviewedAtUtc !== null);
};

export const isListingProposalResponse = (
  value: unknown,
  expectedCatalogId?: string,
): value is ListingProposalResponse => {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'mode', 'catalogId', 'identity', 'base', 'state', 'eventDigest',
    'proposal', 'capabilities', 'aiRequestsPerformed', 'externalCommerceWritesPerformed',
  ]) || value.schemaVersion !== 1 || value.mode !== 'local_ai_proposal_only'
    || typeof value.catalogId !== 'string'
    || (expectedCatalogId !== undefined && value.catalogId !== expectedCatalogId)
    || !proposalIdentity(value.identity) || !record(value.base)
    || !exactKeys(value.base, [
      'catalogObservedAtUtc', 'detailObservedAtUtc', 'sourceDigest', 'ebayDigest', 'policyDigest',
    ])
    || !timestamp(value.base.catalogObservedAtUtc)
    || !(value.base.detailObservedAtUtc === null || timestamp(value.base.detailObservedAtUtc))
    || !digest(value.base.sourceDigest) || !digest(value.base.ebayDigest)
    || !digest(value.base.policyDigest)
    || ![
      'not_prepared', 'preparing', 'ready', 'blocked', 'no_changes',
      'approved_local', 'stale', 'failed',
    ].includes(String(value.state))
    || !(value.eventDigest === null || digest(value.eventDigest))
    || !(value.proposal === null || proposalBody(value.proposal))
    || !record(value.capabilities)
    || !exactKeys(value.capabilities, [
      'generate', 'review', 'adjustLocal', 'approveLocal', 'apply', 'publish',
    ])
    || typeof value.capabilities.generate !== 'boolean'
    || typeof value.capabilities.review !== 'boolean'
    || typeof value.capabilities.adjustLocal !== 'boolean'
    || typeof value.capabilities.approveLocal !== 'boolean'
    || value.capabilities.apply !== false || value.capabilities.publish !== false
    || value.externalCommerceWritesPerformed !== 0
    || !(value.aiRequestsPerformed === 0 || value.aiRequestsPerformed === 1)) return false;

  const parsedProposal = value.proposal as ListingProposalResponse['proposal'];
  if (value.state === 'not_prepared' && (parsedProposal !== null || value.eventDigest !== null)) {
    return false;
  }
  if (['ready', 'no_changes', 'approved_local'].includes(String(value.state))
    && (parsedProposal === null || value.eventDigest === null)) return false;
  if (value.state === 'approved_local') {
    return parsedProposal?.review.status === 'approved_local';
  }
  return parsedProposal?.review.status !== 'approved_local';
};

export const isListingProposalBoundToDraft = (
  proposal: ListingProposalResponse,
  draft: ListingDraftResponse,
): boolean => proposal.catalogId === draft.catalogId
  && proposal.identity.shopifyProductGid === draft.identity.shopifyProductGid
  && proposal.identity.shopifyVariantGid === draft.identity.shopifyVariantGid
  && proposal.identity.rawSku === draft.identity.rawSku
  && proposal.identity.ebaySellerId === draft.identity.ebaySellerId
  && proposal.identity.ebayMarketplaceId === draft.identity.ebayMarketplaceId
  && proposal.identity.managementModel === draft.identity.managementModel
  && proposal.identity.ebayInventorySku === draft.identity.ebayInventorySku
  && proposal.identity.ebayOfferId === draft.identity.ebayOfferId
  && proposal.identity.ebayListingId === draft.identity.ebayListingId
  && proposal.base.sourceDigest === draft.base.sourceDigest
  && proposal.base.ebayDigest === draft.base.ebayDigest;

export const shouldAutomaticallyGenerateListingProposal = (
  response: ListingProposalResponse,
  draft: ListingDraftResponse,
  editEligible: boolean,
): boolean => editEligible
  && response.capabilities.generate
  && (response.state === 'not_prepared' || response.state === 'stale')
  && isListingProposalBoundToDraft(response, draft);

export const listingProposalGenerationAttemptKey = (
  response: ListingProposalResponse,
  draft: ListingDraftResponse,
): string => [
  response.catalogId,
  response.state,
  response.eventDigest ?? 'none',
  response.base.sourceDigest,
  response.base.ebayDigest,
  response.base.policyDigest,
  draft.revision?.revisionDigest ?? 'none',
].join(':');

export const buildGenerateListingProposalInput = (
  response: ListingProposalResponse,
  draft: ListingDraftResponse,
): GenerateListingProposalInput => ({
  schemaVersion: 1,
  action: 'generate_local_proposal',
  catalogId: response.catalogId,
  expectedRevisionDigest: draft.revision?.revisionDigest ?? null,
  base: {
    sourceDigest: response.base.sourceDigest,
    ebayDigest: response.base.ebayDigest,
    policyDigest: response.base.policyDigest,
  },
});

export const buildApproveListingProposalInput = (
  response: ListingProposalResponse,
): ApproveListingProposalInput | null => {
  if (response.state !== 'ready' || response.proposal === null
    || response.eventDigest === null) return null;
  return {
    schemaVersion: 1,
    action: 'approve_local_proposal',
    catalogId: response.catalogId,
    proposalId: response.proposal.id,
    proposalDigest: response.proposal.digest,
    expectedEventDigest: response.eventDigest,
    base: {
      sourceDigest: response.base.sourceDigest,
      ebayDigest: response.base.ebayDigest,
      policyDigest: response.base.policyDigest,
    },
  };
};

export const isGenerateListingProposalInput = (
  value: unknown,
): value is GenerateListingProposalInput => record(value)
  && exactKeys(value, ['schemaVersion', 'action', 'catalogId', 'expectedRevisionDigest', 'base'])
  && value.schemaVersion === 1 && value.action === 'generate_local_proposal'
  && typeof value.catalogId === 'string'
  && (value.expectedRevisionDigest === null || digest(value.expectedRevisionDigest))
  && baseCas(value.base);

export const isApproveListingProposalInput = (
  value: unknown,
): value is ApproveListingProposalInput => record(value)
  && exactKeys(value, [
    'schemaVersion', 'action', 'catalogId', 'proposalId', 'proposalDigest',
    'expectedEventDigest', 'base',
  ])
  && value.schemaVersion === 1 && value.action === 'approve_local_proposal'
  && typeof value.catalogId === 'string' && safeSingleLine(value.proposalId, 160)
  && digest(value.proposalDigest) && digest(value.expectedEventDigest)
  && baseCas(value.base);

const proposalQueryKey = (catalogId: string | undefined) =>
  ['listing-proposal-v1', catalogId] as const;

export const useListingProposal = (catalogId: string | undefined) => useQuery({
  queryKey: proposalQueryKey(catalogId),
  queryFn: async () => {
    const response = await apiClient.get<ListingProposalResponse>(
      `/listing-proposal?id=${encodeURIComponent(catalogId ?? '')}`,
    );
    if (!isListingProposalResponse(response, catalogId)) {
      throw new Error('Listing proposal response is unavailable');
    }
    return response;
  },
  enabled: Boolean(catalogId),
  staleTime: 0,
  refetchOnWindowFocus: true,
  refetchInterval: (query) => query.state.data?.state === 'preparing' ? 30_000 : false,
  retry: false,
});

export const useGenerateListingProposal = (catalogId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GenerateListingProposalInput) => {
      if (!isGenerateListingProposalInput(input)) throw new Error('Proposal input is invalid');
      const response = await apiClient.post<ListingProposalResponse>('/listing-proposal', input);
      if (!isListingProposalResponse(response, input.catalogId)) {
        throw new Error('Generated proposal response is unavailable');
      }
      return response;
    },
    retry: false,
    onSuccess: (response) => {
      queryClient.setQueryData(proposalQueryKey(catalogId), response);
      void queryClient.invalidateQueries({ queryKey: proposalQueryKey(catalogId) });
    },
  });
};

export const useApproveListingProposal = (catalogId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApproveListingProposalInput) => {
      if (!isApproveListingProposalInput(input)) throw new Error('Approval input is invalid');
      const response = await apiClient.post<ListingProposalResponse>('/listing-proposal', input);
      if (!isListingProposalResponse(response, input.catalogId)
        || response.state !== 'approved_local') {
        throw new Error('Approved proposal response is unavailable');
      }
      return response;
    },
    retry: false,
    onSuccess: (response) => {
      queryClient.setQueryData(proposalQueryKey(catalogId), response);
      void queryClient.invalidateQueries({ queryKey: proposalQueryKey(catalogId) });
      void queryClient.invalidateQueries({ queryKey: ['listing-draft-v1', catalogId] });
    },
  });
};
