import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  initializeListingControlSchema,
  upgradeListingControlSchemaV1ToV2,
  upgradeListingControlSchemaV2ToV3,
  verifyListingControlSchema,
  verifyListingControlSchemaV1,
  verifyListingControlSchemaV2,
} from './schema.js';
import {
  LISTING_DRAFT_STATES,
  LISTING_AI_PROPOSABLE_FIELDS,
  LISTING_FIELD_NAMES,
  LISTING_MANAGEMENT_MODELS,
  LISTING_PROPOSAL_CONFIDENCE_LEVELS,
  LISTING_PROPOSAL_EVENT_TYPES,
  LISTING_PROPOSAL_FAILURE_CODES,
  LISTING_PROPOSAL_FIELD_REASON_CODES,
  LISTING_PROPOSAL_OUTCOMES,
  LISTING_PROPOSAL_REVIEW_REASON_CODES,
  LISTING_PROPOSAL_WARNING_CODES,
  type Digest,
  type CreateListingProposalJobInput,
  type ApproveListingProposalInput,
  type CompleteListingProposalInput,
  type ListingBaseDigests,
  type ListingControlAuditVerification,
  type ListingControlScope,
  type ListingFieldInput,
  type ListingIdentity,
  type ListingProposal,
  type ListingProposalEvent,
  type ListingProposalEvidenceItem,
  type ListingProposalEvidenceRef,
  type ListingProposalFieldDecision,
  type ListingProposalFieldDecisionInput,
  type ListingProposalFailureCode,
  type ListingProposalJob,
  type ListingProposalOutcome,
  type ListingProposalResult,
  type ListingProposalReviewReasonCode,
  type ListingProposalUsage,
  type ListingRevision,
  type ListingRevisionInput,
  type MarkListingProposalGeneratingInput,
  type ReviewListingProposalInput,
} from './types.js';

type Sqlite = InstanceType<typeof Database>;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GENESIS_HASH = 'GENESIS';
const MAX_SCALAR_VALUE_BYTES = 4 * 1024;
const MAX_LARGE_VALUE_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARACTERS = 500_000;
const MAX_DESCRIPTION_UTF8_BYTES = 2_000_000;
const MAX_NON_DESCRIPTION_REVISION_VALUE_BYTES = 512 * 1024;
// Covers JSON encoding across source/override/proposed/observed without widening other fields.
const MAX_DESCRIPTION_REVISION_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_PROPOSAL_EVIDENCE_BYTES = 256 * 1024;
const PROHIBITED_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\b(?:access|refresh|identity)[_-]?token\s*[:=]/i,
  /\b(?:api[_-]?key|client[_-]?secret|password|authorization|set-cookie)\s*[:=]/i,
  /\b(?:xox[baprs]-|gh[pousr]_|sk-(?:live|test|proj)-)[A-Za-z0-9_-]{12,}\b/i,
  /\bshpat_[A-Za-z0-9_-]{16,}\b/i,
  /(?:v\^|v%5e)1\.1(?:#|%23)[^\s"']{8,}(?:t\^|t%5e)/i,
] as const;
export const LISTING_CONTROL_STORE_CAPABILITIES = Object.freeze({
  localDraftRuntimeWired: true,
  providerRuntimeWired: false,
  providerReadSupported: false,
  providerWriteSupported: false,
  externalWritesSupported: false,
  credentialCapability: false,
  publishAuthorizationSupported: false,
  contentReviewOnly: true,
  aiProposalPersistenceSupported: true,
  localContentApprovalSupported: true,
} as const);

export type ListingControlStoreErrorCode =
  | 'INVALID_INPUT'
  | 'PATH_REJECTED'
  | 'SCHEMA_MISMATCH'
  | 'ACCOUNT_DRIFT'
  | 'CONFLICT'
  | 'STALE_BASE'
  | 'NOT_FOUND'
  | 'READ_ONLY';

export class ListingControlStoreError extends Error {
  readonly code: ListingControlStoreErrorCode;

  constructor(code: ListingControlStoreErrorCode, message: string) {
    super(message);
    this.name = 'ListingControlStoreError';
    this.code = code;
  }
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Unsafe number in canonical payload');
    }
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
    || typeof value === 'bigint') {
    throw new ListingControlStoreError('INVALID_INPUT', 'Unsupported value in canonical payload');
  }
  if (Buffer.isBuffer(value) || value instanceof Date) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Unsupported object in canonical payload');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ListingControlStoreError('INVALID_INPUT', 'Cyclic payload');
    seen.add(value);
    const result = `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Non-plain object in canonical payload');
    }
    if (seen.has(object)) throw new ListingControlStoreError('INVALID_INPUT', 'Cyclic payload');
    seen.add(object);
    const entries = Object.keys(object).sort().map((key) => {
      if (object[key] === undefined) {
        throw new ListingControlStoreError('INVALID_INPUT', 'Undefined value in canonical payload');
      }
      return `${JSON.stringify(key)}:${stableJson(object[key], seen)}`;
    });
    seen.delete(object);
    return `{${entries.join(',')}}`;
  }
  throw new ListingControlStoreError('INVALID_INPUT', 'Unsupported canonical payload');
}

function assertExactKeys(value: unknown, expected: readonly string[], name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} is invalid`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const canonicalExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} has unexpected fields`);
  }
}

function assertNoCredentialMaterial(value: unknown): void {
  const serialized = stableJson(value);
  if (PROHIBITED_VALUE_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Credential-shaped material is prohibited');
  }
}

export function sha256Digest(value: unknown): Digest {
  const serialized = typeof value === 'string' ? value : stableJson(value);
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

function assertDigest(value: string | null, name: string, nullable = false): Digest | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} must be a sha256 digest`);
  }
  return value as Digest;
}

function safeText(value: string, name: string, maximumLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)
    || PROHIBITED_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} is invalid`);
  }
  return value;
}

function exactSku(value: string, name: string): string {
  const checked = safeText(value, name, 128);
  if (!/^[\x20-\x7e]+$/.test(checked)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} is invalid`);
  }
  return checked;
}

function gid(value: string, kind: 'Product' | 'ProductVariant', name: string): string {
  const checked = safeText(value, name, 256);
  if (!new RegExp(`^gid://shopify/${kind}/[1-9][0-9]*$`).test(checked)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} is invalid`);
  }
  return checked;
}

function identifier(value: string, name: string, maximumLength = 160): string {
  const checked = safeText(value, name, maximumLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(checked)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} contains unsupported characters`);
  }
  return checked;
}

function timestamp(value: string, name: string): { utc: string; epochMs: number } {
  const epochMs = Date.parse(value);
  if (typeof value !== 'string' || !Number.isSafeInteger(epochMs)
    || new Date(epochMs).toISOString() !== value) {
    throw new ListingControlStoreError('INVALID_INPUT', `${name} must be a canonical UTC instant`);
  }
  return { utc: value, epochMs };
}

function canonicalScope(input: ListingControlScope): ListingControlScope {
  assertExactKeys(input, [
    'shopifyStoreDomain', 'ebayEnvironment', 'ebaySellerId', 'ebayMarketplaceId',
  ], 'scope');
  const shopifyStoreDomain = safeText(
    input.shopifyStoreDomain.toLowerCase(),
    'shopifyStoreDomain',
  );
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopifyStoreDomain)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'shopifyStoreDomain is invalid');
  }
  if (!['sandbox', 'production'].includes(input.ebayEnvironment)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'ebayEnvironment is invalid');
  }
  const ebaySellerId = safeText(input.ebaySellerId, 'ebaySellerId', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ebaySellerId)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'ebaySellerId is invalid');
  }
  if (input.ebayMarketplaceId !== 'EBAY_US') {
    throw new ListingControlStoreError('INVALID_INPUT', 'Only EBAY_US is supported');
  }
  return { ...input, shopifyStoreDomain, ebaySellerId, ebayMarketplaceId: 'EBAY_US' };
}

function scopeWithoutKey(input: ListingControlScope & { scopeKey?: Digest }): ListingControlScope {
  return {
    shopifyStoreDomain: input.shopifyStoreDomain,
    ebayEnvironment: input.ebayEnvironment,
    ebaySellerId: input.ebaySellerId,
    ebayMarketplaceId: input.ebayMarketplaceId,
  };
}

function deriveScopeKey(scope: ListingControlScope): Digest {
  return sha256Digest({ schemaVersion: 1, type: 'listing_control_scope', ...canonicalScope(scope) });
}

function deriveStableSubjectKey(
  scope: ListingControlScope,
  shopifyProductGid: string,
  shopifyVariantGid: string,
): Digest {
  return sha256Digest({
    schemaVersion: 1,
    type: 'listing_subject',
    scopeKey: deriveScopeKey(scope),
    shopifyProductGid,
    shopifyVariantGid,
  });
}

function canonicalIdentity(
  input: ListingIdentity,
  scope: ListingControlScope,
): ListingIdentity {
  assertExactKeys(input, [
    'shopifyProductGid', 'shopifyVariantGid', 'rawSku', 'ebaySellerId',
    'ebayMarketplaceId', 'managementModel', 'ebayInventorySku', 'ebayOfferId',
    'ebayListingId',
  ], 'identity');
  if (input.ebaySellerId !== scope.ebaySellerId
    || input.ebayMarketplaceId !== scope.ebayMarketplaceId) {
    throw new ListingControlStoreError('ACCOUNT_DRIFT', 'Listing identity account does not match store scope');
  }
  if (!LISTING_MANAGEMENT_MODELS.includes(input.managementModel)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'managementModel is invalid');
  }
  const rawSku = exactSku(input.rawSku, 'rawSku');
  const inventorySku = input.ebayInventorySku === null
    ? null
    : exactSku(input.ebayInventorySku, 'ebayInventorySku');
  if (inventorySku !== null && inventorySku !== rawSku) {
    throw new ListingControlStoreError('INVALID_INPUT', 'eBay inventory SKU must byte-match raw SKU');
  }
  if (input.managementModel === 'inventory_api' && inventorySku === null) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Inventory API model requires exact inventory SKU');
  }
  return {
    shopifyProductGid: gid(input.shopifyProductGid, 'Product', 'shopifyProductGid'),
    shopifyVariantGid: gid(input.shopifyVariantGid, 'ProductVariant', 'shopifyVariantGid'),
    rawSku,
    ebaySellerId: scope.ebaySellerId,
    ebayMarketplaceId: 'EBAY_US',
    managementModel: input.managementModel,
    ebayInventorySku: inventorySku,
    ebayOfferId: input.ebayOfferId === null ? null : identifier(input.ebayOfferId, 'ebayOfferId'),
    ebayListingId: input.ebayListingId === null ? null : identifier(input.ebayListingId, 'ebayListingId'),
  };
}

export function deriveListingSubjectKey(input: {
  scope: ListingControlScope;
  identity: ListingIdentity;
}): Digest {
  const scope = canonicalScope(input.scope);
  const identity = canonicalIdentity(input.identity, scope);
  return deriveStableSubjectKey(scope, identity.shopifyProductGid, identity.shopifyVariantGid);
}

