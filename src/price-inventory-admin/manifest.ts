/**
 * Pure alignment-manifest derivation for the isolated price/inventory
 * operator CLI. No store, network, credential, or provider access happens
 * here.
 *
 * An alignment manifest names exactly one field (`price` or `quantity`) on
 * exactly one eBay listing target and carries the deterministic
 * before-value (the current eBay observed state) and after-value (the
 * Shopify source state). The manifest derives deterministically from one
 * fresh workspace basis, so `plan` and `dispatch` computing different
 * digests proves the drift moved and fails the ceremony closed.
 *
 * Slice boundary: exact-target, one field, one action at a time. Continuous
 * or automatic price/inventory sync is a separate future slice with its own
 * gates. See docs/PRICE_INVENTORY_DISPATCH.md.
 */
import {
  sha256Digest,
  type Digest,
  type ListingIdentity,
} from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';

export class AlignmentManifestError extends Error {
  constructor(readonly code:
    | 'PLAN_FIELD_INVALID'
    | 'PLAN_TARGET_NOT_MANAGED'
    | 'PLAN_SOURCE_VALUE_INVALID'
    | 'PLAN_NO_DRIFT') {
    super('Alignment manifest derivation failed');
    this.name = 'AlignmentManifestError';
  }
}

const deny = (code: ConstructorParameters<typeof AlignmentManifestError>[0]): never => {
  throw new AlignmentManifestError(code);
};

export const ALIGNMENT_FIELDS = Object.freeze(['price', 'quantity'] as const);
export type AlignmentField = (typeof ALIGNMENT_FIELDS)[number];

/** Positive decimal money amount with at most two fraction digits. */
const PRICE_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const QUANTITY = /^(0|[1-9][0-9]{0,8})$/;

export type ParsedAlignmentPrice = Readonly<{ value: string; currency: string }>;

/**
 * The Shopify source price is the canonical JSON `{amount, currency}` string
 * produced by the draft basis. Anything else — extra keys, a non-positive or
 * malformed amount, a non-ISO currency — fails closed.
 */
export function parseAlignmentPrice(serialized: string): ParsedAlignmentPrice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return deny('PLAN_SOURCE_VALUE_INVALID');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deny('PLAN_SOURCE_VALUE_INVALID');
  }
  const record = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== '["amount","currency"]') {
    return deny('PLAN_SOURCE_VALUE_INVALID');
  }
  const amount = record.amount;
  const currency = record.currency;
  if (typeof amount !== 'string' || !PRICE_AMOUNT.test(amount) || Number(amount) <= 0
    || typeof currency !== 'string' || !CURRENCY.test(currency)) {
    return deny('PLAN_SOURCE_VALUE_INVALID');
  }
  return Object.freeze({ value: amount, currency });
}

/** The Shopify source quantity is a stringified non-negative safe integer. */
export function parseAlignmentQuantity(serialized: string): number {
  if (!QUANTITY.test(serialized)) return deny('PLAN_SOURCE_VALUE_INVALID');
  const quantity = Number(serialized);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    return deny('PLAN_SOURCE_VALUE_INVALID');
  }
  return quantity;
}

export type AlignmentManifest = Readonly<{
  schemaVersion: 1;
  scope: typeof LISTING_DRAFT_SCOPE;
  identity: ListingIdentity;
  field: AlignmentField;
  before: string | null;
  after: string;
}>;

export type DerivedAlignmentManifest = Readonly<{
  manifest: AlignmentManifest;
  manifestDigest: Digest;
}>;

function assertManagedIdentity(identity: ListingIdentity): void {
  const inventoryManaged = identity.managementModel === 'inventory_api'
    && identity.ebayInventorySku !== null
    && identity.ebayOfferId !== null
    && identity.ebayListingId !== null;
  const tradingManaged = identity.managementModel === 'trading_api'
    && identity.ebayInventorySku === null
    && identity.ebayOfferId === null
    && identity.ebayListingId !== null;
  if (!inventoryManaged && !tradingManaged) deny('PLAN_TARGET_NOT_MANAGED');
}

function assertValidAfterValue(field: AlignmentField, after: string): void {
  if (field === 'price') parseAlignmentPrice(after);
  else parseAlignmentQuantity(after);
}

function buildManifest(input: {
  identity: ListingIdentity;
  field: AlignmentField;
  before: string | null;
  after: string;
}): DerivedAlignmentManifest {
  const manifest: AlignmentManifest = Object.freeze({
    schemaVersion: 1 as const,
    scope: LISTING_DRAFT_SCOPE,
    identity: input.identity,
    field: input.field,
    before: input.before,
    after: input.after,
  });
  return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}

/**
 * Derive the deterministic alignment manifest from one fresh workspace
 * basis: before = current eBay observed value, after = Shopify source value.
 * Fails closed on an unmanaged or partially-bound target, a missing or
 * invalid source value, or the absence of drift (`before === after` means
 * there is nothing to align and no write may be planned).
 */
export function deriveAlignmentManifest(input: {
  basis: ListingDraftBasis;
  field: AlignmentField;
}): DerivedAlignmentManifest {
  const { basis, field } = input;
  if (!ALIGNMENT_FIELDS.includes(field)) deny('PLAN_FIELD_INVALID');
  assertManagedIdentity(basis.identity);
  const after = basis.source[field];
  if (after === null) return deny('PLAN_SOURCE_VALUE_INVALID');
  assertValidAfterValue(field, after);
  const before = basis.observed[field];
  if (before === after) deny('PLAN_NO_DRIFT');
  return buildManifest({ identity: basis.identity, field, before, after });
}

/**
 * Rebuild the exact manifest from operator-supplied before/after values and
 * the live identity, for `reconcile`: the recomputed digest must match the
 * digest printed by `plan`, which binds the supplied values to the dispatched
 * manifest byte-for-byte. Drift is deliberately not required here — after a
 * successful alignment the observed value equals `after`.
 */
export function reconstructAlignmentManifest(input: {
  identity: ListingIdentity;
  field: AlignmentField;
  before: string | null;
  after: string;
}): DerivedAlignmentManifest {
  if (!ALIGNMENT_FIELDS.includes(input.field)) deny('PLAN_FIELD_INVALID');
  assertManagedIdentity(input.identity);
  assertValidAfterValue(input.field, input.after);
  return buildManifest(input);
}

export type AlignmentComparison = Readonly<{
  effect: 'effect_observed' | 'effect_absent';
  observedValue: string | null;
}>;

/**
 * Post-dispatch comparison: a single-field alignment either landed exactly
 * (`effect_observed`) or it did not (`effect_absent`); there is no partial
 * state for one field.
 */
export function compareAlignedState(input: {
  manifest: AlignmentManifest;
  freshBasis: ListingDraftBasis;
}): AlignmentComparison {
  const observedValue = input.freshBasis.observed[input.manifest.field] ?? null;
  return Object.freeze({
    effect: observedValue === input.manifest.after
      ? 'effect_observed' as const
      : 'effect_absent' as const,
    observedValue,
  });
}
