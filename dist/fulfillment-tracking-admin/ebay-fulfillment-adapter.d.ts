import type { EbayFulfillmentOrder, FulfillmentManifest } from './manifest.js';
export declare class EbayFulfillmentAdapterError extends Error {
    readonly code: 'FULFILLMENT_EBAY_AUTHORITY_UNAVAILABLE' | 'FULFILLMENT_EBAY_TARGET_INVALID' | 'FULFILLMENT_EBAY_READ_FAILED' | 'FULFILLMENT_EBAY_WRITE_FAILED';
    constructor(code: 'FULFILLMENT_EBAY_AUTHORITY_UNAVAILABLE' | 'FULFILLMENT_EBAY_TARGET_INVALID' | 'FULFILLMENT_EBAY_READ_FAILED' | 'FULFILLMENT_EBAY_WRITE_FAILED');
}
type FetchLike = typeof fetch;
export type EbayFulfillmentAdapter = Readonly<{
    getOrder: (orderId: string) => Promise<EbayFulfillmentOrder>;
    createShippingFulfillment: (manifest: FulfillmentManifest) => Promise<void>;
}>;
export declare function buildShippingFulfillmentBody(manifest: FulfillmentManifest): string;
export declare function createEbayFulfillmentAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): EbayFulfillmentAdapter;
export declare function createProductionEbayFulfillmentAdapter(): EbayFulfillmentAdapter;
export {};
