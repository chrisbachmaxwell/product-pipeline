/**
 * Pure manifest derivation for the isolated listing-lifecycle operator CLI
 * (listing CREATE from an approved local draft of a not-listed item, and
 * listing END for an active listing). No store, network, credential, or
 * provider access happens here.
 *
 * The CREATE manifest derives deterministically from one approved local draft
 * revision alone, so the same revision always yields the same manifest
 * digest — before dispatch, during dispatch, and during any later
 * reconciliation. For a not-listed (unmanaged) item the revision's observed
 * values are all null and the source values rule: the proposed values ARE the
 * listing, and price/quantity come from the revision's Shopify source values
 * because a new listing needs an initial price and quantity and Marketplace
 * Connect has no claim on a listing it never knew.
 *
 * The END manifest derives from one fresh workspace basis (there is no draft
 * revision for an end): identity, the single supported ending reason, and a
 * digest of the observed title binding the manifest to the reviewed state.
 *
 * Relist is deliberately not a separate code path: it is a re-run of the
 * create ceremony against the then-not-listed item.
 */
import { type Digest, type ListingFieldName, type ListingIdentity, type ListingRevision } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';
export declare class ListingLifecycleManifestError extends Error {
    readonly code: 'CREATE_TARGET_ALREADY_LISTED' | 'CREATE_REQUIRED_FIELD_MISSING' | 'CREATE_CONDITION_UNSUPPORTED' | 'CREATE_IDENTITY_MISMATCH' | 'CREATE_BASE_STALE' | 'CREATE_PAYLOAD_INVALID' | 'END_TARGET_NOT_ACTIVE' | 'END_REASON_UNSUPPORTED';
    readonly field: ListingFieldName | null;
    constructor(code: 'CREATE_TARGET_ALREADY_LISTED' | 'CREATE_REQUIRED_FIELD_MISSING' | 'CREATE_CONDITION_UNSUPPORTED' | 'CREATE_IDENTITY_MISMATCH' | 'CREATE_BASE_STALE' | 'CREATE_PAYLOAD_INVALID' | 'END_TARGET_NOT_ACTIVE' | 'END_REASON_UNSUPPORTED', field?: ListingFieldName | null);
}
/**
 * FIXED mapping from the draft model's numeric eBay condition IDs to the
 * Inventory API condition enums. Any other numeric ID fails closed as
 * CREATE_CONDITION_UNSUPPORTED — no fuzzy or default mapping exists.
 */
export declare const CREATE_CONDITION_ENUM_BY_ID: Readonly<Record<string, string>>;
/**
 * Fixed required-or-deny field list for a create. A missing value denies with
 * CREATE_REQUIRED_FIELD_MISSING naming the field (values stay redacted).
 * `quantity` additionally requires an integer of at least one, and `price` a
 * parseable {amount, currency} money value.
 */
export declare const CREATE_REQUIRED_FIELDS: readonly ["title", "category", "condition", "price", "quantity", "fulfillment_policy", "payment_policy", "return_policy", "merchant_location", "images"];
export declare const END_SUPPORTED_REASON: "not-available";
export type ListingCreateManifest = Readonly<{
    schemaVersion: 1;
    scope: typeof LISTING_DRAFT_SCOPE;
    action: 'create_ebay_listing';
    identity: ListingIdentity;
    revisionId: string;
    revisionNumber: number;
    revisionDigest: Digest;
    baseSourceDigest: Digest;
    baseEbayObservationDigest: Digest;
    proposed: Readonly<{
        title: string;
        categoryId: string;
        conditionId: string;
        conditionEnum: string;
        conditionDescription: string | null;
        description: string | null;
        images: readonly string[];
        fulfillmentPolicyId: string;
        paymentPolicyId: string;
        returnPolicyId: string;
        merchantLocationKey: string;
        price: Readonly<{
            amount: string;
            currency: string;
        }>;
        quantity: number;
    }>;
}>;
export type DerivedListingCreateManifest = Readonly<{
    manifest: ListingCreateManifest;
    manifestDigest: Digest;
}>;
export type ListingEndManifest = Readonly<{
    schemaVersion: 1;
    scope: typeof LISTING_DRAFT_SCOPE;
    identity: ListingIdentity;
    action: 'end_listing';
    reason: typeof END_SUPPORTED_REASON;
    observedTitleDigest: Digest;
}>;
export type DerivedListingEndManifest = Readonly<{
    manifest: ListingEndManifest;
    manifestDigest: Digest;
}>;
/**
 * Derive the deterministic CREATE manifest from one stored draft revision of
 * a not-listed (unmanaged) item. For a create the proposed values ARE the
 * listing; price and quantity are taken from the revision's Shopify SOURCE
 * values. Every required field must be present, the condition ID must map
 * through the fixed table, and any eBay artifact on the identity denies as
 * already-listed.
 */
export declare function deriveListingCreateManifest(revision: ListingRevision): DerivedListingCreateManifest;
/**
 * Pre-dispatch freshness gate for a create: the live workspace identity must
 * equal the revision identity, and both the observed values (all null for an
 * unmanaged item — any appearing eBay artifact is drift) AND the Shopify
 * source values must still match the revision. Because a create takes price
 * and quantity from the source values, Shopify drift in them stales the
 * draft and denies dispatch.
 */
export declare function assertFreshBasisMatchesCreateRevision(input: {
    revision: ListingRevision;
    freshBasis: ListingDraftBasis;
}): void;
export type ListingCreatePayloads = Readonly<{
    inventoryItemPayload: Record<string, unknown>;
    offerPayload: Record<string, unknown>;
}>;
/**
 * Derive the exact two provider payloads from the manifest alone: the
 * Inventory-item PUT body and the Offer POST body. Nothing outside the
 * manifest's proposed values is ever serialized.
 */
export declare function buildListingCreatePayloads(manifest: ListingCreateManifest): ListingCreatePayloads;
/**
 * Derive the deterministic END manifest from one fresh basis. The target must
 * be an ACTIVE listing under either management model, and the only supported
 * ending reason is `not-available` (eBay Trading `NotAvailable` / Inventory
 * offer withdraw).
 */
export declare function deriveListingEndManifest(input: {
    basis: ListingDraftBasis;
    reason: string;
}): DerivedListingEndManifest;
/**
 * Post-dispatch outcome classification over one fresh raw workspace read (a
 * fresh read performs a new capture). Deliberately NOT the strict
 * draft-eligibility basis: the in-between states this classifier must name —
 * an unpublished offer artifact, an ambiguous capture — are exactly the
 * states the eligibility gate refuses.
 *
 * - `observed`: the intended terminal state is visible and bound.
 * - `absent`: the pre-dispatch state is still visible unchanged.
 * - `artifact` (create only): an offer/unpublished artifact exists without an
 *   active listing — the created-offer-but-publish-failed case. Never
 *   resolvable, not even with --accept-absent: a remote artifact exists. The
 *   operator finishes or withdraws it in a new ceremony.
 * - `unverified`: the capture is ambiguous; never resolvable.
 */
export type LifecycleOutcomeKind = 'observed' | 'absent' | 'artifact' | 'unverified';
export type LifecycleOutcome = Readonly<{
    kind: LifecycleOutcomeKind;
    observedListingId: string | null;
    observedOfferId: string | null;
    observedDigest: Digest;
}>;
export declare function classifyCreateOutcome(input: {
    workspace: ListingWorkspaceDto;
    sku: string;
    expectedListingId: string | null;
}): LifecycleOutcome;
export declare function classifyEndOutcome(input: {
    workspace: ListingWorkspaceDto;
    sku: string;
    listingId: string;
}): LifecycleOutcome;