function checkValue(value: string | null, field: string, lane: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ListingControlStoreError('INVALID_INPUT', `${field} ${lane} value is invalid`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  let invalidSize = false;
  if (field === 'description') {
    invalidSize = bytes > MAX_DESCRIPTION_UTF8_BYTES;
    if (!invalidSize) {
      let characters = 0;
      for (const _character of value) {
        characters += 1;
        if (characters > MAX_DESCRIPTION_CHARACTERS) {
          invalidSize = true;
          break;
        }
      }
    }
  } else {
    const maximum = ['images', 'item_specifics'].includes(field)
      ? MAX_LARGE_VALUE_BYTES
      : MAX_SCALAR_VALUE_BYTES;
    invalidSize = bytes > maximum;
  }
  if (invalidSize || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ListingControlStoreError('INVALID_INPUT', `${field} ${lane} value is invalid`);
  }
  if (PROHIBITED_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new ListingControlStoreError('INVALID_INPUT', `${field} ${lane} value contains prohibited material`);
  }
  return value;
}

function canonicalField(input: ListingFieldInput): ListingFieldInput {
  assertExactKeys(input, [
    'field', 'sourceValue', 'sourceDigest', 'defaultValue', 'defaultDigest',
    'overrideValue', 'overrideDigest', 'proposedValue', 'proposedDigest',
    'proposedSource', 'observedValue', 'observedDigest',
  ], 'listing field');
  if (!LISTING_FIELD_NAMES.includes(input.field)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Listing field name is invalid');
  }
  const sourceValue = checkValue(input.sourceValue, input.field, 'source');
  const defaultValue = checkValue(input.defaultValue, input.field, 'default');
  const overrideValue = checkValue(input.overrideValue, input.field, 'override');
  const proposedValue = checkValue(input.proposedValue, input.field, 'proposed');
  const observedValue = checkValue(input.observedValue, input.field, 'observed');
  const sourceDigest = assertDigest(input.sourceDigest, `${input.field}.sourceDigest`) as Digest;
  const defaultDigest = assertDigest(input.defaultDigest, `${input.field}.defaultDigest`) as Digest;
  const overrideDigest = assertDigest(input.overrideDigest, `${input.field}.overrideDigest`) as Digest;
  const proposedDigest = assertDigest(input.proposedDigest, `${input.field}.proposedDigest`) as Digest;
  const observedDigest = assertDigest(input.observedDigest, `${input.field}.observedDigest`) as Digest;
  if (sourceDigest !== sha256Digest({ state: sourceValue === null ? 'missing' : 'value', value: sourceValue })) {
    throw new ListingControlStoreError('INVALID_INPUT', `${input.field} source digest mismatch`);
  }
  if (defaultDigest !== sha256Digest({
    state: defaultValue === null ? 'not_set' : 'value', value: defaultValue,
  })) {
    throw new ListingControlStoreError('INVALID_INPUT', `${input.field} default digest mismatch`);
  }
  if (overrideDigest !== sha256Digest({
    state: overrideValue === null ? 'not_set' : 'value', value: overrideValue,
  })) {
    throw new ListingControlStoreError('INVALID_INPUT', `${input.field} override digest mismatch`);
  }
  if (proposedDigest !== sha256Digest({ state: proposedValue === null ? 'omitted' : 'value', value: proposedValue })) {
    throw new ListingControlStoreError('INVALID_INPUT', `${input.field} proposed digest mismatch`);
  }
  if (observedDigest !== sha256Digest({
    state: observedValue === null ? 'unavailable' : 'value', value: observedValue,
  })) {
    throw new ListingControlStoreError('INVALID_INPUT', `${input.field} observed digest mismatch`);
  }
  if (defaultValue !== null || input.proposedSource === 'default') {
    throw new ListingControlStoreError(
      'INVALID_INPUT',
      `${input.field} defaults require a future immutable approved-default revision`,
    );
  }
  const selectedValue = input.proposedSource === 'source'
    ? sourceValue
    : input.proposedSource === 'observed'
      ? observedValue
    : input.proposedSource === 'override'
      ? overrideValue
      : input.proposedSource === 'omit'
        ? null
        : undefined;
  if (selectedValue === undefined
    || ((input.proposedSource === 'source' || input.proposedSource === 'observed'
      || input.proposedSource === 'override') && selectedValue === null)
    || proposedValue !== selectedValue) {
    throw new ListingControlStoreError('INVALID_INPUT', `${input.field} proposed provenance mismatch`);
  }
  return {
    field: input.field,
    sourceValue,
    sourceDigest,
    defaultValue,
    defaultDigest,
    overrideValue,
    overrideDigest,
    proposedValue,
    proposedDigest,
    proposedSource: input.proposedSource,
    observedValue,
    observedDigest,
  };
}

function derivedBaseDigests(
  scope: ListingControlScope,
  identity: ListingIdentity,
  sourceObservedAtUtc: string,
  ebayObservedAtUtc: string,
  fields: readonly ListingFieldInput[],
): ListingBaseDigests {
  const scopeKey = deriveScopeKey(scope);
  const subjectKey = deriveListingSubjectKey({ scope, identity });
  return Object.freeze({
    source: sha256Digest({
      schemaVersion: 1,
      type: 'shopify_source_observation',
      scopeKey,
      subjectKey,
      shopifyProductGid: identity.shopifyProductGid,
      shopifyVariantGid: identity.shopifyVariantGid,
      rawSku: identity.rawSku,
      observedAtUtc: sourceObservedAtUtc,
      fields: fields.map(({ field, sourceDigest }) => ({ field, sourceDigest })),
    }),
    ebay: sha256Digest({
      schemaVersion: 1,
      type: 'ebay_listing_observation',
      scopeKey,
      subjectKey,
      ebayEnvironment: scope.ebayEnvironment,
      ebaySellerId: identity.ebaySellerId,
      ebayMarketplaceId: identity.ebayMarketplaceId,
      managementModel: identity.managementModel,
      ebayInventorySku: identity.ebayInventorySku,
      ebayOfferId: identity.ebayOfferId,
      ebayListingId: identity.ebayListingId,
      observedAtUtc: ebayObservedAtUtc,
      fields: fields.map(({ field, observedDigest }) => ({ field, observedDigest })),
    }),
  });
}

export function deriveListingBaseDigests(input: {
  scope: ListingControlScope;
  identity: ListingIdentity;
  baseSourceObservedAtUtc: string;
  baseEbayObservedAtUtc: string;
  fields: readonly ListingFieldInput[];
}): ListingBaseDigests {
  assertExactKeys(input, [
    'scope', 'identity', 'baseSourceObservedAtUtc', 'baseEbayObservedAtUtc', 'fields',
  ], 'base observation');
  const scope = canonicalScope(input.scope);
  const identity = canonicalIdentity(input.identity, scope);
  const sourceObserved = timestamp(input.baseSourceObservedAtUtc, 'baseSourceObservedAtUtc');
  const ebayObserved = timestamp(input.baseEbayObservedAtUtc, 'baseEbayObservedAtUtc');
  const fields = canonicalFields(input.fields);
  return derivedBaseDigests(scope, identity, sourceObserved.utc, ebayObserved.utc, fields);
}

function derivedSemanticDigests(
  identity: ListingIdentity,
  fields: readonly ListingFieldInput[],
): ListingBaseDigests {
  const source = Object.fromEntries(fields.map(({ field, sourceValue }) => [field, sourceValue]));
  const observed = Object.fromEntries(
    fields.map(({ field, observedValue }) => [field, observedValue]),
  );
  return Object.freeze({
    source: sha256Digest({
      schemaVersion: 1,
      shopifyProductGid: identity.shopifyProductGid,
      shopifyVariantGid: identity.shopifyVariantGid,
      rawSku: identity.rawSku,
      fields: source,
    }),
    ebay: sha256Digest({
      schemaVersion: 1,
      ebaySellerId: identity.ebaySellerId,
      ebayMarketplaceId: identity.ebayMarketplaceId,
      managementModel: identity.managementModel,
      ebayInventorySku: identity.ebayInventorySku,
      ebayOfferId: identity.ebayOfferId,
      ebayListingId: identity.ebayListingId,
      fields: observed,
    }),
  });
}

/** Timestamp-free fact digests shared with the listing-draft DTO contract. */
export function deriveListingSemanticDigests(input: {
  scope: ListingControlScope;
  identity: ListingIdentity;
  fields: readonly ListingFieldInput[];
}): ListingBaseDigests {
  assertExactKeys(input, ['scope', 'identity', 'fields'], 'semantic listing observation');
  const scope = canonicalScope(input.scope);
  const identity = canonicalIdentity(input.identity, scope);
  const fields = canonicalFields(input.fields);
  return derivedSemanticDigests(identity, fields);
}

function canonicalFields(inputs: readonly ListingFieldInput[]): readonly ListingFieldInput[] {
  if (!Array.isArray(inputs) || inputs.length !== LISTING_FIELD_NAMES.length) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Every listing field must be supplied exactly once');
  }
  const byName = new Map(inputs.map((entry) => [entry.field, canonicalField(entry)]));
  if (byName.size !== LISTING_FIELD_NAMES.length
    || LISTING_FIELD_NAMES.some((field) => !byName.has(field))) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Every listing field must be supplied exactly once');
  }
  const fields = LISTING_FIELD_NAMES.map((field) => byName.get(field)!);
  const descriptionFields = fields.filter((field) => field.field === 'description');
  const nonDescriptionFields = fields.filter((field) => field.field !== 'description');
  const descriptionBytes = Buffer.byteLength(stableJson(descriptionFields), 'utf8');
  const nonDescriptionBytes = Buffer.byteLength(stableJson(nonDescriptionFields), 'utf8');
  if (descriptionBytes > MAX_DESCRIPTION_REVISION_VALUE_BYTES
    || nonDescriptionBytes > MAX_NON_DESCRIPTION_REVISION_VALUE_BYTES) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Listing revision is too large');
  }
  return Object.freeze(fields.map((field) => Object.freeze({ ...field })));
}

function canonicalProposalEvidence(
  input: readonly ListingProposalEvidenceItem[],
): readonly ListingProposalEvidenceItem[] {
  if (!Array.isArray(input) || input.length > 128) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal evidence is invalid');
  }
  const evidence = input.map((entry) => {
    assertExactKeys(entry, ['source', 'field', 'valueDigest', 'summary'], 'proposal evidence');
    if (!['shopify', 'ebay', 'draft', 'policy'].includes(entry.source)
      || (entry.field !== 'listing' && !LISTING_FIELD_NAMES.includes(entry.field))) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal evidence reference is invalid');
    }
    return Object.freeze({
      source: entry.source,
      field: entry.field,
      valueDigest: assertDigest(entry.valueDigest, 'proposal evidence valueDigest') as Digest,
      summary: entry.summary === null ? null : safeText(entry.summary, 'proposal evidence summary', 512),
    });
  });
  assertNoCredentialMaterial(evidence);
  if (Buffer.byteLength(stableJson(evidence), 'utf8') > MAX_PROPOSAL_EVIDENCE_BYTES) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal evidence is too large');
  }
  return Object.freeze(evidence);
}

export function deriveListingProposalEvidenceDigest(
  evidenceInput: readonly ListingProposalEvidenceItem[],
): Digest {
  const evidence = canonicalProposalEvidence(evidenceInput);
  return sha256Digest({ schemaVersion: 1, type: 'listing_proposal_evidence', evidence });
}

function canonicalDecisionEvidence(
  input: readonly ListingProposalEvidenceRef[],
): readonly ListingProposalEvidenceRef[] {
  if (!Array.isArray(input) || input.length > 32) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field evidence is invalid');
  }
  const evidence = input.map((entry) => {
    assertExactKeys(entry, ['source', 'field', 'digest'], 'proposal field evidence');
    if (!['shopify', 'ebay', 'draft', 'policy'].includes(entry.source)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field evidence source is invalid');
    }
    return Object.freeze({
      source: entry.source,
      field: safeText(entry.field, 'proposal field evidence field', 128),
      digest: assertDigest(entry.digest, 'proposal field evidence digest') as Digest,
    });
  });
  assertNoCredentialMaterial(evidence);
  if (Buffer.byteLength(stableJson(evidence), 'utf8') > MAX_PROPOSAL_EVIDENCE_BYTES) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field evidence is too large');
  }
  return Object.freeze(evidence);
}

function canonicalProposalDecisions(
  inputs: readonly ListingProposalFieldDecisionInput[],
  required: boolean,
): readonly ListingProposalFieldDecision[] {
  if (!Array.isArray(inputs) || (required && inputs.length !== LISTING_AI_PROPOSABLE_FIELDS.length)
    || (!required && inputs.length !== 0)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field decision set is invalid');
  }
  const decisions = inputs.map((input) => {
    assertExactKeys(input, [
      'field', 'proposedValue', 'proposedDigest', 'proposedSource', 'confidence',
      'reasonCode', 'warningCode', 'evidence',
    ], 'proposal field decision');
    if (!LISTING_AI_PROPOSABLE_FIELDS.includes(input.field)
      || !['source', 'observed', 'override', 'omit'].includes(input.proposedSource)
      || !LISTING_PROPOSAL_CONFIDENCE_LEVELS.includes(input.confidence)
      || !LISTING_PROPOSAL_FIELD_REASON_CODES.includes(input.reasonCode)
      || (input.warningCode !== null
        && !LISTING_PROPOSAL_WARNING_CODES.includes(input.warningCode))) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field decision is invalid');
    }
    const proposedValue = checkValue(input.proposedValue, input.field, 'AI proposed');
    const proposedDigest = assertDigest(input.proposedDigest, `${input.field}.proposedDigest`) as Digest;
    if (proposedDigest !== sha256Digest({
      state: proposedValue === null ? 'omitted' : 'value', value: proposedValue,
    }) || (input.proposedSource === 'omit') !== (proposedValue === null)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field value digest mismatch');
    }
    const evidence = canonicalDecisionEvidence(input.evidence);
    return Object.freeze({
      field: input.field,
      proposedValue,
      proposedDigest,
      proposedSource: input.proposedSource,
      confidence: input.confidence,
      reasonCode: input.reasonCode,
      warningCode: input.warningCode,
      evidence,
      evidenceDigest: sha256Digest({
        schemaVersion: 1, type: 'listing_proposal_field_evidence', evidence,
      }),
    });
  });
  const byName = new Set(decisions.map(({ field }) => field));
  if (byName.size !== decisions.length
    || (required && LISTING_AI_PROPOSABLE_FIELDS.some((field) => !byName.has(field)))) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal fields must be unique and complete');
  }
  return Object.freeze(LISTING_AI_PROPOSABLE_FIELDS
    .map((field) => decisions.find((decision) => decision.field === field))
    .filter((decision): decision is ListingProposalFieldDecision => decision !== undefined));
}

function canonicalUsage(input: ListingProposalUsage): ListingProposalUsage {
  assertExactKeys(input, ['inputTokens', 'outputTokens', 'totalTokens'], 'proposal usage');
  const values = [input.inputTokens, input.outputTokens, input.totalTokens];
  if (!values.every((value) => value === null
    || (Number.isSafeInteger(value) && (value as number) >= 0))
    || (values.some((value) => value === null) && values.some((value) => value !== null))
    || (input.inputTokens !== null && input.outputTokens !== null
      && input.totalTokens !== input.inputTokens + input.outputTokens)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal token usage is invalid');
  }
  return Object.freeze({ ...input });
}

