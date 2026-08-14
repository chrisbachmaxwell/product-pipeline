import { createHash } from 'node:crypto';
import type { ListingDraftDto, ListingDraftField } from './listing-draft-service.js';

export const LISTING_PROPOSAL_FIELDS = [
  'title',
  'category',
  'condition',
  'conditionDescription',
  'description',
  'images',
  'fulfillmentPolicyId',
  'paymentPolicyId',
  'returnPolicyId',
  'merchantLocation',
] as const;
export type ListingProposalFieldName = (typeof LISTING_PROPOSAL_FIELDS)[number];

export const LISTING_PROPOSAL_CHOICES = [
  'keep_ebay',
  'use_shopify',
  'use_saved_draft',
  'omit',
  'needs_human',
] as const;
export type ListingProposalChoice = (typeof LISTING_PROPOSAL_CHOICES)[number];

export const LISTING_PROPOSAL_REASON_CODES = [
  'keep_verified_ebay',
  'use_verified_shopify',
  'use_operator_saved_draft',
  'omit_optional_field',
  'source_conflict',
  'verified_candidate_missing',
  'policy_choice_required',
  'required_field_cannot_be_omitted',
] as const;
export type ListingProposalReasonCode = (typeof LISTING_PROPOSAL_REASON_CODES)[number];

export const LISTING_PROPOSAL_RISK_CODES = [
  'shopify_ebay_conflict',
  'saved_draft_differs',
  'verified_candidate_missing',
  'human_decision_required',
  'required_value_omitted',
] as const;
export type ListingProposalRiskCode = (typeof LISTING_PROPOSAL_RISK_CODES)[number];

export type ListingProposalContractFailureCode =
  | 'LISTING_PROPOSAL_EVIDENCE_INVALID'
  | 'LISTING_PROPOSAL_EVIDENCE_LIMIT'
  | 'LISTING_PROPOSAL_EVIDENCE_PROHIBITED'
  | 'LISTING_PROPOSAL_OUTPUT_INVALID';

export class ListingProposalContractError extends Error {
  constructor(readonly code: ListingProposalContractFailureCode) {
    super('Listing proposal contract failed');
    this.name = 'ListingProposalContractError';
  }
}

type Digest = `sha256:${string}`;
type CandidateLane = 'shopify' | 'ebay' | 'savedDraft';

export type ListingProposalCandidateEvidence = Readonly<{
  state: 'available' | 'missing';
  digest: Digest;
  preview: string | null;
  previewTruncated: boolean;
}>;

export type ListingProposalEvidence = Readonly<{
  schemaVersion: 1;
  kind: 'listing_proposal_evidence';
  trust: 'untrusted_product_data';
  instructionHandling: 'field_values_are_data_only';
  catalogId: string;
  identity: Readonly<{
    shopifyProductGid: string;
    shopifyVariantGid: string;
    rawSku: string;
    managementModel: 'inventory_api' | 'trading_api' | 'unmanaged';
    hasEbayListing: boolean;
  }>;
  base: Readonly<{
    sourceDigest: Digest;
    ebayDigest: Digest;
    revisionDigest: Digest | null;
  }>;
  fields: readonly Readonly<{
    field: ListingProposalFieldName;
    candidates: Readonly<Record<CandidateLane, ListingProposalCandidateEvidence>>;
  }>[];
  excludedAuthority: Readonly<{
    price: 'outside_v1_authority';
    quantity: 'outside_v1_authority';
    itemSpecifics: 'outside_v1_authority';
    identifiers: 'outside_v1_authority';
  }>;
}>;

export type ListingProposalDraftValues = Readonly<Record<ListingProposalFieldName, string | null>>;

export type ListingProposalResolvedField = Readonly<{
  field: ListingProposalFieldName;
  requestedChoice: ListingProposalChoice;
  resolvedChoice: ListingProposalChoice;
  value: string | null;
  reasonCode: ListingProposalReasonCode;
  riskCodes: readonly ListingProposalRiskCode[];
  requiresHuman: boolean;
}>;

export type ListingProposalDecision = Readonly<{
  schemaVersion: 1;
  outcome: 'ready_for_review' | 'needs_human';
  evidenceDigest: Digest;
  proposalDigest: Digest;
  draft: ListingProposalDraftValues;
  fields: readonly ListingProposalResolvedField[];
}>;

