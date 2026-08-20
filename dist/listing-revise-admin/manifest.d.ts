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
import { type Digest, type ListingFieldName, type ListingIdentity, type ListingRevision } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';
export declare class ListingReviseManifestError extends Error {
    readonly code: 'REVISE_TARGET_NOT_INVENTORY_MANAGED' | 'REVISE_IDENTITY_MISMATCH' | 'REVISE_BASE_STALE' | 'REVISE_NO_CHANGES' | 'REVISE_UNSUPPORTED_FIELD' | 'REVISE_PRESERVED_FIELD_MISSING' | 'REVISE_TEMPLATE_UNSUPPORTED' | 'REVISE_TEMPLATE_INPUT_INVALID' | 'REVISE_TEMPLATE_OUTPUT_TOO_LARGE';
    constructor(code: 'REVISE_TARGET_NOT_INVENTORY_MANAGED' | 'REVISE_IDENTITY_MISMATCH' | 'REVISE_BASE_STALE' | 'REVISE_NO_CHANGES' | 'REVISE_UNSUPPORTED_FIELD' | 'REVISE_PRESERVED_FIELD_MISSING' | 'REVISE_TEMPLATE_UNSUPPORTED' | 'REVISE_TEMPLATE_INPUT_INVALID' | 'REVISE_TEMPLATE_OUTPUT_TOO_LARGE');
}
/**
 * Fields this slice may dispatch for an `inventory_api`-managed target.
 * `condition` is deliberately excluded until the
 * numeric-condition-to-Inventory-enum mapping passes its own review;
 * `price`, `quantity`, `item_specifics`, and `identifiers` are never
 * dispatchable (the first two belong to Marketplace Connect, the last two are
 * comparison-only in the draft model).
 */
export declare const DISPATCHABLE_FIELDS: readonly ["title", "condition_description", "description", "images", "category", "fulfillment_policy", "payment_policy", "return_policy", "merchant_location"];
/**
 * Fields this slice may dispatch for a legacy `trading_api`-managed target
 * via `ReviseFixedPriceItem`. The policy fields map to the Seller Business
 * Policy profile ids the workspace observed on the Trading item
 * (`SellerProfiles`). `merchant_location` has no Trading revise mapping and
 * is not dispatchable; `condition` stays excluded for both models, and
 * price/quantity remain never-dispatchable.
 */
export declare const TRADING_DISPATCHABLE_FIELDS: readonly ["title", "condition_description", "description", "images", "category", "fulfillment_policy", "payment_policy", "return_policy"];
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
 * failing closed unless the target is a fully-bound inventory_api listing or
 * a fully-bound trading_api listing, at least one override exists, every
 * override is dispatchable for the target's management model, and the
 * revision observed the preserved price and quantity values.
 */
export declare function deriveListingReviseManifest(revision: ListingRevision): DerivedListingReviseManifest;
export type TemplatedListingReviseManifest = Readonly<{
    manifest: ListingReviseManifest;
    manifestDigest: Digest;
    descriptionTemplateApplied: boolean;
}>;
/**
 * Opt-in branded description templating: when the derived manifest carries a
 * `description` change, replace its after-value with the deterministic
 * `ucg-branded-v1` rendering built from the same stored revision the
 * manifest derives from (title/condition/condition note/images use the
 * revision's proposed values, which the freshness gate has already bound to
 * the live remote state). The recomputed manifest digest therefore binds the
 * exact templated HTML the operator approves. Only the literal version
 * `ucg-branded-v1` is accepted; anything else is a fixed-code denial. With a
 * manifest that carries no description change the manifest passes through
 * byte-identically and `descriptionTemplateApplied` is false.
 */
export declare function applyListingDescriptionTemplate(input: {
    derived: DerivedListingReviseManifest;
    revision: ListingRevision;
    templateVersion: string;
}): TemplatedListingReviseManifest;
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