function normalizeExactPath(databasePath: string, mustExist: boolean): string {
  if (typeof databasePath !== 'string' || databasePath.length === 0
    || databasePath.includes('\u0000') || databasePath.startsWith('file:')
    || databasePath === ':memory:' || !path.isAbsolute(databasePath)
    || path.resolve(databasePath) !== databasePath) {
    throw new ListingControlStoreError('PATH_REJECTED', 'Store path must be an exact absolute path');
  }
  const parent = path.dirname(databasePath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new ListingControlStoreError('PATH_REJECTED', 'Store parent directory is missing');
  }
  const parentStat = fs.statSync(parent);
  if ((parentStat.mode & 0o022) !== 0) {
    throw new ListingControlStoreError('PATH_REJECTED', 'Store parent directory must not be group/world writable');
  }
  if (mustExist) {
    if (!fs.existsSync(databasePath)) {
      throw new ListingControlStoreError('PATH_REJECTED', 'Store file does not exist');
    }
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new ListingControlStoreError('PATH_REJECTED', 'Store must be one regular 0600 file');
    }
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${databasePath}${suffix}`)) {
        throw new ListingControlStoreError('PATH_REJECTED', 'Store has unexpected WAL sidecars');
      }
    }
  } else if (fs.existsSync(databasePath)) {
    throw new ListingControlStoreError('PATH_REJECTED', 'Refusing to replace an existing store');
  }
  return databasePath;
}

function configureWritable(database: Sqlite): void {
  database.pragma('foreign_keys = ON');
  database.pragma('recursive_triggers = ON');
  database.pragma('busy_timeout = 5000');
  if (String(database.pragma('journal_mode = DELETE', { simple: true })).toLowerCase() !== 'delete') {
    throw new Error('DELETE journal mode could not be enforced');
  }
  database.pragma('synchronous = FULL');
}

function configureReadOnly(database: Sqlite): void {
  database.pragma('busy_timeout = 5000');
  database.pragma('query_only = ON');
  if (database.pragma('query_only', { simple: true }) !== 1) {
    throw new Error('SQLite query_only could not be enforced');
  }
}

function readScope(database: Sqlite): ListingControlScope & { scopeKey: Digest } {
  const row = database.prepare(
    `SELECT scope_key, shopify_store_domain, ebay_environment, ebay_seller_id, ebay_marketplace_id
     FROM control_scope WHERE singleton = 1`,
  ).get() as {
    scope_key: string;
    shopify_store_domain: string;
    ebay_environment: 'sandbox' | 'production';
    ebay_seller_id: string;
    ebay_marketplace_id: 'EBAY_US';
  } | undefined;
  if (!row) throw new Error('Listing control scope is missing');
  return {
    scopeKey: assertDigest(row.scope_key, 'scopeKey') as Digest,
    shopifyStoreDomain: row.shopify_store_domain,
    ebayEnvironment: row.ebay_environment,
    ebaySellerId: row.ebay_seller_id,
    ebayMarketplaceId: row.ebay_marketplace_id,
  };
}

function verifyExpectedScope(database: Sqlite, expectedInput: ListingControlScope) {
  const expected = canonicalScope(expectedInput);
  const actual = readScope(database);
  if (actual.scopeKey !== deriveScopeKey(expected)
    || actual.shopifyStoreDomain !== expected.shopifyStoreDomain
    || actual.ebayEnvironment !== expected.ebayEnvironment
    || actual.ebaySellerId !== expected.ebaySellerId
    || actual.ebayMarketplaceId !== expected.ebayMarketplaceId) {
    throw new ListingControlStoreError('ACCOUNT_DRIFT', 'Store belongs to another account scope');
  }
  return actual;
}

type AuditRow = {
  sequence: number;
  scope_key: string;
  event_id: string;
  event_type: string;
  occurred_at_utc: string;
  occurred_epoch_ms: number;
  subject_key: string | null;
  revision_digest: string | null;
  proposal_event_digest: string | null;
  payload_digest: string;
  previous_hash: string;
  event_hash: string;
};

function auditHash(row: Omit<AuditRow, 'occurred_epoch_ms' | 'event_hash'>): Digest {
  if (row.event_type === 'proposal.event') {
    return sha256Digest({
      schemaVersion: 2,
      sequence: row.sequence,
      scopeKey: row.scope_key,
      eventId: row.event_id,
      eventType: row.event_type,
      occurredAtUtc: row.occurred_at_utc,
      subjectKey: row.subject_key,
      revisionDigest: row.revision_digest,
      proposalEventDigest: row.proposal_event_digest,
      payloadDigest: row.payload_digest,
      previousHash: row.previous_hash,
    });
  }
  return sha256Digest({
    schemaVersion: 1,
    sequence: row.sequence,
    scopeKey: row.scope_key,
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAtUtc: row.occurred_at_utc,
    subjectKey: row.subject_key,
    revisionDigest: row.revision_digest,
    payloadDigest: row.payload_digest,
    previousHash: row.previous_hash,
  });
}

function appendAudit(
  database: Sqlite,
  scopeKey: Digest,
  input: {
    eventId: string;
    eventType: 'scope.initialized' | 'revision.created' | 'proposal.event';
    occurredAtUtc: string;
    subjectKey: Digest | null;
    revisionDigest: Digest | null;
    proposalEventDigest?: Digest | null;
    payloadDigest: Digest;
  },
): Digest {
  const occurred = timestamp(input.occurredAtUtc, 'audit occurredAtUtc');
  const eventId = identifier(input.eventId, 'auditEventId');
  const previous = database.prepare(
    'SELECT sequence, event_hash, occurred_epoch_ms FROM audit_events ORDER BY sequence DESC LIMIT 1',
  ).get() as { sequence: number; event_hash: string; occurred_epoch_ms: number } | undefined;
  if (previous && occurred.epochMs < previous.occurred_epoch_ms) {
    throw new ListingControlStoreError('CONFLICT', 'Audit time cannot move backward');
  }
  const row = {
    sequence: (previous?.sequence ?? 0) + 1,
    scope_key: scopeKey,
    event_id: eventId,
    event_type: input.eventType,
    occurred_at_utc: occurred.utc,
    subject_key: input.subjectKey,
    revision_digest: input.revisionDigest,
    proposal_event_digest: input.proposalEventDigest ?? null,
    payload_digest: input.payloadDigest,
    previous_hash: previous?.event_hash ?? GENESIS_HASH,
  };
  const eventHash = auditHash(row);
  database.prepare(
    `INSERT INTO audit_events (
      sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
      subject_key, revision_digest, payload_digest, previous_hash, event_hash
      , proposal_event_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.sequence, scopeKey, eventId, input.eventType, occurred.utc, occurred.epochMs,
    input.subjectKey, input.revisionDigest, input.payloadDigest, row.previous_hash, eventHash,
    row.proposal_event_digest);
  return eventHash;
}

function verifyAudit(database: Sqlite, scopeKey: Digest): ListingControlAuditVerification {
  const rows = database.prepare('SELECT * FROM audit_events ORDER BY sequence').all() as AuditRow[];
  const scope = database.prepare(
    'SELECT created_at_utc FROM control_scope WHERE singleton = 1 AND scope_key = ?',
  ).get(scopeKey) as { created_at_utc: string } | undefined;
  if (!scope || rows.length === 0) return { valid: false, recordCount: 0, headHash: null, error: 'Missing genesis' };
  let previous = GENESIS_HASH;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    let occurredEpochMs: number;
    try { occurredEpochMs = timestamp(row.occurred_at_utc, 'audit occurredAtUtc').epochMs; }
    catch { return { valid: false, recordCount: index, headHash: index ? previous as Digest : null, error: 'Audit timestamp mismatch' }; }
    if (row.sequence !== index + 1 || row.scope_key !== scopeKey
      || row.previous_hash !== previous || row.event_hash !== auditHash(row)
      || !DIGEST_PATTERN.test(row.payload_digest) || row.occurred_epoch_ms !== occurredEpochMs
      || (row.event_type === 'scope.initialized'
        ? row.subject_key !== null || row.revision_digest !== null
          || (row.proposal_event_digest ?? null) !== null
        : row.event_type === 'revision.created'
          ? row.subject_key === null || row.revision_digest === null
            || (row.proposal_event_digest ?? null) !== null
          : row.event_type === 'proposal.event'
            ? row.subject_key === null || row.revision_digest !== null
              || !DIGEST_PATTERN.test(row.proposal_event_digest ?? '')
            : true)) {
      return { valid: false, recordCount: index, headHash: index ? previous as Digest : null, error: 'Audit chain mismatch' };
    }
    if (index === 0 && (row.event_id !== `scope:${scopeKey}`
      || row.event_type !== 'scope.initialized' || row.occurred_at_utc !== scope.created_at_utc
      || row.subject_key !== null || row.revision_digest !== null
      || row.payload_digest !== sha256Digest({ scopeKey }))) {
      return { valid: false, recordCount: 0, headHash: null, error: 'Invalid genesis' };
    }
    previous = row.event_hash;
  }
  return { valid: true, recordCount: rows.length, headHash: previous as Digest };
}

type SubjectRow = {
  subject_key: string; scope_key: string; shopify_product_gid: string; shopify_variant_gid: string;
  created_at_utc: string; created_epoch_ms: number;
};
type RevisionRow = {
  revision_id: string; revision_number: number; scope_key: string; subject_key: string;
  revision_digest: string; previous_revision_digest: string | null; raw_sku: string;
  ebay_seller_id: string; ebay_marketplace_id: 'EBAY_US'; management_model: ListingIdentity['managementModel'];
  ebay_inventory_sku: string | null; ebay_offer_id: string | null; ebay_listing_id: string | null;
  base_source_digest: string; base_source_observed_at_utc: string; base_source_observed_epoch_ms: number;
  base_ebay_observation_digest: string; base_ebay_observed_at_utc: string;
  base_ebay_observed_epoch_ms: number; actor: string; state: ListingRevision['state'];
  created_at_utc: string; created_epoch_ms: number;
};
type FieldRow = {
  field_name: ListingFieldInput['field']; source_value: string | null; source_digest: string;
  default_value: string | null; default_digest: string; override_value: string | null;
  override_digest: string; proposed_value: string | null; proposed_digest: string;
  proposed_source: ListingFieldInput['proposedSource'];
  observed_value: string | null; observed_digest: string;
};
type ProposalJobRow = {
  job_id: string; job_digest: string; scope_key: string; subject_key: string;
  shopify_product_gid: string; shopify_variant_gid: string; raw_sku: string;
  ebay_seller_id: string; ebay_marketplace_id: 'EBAY_US';
  management_model: ListingIdentity['managementModel']; ebay_inventory_sku: string | null;
  ebay_offer_id: string | null; ebay_listing_id: string | null;
  base_revision_digest: string | null; base_source_digest: string;
  base_ebay_observation_digest: string; trigger_digest: string; catalog_id: string;
  evidence_json: string; evidence_digest: string; policy_version: string; policy_digest: string;
  prompt_version: string; prompt_digest: string; proposal_schema_version: string;
  proposal_schema_digest: string; agent_version: string; provider: 'openai' | 'fixture';
  requested_model: string; model_digest: string; requested_by: string;
  created_at_utc: string; created_epoch_ms: number;
};
type ProposalResultRow = {
  result_id: string; result_digest: string; job_id: string; outcome: ListingProposalOutcome;
  scope_key: string; subject_key: string;
  parsed_output_digest: string | null; failure_code: ListingProposalFailureCode | null;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  actor: string; completed_at_utc: string; completed_epoch_ms: number;
};
type ProposalDecisionRow = {
  result_id: string; field_name: ListingProposalFieldDecision['field']; proposed_value: string | null;
  scope_key: string; subject_key: string;
  proposed_digest: string; proposed_source: ListingProposalFieldDecision['proposedSource'];
  confidence: ListingProposalFieldDecision['confidence'];
  reason_code: ListingProposalFieldDecision['reasonCode'];
  warning_code: ListingProposalFieldDecision['warningCode']; evidence_json: string;
  evidence_digest: string;
};
type ProposalEventRow = {
  event_id: string; job_id: string; sequence: number; scope_key: string; subject_key: string;
  event_type: ListingProposalEvent['eventType']; event_digest: string;
  previous_event_digest: string | null; actor: string; occurred_at_utc: string;
  occurred_epoch_ms: number; result_digest: string | null; reviewed_revision_digest: string | null;
  review_reason_code: ListingProposalReviewReasonCode | null; payload_digest: string;
};

function proposalJobMaterial(job: Omit<ListingProposalJob, 'jobDigest'>) {
  return { recordSchemaVersion: 1, type: 'listing_proposal_job', ...job };
}

function proposalResultMaterial(result: Omit<ListingProposalResult, 'resultDigest'>) {
  return { schemaVersion: 1, type: 'listing_proposal_result', ...result };
}

function proposalEventMaterial(event: Omit<ListingProposalEvent, 'eventDigest'>) {
  return { schemaVersion: 1, type: 'listing_proposal_event', ...event };
}

function parseCanonicalJson<T>(value: string, name: string): T {
  try {
    const parsed = JSON.parse(value) as T;
    if (stableJson(parsed) !== value) throw new Error('not canonical');
    return parsed;
  } catch {
    throw new Error(`${name} is not canonical JSON`);
  }
}

function readProposalJob(database: Sqlite, jobId: string): ListingProposalJob | null {
  const row = database.prepare('SELECT * FROM listing_proposal_jobs WHERE job_id = ?')
    .get(jobId) as ProposalJobRow | undefined;
  if (!row) return null;
  const evidence = canonicalProposalEvidence(
    parseCanonicalJson<ListingProposalEvidenceItem[]>(row.evidence_json, 'Proposal evidence'),
  );
  const jobWithoutDigest: Omit<ListingProposalJob, 'jobDigest'> = {
    jobId: row.job_id,
    scopeKey: row.scope_key as Digest,
    subjectKey: row.subject_key as Digest,
    identity: {
      shopifyProductGid: row.shopify_product_gid,
      shopifyVariantGid: row.shopify_variant_gid,
      rawSku: row.raw_sku,
      ebaySellerId: row.ebay_seller_id,
      ebayMarketplaceId: row.ebay_marketplace_id,
      managementModel: row.management_model,
      ebayInventorySku: row.ebay_inventory_sku,
      ebayOfferId: row.ebay_offer_id,
      ebayListingId: row.ebay_listing_id,
    },
    baseRevisionDigest: row.base_revision_digest as Digest | null,
    baseSourceDigest: row.base_source_digest as Digest,
    baseEbayObservationDigest: row.base_ebay_observation_digest as Digest,
    triggerDigest: row.trigger_digest as Digest,
    catalogId: row.catalog_id,
    evidence,
    evidenceDigest: row.evidence_digest as Digest,
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest as Digest,
    promptVersion: row.prompt_version,
    promptDigest: row.prompt_digest as Digest,
    schemaVersion: row.proposal_schema_version,
    schemaDigest: row.proposal_schema_digest as Digest,
    agentVersion: row.agent_version,
    provider: row.provider,
    requestedModel: row.requested_model,
    modelDigest: row.model_digest as Digest,
    requestedBy: row.requested_by,
    createdAtUtc: row.created_at_utc,
  };
  if (row.evidence_digest !== deriveListingProposalEvidenceDigest(evidence)
    || row.job_digest !== sha256Digest(proposalJobMaterial(jobWithoutDigest))) {
    throw new Error('Proposal job digest mismatch');
  }
  return Object.freeze({ ...jobWithoutDigest, jobDigest: row.job_digest as Digest });
}