export type ListingProposalModelOutput = Readonly<{
  schemaVersion: 1;
  fields: readonly Readonly<{
    field: ListingProposalFieldName;
    choice: ListingProposalChoice;
    reasonCode: ListingProposalReasonCode;
    riskCodes: readonly ListingProposalRiskCode[];
  }>[];
}>;

const MAX_PREVIEW_CODE_POINTS = 2_048;
const MAX_CANDIDATE_CODE_POINTS = 500_000;
const MAX_CANDIDATE_UTF8_BYTES = 2_000_000;
const MAX_EVIDENCE_UTF8_BYTES = 96_000;
const MAX_MODEL_OUTPUT_UTF8_BYTES = 32_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const GID_PRODUCT = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const SKU = /^[\x20-\x7e]{1,128}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const RAW_HTML = /<\/?[A-Za-z][^>]*>/u;
const PROHIBITED = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\bshpat_[A-Za-z0-9_-]{16,}\b/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/i,
  /(?:v\^|v%5e)1\.1(?:#|%23)[^\s"']{8,}(?:t\^|t%5e)/i,
  /\b(?:access|refresh|identity)[_-]?token\s*[:=]/i,
  /\b(?:api[_-]?key|client[_-]?secret|authorization|set-cookie)\s*[:=]/i,
] as const;
const FIELD_SET = new Set<string>(LISTING_PROPOSAL_FIELDS);
const CHOICE_SET = new Set<string>(LISTING_PROPOSAL_CHOICES);
const REASON_SET = new Set<string>(LISTING_PROPOSAL_REASON_CODES);
const RISK_SET = new Set<string>(LISTING_PROPOSAL_RISK_CODES);
const REASONS_BY_CHOICE: Readonly<Record<ListingProposalChoice, readonly ListingProposalReasonCode[]>>
  = Object.freeze({
    keep_ebay: Object.freeze(['keep_verified_ebay'] as const),
    use_shopify: Object.freeze(['use_verified_shopify'] as const),
    use_saved_draft: Object.freeze(['use_operator_saved_draft'] as const),
    omit: Object.freeze(['omit_optional_field'] as const),
    needs_human: Object.freeze(['source_conflict', 'verified_candidate_missing',
      'policy_choice_required'] as const),
  });

const invalidEvidence = (): never => {
  throw new ListingProposalContractError('LISTING_PROPOSAL_EVIDENCE_INVALID');
};
const evidenceLimit = (): never => {
  throw new ListingProposalContractError('LISTING_PROPOSAL_EVIDENCE_LIMIT');
};
const prohibitedEvidence = (): never => {
  throw new ListingProposalContractError('LISTING_PROPOSAL_EVIDENCE_PROHIBITED');
};
const invalidOutput = (): never => {
  throw new ListingProposalContractError('LISTING_PROPOSAL_OUTPUT_INVALID');
};

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return invalidEvidence();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

function digest(value: unknown): Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeCandidate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return invalidEvidence();
  const points = Array.from(value);
  if (points.length > MAX_CANDIDATE_CODE_POINTS
    || utf8Length(value) > MAX_CANDIDATE_UTF8_BYTES) return evidenceLimit();
  if (CONTROL.test(value) || RAW_HTML.test(value) || PROHIBITED.some((pattern) => pattern.test(value))) {
    return prohibitedEvidence();
  }
  return value;
}

function candidateEvidence(value: string | null): ListingProposalCandidateEvidence {
  const points = value === null ? [] : Array.from(value);
  const previewTruncated = points.length > MAX_PREVIEW_CODE_POINTS;
  return Object.freeze({
    state: value === null ? 'missing' as const : 'available' as const,
    digest: digest({ state: value === null ? 'missing' : 'available', value }),
    preview: value === null ? null : points.slice(0, MAX_PREVIEW_CODE_POINTS).join(''),
    previewTruncated,
  });
}

function validateField(value: unknown, editable: boolean): ListingDraftField {
  if (!exactKeys(value, ['shopify', 'ebay', 'draft', 'editable'])
    || value.editable !== editable) return invalidEvidence();
  return Object.freeze({
    shopify: safeCandidate(value.shopify),
    ebay: safeCandidate(value.ebay),
    draft: safeCandidate(value.draft),
    editable,
  });
}

