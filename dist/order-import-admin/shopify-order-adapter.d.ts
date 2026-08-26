export declare class ShopifyOrderAdapterError extends Error {
    readonly code: 'SHOPIFY_AUTHORITY_UNAVAILABLE' | 'SHOPIFY_IDENTITY_MISMATCH' | 'SHOPIFY_TARGET_INVALID' | 'SHOPIFY_READ_FAILED' | 'SHOPIFY_WRITE_FAILED';
    constructor(code: 'SHOPIFY_AUTHORITY_UNAVAILABLE' | 'SHOPIFY_IDENTITY_MISMATCH' | 'SHOPIFY_TARGET_INVALID' | 'SHOPIFY_READ_FAILED' | 'SHOPIFY_WRITE_FAILED');
}
type FetchLike = typeof fetch;
export type ShopifyOrderCreateResult = Readonly<{
    /** Canonical Order GID when the provider reported a created order. */
    orderGid: string | null;
    /** True when the provider returned orderCreate userErrors. */
    userErrorsPresent: boolean;
}>;
export type ShopifyOrderAdapter = Readonly<{
    /** Verify the pinned shop identity and return the installation scopes. */
    getInstallationScopes: () => Promise<string[]>;
    /** Dedup/verify search: orders(first: 5, query: "tag:'<tag>'") — GIDs only. */
    findOrderGidsByTag: (tag: string) => Promise<string[]>;
    /** Incumbent dedup search: exact originating-platform order id — GIDs only. */
    findOrderGidsBySourceIdentifier: (sourceIdentifier: string) => Promise<string[]>;
    /** Exact-SKU variant lookup: productVariants(first: 1, query: "sku:'<sku>'"). */
    findVariantGidBySku: (sku: string) => Promise<string | null>;
    /** The single bounded orderCreate mutation of the dispatch ceremony. */
    createOrder: (orderInput: Record<string, unknown>) => Promise<ShopifyOrderCreateResult>;
}>;
export declare function createShopifyOrderAdapter(dependencies: Readonly<{
    fetchImpl?: FetchLike;
    getAccessToken: () => Promise<string>;
}>): ShopifyOrderAdapter;
/**
 * Default production Shopify authority: the existing offline access token in
 * the shadow ledger's `auth_tokens` shopify row, read query-only. The token
 * is never persisted elsewhere, logged, or returned outside the adapter.
 */
export declare function createProductionShopifyOrderTokenProvider(): () => Promise<string>;
export {};
