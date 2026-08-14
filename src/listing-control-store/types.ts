export type Digest = `sha256:${string}`;

export const LISTING_MANAGEMENT_MODELS = [
  'inventory_api',
  'trading_api',
  'unmanaged',
  'unknown',
] as const;
export type ListingManagementModel = (typeof LISTING_MANAGEMENT_MODELS)[number];

export const LISTING_DRAFT_STATES = ['draft', 'reviewed', 'stale'] as const;
export type ListingDraftState = (typeof LISTING_DRAFT_STATES)[number];

export const LISTING_FIELD_NAMES = [
  'title',
  'category',
  'condition',
  'condition_description',
  'price',
  'quantity',
  'description',
  'images',
  'item_specifics',
  'identifiers',
  'fulfillment_policy',
  'payment_policy',
  'return_policy',
  'merchant_location',
] as const;
export type ListingFieldName = (typeof LISTING_FIELD_NAMES)[number];

export const LISTING_AI_PROPOSABLE_FIELDS = [
  'title',
  'category',
  'condition',
  'condition_description',
  'description',
  'images',
  'fulfillment_policy',
  'payment_policy',
  'return_policy',
  'merchant_location',
] as const satisfies readonly ListingFieldName[];
export type ListingAiProposableField = (typeof LISTING_AI_PROPOSABLE_FIELDS)[number];

export type ListingControlScope = Readonly<{
  shopifyStoreDomain: string;
  ebayEnvironment: 'sandbox' | 'production';
  ebaySellerId: string;
  ebayMarketplaceId: 'EBAY_US';
}>;

export type ListingIdentity = Readonly<{
  shopifyProductGid: string;
  shopifyVariantGid: string;
  rawSku: string;
  ebaySellerId: string;
  ebayMarketplaceId: 'EBAY_US';
  managementModel: ListingManagementModel;
  ebayInventorySku: string | null;
  ebayOfferId: string | null;
  ebayListingId: string | null;
}>;

export type ListingFieldInput = Readonly<{
  field: ListingFieldName;
  sourceValue: string | null;
  sourceDigest: Digest;
  defaultValue: string | null;
  defaultDigest: Digest;
  overrideValue: string | null;
  overrideDigest: Digest;
  proposedValue: string | null;
  proposedDigest: Digest;
  proposedSource: 'source' | 'observed' | 'default' | 'override' | 'omit';
  observedValue: string | null;
  observedDigest: Digest;
}>;

export type ListingBaseDigests = Readonly<{
  source: Digest;
  ebay: Digest;
}>;

export type ListingRevisionInput = Readonly<{
  revisionId: string;
  identity: ListingIdentity;
  baseSourceDigest: Digest;
  baseSourceObservedAtUtc: string;
  baseEbayObservationDigest: Digest;
  baseEbayObservedAtUtc: string;
  fields: readonly ListingFieldInput[];
  actor: string;
  state: ListingDraftState;
  createdAtUtc: string;
  expectedPreviousRevisionDigest: Digest | null;
  expectedLatestBaseSourceDigest: Digest | null;
  expectedLatestBaseEbayObservationDigest: Digest | null;
  auditEventId: string;
}>;

export type ListingRevisionField = ListingFieldInput;

export type ListingRevision = Readonly<{
  revisionId: string;
  revisionNumber: number;
  scopeKey: Digest;
  subjectKey: Digest;
  revisionDigest: Digest;
  previousRevisionDigest: Digest | null;
  identity: ListingIdentity;
  baseSourceDigest: Digest;
  baseSourceObservedAtUtc: string;
  baseEbayObservationDigest: Digest;
  baseEbayObservedAtUtc: string;
  actor: string;
  state: ListingDraftState;
  createdAtUtc: string;
  fields: readonly ListingRevisionField[];
}>;

export type ListingControlAuditVerification = Readonly<{
  valid: boolean;
  recordCount: number;
  headHash: Digest | null;
  error?: string;
}>;

export const LISTING_PROPOSAL_OUTCOMES = [
  'ready',
  'no_change',
  'needs_human',
  'failed',
] as const;
export type ListingProposalOutcome = (typeof LISTING_PROPOSAL_OUTCOMES)[number];

export const LISTING_PROPOSAL_EVENT_TYPES = [
  'queued',
  'generating',
  ...LISTING_PROPOSAL_OUTCOMES,
  'approved',
  'rejected',
  'stale',
] as const;
export type ListingProposalEventType = (typeof LISTING_PROPOSAL_EVENT_TYPES)[number];

export const LISTING_PROPOSAL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ListingProposalConfidence = (typeof LISTING_PROPOSAL_CONFIDENCE_LEVELS)[number];

export const LISTING_PROPOSAL_FIELD_REASON_CODES = [
  'shopify_authoritative',
  'ebay_authoritative',
  'preserve_current',
  'operator_override',
  'policy_selected',
  'missing_source',
  'conflicting_sources',
  'unsupported_change',
] as const;
export type ListingProposalFieldReasonCode =
  (typeof LISTING_PROPOSAL_FIELD_REASON_CODES)[number];

export const LISTING_PROPOSAL_WARNING_CODES = [
  'missing_required',
  'source_conflict',
  'policy_exception',
  'low_confidence',
  'unsupported_fact',
] as const;
export type ListingProposalWarningCode = (typeof LISTING_PROPOSAL_WARNING_CODES)[number];

