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
import { sha256Digest, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export class AlignmentManifestError extends Error {
    code;
    constructor(code) {
        super('Alignment manifest derivation failed');
        this.code = code;
        this.name = 'AlignmentManifestError';
    }
}
const deny = (code) => {
    throw new AlignmentManifestError(code);
};
export const ALIGNMENT_FIELDS = Object.freeze(['price', 'quantity']);
/** Positive decimal money amount with at most two fraction digits. */
const PRICE_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const QUANTITY = /^(0|[1-9][0-9]{0,8})$/;
/**
 * The Shopify source price is the canonical JSON `{amount, currency}` string
 * produced by the draft basis. Anything else — extra keys, a non-positive or
 * malformed amount, a non-ISO currency — fails closed.
 */
export function parseAlignmentPrice(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return deny('PLAN_SOURCE_VALUE_INVALID');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return deny('PLAN_SOURCE_VALUE_INVALID');
    }
    const record = parsed;
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
export function parseAlignmentQuantity(serialized) {
    if (!QUANTITY.test(serialized))
        return deny('PLAN_SOURCE_VALUE_INVALID');
    const quantity = Number(serialized);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
        return deny('PLAN_SOURCE_VALUE_INVALID');
    }
    return quantity;
}
function assertManagedIdentity(identity) {
    const inventoryManaged = identity.managementModel === 'inventory_api'
        && identity.ebayInventorySku !== null
        && identity.ebayOfferId !== null
        && identity.ebayListingId !== null;
    const tradingManaged = identity.managementModel === 'trading_api'
        && identity.ebayInventorySku === null
        && identity.ebayOfferId === null
        && identity.ebayListingId !== null;
    if (!inventoryManaged && !tradingManaged)
        deny('PLAN_TARGET_NOT_MANAGED');
}
function assertValidAfterValue(field, after) {
    if (field === 'price')
        parseAlignmentPrice(after);
    else
        parseAlignmentQuantity(after);
}
function buildManifest(input) {
    const manifest = Object.freeze({
        schemaVersion: 1,
        scope: LISTING_DRAFT_SCOPE,
        identity: input.identity,
        field: input.field,
        before: input.before,
        after: input.after,
    });
    return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}
/**
 * Canonical decimal form of a money amount, for comparison only.
 *
 * Trailing fractional zeros are removed exactly — no float parsing, so no
 * rounding is introduced: "1899.0" and "1899.00" both fold to "1899", and
 * "164.950" folds to "164.95". Anything that is not a plain decimal is
 * returned unchanged so it can never compare equal to something it is not.
 */
function canonicalAmount(amount) {
    if (!/^-?\d+(\.\d+)?$/u.test(amount))
        return amount;
    if (!amount.includes('.'))
        return amount;
    const trimmed = amount.replace(/0+$/u, '').replace(/\.$/u, '');
    return trimmed === '' || trimmed === '-' ? amount : trimmed;
}
/**
 * True when the eBay observed value and the Shopify source value are the same
 * aligned value, ignoring representation.
 *
 * Plain string equality reported false drift on live data: eBay returns
 * `{"amount":"1899.0"}` where Shopify holds `{"amount":"1899.00"}` for a
 * listing whose price is identical. Planning that as drift would dispatch a
 * real provider write that changes nothing — wasted eBay calls, noise in the
 * audit chain, and an avoidable chance of a failed write on a listing that
 * needed no work at all.
 *
 * Only the numeric amount is normalized. Currency must still match exactly,
 * malformed values never fold together, and the manifest is still built from
 * the ORIGINAL strings so the value dispatched to eBay is Shopify's own, not
 * a rewritten one.
 */
function isSameAlignedValue(field, before, after) {
    if (before === after)
        return true;
    if (field !== 'price' || before === null)
        return false;
    let left;
    let right;
    try {
        left = JSON.parse(before);
        right = JSON.parse(after);
    }
    catch {
        return false;
    }
    const asMoney = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof value.amount === 'string'
        && typeof value.currency === 'string'
        ? value
        : null;
    const leftMoney = asMoney(left);
    const rightMoney = asMoney(right);
    if (leftMoney === null || rightMoney === null)
        return false;
    return leftMoney.currency === rightMoney.currency
        && canonicalAmount(leftMoney.amount) === canonicalAmount(rightMoney.amount);
}
/**
 * Derive the deterministic alignment manifest from one fresh workspace
 * basis: before = current eBay observed value, after = Shopify source value.
 * Fails closed on an unmanaged or partially-bound target, a missing or
 * invalid source value, or the absence of drift (`before === after` means
 * there is nothing to align and no write may be planned).
 */
export function deriveAlignmentManifest(input) {
    const { basis, field } = input;
    if (!ALIGNMENT_FIELDS.includes(field))
        deny('PLAN_FIELD_INVALID');
    assertManagedIdentity(basis.identity);
    const after = basis.source[field];
    if (after === null)
        return deny('PLAN_SOURCE_VALUE_INVALID');
    assertValidAfterValue(field, after);
    const before = basis.observed[field];
    if (isSameAlignedValue(field, before, after))
        deny('PLAN_NO_DRIFT');
    return buildManifest({ identity: basis.identity, field, before, after });
}
/**
 * Rebuild the exact manifest from operator-supplied before/after values and
 * the live identity, for `reconcile`: the recomputed digest must match the
 * digest printed by `plan`, which binds the supplied values to the dispatched
 * manifest byte-for-byte. Drift is deliberately not required here — after a
 * successful alignment the observed value equals `after`.
 */
export function reconstructAlignmentManifest(input) {
    if (!ALIGNMENT_FIELDS.includes(input.field))
        deny('PLAN_FIELD_INVALID');
    assertManagedIdentity(input.identity);
    assertValidAfterValue(input.field, input.after);
    return buildManifest(input);
}
/**
 * Post-dispatch comparison: a single-field alignment either landed exactly
 * (`effect_observed`) or it did not (`effect_absent`); there is no partial
 * state for one field.
 */
export function compareAlignedState(input) {
    const observedValue = input.freshBasis.observed[input.manifest.field] ?? null;
    return Object.freeze({
        effect: observedValue === input.manifest.after
            ? 'effect_observed'
            : 'effect_absent',
        observedValue,
    });
}