function draftFields(value: Record<string, unknown>): Record<ListingProposalFieldName, ListingDraftField> {
  if (!exactKeys(value.sections, ['listing', 'content', 'delivery'])) return invalidEvidence();
  const sections = value.sections;
  if (!exactKeys(sections.listing, [
    'title', 'category', 'condition', 'conditionDescription', 'price', 'quantity',
  ]) || !exactKeys(sections.content, [
    'description', 'images', 'itemSpecifics', 'identifiers',
  ]) || !exactKeys(sections.delivery, [
    'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId', 'merchantLocation',
  ])) return invalidEvidence();
  validateField(sections.listing.price, false);
  validateField(sections.listing.quantity, false);
  validateField(sections.content.itemSpecifics, false);
  validateField(sections.content.identifiers, false);
  return Object.freeze({
    title: validateField(sections.listing.title, true),
    category: validateField(sections.listing.category, true),
    condition: validateField(sections.listing.condition, true),
    conditionDescription: validateField(sections.listing.conditionDescription, true),
    description: validateField(sections.content.description, true),
    images: validateField(sections.content.images, true),
    fulfillmentPolicyId: validateField(sections.delivery.fulfillmentPolicyId, true),
    paymentPolicyId: validateField(sections.delivery.paymentPolicyId, true),
    returnPolicyId: validateField(sections.delivery.returnPolicyId, true),
    merchantLocation: validateField(sections.delivery.merchantLocation, true),
  });
}

type ParsedDraft = Readonly<{
  dto: ListingDraftDto;
  fields: Record<ListingProposalFieldName, ListingDraftField>;
}>;

function parseDraftDto(input: unknown): ParsedDraft {
  if (!exactKeys(input, [
    'schemaVersion', 'mode', 'catalogId', 'identity', 'base', 'revision', 'sections',
    'capabilities', 'externalWritesPerformed',
  ]) || input.schemaVersion !== 1 || input.mode !== 'local_draft_only'
    || typeof input.catalogId !== 'string' || !CATALOG_ID.test(input.catalogId)
    || input.externalWritesPerformed !== 0
    || !exactKeys(input.identity, [
      'shopifyProductGid', 'shopifyVariantGid', 'rawSku', 'ebaySellerId',
      'ebayMarketplaceId', 'managementModel', 'ebayInventorySku', 'ebayOfferId',
      'ebayListingId',
    ])) return invalidEvidence();
  if (PROHIBITED.some((pattern) => pattern.test(String(input.catalogId)))) {
    return prohibitedEvidence();
  }
  const identity = input.identity;
  if (typeof identity.shopifyProductGid !== 'string'
    || !GID_PRODUCT.test(identity.shopifyProductGid)
    || typeof identity.shopifyVariantGid !== 'string'
    || !GID_VARIANT.test(identity.shopifyVariantGid)
    || typeof identity.rawSku !== 'string' || !SKU.test(identity.rawSku)
    || identity.rawSku.trim() !== identity.rawSku
    || !['inventory_api', 'trading_api', 'unmanaged'].includes(String(identity.managementModel))
    || typeof identity.ebaySellerId !== 'string' || identity.ebaySellerId.length === 0
    || identity.ebaySellerId.length > 128 || CONTROL.test(identity.ebaySellerId)
    || identity.ebayMarketplaceId !== 'EBAY_US'
    || ![identity.ebayInventorySku, identity.ebayOfferId, identity.ebayListingId].every(
      (entry) => entry === null || (typeof entry === 'string' && entry.length > 0
        && entry.length <= 128 && !CONTROL.test(entry)),
    )) return invalidEvidence();
  if (PROHIBITED.some((pattern) => pattern.test(canonicalJson(identity)))) {
    return prohibitedEvidence();
  }
  if (!exactKeys(input.base, [
    'catalogObservedAtUtc', 'detailObservedAtUtc', 'sourceDigest', 'ebayDigest',
  ]) || typeof input.base.catalogObservedAtUtc !== 'string'
    || input.base.catalogObservedAtUtc.length > 64
    || !Number.isFinite(Date.parse(input.base.catalogObservedAtUtc))
    || (input.base.detailObservedAtUtc !== null
      && (typeof input.base.detailObservedAtUtc !== 'string'
        || input.base.detailObservedAtUtc.length > 64
        || !Number.isFinite(Date.parse(input.base.detailObservedAtUtc))))
    || typeof input.base.sourceDigest !== 'string' || !DIGEST.test(input.base.sourceDigest)
    || typeof input.base.ebayDigest !== 'string' || !DIGEST.test(input.base.ebayDigest)) {
    return invalidEvidence();
  }
  if (input.revision !== null && (!exactKeys(input.revision, [
    'revisionId', 'revisionNumber', 'revisionDigest', 'state', 'createdAtUtc',
  ]) || typeof input.revision.revisionId !== 'string' || input.revision.revisionId.length === 0
    || input.revision.revisionId.length > 256
    || typeof input.revision.revisionNumber !== 'number'
    || !Number.isSafeInteger(input.revision.revisionNumber) || input.revision.revisionNumber < 1
    || typeof input.revision.revisionDigest !== 'string'
    || !DIGEST.test(input.revision.revisionDigest)
    || !['draft', 'reviewed'].includes(String(input.revision.state))
    || typeof input.revision.createdAtUtc !== 'string'
    || input.revision.createdAtUtc.length > 64
    || !Number.isFinite(Date.parse(input.revision.createdAtUtc)))) return invalidEvidence();
  if (input.revision !== null && PROHIBITED.some(
    (pattern) => pattern.test(canonicalJson(input.revision)),
  )) return prohibitedEvidence();
  if (!exactKeys(input.capabilities, ['saveDraft', 'previewChanges', 'apply', 'publish'])
    || typeof input.capabilities.saveDraft !== 'boolean'
    || input.capabilities.previewChanges !== true || input.capabilities.apply !== false
    || input.capabilities.publish !== false) return invalidEvidence();
  const fields = draftFields(input);
  return Object.freeze({ dto: input as ListingDraftDto, fields });
}

