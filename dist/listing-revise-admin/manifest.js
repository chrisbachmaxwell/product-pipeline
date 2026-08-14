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
import { sha256Digest, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export class ListingReviseManifestError extends Error {
    code;
    constructor(code) {
        super('Listing revise manifest derivation failed');
        this.code = code;
        this.name = 'ListingReviseManifestError';
    }
}
const deny = (code) => {
    throw new ListingReviseManifestError(code);
};
/**
 * Fields this slice may dispatch. `condition` is deliberately excluded until
 * the numeric-condition-to-Inventory-enum mapping passes its own review;
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
]);
function revisionField(revision, field) {
    return revision.fields.find((candidate) => candidate.field === field) ?? null;
}
/**
 * Derive the deterministic dispatch manifest from one stored draft revision,
 * failing closed unless the target is a fully-bound inventory_api listing, at
 * least one override exists, every override is a dispatchable field, and the
 * revision observed the preserved price and quantity values.
 */
export function deriveListingReviseManifest(revision) {
    const identity = revision.identity;
    if (identity.managementModel !== 'inventory_api'
        || identity.ebayInventorySku === null
        || identity.ebayOfferId === null
        || identity.ebayListingId === null) {
        deny('REVISE_TARGET_NOT_INVENTORY_MANAGED');
    }
    const overrides = revision.fields.filter((field) => field.proposedSource === 'override' && field.overrideValue !== null);
    if (overrides.length === 0)
        deny('REVISE_NO_CHANGES');
    const dispatchable = new Set(DISPATCHABLE_FIELDS);
    for (const field of overrides) {
        if (!dispatchable.has(field.field))
            deny('REVISE_UNSUPPORTED_FIELD');
    }
    const preservedPrice = revisionField(revision, 'price')?.observedValue ?? null;
    const preservedQuantity = revisionField(revision, 'quantity')?.observedValue ?? null;
    if (preservedPrice === null || preservedQuantity === null) {
        throw new ListingReviseManifestError('REVISE_PRESERVED_FIELD_MISSING');
    }
    const changes = overrides.map((field) => Object.freeze({
        field: field.field,
        before: field.observedValue,
        after: field.overrideValue,
    }));
    const manifest = Object.freeze({
        schemaVersion: 1,
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
function identitiesMatch(left, right) {
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
export function assertFreshBasisMatchesRevision(input) {
    if (!identitiesMatch(input.freshBasis.identity, input.revision.identity)) {
        deny('REVISE_IDENTITY_MISMATCH');
    }
    for (const field of input.revision.fields) {
        const freshObserved = input.freshBasis.observed[field.field] ?? null;
        if (freshObserved !== field.observedValue)
            deny('REVISE_BASE_STALE');
    }
}
/**
 * Post-dispatch comparison: classify the live observed values against the
 * manifest's expected after-values. `partial` means some but not all changes
 * are visible; the caller must record it as a critical reconciliation
 * exception and leave the job unresolved for operator investigation.
 */
export function compareDispatchedState(input) {
    const matched = [];
    const unmatched = [];
    for (const change of input.manifest.changes) {
        const observed = input.freshBasis.observed[change.field] ?? null;
        if (observed === change.after)
            matched.push(change.field);
        else
            unmatched.push(change.field);
    }
    const effect = unmatched.length === 0
        ? 'revised_state_observed'
        : matched.length === 0 ? 'revised_state_absent' : 'partial';
    return Object.freeze({
        effect,
        matchedFields: Object.freeze(matched),
        unmatchedFields: Object.freeze(unmatched),
    });
}
export class ListingRevisePayloadError extends Error {
    code;
    constructor(code) {
        super('Listing revise payload derivation failed');
        this.code = code;
        this.name = 'ListingRevisePayloadError';
    }
}
const denyPayload = (code) => {
    throw new ListingRevisePayloadError(code);
};
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ...value }
        : denyPayload('REVISE_RAW_PAYLOAD_INVALID');
}
function parseImageList(serialized) {
    try {
        const parsed = JSON.parse(serialized);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 24
            || parsed.some((entry) => typeof entry !== 'string')) {
            return denyPayload('REVISE_RAW_PAYLOAD_INVALID');
        }
        return parsed;
    }
    catch {
        return denyPayload('REVISE_RAW_PAYLOAD_INVALID');
    }
}
/**
 * Apply exactly the manifest's changes to the raw provider resources fetched
 * moments before dispatch, preserving every other property byte-for-byte.
 * Price/quantity preservation is enforced structurally: the pricing and
 * availability subtrees of the raw resources are asserted unchanged between
 * the fetched objects and the produced payloads.
 */
export function buildListingRevisePayloads(input) {
    const { manifest } = input;
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
    const itemPayload = { ...rawItem };
    const offerPayload = { ...rawOffer };
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
    const preserved = [
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
