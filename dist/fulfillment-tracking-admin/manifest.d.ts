import { type Digest } from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export declare class FulfillmentManifestError extends Error {
    readonly code: 'FULFILLMENT_ORDER_ID_MISMATCH' | 'FULFILLMENT_NOT_COMPLETE' | 'FULFILLMENT_PARTIAL_DENIED' | 'FULFILLMENT_MULTIPLE_DENIED' | 'FULFILLMENT_TRACKING_REQUIRED' | 'FULFILLMENT_ALREADY_RECORDED' | 'FULFILLMENT_SOURCE_INVALID' | 'FULFILLMENT_TARGET_INVALID';
    constructor(code: 'FULFILLMENT_ORDER_ID_MISMATCH' | 'FULFILLMENT_NOT_COMPLETE' | 'FULFILLMENT_PARTIAL_DENIED' | 'FULFILLMENT_MULTIPLE_DENIED' | 'FULFILLMENT_TRACKING_REQUIRED' | 'FULFILLMENT_ALREADY_RECORDED' | 'FULFILLMENT_SOURCE_INVALID' | 'FULFILLMENT_TARGET_INVALID');
}
export type ShopifyFulfillmentOrder = Readonly<{
    orderGid: string;
    lineItems: readonly Readonly<{
        lineItemGid: string;
        quantity: number;
    }>[];
    fulfillments: readonly Readonly<{
        fulfillmentGid: string;
        status: string;
        createdAtUtc: string;
        tracking: readonly Readonly<{
            company: string | null;
            number: string;
        }>[];
        lineItems: readonly Readonly<{
            lineItemGid: string;
            quantity: number;
        }>[];
    }>[];
}>;
export type EbayFulfillmentOrder = Readonly<{
    orderId: string;
    fulfillmentStatus: string;
    lineItems: readonly Readonly<{
        lineItemId: string;
        quantity: number;
    }>[];
    shippingFulfillments: readonly Readonly<{
        fulfillmentId: string;
        trackingNumber: string | null;
        shippingCarrierCode: string | null;
        shippedDate: string | null;
        lineItems: readonly Readonly<{
            lineItemId: string;
            quantity: number;
        }>[];
    }>[];
}>;
export type FulfillmentManifest = Readonly<{
    schemaVersion: 1;
    scope: typeof LISTING_DRAFT_SCOPE;
    shopifyOrderGid: string;
    ebayOrderId: string;
    shopifyFulfillmentGid: string;
    shippedDate: string;
    shippingCarrierCode: string;
    trackingNumber: string;
    lineItems: readonly Readonly<{
        lineItemId: string;
        quantity: number;
    }>[];
}>;
export type DerivedFulfillmentManifest = Readonly<{
    manifest: FulfillmentManifest;
    manifestDigest: Digest;
}>;
export declare function mapCarrierCode(company: string | null): string;
export declare function deriveFulfillmentManifest(input: {
    shopify: ShopifyFulfillmentOrder;
    ebay: EbayFulfillmentOrder;
    expectedShopifyOrderGid: string;
    expectedEbayOrderId: string;
    allowAlreadyRecorded?: boolean;
}): DerivedFulfillmentManifest;
export declare function compareFulfillmentEffect(input: {
    expectedManifestDigest: Digest;
    shopifyOrderGid: string;
    ebayOrderId: string;
    shopifyFulfillmentGid: string;
    ebay: EbayFulfillmentOrder;
}): 'effect_observed' | 'effect_absent';
