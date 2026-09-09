import type { ShopifyFulfillmentOrder } from './manifest.js';
export declare class ShopifyFulfillmentReadError extends Error {
    readonly code: 'FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE' | 'FULFILLMENT_SHOPIFY_TARGET_INVALID' | 'FULFILLMENT_SHOPIFY_READ_FAILED';
    constructor(code: 'FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE' | 'FULFILLMENT_SHOPIFY_TARGET_INVALID' | 'FULFILLMENT_SHOPIFY_READ_FAILED');
}
type FetchLike = typeof fetch;
export type ShippedEbayOrderCandidate = Readonly<{
    ebayOrderId: string;
    shopifyOrderGid: string;
    shopifyFulfillmentGid: string;
}>;
export type ShopifyFulfillmentReader = Readonly<{
    /**
     * Bounded discovery read: recently-updated eBay-tagged shipped orders that
     * carry a successful fulfillment with a tracking number. Over-reporting is
     * safe by design -- the dispatch ceremony denies anything without OUR
     * order link (FULFILLMENT_ORDER_LINK_REQUIRED, e.g. incumbent-era orders)
     * or already recorded (FULFILLMENT_INTENT_ALREADY_RECORDED).
     */
    searchShippedEbayOrders: (input: Readonly<{
        lookbackHours: number;
        maxOrders: number;
    }>) => Promise<readonly ShippedEbayOrderCandidate[]>;
    getOrder: (orderGid: string) => Promise<ShopifyFulfillmentOrder>;
}>;
export declare function createShopifyFulfillmentReader(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): ShopifyFulfillmentReader;
export declare function createProductionShopifyFulfillmentReader(): ShopifyFulfillmentReader;
export {};