function readProposalResult(database: Sqlite, jobId: string): ListingProposalResult | null {
  const row = database.prepare('SELECT * FROM listing_proposal_results WHERE job_id = ?')
    .get(jobId) as ProposalResultRow | undefined;
  if (!row) return null;
  const decisions = (database.prepare(
    'SELECT * FROM listing_proposal_field_decisions WHERE result_id = ? ORDER BY field_name',
  ).all(row.result_id) as ProposalDecisionRow[]).map((decision): ListingProposalFieldDecision => {
    const evidence = canonicalDecisionEvidence(
      parseCanonicalJson<ListingProposalEvidenceRef[]>(decision.evidence_json, 'Decision evidence'),
    );
    const evidenceDigest = sha256Digest({
      schemaVersion: 1, type: 'listing_proposal_field_evidence', evidence,
    });
    if (evidenceDigest !== decision.evidence_digest) throw new Error('Decision evidence digest mismatch');
    return Object.freeze({
      field: decision.field_name,
      proposedValue: decision.proposed_value,
      proposedDigest: decision.proposed_digest as Digest,
      proposedSource: decision.proposed_source,
      confidence: decision.confidence,
      reasonCode: decision.reason_code,
      warningCode: decision.warning_code,
      evidence,
      evidenceDigest,
    });
  });
  const ordered = LISTING_AI_PROPOSABLE_FIELDS
    .map((field) => decisions.find((decision) => decision.field === field))
    .filter((decision): decision is ListingProposalFieldDecision => decision !== undefined);
  const resultWithoutDigest: Omit<ListingProposalResult, 'resultDigest'> = {
    resultId: row.result_id,
    jobId: row.job_id,
    outcome: row.outcome,
    parsedOutputDigest: row.parsed_output_digest as Digest | null,
    failureCode: row.failure_code,
    usage: Object.freeze({
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    }),
    actor: row.actor,
    completedAtUtc: row.completed_at_utc,
    fields: Object.freeze(ordered),
  };
  if (row.result_digest !== sha256Digest(proposalResultMaterial(resultWithoutDigest))) {
    throw new Error('Proposal result digest mismatch');
  }
  return Object.freeze({ ...resultWithoutDigest, resultDigest: row.result_digest as Digest });
}

function readProposalEvent(database: Sqlite, eventId: string): ListingProposalEvent | null {
  const row = database.prepare('SELECT * FROM listing_proposal_events WHERE event_id = ?')
    .get(eventId) as ProposalEventRow | undefined;
  if (!row) return null;
  const eventWithoutDigest: Omit<ListingProposalEvent, 'eventDigest'> = {
    eventId: row.event_id,
    jobId: row.job_id,
    sequence: row.sequence,
    scopeKey: row.scope_key as Digest,
    subjectKey: row.subject_key as Digest,
    eventType: row.event_type,
    previousEventDigest: row.previous_event_digest as Digest | null,
    actor: row.actor,
    occurredAtUtc: row.occurred_at_utc,
    resultDigest: row.result_digest as Digest | null,
    reviewedRevisionDigest: row.reviewed_revision_digest as Digest | null,
    reviewReasonCode: row.review_reason_code,
    payloadDigest: row.payload_digest as Digest,
  };
  if (row.event_digest !== sha256Digest(proposalEventMaterial(eventWithoutDigest))) {
    throw new Error('Proposal event digest mismatch');
  }
  return Object.freeze({ ...eventWithoutDigest, eventDigest: row.event_digest as Digest });
}

function readLatestProposalEvent(database: Sqlite, jobId: string): ListingProposalEvent | null {
  const row = database.prepare(
    'SELECT event_id FROM listing_proposal_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1',
  ).get(jobId) as { event_id: string } | undefined;
  return row ? readProposalEvent(database, row.event_id) : null;
}

function readProposal(database: Sqlite, jobId: string): ListingProposal | null {
  const job = readProposalJob(database, jobId);
  if (!job) return null;
  const latestEvent = readLatestProposalEvent(database, jobId);
  if (!latestEvent) throw new Error('Proposal job event is missing');
  return Object.freeze({ job, latestEvent, result: readProposalResult(database, jobId) });
}

