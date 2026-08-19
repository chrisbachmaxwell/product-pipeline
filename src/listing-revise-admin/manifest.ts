/**
 * Pure dispatch-manifest derivation for the isolated listing-revise operator
 * CLI. No store, network, credential, or provider access happens here.
 *
 * The manifest derives deterministically from one approved local draft
 * revision alone, so the same revision always yields the same manifest
 * digest — before dispatch, during dispatch, and during any later
 * reconciliation. Pre-dispatch freshness is a separate gate
 * (`assertFreshBasisMatchesRevision`) that fails closed when the remote
 * listing drifted from the revision's observed base.
 *
 * Slice boundary: fully-bound `inventory_api`-managed listings and
 * fully-bound `trading_api`-managed listings (the goal-G5 Stage 2 extension),
 * each with its own reviewed dispatchable field set, and byte-exact
 * preservation of price and quantity for both models. See
 * docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md and docs/LISTING_REVISE_DISPATCH.md.
 */
import {
  sha256Digest,
  type Digest,
  type ListingFieldName,
  type ListingIdentity,
  type ListingRevision,
} from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';

export class ListingReviseManifestError extends Error {
  constructor(readonly code:
    | 'REVISE_TARGET_NOT_INVENTORY_MANAGED'
    | 'REVISE_IDENTITY_MISMATCH'
    | 'REVISE_BASE_STALE'
    | 'REVISE_NO_CHANGES'
    | 'REVISE_UNSUPPORTED_FIELD'
    | 'REVISE_PRESERVED_FIELD_MISSING') {
    super('Listing revise manifest derivation failed');
    this.name = 'ListingReviseManifestError';
  }
}

const deny = (code: ConstructorParameters<typeof ListingReviseManifestError>[0]): never => {
  throw new ListingReviseManifestError(code);
};

/**
 * Fields this slice may dispatch for an `inventory_api`-managed target.
 * `condition` is deliberately excluded until the
 * numeric-condition-to-Inventory-enum mapping passes its own review;
 * `price`, `quantity`, `item_specifics`, and `identifiers` are never
 * dispatchable (the first two belong to Marketplace Connect, the last two are
 * comparison-only in the draft model).
 */
export const DISPATCHABLE_FIELDS = Object.freeze([
  'title',
  'condition_description',
  'description',
  'images',
  'category',
  'fulfillment_policy',
  'payment_policy',
  'return_policy',
  'merchant_location',
] as const satisfies readonly ListingFieldName[]);

/**
 * Fields this slice may dispatch for a legacy `trading_api`-managed target
 * via `ReviseFixedPriceItem`. The policy fields map to the Seller Business
 * Policy profile ids the workspace observed on the Trading item
 * (`SellerProfiles`). `merchant_location` has no Trading revise mapping and
 * is not dispatchable; `condition` stays excluded for both models, and
 * price/quantity remain never-dispatchable.
 */
export const TRADING_DISPATCHABLE_FIELDS = Object.freeze([
  'title',
  'condition_description',
  'description',
  'images',
  'category',
  'fulfillment_policy',
  'payment_policy',
  'return_policy',
] as const satisfies readonly ListingFieldName[]);

export type ListingReviseChange = Readonly<{
  field: ListingFieldName;
  before: string | null;
  after: string;
}>;

export type ListingReviseManifest = Readonly<{
  schemaVersion: 1;
  scope: typeof LISTING_DRAFT_SCOPE;
  identity: ListingIdentity;
  revisionId: string;
  revisionNumber: number;
  revisionDigest: Digest;
  baseEbayObservationDigest: Digest;
  changes: readonly ListingReviseChange[];
  preserved: Readonly<{ price: string; quantity: string }>;
}>;

export type DerivedListingReviseManifest = Readonly<{
  manifest: ListingReviseManifest;
  manifestDigest: Digest;
}>;

function revisionField(revision: ListingRevision, field: ListingFieldName) {
  return revision.fields.find((candidate) => candidate.field === field) ?? null;
}

/**
 * Derive the deterministic dispatch manifest from one stored draft revision,
 * failing closed unless the target is a fully-bound inventory_api listing or
 * a fully-bound trading_api listing, at least one override exists, every
 * override is dispatchable for the target's management model, and the
 * revision observed the preserved price and quantity values.
 */