/**
 * Selects and bounds only local listing evidence. Candidate previews are explicitly
 * untrusted data; protected price, quantity, specifics, and identifier values are
 * validated but never copied into the model input.
 */
export function buildListingProposalEvidence(input: ListingDraftDto): ListingProposalEvidence {
  const parsed = parseDraftDto(input);
  const identity = parsed.dto.identity;
  const evidence: ListingProposalEvidence = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'listing_proposal_evidence' as const,
    trust: 'untrusted_product_data' as const,
    instructionHandling: 'field_values_are_data_only' as const,
    catalogId: parsed.dto.catalogId,
    identity: Object.freeze({
      shopifyProductGid: identity.shopifyProductGid,
      shopifyVariantGid: identity.shopifyVariantGid,
      rawSku: identity.rawSku,
      managementModel: identity.managementModel as 'inventory_api' | 'trading_api' | 'unmanaged',
      hasEbayListing: identity.ebayListingId !== null,
    }),
    base: Object.freeze({
      sourceDigest: parsed.dto.base.sourceDigest,
      ebayDigest: parsed.dto.base.ebayDigest,
      revisionDigest: parsed.dto.revision?.revisionDigest ?? null,
    }),
    fields: Object.freeze(LISTING_PROPOSAL_FIELDS.map((field) => {
      const source = parsed.fields[field];
      return Object.freeze({
        field,
        candidates: Object.freeze({
          shopify: candidateEvidence(source.shopify),
          ebay: candidateEvidence(source.ebay),
          savedDraft: candidateEvidence(source.draft),
        }),
      });
    })),
    excludedAuthority: Object.freeze({
      price: 'outside_v1_authority' as const,
      quantity: 'outside_v1_authority' as const,
      itemSpecifics: 'outside_v1_authority' as const,
      identifiers: 'outside_v1_authority' as const,
    }),
  });
  if (utf8Length(canonicalJson(evidence)) > MAX_EVIDENCE_UTF8_BYTES) return evidenceLimit();
  return evidence;
}

export function digestListingProposalEvidence(value: ListingProposalEvidence): Digest {
  return digest(value);
}

export function serializeListingProposalEvidence(value: ListingProposalEvidence): string {
  const serialized = canonicalJson(value);
  if (utf8Length(serialized) > MAX_EVIDENCE_UTF8_BYTES) return evidenceLimit();
  return serialized;
}

