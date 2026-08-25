import type { ShopifyFulfillmentOrder } from './manifest.js';
export declare class ShopifyFulfillmentReadError extends Error {
    readonly code: 'FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE' | 'FULFILLMENT_SHOPIFY_TARGET_INVALID' | 'FULFILLMENT_SHOPIFY_READ_FAILED';
    constructor(code: 'FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE' | 'FULFILLMENT_SHOPIFY_TARGET_INVALID' | 'FULFILLMENT_SHOPIFY_READ_FAILED');
}
type FetchLike = typeof fetch;
export type ShopifyFulfillmentReader = Readonly<{
    getOrder: (orderGid: string) => Promise<ShopifyFulfillmentOrder>;
}>;
export declare function createShopifyFulfillmentReader(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): ShopifyFulfillmentReader;
export declare function createProductionShopifyFulfillmentReader(): ShopifyFulfillmentReader;
export {};