export const LISTING_PROPOSAL_FAILURE_CODES = [
  'model_unavailable',
  'invalid_output',
  'policy_blocked',
  'stale_base',
  'rate_limited',
  'internal_error',
] as const;
export type ListingProposalFailureCode = (typeof LISTING_PROPOSAL_FAILURE_CODES)[number];

export const LISTING_PROPOSAL_REVIEW_REASON_CODES = [
  'accepted',
  'operator_rejected',
  'base_changed',
  'superseded',
] as const;
export type ListingProposalReviewReasonCode =
  (typeof LISTING_PROPOSAL_REVIEW_REASON_CODES)[number];

export type ListingProposalEvidenceRef = Readonly<{
  source: 'shopify' | 'ebay' | 'draft' | 'policy';
  field: string;
  digest: Digest;
}>;

export type ListingProposalEvidenceItem = Readonly<{
  source: 'shopify' | 'ebay' | 'draft' | 'policy';
  field: ListingFieldName | 'listing';
  valueDigest: Digest;
  summary: string | null;
}>;

export type ListingProposalFieldDecisionInput = Readonly<{
  field: ListingAiProposableField;
  proposedValue: string | null;
  proposedDigest: Digest;
  proposedSource: 'source' | 'observed' | 'override' | 'omit';
  confidence: ListingProposalConfidence;
  reasonCode: ListingProposalFieldReasonCode;
  warningCode: ListingProposalWarningCode | null;
  evidence: readonly ListingProposalEvidenceRef[];
}>;

export type ListingProposalFieldDecision = ListingProposalFieldDecisionInput & Readonly<{
  evidenceDigest: Digest;
}>;

export type ListingProposalUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type ListingProposalJob = Readonly<{
  jobId: string;
  jobDigest: Digest;
  scopeKey: Digest;
  subjectKey: Digest;
  identity: ListingIdentity;
  baseRevisionDigest: Digest | null;
  baseSourceDigest: Digest;
  baseEbayObservationDigest: Digest;
  triggerDigest: Digest;
  catalogId: string;
  evidence: readonly ListingProposalEvidenceItem[];
  evidenceDigest: Digest;
  policyVersion: string;
  policyDigest: Digest;
  promptVersion: string;
  promptDigest: Digest;
  schemaVersion: string;
  schemaDigest: Digest;
  agentVersion: string;
  provider: 'openai' | 'fixture';
  requestedModel: string;
  modelDigest: Digest;
  requestedBy: string;
  createdAtUtc: string;
}>;

export type CreateListingProposalJobInput = Readonly<{
  jobId: string;
  identity: ListingIdentity;
  baseRevisionDigest: Digest | null;
  baseSourceDigest: Digest;
  baseEbayObservationDigest: Digest;
  triggerDigest: Digest;
  catalogId: string;
  evidence: readonly ListingProposalEvidenceItem[];
  evidenceDigest: Digest;
  policyVersion: string;
  policyDigest: Digest;
  promptVersion: string;
  promptDigest: Digest;
  schemaVersion: string;
  schemaDigest: Digest;
  agentVersion: string;
  provider: 'openai' | 'fixture';
  requestedModel: string;
  modelDigest: Digest;
  requestedBy: string;
  createdAtUtc: string;
  eventId: string;
}>;

export type ListingProposalResult = Readonly<{
  resultId: string;
  resultDigest: Digest;
  jobId: string;
  outcome: ListingProposalOutcome;
  parsedOutputDigest: Digest | null;
  failureCode: ListingProposalFailureCode | null;
  usage: ListingProposalUsage;
  actor: string;
  completedAtUtc: string;
  fields: readonly ListingProposalFieldDecision[];
}>;

export type ListingProposalEvent = Readonly<{
  eventId: string;
  jobId: string;
  sequence: number;
  scopeKey: Digest;
  subjectKey: Digest;
  eventType: ListingProposalEventType;
  eventDigest: Digest;
  previousEventDigest: Digest | null;
  actor: string;
  occurredAtUtc: string;
  resultDigest: Digest | null;
  reviewedRevisionDigest: Digest | null;
  reviewReasonCode: ListingProposalReviewReasonCode | null;
  payloadDigest: Digest;
}>;

export type ListingProposal = Readonly<{
  job: ListingProposalJob;
  latestEvent: ListingProposalEvent;
  result: ListingProposalResult | null;
}>;

export type MarkListingProposalGeneratingInput = Readonly<{
  jobId: string;
  expectedPreviousEventDigest: Digest;
  actor: string;
  occurredAtUtc: string;
  eventId: string;
}>;

export type CompleteListingProposalInput = Readonly<{
  jobId: string;
  resultId: string;
  outcome: ListingProposalOutcome;
  expectedPreviousEventDigest: Digest;
  parsedOutputDigest: Digest | null;
  fieldDecisions: readonly ListingProposalFieldDecisionInput[];
  usage: ListingProposalUsage;
  failureCode: ListingProposalFailureCode | null;
  actor: string;
  occurredAtUtc: string;
  eventId: string;
}>;

export type ApproveListingProposalInput = Readonly<{
  jobId: string;
  resultDigest: Digest;
  expectedPreviousEventDigest: Digest;
  revision: ListingRevisionInput;
  actor: string;
  occurredAtUtc: string;
  eventId: string;
}>;

export type ReviewListingProposalInput = Readonly<{
  jobId: string;
  resultDigest: Digest;
  expectedPreviousEventDigest: Digest;
  actor: string;
  occurredAtUtc: string;
  eventId: string;
  reasonCode: Exclude<ListingProposalReviewReasonCode, 'accepted'>;
}>;