function candidateValues(input: ListingDraftDto): Record<ListingProposalFieldName,
Readonly<Record<CandidateLane, string | null>>> {
  const parsed = parseDraftDto(input);
  return Object.freeze(Object.fromEntries(LISTING_PROPOSAL_FIELDS.map((field) => {
    const value = parsed.fields[field];
    return [field, Object.freeze({
      shopify: value.shopify,
      ebay: value.ebay,
      savedDraft: value.draft,
    })];
  })) as Record<ListingProposalFieldName, Readonly<Record<CandidateLane, string | null>>>);
}

function modelOutput(value: unknown): ListingProposalModelOutput {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return invalidOutput(); }
  if (utf8Length(serialized) > MAX_MODEL_OUTPUT_UTF8_BYTES
    || !exactKeys(value, ['schemaVersion', 'fields']) || value.schemaVersion !== 1
    || !Array.isArray(value.fields) || value.fields.length !== LISTING_PROPOSAL_FIELDS.length) {
    return invalidOutput();
  }
  const seen = new Set<string>();
  const fields = value.fields.map((entry): ListingProposalModelOutput['fields'][number] => {
    if (!exactKeys(entry, ['field', 'choice', 'reasonCode', 'riskCodes'])
      || typeof entry.field !== 'string' || !FIELD_SET.has(entry.field) || seen.has(entry.field)
      || typeof entry.choice !== 'string' || !CHOICE_SET.has(entry.choice)
      || typeof entry.reasonCode !== 'string' || !REASON_SET.has(entry.reasonCode)
      || !Array.isArray(entry.riskCodes) || entry.riskCodes.length > 4) return invalidOutput();
    seen.add(entry.field);
    const choice = entry.choice as ListingProposalChoice;
    const reasonCode = entry.reasonCode as ListingProposalReasonCode;
    if (!REASONS_BY_CHOICE[choice].includes(reasonCode)) return invalidOutput();
    const risks = entry.riskCodes.map((risk) => {
      if (typeof risk !== 'string' || !RISK_SET.has(risk)) return invalidOutput();
      return risk as ListingProposalRiskCode;
    });
    if (new Set(risks).size !== risks.length) return invalidOutput();
    return Object.freeze({
      field: entry.field as ListingProposalFieldName,
      choice,
      reasonCode,
      riskCodes: Object.freeze(risks),
    });
  });
  if (seen.size !== LISTING_PROPOSAL_FIELDS.length) return invalidOutput();
  return Object.freeze({ schemaVersion: 1 as const, fields: Object.freeze(fields) });
}

function laneForChoice(choice: ListingProposalChoice): CandidateLane | null {
  if (choice === 'keep_ebay') return 'ebay';
  if (choice === 'use_shopify') return 'shopify';
  if (choice === 'use_saved_draft') return 'savedDraft';
  return null;
}

function orderedRisks(values: Iterable<ListingProposalRiskCode>): readonly ListingProposalRiskCode[] {
  const unique = new Set(values);
  return Object.freeze(LISTING_PROPOSAL_RISK_CODES.filter((risk) => unique.has(risk)));
}

function decisionRisks(
  candidates: Readonly<Record<CandidateLane, string | null>>,
  requestedChoice: ListingProposalChoice,
  supplied: readonly ListingProposalRiskCode[],
  missingCandidate: boolean,
  requiredOmission: boolean,
): readonly ListingProposalRiskCode[] {
  const risks = new Set<ListingProposalRiskCode>(supplied);
  if (candidates.shopify !== null && candidates.ebay !== null
    && candidates.shopify !== candidates.ebay) risks.add('shopify_ebay_conflict');
  if (candidates.savedDraft !== null
    && [candidates.shopify, candidates.ebay].some(
      (candidate) => candidate !== null && candidate !== candidates.savedDraft,
    )) risks.add('saved_draft_differs');
  if (missingCandidate) risks.add('verified_candidate_missing');
  if (requiredOmission) risks.add('required_value_omitted');
  if (missingCandidate || requiredOmission || requestedChoice === 'needs_human') {
    risks.add('human_decision_required');
  }
  return orderedRisks(risks);
}

function omissionAllowed(
  field: ListingProposalFieldName,
  managementModel: ListingProposalEvidence['identity']['managementModel'],
): boolean {
  return field === 'conditionDescription'
    || (field === 'merchantLocation' && managementModel === 'trading_api');
}

