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
import { type Digest, type ListingIdentity } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';
export declare class AlignmentManifestError extends Error {
    readonly code: 'PLAN_FIELD_INVALID' | 'PLAN_TARGET_NOT_MANAGED' | 'PLAN_SOURCE_VALUE_INVALID' | 'PLAN_NO_DRIFT';
    constructor(code: 'PLAN_FIELD_INVALID' | 'PLAN_TARGET_NOT_MANAGED' | 'PLAN_SOURCE_VALUE_INVALID' | 'PLAN_NO_DRIFT');
}
export declare const ALIGNMENT_FIELDS: readonly ["price", "quantity"];
export type AlignmentField = (typeof ALIGNMENT_FIELDS)[number];
export type ParsedAlignmentPrice = Readonly<{
    value: string;
    currency: string;
}>;
/**
 * The Shopify source price is the canonical JSON `{amount, currency}` string
 * produced by the draft basis. Anything else — extra keys, a non-positive or
 * malformed amount, a non-ISO currency — fails closed.
 */
export declare function parseAlignmentPrice(serialized: string): ParsedAlignmentPrice;
/** The Shopify source quantity is a stringified non-negative safe integer. */
export declare function parseAlignmentQuantity(serialized: string): number;
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
/**
 * Derive the deterministic alignment manifest from one fresh workspace
 * basis: before = current eBay observed value, after = Shopify source value.
 * Fails closed on an unmanaged or partially-bound target, a missing or
 * invalid source value, or the absence of drift (`before === after` means
 * there is nothing to align and no write may be planned).
 */
export declare function deriveAlignmentManifest(input: {
    basis: ListingDraftBasis;
    field: AlignmentField;
}): DerivedAlignmentManifest;
/**
 * Rebuild the exact manifest from operator-supplied before/after values and
 * the live identity, for `reconcile`: the recomputed digest must match the
 * digest printed by `plan`, which binds the supplied values to the dispatched
 * manifest byte-for-byte. Drift is deliberately not required here — after a
 * successful alignment the observed value equals `after`.
 */
export declare function reconstructAlignmentManifest(input: {
    identity: ListingIdentity;
    field: AlignmentField;
    before: string | null;
    after: string;
}): DerivedAlignmentManifest;
export type AlignmentComparison = Readonly<{
    effect: 'effect_observed' | 'effect_absent';
    observedValue: string | null;
}>;
/**
 * Post-dispatch comparison: a single-field alignment either landed exactly
 * (`effect_observed`) or it did not (`effect_absent`); there is no partial
 * state for one field.
 */
export declare function compareAlignedState(input: {
    manifest: AlignmentManifest;
    freshBasis: ListingDraftBasis;
}): AlignmentComparison;