export function deriveListingReviseManifest(revision: ListingRevision): DerivedListingReviseManifest {
  const identity = revision.identity;
  const inventoryManaged = identity.managementModel === 'inventory_api'
    && identity.ebayInventorySku !== null
    && identity.ebayOfferId !== null
    && identity.ebayListingId !== null;
  const tradingManaged = identity.managementModel === 'trading_api'
    && identity.ebayInventorySku === null
    && identity.ebayOfferId === null
    && identity.ebayListingId !== null;
  if (!inventoryManaged && !tradingManaged) {
    deny('REVISE_TARGET_NOT_INVENTORY_MANAGED');
  }

  const overrides = revision.fields.filter(
    (field) => field.proposedSource === 'override' && field.overrideValue !== null,
  );
  if (overrides.length === 0) deny('REVISE_NO_CHANGES');
  const dispatchable = new Set<ListingFieldName>(
    tradingManaged ? TRADING_DISPATCHABLE_FIELDS : DISPATCHABLE_FIELDS,
  );
  for (const field of overrides) {
    if (!dispatchable.has(field.field)) deny('REVISE_UNSUPPORTED_FIELD');
  }

  const preservedPrice = revisionField(revision, 'price')?.observedValue ?? null;
  const preservedQuantity = revisionField(revision, 'quantity')?.observedValue ?? null;
  if (preservedPrice === null || preservedQuantity === null) {
    throw new ListingReviseManifestError('REVISE_PRESERVED_FIELD_MISSING');
  }

  const changes = overrides.map((field) => Object.freeze({
    field: field.field,
    before: field.observedValue,
    after: field.overrideValue as string,
  }));
  const manifest: ListingReviseManifest = Object.freeze({
    schemaVersion: 1 as const,
    scope: LISTING_DRAFT_SCOPE,
    identity,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    revisionDigest: revision.revisionDigest,
    baseEbayObservationDigest: revision.baseEbayObservationDigest,
    changes: Object.freeze(changes),
    preserved: Object.freeze({ price: preservedPrice, quantity: preservedQuantity }),
  });
  return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}

function identitiesMatch(left: ListingIdentity, right: ListingIdentity): boolean {
  return left.shopifyProductGid === right.shopifyProductGid
    && left.shopifyVariantGid === right.shopifyVariantGid
    && left.rawSku === right.rawSku
    && left.ebaySellerId === right.ebaySellerId
    && left.ebayMarketplaceId === right.ebayMarketplaceId
    && left.managementModel === right.managementModel
    && left.ebayInventorySku === right.ebayInventorySku
    && left.ebayOfferId === right.ebayOfferId
    && left.ebayListingId === right.ebayListingId;
}

/**
 * Pre-dispatch freshness gate: the live workspace identity must equal the
 * revision identity, and every field value the revision observed must still
 * be the live observed value. Any drift — including price or quantity moved
 * by the incumbent — makes the draft stale and denies dispatch.
 */
export function assertFreshBasisMatchesRevision(input: {
  revision: ListingRevision;
  freshBasis: ListingDraftBasis;
}): void {
  if (!identitiesMatch(input.freshBasis.identity, input.revision.identity)) {
    deny('REVISE_IDENTITY_MISMATCH');
  }
  for (const field of input.revision.fields) {
    const freshObserved = input.freshBasis.observed[field.field] ?? null;
    if (freshObserved !== field.observedValue) deny('REVISE_BASE_STALE');
  }
}

export type ListingReviseComparison = Readonly<{
  effect: 'revised_state_observed' | 'revised_state_absent' | 'partial';
  matchedFields: readonly ListingFieldName[];
  unmatchedFields: readonly ListingFieldName[];
}>;

/**
 * Post-dispatch comparison: classify the live observed values against the
 * manifest's expected after-values. `partial` means some but not all changes
 * are visible; the caller must record it as a critical reconciliation
 * exception and leave the job unresolved for operator investigation.
 */
export function compareDispatchedState(input: {
  manifest: ListingReviseManifest;
  freshBasis: ListingDraftBasis;
}): ListingReviseComparison {
  const matched: ListingFieldName[] = [];
  const unmatched: ListingFieldName[] = [];
  for (const change of input.manifest.changes) {
    const observed = input.freshBasis.observed[change.field] ?? null;
    if (observed === change.after) matched.push(change.field);
    else unmatched.push(change.field);
  }
  const effect = unmatched.length === 0
    ? 'revised_state_observed' as const
    : matched.length === 0 ? 'revised_state_absent' as const : 'partial' as const;
  return Object.freeze({
    effect,
    matchedFields: Object.freeze(matched),
    unmatchedFields: Object.freeze(unmatched),
  });
}

export class ListingRevisePayloadError extends Error {
  constructor(readonly code:
    | 'REVISE_RAW_BINDING_MISMATCH'
    | 'REVISE_RAW_PRESERVATION_VIOLATED'
    | 'REVISE_RAW_PAYLOAD_INVALID') {
    super('Listing revise payload derivation failed');
    this.name = 'ListingRevisePayloadError';
  }
}