/**
 * Independently validates model JSON and resolves every choice only through the
 * exact server-known DTO candidates. A missing selected lane is downgraded to
 * needs_human; the model can never supply or synthesize a field value.
 */
export function resolveListingProposalOutput(
  raw: unknown,
  evidence: ListingProposalEvidence,
  input: ListingDraftDto,
): ListingProposalDecision {
  const rebuiltEvidence = buildListingProposalEvidence(input);
  if (canonicalJson(rebuiltEvidence) !== canonicalJson(evidence)) return invalidOutput();
  const output = modelOutput(raw);
  const values = candidateValues(input);
  const byField = new Map(output.fields.map((field) => [field.field, field]));
  const resolved = LISTING_PROPOSAL_FIELDS.map((field): ListingProposalResolvedField => {
    const requested = byField.get(field);
    if (!requested) return invalidOutput();
    const lane = laneForChoice(requested.choice);
    const value = lane === null ? null : values[field][lane];
    const missingCandidate = lane !== null && value === null;
    const requiredOmission = requested.choice === 'omit'
      && !omissionAllowed(field, evidence.identity.managementModel);
    const resolvedChoice: ListingProposalChoice = missingCandidate || requiredOmission
      ? 'needs_human' : requested.choice;
    const reasonCode: ListingProposalReasonCode = missingCandidate
      ? 'verified_candidate_missing'
      : requiredOmission ? 'required_field_cannot_be_omitted' : requested.reasonCode;
    return Object.freeze({
      field,
      requestedChoice: requested.choice,
      resolvedChoice,
      value,
      reasonCode,
      riskCodes: decisionRisks(values[field], requested.choice, requested.riskCodes,
        missingCandidate, requiredOmission),
      requiresHuman: resolvedChoice === 'needs_human',
    });
  });
  const draft = Object.freeze(Object.fromEntries(resolved.map(
    (field) => [field.field, field.value],
  )) as Record<ListingProposalFieldName, string | null>);
  const evidenceDigest = digestListingProposalEvidence(evidence);
  const proposalCore = Object.freeze({
    schemaVersion: 1 as const,
    outcome: resolved.some((field) => field.requiresHuman)
      ? 'needs_human' as const : 'ready_for_review' as const,
    evidenceDigest,
    draft,
    fields: Object.freeze(resolved),
  });
  return Object.freeze({ ...proposalCore, proposalDigest: digest(proposalCore) });
}

export function digestListingProposalDecision(value: ListingProposalDecision): Digest {
  const { proposalDigest, ...core } = value;
  const calculated = digest(core);
  if (proposalDigest !== calculated) return invalidOutput();
  return calculated;
}

export function parseListingProposalModelJson(value: string): unknown {
  if (typeof value !== 'string' || utf8Length(value) > MAX_MODEL_OUTPUT_UTF8_BYTES
    || CONTROL.test(value)) return invalidOutput();
  try { return JSON.parse(value) as unknown; } catch { return invalidOutput(); }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const LISTING_PROPOSAL_RESPONSE_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'fields'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    fields: {
      type: 'array',
      minItems: LISTING_PROPOSAL_FIELDS.length,
      maxItems: LISTING_PROPOSAL_FIELDS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'choice', 'reasonCode', 'riskCodes'],
        properties: {
          field: { type: 'string', enum: [...LISTING_PROPOSAL_FIELDS] },
          choice: { type: 'string', enum: [...LISTING_PROPOSAL_CHOICES] },
          reasonCode: { type: 'string', enum: [...LISTING_PROPOSAL_REASON_CODES] },
          riskCodes: {
            type: 'array',
            maxItems: 4,
            uniqueItems: true,
            items: { type: 'string', enum: [...LISTING_PROPOSAL_RISK_CODES] },
          },
        },
      },
    },
  },
} as const);

export const LISTING_PROPOSAL_CONTRACT_TESTING = Object.freeze({
  canonicalJson,
  modelOutput,
  maximumPreviewCodePoints: MAX_PREVIEW_CODE_POINTS,
  maximumEvidenceUtf8Bytes: MAX_EVIDENCE_UTF8_BYTES,
  maximumModelOutputUtf8Bytes: MAX_MODEL_OUTPUT_UTF8_BYTES,
});