function appendProposalEvent(
  database: Sqlite,
  job: ListingProposalJob,
  input: {
    eventId: string;
    eventType: ListingProposalEvent['eventType'];
    expectedPreviousEventDigest: Digest | null;
    actor: string;
    occurredAtUtc: string;
    resultDigest: Digest | null;
    reviewedRevisionDigest: Digest | null;
    reviewReasonCode: ListingProposalReviewReasonCode | null;
    payloadDigest: Digest;
  },
): ListingProposalEvent {
  const eventId = identifier(input.eventId, 'proposal eventId', 120);
  const actor = identifier(input.actor, 'proposal event actor');
  const occurred = timestamp(input.occurredAtUtc, 'proposal event occurredAtUtc');
  const previous = readLatestProposalEvent(database, job.jobId);
  if ((previous?.eventDigest ?? null) !== input.expectedPreviousEventDigest) {
    throw new ListingControlStoreError('STALE_BASE', 'Proposal event base is stale');
  }
  if (previous && occurred.epochMs < Date.parse(previous.occurredAtUtc)) {
    throw new ListingControlStoreError('CONFLICT', 'Proposal event time cannot move backward');
  }
  if (!LISTING_PROPOSAL_EVENT_TYPES.includes(input.eventType)) {
    throw new ListingControlStoreError('INVALID_INPUT', 'Proposal event type is invalid');
  }
  const eventWithoutDigest: Omit<ListingProposalEvent, 'eventDigest'> = {
    eventId,
    jobId: job.jobId,
    sequence: (previous?.sequence ?? 0) + 1,
    scopeKey: job.scopeKey,
    subjectKey: job.subjectKey,
    eventType: input.eventType,
    previousEventDigest: input.expectedPreviousEventDigest,
    actor,
    occurredAtUtc: occurred.utc,
    resultDigest: input.resultDigest,
    reviewedRevisionDigest: input.reviewedRevisionDigest,
    reviewReasonCode: input.reviewReasonCode,
    payloadDigest: assertDigest(input.payloadDigest, 'proposal event payloadDigest') as Digest,
  };
  const eventDigest = sha256Digest(proposalEventMaterial(eventWithoutDigest));
  database.prepare(
    `INSERT INTO listing_proposal_events (
      event_id, job_id, sequence, scope_key, subject_key, event_type, event_digest,
      previous_event_digest, actor, occurred_at_utc, occurred_epoch_ms, result_digest,
      reviewed_revision_digest, review_reason_code, payload_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, job.jobId, eventWithoutDigest.sequence, job.scopeKey, job.subjectKey,
    input.eventType, eventDigest, input.expectedPreviousEventDigest, actor, occurred.utc,
    occurred.epochMs, input.resultDigest, input.reviewedRevisionDigest,
    input.reviewReasonCode, input.payloadDigest);
  appendAudit(database, job.scopeKey, {
    eventId: `pa:${eventId}`,
    eventType: 'proposal.event',
    occurredAtUtc: occurred.utc,
    subjectKey: job.subjectKey,
    revisionDigest: null,
    proposalEventDigest: eventDigest,
    payloadDigest: eventDigest,
  });
  return readProposalEvent(database, eventId)!;
}

function identityFromRows(subject: SubjectRow, revision: RevisionRow): ListingIdentity {
  return {
    shopifyProductGid: subject.shopify_product_gid,
    shopifyVariantGid: subject.shopify_variant_gid,
    rawSku: revision.raw_sku,
    ebaySellerId: revision.ebay_seller_id,
    ebayMarketplaceId: revision.ebay_marketplace_id,
    managementModel: revision.management_model,
    ebayInventorySku: revision.ebay_inventory_sku,
    ebayOfferId: revision.ebay_offer_id,
    ebayListingId: revision.ebay_listing_id,
  };
}

function fieldFromRow(row: FieldRow): ListingFieldInput {
  return {
    field: row.field_name,
    sourceValue: row.source_value,
    sourceDigest: row.source_digest as Digest,
    defaultValue: row.default_value,
    defaultDigest: row.default_digest as Digest,
    overrideValue: row.override_value,
    overrideDigest: row.override_digest as Digest,
    proposedValue: row.proposed_value,
    proposedDigest: row.proposed_digest as Digest,
    proposedSource: row.proposed_source,
    observedValue: row.observed_value,
    observedDigest: row.observed_digest as Digest,
  };
}

function revisionMaterial(input: {
  revisionId: string; revisionNumber: number; scopeKey: Digest; subjectKey: Digest;
  previousRevisionDigest: Digest | null; identity: ListingIdentity; baseSourceDigest: Digest;
  baseSourceObservedAtUtc: string; baseEbayObservationDigest: Digest; baseEbayObservedAtUtc: string;
  actor: string; state: ListingRevision['state']; createdAtUtc: string; fields: readonly ListingFieldInput[];
}) {
  return { schemaVersion: 1, ...input };
}

function readRevision(database: Sqlite, revisionId: string): ListingRevision | null {
  const row = database.prepare('SELECT * FROM listing_revisions WHERE revision_id = ?').get(revisionId) as RevisionRow | undefined;
  if (!row) return null;
  const subject = database.prepare('SELECT * FROM listing_subjects WHERE subject_key = ?').get(row.subject_key) as SubjectRow | undefined;
  if (!subject) throw new Error('Revision subject is missing');
  const fields = (database.prepare(
    'SELECT * FROM listing_revision_fields WHERE revision_id = ? ORDER BY field_name',
  ).all(row.revision_id) as FieldRow[]).map(fieldFromRow);
  const orderedFields = LISTING_FIELD_NAMES.map((name) => fields.find((field) => field.field === name));
  if (orderedFields.some((field) => field === undefined)) throw new Error('Revision fields are incomplete');
  const identity = identityFromRows(subject, row);
  const material = revisionMaterial({
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    scopeKey: row.scope_key as Digest,
    subjectKey: row.subject_key as Digest,
    previousRevisionDigest: row.previous_revision_digest as Digest | null,
    identity,
    baseSourceDigest: row.base_source_digest as Digest,
    baseSourceObservedAtUtc: row.base_source_observed_at_utc,
    baseEbayObservationDigest: row.base_ebay_observation_digest as Digest,
    baseEbayObservedAtUtc: row.base_ebay_observed_at_utc,
    actor: row.actor,
    state: row.state,
    createdAtUtc: row.created_at_utc,
    fields: orderedFields as ListingFieldInput[],
  });
  if (row.revision_digest !== sha256Digest(material)) throw new Error('Revision digest mismatch');
  return Object.freeze({ ...material, revisionDigest: row.revision_digest as Digest });
}

function verifyDomain(database: Sqlite, scopeKey: Digest): void {
  const storedScope = readScope(database);
  const exactScope = scopeWithoutKey(storedScope);
  const scopeTime = database.prepare(
    'SELECT created_at_utc, created_epoch_ms FROM control_scope WHERE singleton = 1',
  ).get() as { created_at_utc: string; created_epoch_ms: number };
  if (timestamp(scopeTime.created_at_utc, 'scope createdAtUtc').epochMs !== scopeTime.created_epoch_ms) {
    throw new Error('Scope timestamp mismatch');
  }
  const subjects = database.prepare('SELECT * FROM listing_subjects ORDER BY subject_key').all() as SubjectRow[];
  for (const subject of subjects) {
    if (subject.scope_key !== scopeKey
      || subject.subject_key !== deriveStableSubjectKey(
        exactScope,
        gid(subject.shopify_product_gid, 'Product', 'shopifyProductGid'),
        gid(subject.shopify_variant_gid, 'ProductVariant', 'shopifyVariantGid'),
      )
      || timestamp(subject.created_at_utc, 'subject createdAtUtc').epochMs !== subject.created_epoch_ms) {
      throw new Error('Listing subject digest or scope mismatch');
    }
    const rows = database.prepare(
      'SELECT * FROM listing_revisions WHERE subject_key = ? ORDER BY revision_number',
    ).all(subject.subject_key) as RevisionRow[];
    const hasProposalTables = database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'listing_proposal_jobs'",
    ).get() as { count: number };
    if (rows.length === 0 && (hasProposalTables.count === 0 || !database.prepare(
      'SELECT 1 FROM listing_proposal_jobs WHERE subject_key = ? LIMIT 1',
    ).get(subject.subject_key))) throw new Error('Orphan listing subject');
    let previous: string | null = null;
    for (const [index, row] of rows.entries()) {
      const revision = readRevision(database, row.revision_id);
      if (row.revision_number !== index + 1 || row.previous_revision_digest !== previous || !revision
        || timestamp(row.base_source_observed_at_utc, 'baseSourceObservedAtUtc').epochMs
          !== row.base_source_observed_epoch_ms
        || timestamp(row.base_ebay_observed_at_utc, 'baseEbayObservedAtUtc').epochMs
          !== row.base_ebay_observed_epoch_ms
        || timestamp(row.created_at_utc, 'createdAtUtc').epochMs !== row.created_epoch_ms) {
        throw new Error('Listing revision chain mismatch');
      }
      const identity = canonicalIdentity(revision.identity, exactScope);
      const derivedBases = derivedBaseDigests(
        exactScope,
        identity,
        revision.baseSourceObservedAtUtc,
        revision.baseEbayObservedAtUtc,
        revision.fields,
      );
      if (revision.baseSourceDigest !== derivedBases.source
        || revision.baseEbayObservationDigest !== derivedBases.ebay) {
        throw new Error('Listing observation digest mismatch');
      }
      const audit = database.prepare(
        `SELECT subject_key, payload_digest, COUNT(*) AS count FROM audit_events
         WHERE event_type = 'revision.created' AND revision_digest = ?`,
      ).get(row.revision_digest) as { subject_key: string | null; payload_digest: string; count: number } | undefined;
      const expectedAuditPayload = sha256Digest({
        revisionId: revision.revisionId,
        revisionDigest: revision.revisionDigest,
        subjectKey: revision.subjectKey,
        revisionNumber: revision.revisionNumber,
        actor: revision.actor,
        state: revision.state,
        baseSourceDigest: revision.baseSourceDigest,
        baseEbayObservationDigest: revision.baseEbayObservationDigest,
      });
      if (!audit || audit.count !== 1 || audit.subject_key !== revision.subjectKey
        || audit.payload_digest !== expectedAuditPayload) {
        throw new Error('Revision audit binding mismatch');
      }
      previous = row.revision_digest;
    }
  }
  const bindings = database.prepare(
    'SELECT * FROM ebay_artifact_bindings ORDER BY artifact_type, artifact_id',
  ).all() as Array<{
    scope_key: string; artifact_type: 'offer' | 'listing'; artifact_id: string;
    subject_key: string; created_at_utc: string; created_epoch_ms: number;
  }>;
  for (const binding of bindings) {
    const column = binding.artifact_type === 'offer' ? 'ebay_offer_id' : 'ebay_listing_id';
    const referenced = database.prepare(
      `SELECT 1 FROM listing_revisions WHERE subject_key = ? AND ${column} = ? LIMIT 1`,
    ).get(binding.subject_key, binding.artifact_id);
    if (binding.scope_key !== scopeKey || !referenced
      || timestamp(binding.created_at_utc, 'artifact createdAtUtc').epochMs !== binding.created_epoch_ms) {
      throw new Error('eBay artifact binding mismatch');
    }
  }
  const skuBindings = database.prepare(
    'SELECT * FROM shopify_sku_bindings ORDER BY raw_sku',
  ).all() as Array<{
    scope_key: string; raw_sku: string; subject_key: string;
    created_at_utc: string; created_epoch_ms: number;
  }>;
  for (const binding of skuBindings) {
    const referenced = database.prepare(
      'SELECT 1 FROM listing_revisions WHERE subject_key = ? AND raw_sku = ? LIMIT 1',
    ).get(binding.subject_key, binding.raw_sku);
    if (binding.scope_key !== scopeKey || !referenced
      || timestamp(binding.created_at_utc, 'SKU binding createdAtUtc').epochMs
        !== binding.created_epoch_ms) {
      throw new Error('Shopify SKU binding mismatch');
    }
  }
  const unboundSkus = database.prepare(
    `SELECT revision_id FROM listing_revisions revision
     WHERE NOT EXISTS (
       SELECT 1 FROM shopify_sku_bindings binding
       WHERE binding.scope_key = revision.scope_key AND binding.raw_sku = revision.raw_sku
         AND binding.subject_key = revision.subject_key
     )`,
  ).all() as unknown[];
  if (unboundSkus.length !== 0) throw new Error('Revision has unbound Shopify SKU identity');
  const unboundArtifacts = database.prepare(
    `SELECT revision_id FROM listing_revisions revision
     WHERE (revision.ebay_offer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM ebay_artifact_bindings binding
       WHERE binding.scope_key = revision.scope_key AND binding.artifact_type = 'offer'
         AND binding.artifact_id = revision.ebay_offer_id AND binding.subject_key = revision.subject_key
     )) OR (revision.ebay_listing_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM ebay_artifact_bindings binding
       WHERE binding.scope_key = revision.scope_key AND binding.artifact_type = 'listing'
         AND binding.artifact_id = revision.ebay_listing_id AND binding.subject_key = revision.subject_key
     ))`,
  ).all() as unknown[];
  if (unboundArtifacts.length !== 0) throw new Error('Revision has unbound eBay artifact identity');
  const revisionAudit = database.prepare(
    `SELECT r.revision_digest FROM listing_revisions r
     LEFT JOIN audit_events a ON a.revision_digest = r.revision_digest AND a.event_type = 'revision.created'
     WHERE a.sequence IS NULL`,
  ).all() as unknown[];
  if (revisionAudit.length !== 0) throw new Error('Revision audit binding is missing');
  const proposalTable = database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'listing_proposal_events'",
  ).get() as { count: number };
  if (proposalTable.count !== 0) verifyProposalDomain(database, scopeKey, exactScope);
  const proposalEventCount = proposalTable.count === 0 ? 0 : (database.prepare(
    'SELECT COUNT(*) AS count FROM listing_proposal_events',
  ).get() as { count: number }).count;
  const counts = database.prepare(
    `SELECT
      (SELECT COUNT(*) FROM listing_revisions) AS revision_count,
      (SELECT COUNT(*) FROM audit_events WHERE event_type = 'revision.created') AS revision_audit_count,
      (SELECT COUNT(*) FROM audit_events WHERE event_type = 'proposal.event') AS proposal_audit_count,
      (SELECT COUNT(*) FROM audit_events) AS total_audit_count`,
  ).get() as { revision_count: number; revision_audit_count: number;
    proposal_audit_count: number; total_audit_count: number };
  if (counts.revision_audit_count !== counts.revision_count
    || counts.proposal_audit_count !== proposalEventCount
    || counts.total_audit_count !== counts.revision_count + proposalEventCount + 1) {
    throw new Error('Unexpected listing control audit event');
  }
}

function verifyProposalDomain(
  database: Sqlite,
  scopeKey: Digest,
  scope: ListingControlScope,
): void {
  const jobs = database.prepare('SELECT * FROM listing_proposal_jobs ORDER BY job_id')
    .all() as ProposalJobRow[];
  for (const row of jobs) {
    const job = readProposalJob(database, row.job_id);
    if (!job || row.scope_key !== scopeKey
      || timestamp(row.created_at_utc, 'proposal createdAtUtc').epochMs !== row.created_epoch_ms) {
      throw new Error('Proposal job scope or timestamp mismatch');
    }
    const identity = canonicalIdentity(job.identity, scope);
    if (job.subjectKey !== deriveListingSubjectKey({ scope, identity })) {
      throw new Error('Proposal subject identity mismatch');
    }
    const base = job.baseRevisionDigest === null ? null : database.prepare(
      `SELECT subject_key, base_source_digest, base_ebay_observation_digest
       FROM listing_revisions WHERE revision_digest = ?`,
    ).get(job.baseRevisionDigest) as {
      subject_key: string; base_source_digest: string; base_ebay_observation_digest: string;
    } | undefined;
    if (job.baseRevisionDigest !== null && (!base || base.subject_key !== job.subjectKey)) {
      throw new Error('Proposal base revision mismatch');
    }
    const baseRevisionRow = job.baseRevisionDigest === null ? undefined : database.prepare(
      'SELECT revision_id FROM listing_revisions WHERE revision_digest = ?',
    ).get(job.baseRevisionDigest) as { revision_id: string } | undefined;
    const baseRevision = baseRevisionRow
      ? readRevision(database, baseRevisionRow.revision_id) : null;
    for (const item of job.evidence.filter(({ source }) => source === 'draft')) {
      const field = item.field === 'listing'
        ? null : baseRevision?.fields.find(({ field: name }) => name === item.field);
      if (!field || field.proposedDigest !== item.valueDigest) {
        throw new Error('Proposal draft evidence mismatch');
      }
    }
    const eventRows = database.prepare(
      'SELECT * FROM listing_proposal_events WHERE job_id = ? ORDER BY sequence',
    ).all(job.jobId) as ProposalEventRow[];
    if (eventRows.length === 0 || eventRows.length > 4) throw new Error('Proposal event chain is incomplete');
    let previous: Digest | null = null;
    let previousEpoch = row.created_epoch_ms;
    for (const [index, eventRow] of eventRows.entries()) {
      const event = readProposalEvent(database, eventRow.event_id);
      if (!event || event.sequence !== index + 1 || event.previousEventDigest !== previous
        || event.scopeKey !== scopeKey || event.subjectKey !== job.subjectKey
        || timestamp(event.occurredAtUtc, 'proposal occurredAtUtc').epochMs
          !== eventRow.occurred_epoch_ms
        || eventRow.occurred_epoch_ms < previousEpoch) {
        throw new Error('Proposal event chain mismatch');
      }
      const audit = database.prepare(
        `SELECT subject_key, payload_digest, COUNT(*) AS count FROM audit_events
         WHERE event_type = 'proposal.event' AND proposal_event_digest = ?`,
      ).get(event.eventDigest) as { subject_key: string; payload_digest: string; count: number } | undefined;
      if (!audit || audit.count !== 1 || audit.subject_key !== job.subjectKey
        || audit.payload_digest !== event.eventDigest) {
        throw new Error('Proposal audit binding mismatch');
      }
      previous = event.eventDigest;
      previousEpoch = eventRow.occurred_epoch_ms;
    }
    const proposal = readProposal(database, job.jobId)!;
    const completion = eventRows.find((event) => LISTING_PROPOSAL_OUTCOMES.includes(
      event.event_type as ListingProposalOutcome,
    ));
    if ((proposal.result === null) !== (completion === undefined)
      || (proposal.result && (completion?.result_digest !== proposal.result.resultDigest
        || completion.event_type !== proposal.result.outcome))) {
      throw new Error('Proposal result event mismatch');
    }
    if (proposal.result) {
      const resultScope = database.prepare(
        'SELECT scope_key, subject_key FROM listing_proposal_results WHERE result_id = ?',
      ).get(proposal.result.resultId) as { scope_key: string; subject_key: string } | undefined;
      const decisionScopeDrift = database.prepare(
        `SELECT field_name FROM listing_proposal_field_decisions
         WHERE result_id = ? AND (scope_key <> ? OR subject_key <> ?) LIMIT 1`,
      ).get(proposal.result.resultId, scopeKey, job.subjectKey);
      if (!resultScope || resultScope.scope_key !== scopeKey
        || resultScope.subject_key !== job.subjectKey || decisionScopeDrift) {
        throw new Error('Proposal result scope mismatch');
      }
      const expectedDecisionCount = proposal.result.outcome === 'failed'
        ? 0 : LISTING_AI_PROPOSABLE_FIELDS.length;
      const hasLowConfidence = proposal.result.fields.some(
        ({ confidence }) => confidence === 'low',
      );
      if (proposal.result.fields.length !== expectedDecisionCount
        || (proposal.result.outcome !== 'failed'
          && ((proposal.result.outcome === 'needs_human') !== hasLowConfidence))) {
        throw new Error('Proposal decision set mismatch');
      }
      const approval = eventRows.find((event) => event.event_type === 'approved');
      if (approval) {
        const revision = database.prepare(
          'SELECT revision_id FROM listing_revisions WHERE revision_digest = ?',
        ).get(approval.reviewed_revision_digest) as { revision_id: string } | undefined;
        const reviewed = revision ? readRevision(database, revision.revision_id) : null;
        const reviewedSemantic = reviewed
          ? derivedSemanticDigests(reviewed.identity, reviewed.fields) : null;
        if (!reviewed || reviewed.state !== 'reviewed'
          || reviewed.previousRevisionDigest !== job.baseRevisionDigest
          || reviewedSemantic?.source !== job.baseSourceDigest
          || reviewedSemantic?.ebay !== job.baseEbayObservationDigest
          || LISTING_AI_PROPOSABLE_FIELDS.some((fieldName) => {
            const decision = proposal.result!.fields.find(({ field }) => field === fieldName);
            const field = reviewed.fields.find(({ field: name }) => name === fieldName);
            return !decision || !field || field.proposedDigest !== decision.proposedDigest
              || field.proposedValue !== decision.proposedValue
              || field.proposedSource !== decision.proposedSource;
          })) {
          throw new Error('Approved proposal revision binding mismatch');
        }
      }
    }
  }
  const orphanResults = database.prepare(
    `SELECT result_id FROM listing_proposal_results result
     WHERE NOT EXISTS (SELECT 1 FROM listing_proposal_jobs job WHERE job.job_id = result.job_id)`,
  ).all() as unknown[];
  if (orphanResults.length !== 0) throw new Error('Orphan proposal result');
}

function verifyDataIntegrity(database: Sqlite, scopeKey: Digest): void {
  if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('SQLite quick_check failed');
  if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) throw new Error('Foreign-key integrity failed');
  const audit = verifyAudit(database, scopeKey);
  if (!audit.valid) throw new Error(audit.error ?? 'Audit verification failed');
  verifyDomain(database, scopeKey);
}

function verifyIntegrity(database: Sqlite, scopeKey: Digest): void {
  verifyListingControlSchema(database);
  verifyDataIntegrity(database, scopeKey);
}

function translateError(error: unknown): never {
  if (error instanceof ListingControlStoreError) throw error;
  const message = error instanceof Error ? error.message : 'Listing control store failed';
  if (/locked|busy/i.test(message)) throw new ListingControlStoreError('CONFLICT', 'Concurrent store write denied');
  throw new ListingControlStoreError('SCHEMA_MISMATCH', message);
}

export interface ListingControlStore {
  readonly databasePath: string;
  readonly scope: ListingControlScope;
  readonly scopeKey: Digest;
  readonly writable: boolean;
  readonly capabilities: typeof LISTING_CONTROL_STORE_CAPABILITIES;
  createRevision(input: ListingRevisionInput): ListingRevision;
  createProposalJob(input: CreateListingProposalJobInput): {
    job: ListingProposalJob; deduplicated: boolean;
  };
  markProposalGenerating(input: MarkListingProposalGeneratingInput): ListingProposalEvent;
  completeProposal(input: CompleteListingProposalInput): {
    result: ListingProposalResult; event: ListingProposalEvent;
  };
  approveProposal(input: ApproveListingProposalInput): {
    revision: ListingRevision; event: ListingProposalEvent;
  };
  rejectProposal(input: ReviewListingProposalInput): ListingProposalEvent;
  markProposalStale(input: ReviewListingProposalInput): ListingProposalEvent;
  getProposalJob(jobId: string): ListingProposal | null;
  getLatestProposal(shopifyVariantGid: string): ListingProposal | null;
  getLatestProposalForCatalog(shopifyVariantGid: string, catalogId: string): ListingProposal | null;
  countProposalJobsForSubjectSince(shopifyVariantGid: string, sinceUtc: string): number;
  countProposalJobsForScopeSince(sinceUtc: string): number;
  getRevision(revisionId: string): ListingRevision | null;
  getLatestRevision(shopifyVariantGid: string): ListingRevision | null;
  verifyAudit(): ListingControlAuditVerification;
  verifyIntegrity(): void;
  close(): void;
}

class ListingControlStoreImpl implements ListingControlStore {
  readonly capabilities = LISTING_CONTROL_STORE_CAPABILITIES;

  constructor(
    private readonly database: Sqlite,
    readonly databasePath: string,
    readonly scope: ListingControlScope,
    readonly scopeKey: Digest,
    readonly writable: boolean,
  ) {}

  private assertWritable() {
    if (!this.writable) throw new ListingControlStoreError('READ_ONLY', 'Store is read-only');
  }

  private immediate<T>(operation: () => T): T {
    try {
      return this.database.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof ListingControlStoreError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/locked|busy/i.test(message)) {
        throw new ListingControlStoreError('CONFLICT', 'Concurrent store write denied');
      }
      if (/constraint|replay|replacement|chain mismatch|base mismatch|result mismatch/i.test(message)) {
        throw new ListingControlStoreError('CONFLICT', 'Proposal persistence conflict');
      }
      throw new ListingControlStoreError('SCHEMA_MISMATCH', 'Proposal persistence failed');
    }
  }

  createRevision(input: ListingRevisionInput): ListingRevision {
    return this.createRevisionInternal(input, false);
  }

  private createRevisionInternal(
    input: ListingRevisionInput,
    allowReviewedProposalApproval: boolean,
  ): ListingRevision {
    this.assertWritable();
    assertExactKeys(input, [
      'revisionId', 'identity', 'baseSourceDigest', 'baseSourceObservedAtUtc',
      'baseEbayObservationDigest', 'baseEbayObservedAtUtc', 'fields', 'actor',
      'state', 'createdAtUtc', 'expectedPreviousRevisionDigest',
      'expectedLatestBaseSourceDigest', 'expectedLatestBaseEbayObservationDigest',
      'auditEventId',
    ], 'revision');
    const revisionId = identifier(input.revisionId, 'revisionId');
    const actor = identifier(input.actor, 'actor');
    const auditEventId = identifier(input.auditEventId, 'auditEventId');
    const created = timestamp(input.createdAtUtc, 'createdAtUtc');
    const sourceObserved = timestamp(input.baseSourceObservedAtUtc, 'baseSourceObservedAtUtc');
    const ebayObserved = timestamp(input.baseEbayObservedAtUtc, 'baseEbayObservedAtUtc');
    if (sourceObserved.epochMs > created.epochMs || ebayObserved.epochMs > created.epochMs) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Base observations cannot be newer than revision');
    }
    if (!LISTING_DRAFT_STATES.includes(input.state)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Revision state is invalid');
    }
    if (input.state !== 'draft'
      && !(allowReviewedProposalApproval && input.state === 'reviewed')) {
      throw new ListingControlStoreError(
        'INVALID_INPUT',
        'Reviewed and stale transitions are not implemented in this unwired store',
      );
    }
    const identity = canonicalIdentity(input.identity, this.scope);
    const subjectKey = deriveListingSubjectKey({ scope: this.scope, identity });
    const baseSourceDigest = assertDigest(input.baseSourceDigest, 'baseSourceDigest') as Digest;
    const baseEbayObservationDigest = assertDigest(input.baseEbayObservationDigest, 'baseEbayObservationDigest') as Digest;
    const expectedPreviousRevisionDigest = assertDigest(
      input.expectedPreviousRevisionDigest, 'expectedPreviousRevisionDigest', true,
    );
    const expectedLatestBaseSourceDigest = assertDigest(
      input.expectedLatestBaseSourceDigest, 'expectedLatestBaseSourceDigest', true,
    );
    const expectedLatestBaseEbayObservationDigest = assertDigest(
      input.expectedLatestBaseEbayObservationDigest, 'expectedLatestBaseEbayObservationDigest', true,
    );
    const fields = canonicalFields(input.fields);
    assertNoCredentialMaterial(input);
    const derivedBases = derivedBaseDigests(
      this.scope,
      identity,
      sourceObserved.utc,
      ebayObserved.utc,
      fields,
    );
    if (baseSourceDigest !== derivedBases.source
      || baseEbayObservationDigest !== derivedBases.ebay) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Base observation digest mismatch');
    }

    try {
      const transaction = this.database.transaction(() => {
        const existingById = this.database.prepare(
          'SELECT revision_digest FROM listing_revisions WHERE revision_id = ?',
        ).get(revisionId) as { revision_digest: string } | undefined;
        if (existingById) throw new ListingControlStoreError('CONFLICT', 'Revision replay denied');

        let subject = this.database.prepare(
          'SELECT * FROM listing_subjects WHERE subject_key = ?',
        ).get(subjectKey) as SubjectRow | undefined;
        if (!subject) {
          if (expectedPreviousRevisionDigest !== null
            || expectedLatestBaseSourceDigest !== null
            || expectedLatestBaseEbayObservationDigest !== null) {
            throw new ListingControlStoreError('STALE_BASE', 'New subject cannot have a prior revision base');
          }
          this.database.prepare(
            `INSERT INTO listing_subjects (
              subject_key, scope_key, shopify_product_gid, shopify_variant_gid,
              created_at_utc, created_epoch_ms
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(subjectKey, this.scopeKey, identity.shopifyProductGid, identity.shopifyVariantGid,
            created.utc, created.epochMs);
          subject = this.database.prepare('SELECT * FROM listing_subjects WHERE subject_key = ?')
            .get(subjectKey) as SubjectRow;
        } else if (subject.shopify_product_gid !== identity.shopifyProductGid
          || subject.shopify_variant_gid !== identity.shopifyVariantGid) {
          throw new ListingControlStoreError('CONFLICT', 'Listing subject identity is immutable');
        }

        const previous = this.database.prepare(
          `SELECT revision_number, revision_digest, base_source_digest, base_ebay_observation_digest
           FROM listing_revisions WHERE subject_key = ? ORDER BY revision_number DESC LIMIT 1`,
        ).get(subjectKey) as {
          revision_number: number; revision_digest: string; base_source_digest: string;
          base_ebay_observation_digest: string;
        } | undefined;
        if ((previous?.revision_digest ?? null) !== expectedPreviousRevisionDigest
          || (previous?.base_source_digest ?? null) !== expectedLatestBaseSourceDigest
          || (previous?.base_ebay_observation_digest ?? null) !== expectedLatestBaseEbayObservationDigest) {
          throw new ListingControlStoreError('STALE_BASE', 'Revision base is stale');
        }
        const revisionNumber = (previous?.revision_number ?? 0) + 1;
        const existingSkuBinding = this.database.prepare(
          `SELECT subject_key FROM shopify_sku_bindings
           WHERE scope_key = ? AND raw_sku = ?`,
        ).get(this.scopeKey, identity.rawSku) as { subject_key: string } | undefined;
        if (existingSkuBinding && existingSkuBinding.subject_key !== subjectKey) {
          throw new ListingControlStoreError('CONFLICT', 'Exact Shopify SKU belongs to another variant');
        }
        if (!existingSkuBinding) {
          this.database.prepare(
            `INSERT INTO shopify_sku_bindings (
               scope_key, raw_sku, subject_key, created_at_utc, created_epoch_ms
             ) VALUES (?, ?, ?, ?, ?)`,
          ).run(this.scopeKey, identity.rawSku, subjectKey, created.utc, created.epochMs);
        }
        const material = revisionMaterial({
          revisionId,
          revisionNumber,
          scopeKey: this.scopeKey,
          subjectKey,
          previousRevisionDigest: expectedPreviousRevisionDigest,
          identity,
          baseSourceDigest,
          baseSourceObservedAtUtc: sourceObserved.utc,
          baseEbayObservationDigest,
          baseEbayObservedAtUtc: ebayObserved.utc,
          actor,
          state: input.state,
          createdAtUtc: created.utc,
          fields,
        });
        const revisionDigest = sha256Digest(material);
        this.database.prepare(
          `INSERT INTO listing_revisions (
            revision_id, scope_key, subject_key, revision_number, revision_digest,
            previous_revision_digest, raw_sku, ebay_seller_id, ebay_marketplace_id,
            management_model, ebay_inventory_sku, ebay_offer_id, ebay_listing_id,
            base_source_digest, base_source_observed_at_utc,
            base_source_observed_epoch_ms, base_ebay_observation_digest,
            base_ebay_observed_at_utc, base_ebay_observed_epoch_ms, actor, state,
            created_at_utc, created_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(revisionId, this.scopeKey, subjectKey, revisionNumber, revisionDigest,
          expectedPreviousRevisionDigest, identity.rawSku, identity.ebaySellerId,
          identity.ebayMarketplaceId, identity.managementModel, identity.ebayInventorySku,
          identity.ebayOfferId, identity.ebayListingId, baseSourceDigest,
          sourceObserved.utc, sourceObserved.epochMs,
          baseEbayObservationDigest, ebayObserved.utc, ebayObserved.epochMs, actor, input.state,
          created.utc, created.epochMs);
        const insertArtifact = this.database.prepare(
          `INSERT INTO ebay_artifact_bindings (
             scope_key, artifact_type, artifact_id, subject_key, created_at_utc, created_epoch_ms
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope_key, artifact_type, artifact_id) DO NOTHING`,
        );
        for (const [artifactType, artifactId] of [
          ['offer', identity.ebayOfferId],
          ['listing', identity.ebayListingId],
        ] as const) {
          if (artifactId !== null) {
            const existing = this.database.prepare(
              `SELECT subject_key FROM ebay_artifact_bindings
               WHERE scope_key = ? AND artifact_type = ? AND artifact_id = ?`,
            ).get(this.scopeKey, artifactType, artifactId) as { subject_key: string } | undefined;
            if (existing && existing.subject_key !== subjectKey) {
              throw new ListingControlStoreError('CONFLICT', 'eBay artifact belongs to another subject');
            }
            if (!existing) {
              insertArtifact.run(
                this.scopeKey,
                artifactType,
                artifactId,
                subjectKey,
                created.utc,
                created.epochMs,
              );
            }
          }
        }
        const insertField = this.database.prepare(
          `INSERT INTO listing_revision_fields (
            revision_id, field_name, source_value, source_digest, default_value, default_digest,
            override_value, override_digest, proposed_value, proposed_digest, proposed_source,
            observed_value, observed_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const field of fields) {
          insertField.run(revisionId, field.field, field.sourceValue, field.sourceDigest,
            field.defaultValue, field.defaultDigest, field.overrideValue, field.overrideDigest,
            field.proposedValue, field.proposedDigest, field.proposedSource,
            field.observedValue, field.observedDigest);
        }
        appendAudit(this.database, this.scopeKey, {
          eventId: auditEventId,
          eventType: 'revision.created',
          occurredAtUtc: created.utc,
          subjectKey,
          revisionDigest,
          payloadDigest: sha256Digest({
            revisionId, revisionDigest, subjectKey, revisionNumber, actor, state: input.state,
            baseSourceDigest, baseEbayObservationDigest,
          }),
        });
        return readRevision(this.database, revisionId)!;
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof ListingControlStoreError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/locked|busy/i.test(message)) {
        throw new ListingControlStoreError('CONFLICT', 'Concurrent store write denied');
      }
      if (/constraint|replay|replacement|chain mismatch/i.test(message)) {
        throw new ListingControlStoreError('CONFLICT', 'Listing revision conflict');
      }
      throw new ListingControlStoreError('SCHEMA_MISMATCH', 'Listing revision persistence failed');
    }
  }

  createProposalJob(input: CreateListingProposalJobInput): {
    job: ListingProposalJob; deduplicated: boolean;
  } {
    this.assertWritable();
    assertExactKeys(input, [
      'jobId', 'identity', 'baseRevisionDigest', 'baseSourceDigest',
      'baseEbayObservationDigest', 'triggerDigest', 'catalogId', 'evidence',
      'evidenceDigest', 'policyVersion', 'policyDigest', 'promptVersion',
      'promptDigest', 'schemaVersion', 'schemaDigest', 'agentVersion', 'provider',
      'requestedModel', 'modelDigest', 'requestedBy', 'createdAtUtc', 'eventId',
    ], 'proposal job');
    const jobId = identifier(input.jobId, 'proposal jobId');
    const identity = canonicalIdentity(input.identity, this.scope);
    const subjectKey = deriveListingSubjectKey({ scope: this.scope, identity });
    const baseRevisionDigest = assertDigest(
      input.baseRevisionDigest, 'proposal baseRevisionDigest', true,
    );
    const baseSourceDigest = assertDigest(input.baseSourceDigest, 'proposal baseSourceDigest') as Digest;
    const baseEbayObservationDigest = assertDigest(
      input.baseEbayObservationDigest, 'proposal baseEbayObservationDigest',
    ) as Digest;
    const triggerDigest = assertDigest(input.triggerDigest, 'proposal triggerDigest') as Digest;
    const evidence = canonicalProposalEvidence(input.evidence);
    const evidenceDigest = assertDigest(input.evidenceDigest, 'proposal evidenceDigest') as Digest;
    if (evidenceDigest !== deriveListingProposalEvidenceDigest(evidence)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal evidence digest mismatch');
    }
    const policyDigest = assertDigest(input.policyDigest, 'proposal policyDigest') as Digest;
    const promptDigest = assertDigest(input.promptDigest, 'proposal promptDigest') as Digest;
    const schemaDigest = assertDigest(input.schemaDigest, 'proposal schemaDigest') as Digest;
    const modelDigest = assertDigest(input.modelDigest, 'proposal modelDigest') as Digest;
    const catalogId = identifier(input.catalogId, 'proposal catalogId');
    const policyVersion = identifier(input.policyVersion, 'proposal policyVersion');
    const promptVersion = identifier(input.promptVersion, 'proposal promptVersion');
    const schemaVersion = identifier(input.schemaVersion, 'proposal schemaVersion');
    const agentVersion = identifier(input.agentVersion, 'proposal agentVersion');
    if (!['openai', 'fixture'].includes(input.provider)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal provider is invalid');
    }
    const requestedModel = safeText(input.requestedModel, 'proposal requestedModel', 128);
    const requestedBy = identifier(input.requestedBy, 'proposal requestedBy');
    const created = timestamp(input.createdAtUtc, 'proposal createdAtUtc');
    const eventId = identifier(input.eventId, 'proposal eventId', 120);
    assertNoCredentialMaterial(input);
    const jobWithoutDigest: Omit<ListingProposalJob, 'jobDigest'> = {
      jobId,
      scopeKey: this.scopeKey,
      subjectKey,
      identity,
      baseRevisionDigest,
      baseSourceDigest,
      baseEbayObservationDigest,
      triggerDigest,
      catalogId,
      evidence,
      evidenceDigest,
      policyVersion,
      policyDigest,
      promptVersion,
      promptDigest,
      schemaVersion,
      schemaDigest,
      agentVersion,
      provider: input.provider,
      requestedModel,
      modelDigest,
      requestedBy,
      createdAtUtc: created.utc,
    };
    const jobDigest = sha256Digest(proposalJobMaterial(jobWithoutDigest));
    const semanticDigest = (job: Omit<ListingProposalJob, 'jobDigest'>): Digest => sha256Digest({
      schemaVersion: 1,
      type: 'listing_proposal_trigger_material',
      scopeKey: job.scopeKey,
      subjectKey: job.subjectKey,
      identity: job.identity,
      baseRevisionDigest: job.baseRevisionDigest,
      baseSourceDigest: job.baseSourceDigest,
      baseEbayObservationDigest: job.baseEbayObservationDigest,
      triggerDigest: job.triggerDigest,
      catalogId: job.catalogId,
      evidenceDigest: job.evidenceDigest,
      policyVersion: job.policyVersion,
      policyDigest: job.policyDigest,
      promptVersion: job.promptVersion,
      promptDigest: job.promptDigest,
      schemaVersionName: job.schemaVersion,
      schemaDigest: job.schemaDigest,
      agentVersion: job.agentVersion,
      provider: job.provider,
      requestedModel: job.requestedModel,
      modelDigest: job.modelDigest,
    });
    return this.immediate(() => {
      const existingRow = this.database.prepare(
        `SELECT job_id FROM listing_proposal_jobs
         WHERE scope_key = ? AND subject_key = ? AND trigger_digest = ?`,
      ).get(this.scopeKey, subjectKey, triggerDigest) as { job_id: string } | undefined;
      if (existingRow) {
        const existing = readProposalJob(this.database, existingRow.job_id)!;
        const { jobDigest: _existingDigest, ...existingWithoutDigest } = existing;
        if (semanticDigest(existingWithoutDigest) !== semanticDigest(jobWithoutDigest)) {
          throw new ListingControlStoreError('CONFLICT', 'Proposal trigger digest was reused with different inputs');
        }
        return { job: existing, deduplicated: true };
      }
      let subject = this.database.prepare(
        'SELECT * FROM listing_subjects WHERE subject_key = ?',
      ).get(subjectKey) as SubjectRow | undefined;
      if (!subject) {
        if (baseRevisionDigest !== null) {
          throw new ListingControlStoreError('STALE_BASE', 'Proposal base revision is missing');
        }
        this.database.prepare(
          `INSERT INTO listing_subjects (
            subject_key, scope_key, shopify_product_gid, shopify_variant_gid,
            created_at_utc, created_epoch_ms
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(subjectKey, this.scopeKey, identity.shopifyProductGid, identity.shopifyVariantGid,
          created.utc, created.epochMs);
        subject = this.database.prepare('SELECT * FROM listing_subjects WHERE subject_key = ?')
          .get(subjectKey) as SubjectRow;
      }
      if (subject.shopify_product_gid !== identity.shopifyProductGid
        || subject.shopify_variant_gid !== identity.shopifyVariantGid) {
        throw new ListingControlStoreError('CONFLICT', 'Proposal subject identity is immutable');
      }
      const latest = this.database.prepare(
        `SELECT revision_id, revision_digest, base_source_digest, base_ebay_observation_digest
         FROM listing_revisions WHERE subject_key = ? ORDER BY revision_number DESC LIMIT 1`,
      ).get(subjectKey) as { revision_id: string; revision_digest: string;
        base_source_digest: string; base_ebay_observation_digest: string } | undefined;
      if ((latest?.revision_digest ?? null) !== baseRevisionDigest) {
        throw new ListingControlStoreError('STALE_BASE', 'Proposal listing base is stale');
      }
      const baseRevision = latest ? readRevision(this.database, latest.revision_id) : null;
      for (const item of evidence.filter(({ source }) => source === 'draft')) {
        const baseField = item.field === 'listing'
          ? null : baseRevision?.fields.find(({ field }) => field === item.field);
        if (!baseField || item.valueDigest !== baseField.proposedDigest) {
          throw new ListingControlStoreError('INVALID_INPUT', 'Draft evidence does not match the base revision');
        }
      }
      this.database.prepare(
        `INSERT INTO listing_proposal_jobs (
          job_id, job_digest, scope_key, subject_key, shopify_product_gid,
          shopify_variant_gid, raw_sku, ebay_seller_id, ebay_marketplace_id,
          management_model, ebay_inventory_sku, ebay_offer_id, ebay_listing_id,
          base_revision_digest, base_source_digest, base_ebay_observation_digest,
          trigger_digest, catalog_id, evidence_json, evidence_digest, policy_version,
          policy_digest, prompt_version, prompt_digest, proposal_schema_version,
          proposal_schema_digest, agent_version, provider, requested_model, model_digest,
          requested_by, created_at_utc, created_epoch_ms
        ) VALUES (
          @jobId, @jobDigest, @scopeKey, @subjectKey, @shopifyProductGid,
          @shopifyVariantGid, @rawSku, @ebaySellerId, @ebayMarketplaceId,
          @managementModel, @ebayInventorySku, @ebayOfferId, @ebayListingId,
          @baseRevisionDigest, @baseSourceDigest, @baseEbayObservationDigest,
          @triggerDigest, @catalogId, @evidenceJson, @evidenceDigest, @policyVersion,
          @policyDigest, @promptVersion, @promptDigest, @proposalSchemaVersion,
          @proposalSchemaDigest, @agentVersion, @provider, @requestedModel, @modelDigest,
          @requestedBy, @createdAtUtc, @createdEpochMs
        )`,
      ).run({
        ...identity,
        jobId,
        jobDigest,
        scopeKey: this.scopeKey,
        subjectKey,
        baseRevisionDigest,
        baseSourceDigest,
        baseEbayObservationDigest,
        triggerDigest,
        catalogId,
        evidenceJson: stableJson(evidence),
        evidenceDigest,
        policyVersion,
        policyDigest,
        promptVersion,
        promptDigest,
        proposalSchemaVersion: schemaVersion,
        proposalSchemaDigest: schemaDigest,
        agentVersion,
        provider: input.provider,
        requestedModel,
        modelDigest,
        requestedBy,
        createdAtUtc: created.utc,
        createdEpochMs: created.epochMs,
      });
      const job = readProposalJob(this.database, jobId)!;
      appendProposalEvent(this.database, job, {
        eventId,
        eventType: 'queued',
        expectedPreviousEventDigest: null,
        actor: requestedBy,
        occurredAtUtc: created.utc,
        resultDigest: null,
        reviewedRevisionDigest: null,
        reviewReasonCode: null,
        payloadDigest: jobDigest,
      });
      return { job, deduplicated: false };
    });
  }

  markProposalGenerating(input: MarkListingProposalGeneratingInput): ListingProposalEvent {
    this.assertWritable();
    assertExactKeys(input, [
      'jobId', 'expectedPreviousEventDigest', 'actor', 'occurredAtUtc', 'eventId',
    ], 'proposal generating event');
    const jobId = identifier(input.jobId, 'proposal jobId');
    const expected = assertDigest(
      input.expectedPreviousEventDigest, 'proposal expectedPreviousEventDigest',
    ) as Digest;
    return this.immediate(() => {
      const job = readProposalJob(this.database, jobId);
      if (!job) throw new ListingControlStoreError('NOT_FOUND', 'Proposal job was not found');
      return appendProposalEvent(this.database, job, {
        eventId: input.eventId,
        eventType: 'generating',
        expectedPreviousEventDigest: expected,
        actor: input.actor,
        occurredAtUtc: input.occurredAtUtc,
        resultDigest: null,
        reviewedRevisionDigest: null,
        reviewReasonCode: null,
        payloadDigest: job.jobDigest,
      });
    });
  }

  completeProposal(input: CompleteListingProposalInput): {
    result: ListingProposalResult; event: ListingProposalEvent;
  } {
    this.assertWritable();
    assertExactKeys(input, [
      'jobId', 'resultId', 'outcome', 'expectedPreviousEventDigest',
      'parsedOutputDigest', 'fieldDecisions', 'usage', 'failureCode', 'actor',
      'occurredAtUtc', 'eventId',
    ], 'proposal result');
    const jobId = identifier(input.jobId, 'proposal jobId');
    const resultId = identifier(input.resultId, 'proposal resultId');
    if (!LISTING_PROPOSAL_OUTCOMES.includes(input.outcome)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal outcome is invalid');
    }
    const expected = assertDigest(
      input.expectedPreviousEventDigest, 'proposal expectedPreviousEventDigest',
    ) as Digest;
    const parsedOutputDigest = assertDigest(
      input.parsedOutputDigest, 'proposal parsedOutputDigest', true,
    );
    const failureCode = input.failureCode;
    if ((input.outcome === 'failed') !== (failureCode !== null)
      || (failureCode !== null && !LISTING_PROPOSAL_FAILURE_CODES.includes(failureCode))
      || (input.outcome !== 'failed' && parsedOutputDigest === null)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal failure provenance is invalid');
    }
    const decisions = canonicalProposalDecisions(
      input.fieldDecisions, input.outcome !== 'failed',
    );
    const hasLowConfidence = decisions.some(({ confidence }) => confidence === 'low');
    if (input.outcome !== 'failed'
      && ((input.outcome === 'needs_human') !== hasLowConfidence)) {
      throw new ListingControlStoreError(
        'INVALID_INPUT',
        'Proposal outcome and field confidence do not agree',
      );
    }
    const usage = canonicalUsage(input.usage);
    const actor = identifier(input.actor, 'proposal result actor');
    const completed = timestamp(input.occurredAtUtc, 'proposal completedAtUtc');
    identifier(input.eventId, 'proposal eventId', 120);
    assertNoCredentialMaterial(input);
    return this.immediate(() => {
      const job = readProposalJob(this.database, jobId);
      if (!job) throw new ListingControlStoreError('NOT_FOUND', 'Proposal job was not found');
      const latest = readLatestProposalEvent(this.database, jobId);
      if (!latest || latest.eventDigest !== expected || latest.eventType !== 'generating') {
        throw new ListingControlStoreError('STALE_BASE', 'Proposal generation state is stale');
      }
      for (const decision of decisions) {
        for (const reference of decision.evidence) {
          if (!job.evidence.some((item) => item.source === reference.source
            && item.field === reference.field && item.valueDigest === reference.digest)) {
            throw new ListingControlStoreError('INVALID_INPUT', 'Proposal field evidence is not in the job catalog');
          }
        }
        const expectedSource = decision.proposedSource === 'source' ? 'shopify'
          : decision.proposedSource === 'observed' ? 'ebay'
            : decision.proposedSource === 'override' ? 'draft' : null;
        if (expectedSource && !job.evidence.some((item) => item.source === expectedSource
          && item.field === decision.field && item.valueDigest === decision.proposedDigest)) {
          throw new ListingControlStoreError('INVALID_INPUT', 'Proposal selected value lacks exact source evidence');
        }
      }
      const resultWithoutDigest: Omit<ListingProposalResult, 'resultDigest'> = {
        resultId,
        jobId,
        outcome: input.outcome,
        parsedOutputDigest,
        failureCode,
        usage,
        actor,
        completedAtUtc: completed.utc,
        fields: decisions,
      };
      const resultDigest = sha256Digest(proposalResultMaterial(resultWithoutDigest));
      this.database.prepare(
        `INSERT INTO listing_proposal_results (
          result_id, result_digest, job_id, scope_key, subject_key, outcome,
          parsed_output_digest, failure_code,
          input_tokens, output_tokens, total_tokens, actor, completed_at_utc, completed_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(resultId, resultDigest, jobId, job.scopeKey, job.subjectKey, input.outcome,
        parsedOutputDigest, failureCode,
        usage.inputTokens, usage.outputTokens, usage.totalTokens, actor, completed.utc,
        completed.epochMs);
      const insertDecision = this.database.prepare(
        `INSERT INTO listing_proposal_field_decisions (
          result_id, scope_key, subject_key, field_name, proposed_value,
          proposed_digest, proposed_source,
          confidence, reason_code, warning_code, evidence_json, evidence_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const decision of decisions) {
        insertDecision.run(resultId, job.scopeKey, job.subjectKey, decision.field,
          decision.proposedValue,
          decision.proposedDigest, decision.proposedSource, decision.confidence,
          decision.reasonCode, decision.warningCode, stableJson(decision.evidence),
          decision.evidenceDigest);
      }
      const result = readProposalResult(this.database, jobId)!;
      const event = appendProposalEvent(this.database, job, {
        eventId: input.eventId,
        eventType: input.outcome,
        expectedPreviousEventDigest: expected,
        actor,
        occurredAtUtc: completed.utc,
        resultDigest,
        reviewedRevisionDigest: null,
        reviewReasonCode: null,
        payloadDigest: resultDigest,
      });
      return { result, event };
    });
  }

  approveProposal(input: ApproveListingProposalInput): {
    revision: ListingRevision; event: ListingProposalEvent;
  } {
    this.assertWritable();
    assertExactKeys(input, [
      'jobId', 'resultDigest', 'expectedPreviousEventDigest', 'revision', 'actor',
      'occurredAtUtc', 'eventId',
    ], 'proposal approval');
    const jobId = identifier(input.jobId, 'proposal jobId');
    const resultDigest = assertDigest(input.resultDigest, 'proposal resultDigest') as Digest;
    const expected = assertDigest(
      input.expectedPreviousEventDigest, 'proposal expectedPreviousEventDigest',
    ) as Digest;
    const actor = identifier(input.actor, 'proposal approval actor');
    const occurred = timestamp(input.occurredAtUtc, 'proposal approval occurredAtUtc');
    identifier(input.eventId, 'proposal eventId', 120);
    assertNoCredentialMaterial(input);
    return this.immediate(() => {
      const proposal = readProposal(this.database, jobId);
      if (!proposal || !proposal.result) {
        throw new ListingControlStoreError('NOT_FOUND', 'Ready proposal was not found');
      }
      if (proposal.result.resultDigest !== resultDigest
        || proposal.result.outcome !== 'ready'
        || proposal.result.fields.some(({ confidence }) => confidence === 'low')
        || proposal.latestEvent.eventDigest !== expected
        || proposal.latestEvent.eventType !== proposal.result.outcome) {
        throw new ListingControlStoreError('STALE_BASE', 'Proposal approval state is stale');
      }
      const storedBase = proposal.job.baseRevisionDigest === null ? null : this.database.prepare(
        `SELECT base_source_digest, base_ebay_observation_digest
         FROM listing_revisions WHERE revision_digest = ? AND subject_key = ?`,
      ).get(proposal.job.baseRevisionDigest, proposal.job.subjectKey) as {
        base_source_digest: string; base_ebay_observation_digest: string;
      } | undefined;
      if (proposal.job.baseRevisionDigest !== null && !storedBase) {
        throw new ListingControlStoreError('STALE_BASE', 'Proposal base revision is missing');
      }
      const approvedIdentity = canonicalIdentity(input.revision.identity, this.scope);
      const revisionFields = canonicalFields(input.revision.fields);
      const semanticBases = derivedSemanticDigests(approvedIdentity, revisionFields);
      if (input.revision.state !== 'reviewed'
        || input.revision.createdAtUtc !== occurred.utc
        || input.revision.expectedPreviousRevisionDigest !== proposal.job.baseRevisionDigest
        || input.revision.expectedLatestBaseSourceDigest
          !== (storedBase?.base_source_digest ?? null)
        || input.revision.expectedLatestBaseEbayObservationDigest
          !== (storedBase?.base_ebay_observation_digest ?? null)
        || semanticBases.source !== proposal.job.baseSourceDigest
        || semanticBases.ebay !== proposal.job.baseEbayObservationDigest
        || approvedIdentity.shopifyVariantGid
          !== proposal.job.identity.shopifyVariantGid) {
        throw new ListingControlStoreError('STALE_BASE', 'Approved revision does not match the proposal base');
      }
      if (LISTING_AI_PROPOSABLE_FIELDS.some((fieldName) => {
        const decision = proposal.result!.fields.find(({ field }) => field === fieldName);
        const field = revisionFields.find(({ field: name }) => name === fieldName);
        return !decision || !field || field.proposedValue !== decision.proposedValue
          || field.proposedDigest !== decision.proposedDigest
          || field.proposedSource !== decision.proposedSource;
      })) {
        throw new ListingControlStoreError('INVALID_INPUT', 'Approved revision differs from the proposal');
      }
      const revision = this.createRevisionInternal(input.revision, true);
      const payloadDigest = sha256Digest({
        resultDigest,
        reviewedRevisionDigest: revision.revisionDigest,
        reviewReasonCode: 'accepted',
      });
      const event = appendProposalEvent(this.database, proposal.job, {
        eventId: input.eventId,
        eventType: 'approved',
        expectedPreviousEventDigest: expected,
        actor,
        occurredAtUtc: occurred.utc,
        resultDigest,
        reviewedRevisionDigest: revision.revisionDigest,
        reviewReasonCode: 'accepted',
        payloadDigest,
      });
      return { revision, event };
    });
  }

  rejectProposal(input: ReviewListingProposalInput): ListingProposalEvent {
    if (input.reasonCode !== 'operator_rejected') {
      throw new ListingControlStoreError('INVALID_INPUT', 'Rejected proposal requires operator_rejected');
    }
    return this.reviewProposal(input, 'rejected');
  }

  markProposalStale(input: ReviewListingProposalInput): ListingProposalEvent {
    if (!['base_changed', 'superseded'].includes(input.reasonCode)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Stale proposal reason is invalid');
    }
    return this.reviewProposal(input, 'stale');
  }

  private reviewProposal(
    input: ReviewListingProposalInput,
    eventType: 'rejected' | 'stale',
  ): ListingProposalEvent {
    this.assertWritable();
    assertExactKeys(input, [
      'jobId', 'resultDigest', 'expectedPreviousEventDigest', 'actor', 'occurredAtUtc',
      'eventId', 'reasonCode',
    ], 'proposal review');
    const jobId = identifier(input.jobId, 'proposal jobId');
    const resultDigest = assertDigest(input.resultDigest, 'proposal resultDigest') as Digest;
    const expected = assertDigest(
      input.expectedPreviousEventDigest, 'proposal expectedPreviousEventDigest',
    ) as Digest;
    const reasonCode = input.reasonCode;
    if (!LISTING_PROPOSAL_REVIEW_REASON_CODES.includes(reasonCode)) {
      throw new ListingControlStoreError('INVALID_INPUT', 'Proposal review reason is invalid');
    }
    assertNoCredentialMaterial(input);
    return this.immediate(() => {
      const proposal = readProposal(this.database, jobId);
      if (!proposal || !proposal.result) {
        throw new ListingControlStoreError('NOT_FOUND', 'Proposal result was not found');
      }
      if (proposal.result.resultDigest !== resultDigest
        || proposal.latestEvent.eventDigest !== expected
        || proposal.latestEvent.eventType !== proposal.result.outcome
        || proposal.result.outcome === 'failed') {
        throw new ListingControlStoreError('STALE_BASE', 'Proposal review state is stale');
      }
      return appendProposalEvent(this.database, proposal.job, {
        eventId: input.eventId,
        eventType,
        expectedPreviousEventDigest: expected,
        actor: input.actor,
        occurredAtUtc: input.occurredAtUtc,
        resultDigest,
        reviewedRevisionDigest: null,
        reviewReasonCode: reasonCode,
        payloadDigest: sha256Digest({ resultDigest, reviewReasonCode: reasonCode }),
      });
    });
  }

  getProposalJob(jobId: string): ListingProposal | null {
    return readProposal(this.database, identifier(jobId, 'proposal jobId'));
  }

  getLatestProposal(shopifyVariantGid: string): ListingProposal | null {
    const variant = gid(shopifyVariantGid, 'ProductVariant', 'shopifyVariantGid');
    const row = this.database.prepare(
      `SELECT job.job_id FROM listing_proposal_jobs job
       JOIN listing_subjects subject ON subject.subject_key = job.subject_key
       WHERE job.scope_key = ? AND subject.shopify_variant_gid = ?
       ORDER BY job.created_epoch_ms DESC, job.job_id DESC LIMIT 1`,
    ).get(this.scopeKey, variant) as { job_id: string } | undefined;
    return row ? readProposal(this.database, row.job_id) : null;
  }

  getLatestProposalForCatalog(
    shopifyVariantGid: string,
    catalogId: string,
  ): ListingProposal | null {
    const variant = gid(shopifyVariantGid, 'ProductVariant', 'shopifyVariantGid');
    const catalog = identifier(catalogId, 'proposal catalogId');
    const row = this.database.prepare(
      `SELECT job.job_id FROM listing_proposal_jobs job
       JOIN listing_subjects subject ON subject.subject_key = job.subject_key
       WHERE job.scope_key = ? AND subject.shopify_variant_gid = ? AND job.catalog_id = ?
       ORDER BY job.created_epoch_ms DESC, job.job_id DESC LIMIT 1`,
    ).get(this.scopeKey, variant, catalog) as { job_id: string } | undefined;
    return row ? readProposal(this.database, row.job_id) : null;
  }

  countProposalJobsForSubjectSince(shopifyVariantGid: string, sinceUtc: string): number {
    const variant = gid(shopifyVariantGid, 'ProductVariant', 'shopifyVariantGid');
    const since = timestamp(sinceUtc, 'proposal rate window');
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM listing_proposal_jobs job
       JOIN listing_subjects subject ON subject.subject_key = job.subject_key
       WHERE job.scope_key = ? AND subject.shopify_variant_gid = ?
         AND job.created_epoch_ms >= ?`,
    ).get(this.scopeKey, variant, since.epochMs) as { count: number };
    return row.count;
  }

  countProposalJobsForScopeSince(sinceUtc: string): number {
    const since = timestamp(sinceUtc, 'proposal rate window');
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM listing_proposal_jobs
       WHERE scope_key = ? AND created_epoch_ms >= ?`,
    ).get(this.scopeKey, since.epochMs) as { count: number };
    return row.count;
  }

  getRevision(revisionId: string): ListingRevision | null {
    return readRevision(this.database, identifier(revisionId, 'revisionId'));
  }

  getLatestRevision(shopifyVariantGid: string): ListingRevision | null {
    const variant = gid(shopifyVariantGid, 'ProductVariant', 'shopifyVariantGid');
    const row = this.database.prepare(
      `SELECT revision_id FROM listing_revisions revision
       JOIN listing_subjects subject ON subject.subject_key = revision.subject_key
       WHERE subject.scope_key = ? AND subject.shopify_variant_gid = ?
       ORDER BY revision.revision_number DESC LIMIT 1`,
    ).get(this.scopeKey, variant) as { revision_id: string } | undefined;
    return row ? readRevision(this.database, row.revision_id) : null;
  }

  verifyAudit(): ListingControlAuditVerification {
    return verifyAudit(this.database, this.scopeKey);
  }

  verifyIntegrity(): void {
    verifyIntegrity(this.database, this.scopeKey);
  }

  close(): void {
    this.database.close();
  }
}

export function initializeListingControlStore(input: {
  databasePath: string;
  scope: ListingControlScope;
  createdAtUtc: string;
}): ListingControlStore {
  assertExactKeys(input, ['databasePath', 'scope', 'createdAtUtc'], 'initialization');
  const databasePath = normalizeExactPath(input.databasePath, false);
  const scope = canonicalScope(input.scope);
  const scopeKey = deriveScopeKey(scope);
  const created = timestamp(input.createdAtUtc, 'createdAtUtc');
  const temporaryPath = path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.${randomUUID()}.creating`);
  let database: Sqlite | null = null;
  let published = false;
  try {
    database = new Database(temporaryPath);
    fs.chmodSync(temporaryPath, 0o600);
    configureWritable(database);
    initializeListingControlSchema(database, created.utc);
    const transaction = database.transaction(() => {
      database!.prepare(
        `INSERT INTO control_scope (
          singleton, scope_key, shopify_store_domain, ebay_environment, ebay_seller_id,
          ebay_marketplace_id, created_at_utc, created_epoch_ms
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(scopeKey, scope.shopifyStoreDomain, scope.ebayEnvironment, scope.ebaySellerId,
        scope.ebayMarketplaceId, created.utc, created.epochMs);
      appendAudit(database!, scopeKey, {
        eventId: `scope:${scopeKey}`,
        eventType: 'scope.initialized',
        occurredAtUtc: created.utc,
        subjectKey: null,
        revisionDigest: null,
        payloadDigest: sha256Digest({ scopeKey }),
      });
    });
    transaction.immediate();
    verifyListingControlSchema(database);
    verifyIntegrity(database, scopeKey);
    database.close();
    database = null;
    fs.chmodSync(temporaryPath, 0o600);
    fs.linkSync(temporaryPath, databasePath);
    published = true;
    fs.unlinkSync(temporaryPath);
    fs.chmodSync(databasePath, 0o600);
    const directory = fs.openSync(path.dirname(databasePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return openListingControlStore({ databasePath, expectedScope: scope });
  } catch (error) {
    if (database?.open) database.close();
    for (const candidate of [temporaryPath, `${temporaryPath}-journal`, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    if (published) {
      for (const candidate of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      }
    }
    translateError(error);
  }
}

function preflightOpen(databasePath: string, expectedScope: ListingControlScope) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    configureReadOnly(database);
    verifyListingControlSchema(database);
    const scope = verifyExpectedScope(database, expectedScope);
    verifyIntegrity(database, scope.scopeKey);
    return scope;
  } finally {
    database.close();
  }
}

export function openListingControlStore(input: {
  databasePath: string;
  expectedScope: ListingControlScope;
}): ListingControlStore {
  const databasePath = normalizeExactPath(input.databasePath, true);
  try { preflightOpen(databasePath, input.expectedScope); } catch (error) { translateError(error); }
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    configureWritable(database);
    verifyListingControlSchema(database);
    const scope = verifyExpectedScope(database, input.expectedScope);
    verifyIntegrity(database, scope.scopeKey);
    return new ListingControlStoreImpl(database, databasePath, canonicalScope(input.expectedScope), scope.scopeKey, true);
  } catch (error) {
    database.close();
    translateError(error);
  }
}

export function openListingControlStoreReadOnly(input: {
  databasePath: string;
  expectedScope: ListingControlScope;
}): ListingControlStore {
  const databasePath = normalizeExactPath(input.databasePath, true);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    configureReadOnly(database);
    verifyListingControlSchema(database);
    const scope = verifyExpectedScope(database, input.expectedScope);
    verifyIntegrity(database, scope.scopeKey);
    return new ListingControlStoreImpl(database, databasePath, canonicalScope(input.expectedScope), scope.scopeKey, false);
  } catch (error) {
    database.close();
    translateError(error);
  }
}

/**
 * Explicit operational migration for a pre-existing canonical V1 file. This
 * is intentionally absent from every runtime open/request path.
 */
export function upgradeListingControlStoreV1ToV2(input: {
  databasePath: string;
  expectedScope: ListingControlScope;
  appliedAtUtc: string;
}): ListingControlStore {
  assertExactKeys(input, ['databasePath', 'expectedScope', 'appliedAtUtc'], 'upgrade');
  const databasePath = normalizeExactPath(input.databasePath, true);
  const applied = timestamp(input.appliedAtUtc, 'appliedAtUtc');
  let database: Sqlite | null = null;
  try {
    database = new Database(databasePath, { fileMustExist: true });
    configureWritable(database);
    verifyListingControlSchemaV1(database);
    const scope = verifyExpectedScope(database, input.expectedScope);
    verifyDataIntegrity(database, scope.scopeKey);
    upgradeListingControlSchemaV1ToV2(database, applied.utc);
    verifyDataIntegrity(database, scope.scopeKey);
    // Compatibility admin path: a V1 file is advanced through every explicit
    // reviewed migration because runtime open accepts only the current schema.
    upgradeListingControlSchemaV2ToV3(database, applied.utc);
    verifyIntegrity(database, scope.scopeKey);
    database.close();
    database = null;
    fs.chmodSync(databasePath, 0o600);
    return openListingControlStore({ databasePath, expectedScope: input.expectedScope });
  } catch (error) {
    if (database?.open) database.close();
    translateError(error);
  }
}


/** Explicit admin-only migration. Runtime open/request paths never invoke it. */
export function upgradeListingControlStoreV2ToV3(input: {
  databasePath: string;
  expectedScope: ListingControlScope;
  appliedAtUtc: string;
}): ListingControlStore {
  assertExactKeys(input, ['databasePath', 'expectedScope', 'appliedAtUtc'], 'upgrade');
  const databasePath = normalizeExactPath(input.databasePath, true);
  const applied = timestamp(input.appliedAtUtc, 'appliedAtUtc');
  let database: Sqlite | null = null;
  try {
    database = new Database(databasePath, { fileMustExist: true });
    configureWritable(database);
    verifyListingControlSchemaV2(database);
    const scope = verifyExpectedScope(database, input.expectedScope);
    verifyDataIntegrity(database, scope.scopeKey);
    upgradeListingControlSchemaV2ToV3(database, applied.utc);
    verifyIntegrity(database, scope.scopeKey);
    database.close();
    database = null;
    fs.chmodSync(databasePath, 0o600);
    return openListingControlStore({ databasePath, expectedScope: input.expectedScope });
  } catch (error) {
    if (database?.open) database.close();
    translateError(error);
  }
}