const denyPayload = (code: ConstructorParameters<typeof ListingRevisePayloadError>[0]): never => {
  throw new ListingRevisePayloadError(code);
};

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as RawRecord) }
    : denyPayload('REVISE_RAW_PAYLOAD_INVALID');
}

function parseImageList(serialized: string): string[] {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 24
      || parsed.some((entry) => typeof entry !== 'string')) {
      return denyPayload('REVISE_RAW_PAYLOAD_INVALID');
    }
    return parsed as string[];
  } catch {
    return denyPayload('REVISE_RAW_PAYLOAD_INVALID');
  }
}

export type ListingRevisePayloads = Readonly<{
  inventoryItemChanged: boolean;
  offerChanged: boolean;
  inventoryItemPayload: RawRecord;
  offerPayload: RawRecord;
}>;

/**
 * Apply exactly the manifest's changes to the raw provider resources fetched
 * moments before dispatch, preserving every other property byte-for-byte.
 * Price/quantity preservation is enforced structurally: the pricing and
 * availability subtrees of the raw resources are asserted unchanged between
 * the fetched objects and the produced payloads.
 */
export function buildListingRevisePayloads(input: {
  manifest: ListingReviseManifest;
  rawInventoryItem: unknown;
  rawOffer: unknown;
}): ListingRevisePayloads {
  const { manifest } = input;
  if (manifest.identity.managementModel !== 'inventory_api') {
    denyPayload('REVISE_RAW_PAYLOAD_INVALID');
  }
  const rawItem = asRecord(input.rawInventoryItem);
  const rawOffer = asRecord(input.rawOffer);

  if (typeof rawOffer.offerId !== 'string' || rawOffer.offerId !== manifest.identity.ebayOfferId
    || typeof rawOffer.sku !== 'string' || rawOffer.sku !== manifest.identity.ebayInventorySku
    || rawOffer.marketplaceId !== manifest.identity.ebayMarketplaceId) {
    denyPayload('REVISE_RAW_BINDING_MISMATCH');
  }
  if (rawOffer.listing !== undefined) {
    const listingRecord = asRecord(rawOffer.listing);
    if (listingRecord.listingId !== manifest.identity.ebayListingId) {
      denyPayload('REVISE_RAW_BINDING_MISMATCH');
    }
  }

  const itemPayload: RawRecord = { ...rawItem };
  const offerPayload: RawRecord = { ...rawOffer };
  let inventoryItemChanged = false;
  let offerChanged = false;

  for (const change of manifest.changes) {
    switch (change.field) {
      case 'title': {
        const product = asRecord(itemPayload.product ?? {});
        product.title = change.after;
        itemPayload.product = product;
        inventoryItemChanged = true;
        break;
      }
      case 'images': {
        const product = asRecord(itemPayload.product ?? {});
        product.imageUrls = parseImageList(change.after);
        itemPayload.product = product;
        inventoryItemChanged = true;
        break;
      }
      case 'condition_description': {
        itemPayload.conditionDescription = change.after;
        inventoryItemChanged = true;
        break;
      }
      case 'description': {
        offerPayload.listingDescription = change.after;
        offerChanged = true;
        break;
      }
      case 'category': {
        offerPayload.categoryId = change.after;
        offerChanged = true;
        break;
      }
      case 'fulfillment_policy':
      case 'payment_policy':
      case 'return_policy': {
        const policies = asRecord(offerPayload.listingPolicies ?? {});
        const key = change.field === 'fulfillment_policy'
          ? 'fulfillmentPolicyId'
          : change.field === 'payment_policy' ? 'paymentPolicyId' : 'returnPolicyId';
        policies[key] = change.after;
        offerPayload.listingPolicies = policies;
        offerChanged = true;
        break;
      }
      case 'merchant_location': {
        offerPayload.merchantLocationKey = change.after;
        offerChanged = true;
        break;
      }
      default:
        denyPayload('REVISE_RAW_PAYLOAD_INVALID');
    }
  }

  // Structural preservation: pricing and availability subtrees must be
  // byte-identical between the fetched resources and the outgoing payloads.
  const preserved: Array<[unknown, unknown]> = [
    [rawOffer.pricingSummary, offerPayload.pricingSummary],
    [rawOffer.availableQuantity, offerPayload.availableQuantity],
    [rawOffer.quantityLimitPerBuyer, offerPayload.quantityLimitPerBuyer],
    [rawItem.availability, itemPayload.availability],
    [rawItem.packageWeightAndSize, itemPayload.packageWeightAndSize],
    [rawItem.condition, itemPayload.condition],
  ];
  for (const [before, after] of preserved) {
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      denyPayload('REVISE_RAW_PRESERVATION_VIOLATED');
    }
  }

  return Object.freeze({
    inventoryItemChanged,
    offerChanged,
    inventoryItemPayload: itemPayload,
    offerPayload,
  });
}
