import { sha256Digest } from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export class FulfillmentManifestError extends Error {
    code;
    constructor(code) {
        super('Fulfillment manifest derivation denied');
        this.code = code;
        this.name = 'FulfillmentManifestError';
    }
}
const deny = (code) => {
    throw new FulfillmentManifestError(code);
};
const ORDER_GID = /^gid:\/\/shopify\/Order\/[^/\s]+$/;
const FULFILLMENT_GID = /^gid:\/\/shopify\/Fulfillment\/[^/\s]+$/;
const SAFE_EBAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TRACKING = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/;
function canonicalUtc(value) {
    const epoch = Date.parse(value);
    if (!Number.isSafeInteger(epoch))
        return deny('FULFILLMENT_SOURCE_INVALID');
    return new Date(epoch).toISOString();
}
export function mapCarrierCode(company) {
    const normalized = (company ?? '').trim().toLowerCase();
    if (normalized.includes('usps'))
        return 'USPS';
    if (normalized === 'ups' || normalized.includes('united parcel'))
        return 'UPS';
    if (normalized.includes('fedex') || normalized.includes('federal express'))
        return 'FedEx';
    if (normalized.includes('dhl'))
        return 'DHL';
    return 'OTHER';
}
function quantityMap(values) {
    const result = new Map();
    for (const value of values) {
        if (typeof value.lineItemGid !== 'string' || value.lineItemGid.length === 0
            || !Number.isSafeInteger(value.quantity) || value.quantity < 1
            || result.has(value.lineItemGid)) {
            deny('FULFILLMENT_SOURCE_INVALID');
        }
        result.set(value.lineItemGid, value.quantity);
    }
    return result;
}
function mapsEqual(left, right) {
    return left.size === right.size
        && [...left].every(([key, quantity]) => right.get(key) === quantity);
}
export function deriveFulfillmentManifest(input) {
    if (!ORDER_GID.test(input.expectedShopifyOrderGid)
        || !SAFE_EBAY_ID.test(input.expectedEbayOrderId)) {
        deny('FULFILLMENT_TARGET_INVALID');
    }
    if (input.shopify.orderGid !== input.expectedShopifyOrderGid
        || input.ebay.orderId !== input.expectedEbayOrderId) {
        deny('FULFILLMENT_ORDER_ID_MISMATCH');
    }
    const successful = input.shopify.fulfillments.filter((entry) => entry.status === 'SUCCESS');
    if (successful.length === 0)
        deny('FULFILLMENT_NOT_COMPLETE');
    if (successful.length !== 1 || input.shopify.fulfillments.length !== 1) {
        deny('FULFILLMENT_MULTIPLE_DENIED');
    }
    const fulfillment = successful[0];
    if (!FULFILLMENT_GID.test(fulfillment.fulfillmentGid)) {
        deny('FULFILLMENT_SOURCE_INVALID');
    }
    if (!mapsEqual(quantityMap(input.shopify.lineItems), quantityMap(fulfillment.lineItems))) {
        deny('FULFILLMENT_PARTIAL_DENIED');
    }
    if (fulfillment.tracking.length !== 1
        || !SAFE_TRACKING.test(fulfillment.tracking[0]?.number ?? '')) {
        deny('FULFILLMENT_TRACKING_REQUIRED');
    }
    const trackingNumber = fulfillment.tracking[0].number;
    if (!input.allowAlreadyRecorded && input.ebay.shippingFulfillments.length > 0) {
        deny('FULFILLMENT_ALREADY_RECORDED');
    }
    if (!Array.isArray(input.ebay.lineItems) || input.ebay.lineItems.length === 0) {
        deny('FULFILLMENT_TARGET_INVALID');
    }
    const seen = new Set();
    const lineItems = input.ebay.lineItems.map((entry) => {
        if (!SAFE_EBAY_ID.test(entry.lineItemId) || seen.has(entry.lineItemId)
            || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1) {
            return deny('FULFILLMENT_TARGET_INVALID');
        }
        seen.add(entry.lineItemId);
        return Object.freeze({ lineItemId: entry.lineItemId, quantity: entry.quantity });
    });
    const manifest = Object.freeze({
        schemaVersion: 1,
        scope: LISTING_DRAFT_SCOPE,
        shopifyOrderGid: input.shopify.orderGid,
        ebayOrderId: input.ebay.orderId,
        shopifyFulfillmentGid: fulfillment.fulfillmentGid,
        shippedDate: canonicalUtc(fulfillment.createdAtUtc),
        shippingCarrierCode: mapCarrierCode(fulfillment.tracking[0].company),
        trackingNumber,
        lineItems: Object.freeze(lineItems),
    });
    return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}
export function compareFulfillmentEffect(input) {
    const match = input.ebay.shippingFulfillments.some((entry) => entry.trackingNumber === input.manifest.trackingNumber
        && entry.shippingCarrierCode === input.manifest.shippingCarrierCode);
    return match ? 'effect_observed' : 'effect_absent';
}
