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
 * Slice boundary (goal G4): only `inventory_api`-managed listings, only the
 * reviewed dispatchable fields, and byte-exact preservation of price and
 * quantity. Legacy Trading-managed listings are structurally rejected — see
 * docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md.
 */
import { type Digest, type ListingFieldName, type ListingIdentity, type ListingRevision } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';
export declare class ListingReviseManifestError extends Error {
    readonly code: 'REVISE_TARGET_NOT_INVENTORY_MANAGED' | 'REVISE_IDENTITY_MISMATCH' | 'REVISE_BASE_STALE' | 'REVISE_NO_CHANGES' | 'REVISE_UNSUPPORTED_FIELD' | 'REVISE_PRESERVED_FIELD_MISSING';
    constructor(code: 'REVISE_TARGET_NOT_INVENTORY_MANAGED' | 'REVISE_IDENTITY_MISMATCH' | 'REVISE_BASE_STALE' | 'REVISE_NO_CHANGES' | 'REVISE_UNSUPPORTED_FIELD' | 'REVISE_PRESERVED_FIELD_MISSING');
}
/**
 * Fields this slice may dispatch. `condition` is deliberately excluded until
 * the numeric-condition-to-Inventory-enum mapping passes its own review;
 * `price`, `quantity`, `item_specifics`, and `identifiers` are never
 * dispatchable (the first two belong to Marketplace Connect, the last two are
 * comparison-only in the draft model).
 */
export declare const DISPATCHABLE_FIELDS: readonly ["title", "condition_description", "description", "images", "category", "fulfillment_policy", "payment_policy", "return_policy", "merchant_location"];
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
    preserved: Readonly<{
        price: string;
        quantity: string;
    }>;
}>;
export type DerivedListingReviseManifest = Readonly<{
    manifest: ListingReviseManifest;
    manifestDigest: Digest;
}>;
/**
 * Derive the deterministic dispatch manifest from one stored draft revision,
 * failing closed unless the target is a fully-bound inventory_api listing, at
 * least one override exists, every override is a dispatchable field, and the
 * revision observed the preserved price and quantity values.
 */
export declare function deriveListingReviseManifest(revision: ListingRevision): DerivedListingReviseManifest;
/**
 * Pre-dispatch freshness gate: the live workspace identity must equal the
 * revision identity, and every field value the revision observed must still
 * be the live observed value. Any drift — including price or quantity moved
 * by the incumbent — makes the draft stale and denies dispatch.
 */
export declare function assertFreshBasisMatchesRevision(input: {
    revision: ListingRevision;
    freshBasis: ListingDraftBasis;
}): void;
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
export declare function compareDispatchedState(input: {
    manifest: ListingReviseManifest;
    freshBasis: ListingDraftBasis;
}): ListingReviseComparison;
export declare class ListingRevisePayloadError extends Error {
    readonly code: 'REVISE_RAW_BINDING_MISMATCH' | 'REVISE_RAW_PRESERVATION_VIOLATED' | 'REVISE_RAW_PAYLOAD_INVALID';
    constructor(code: 'REVISE_RAW_BINDING_MISMATCH' | 'REVISE_RAW_PRESERVATION_VIOLATED' | 'REVISE_RAW_PAYLOAD_INVALID');
}
type RawRecord = Record<string, unknown>;
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
export declare function buildListingRevisePayloads(input: {
    manifest: ListingReviseManifest;
    rawInventoryItem: unknown;
    rawOffer: unknown;
}): ListingRevisePayloads;
export {};
