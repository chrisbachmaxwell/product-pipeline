export declare const SANDBOX_ALIGNMENT_SCOPE: Readonly<{
    schemaVersion: 1;
    environment: "sandbox";
    shopify: Readonly<{
        storeDomain: "usedcameragear.myshopify.com";
        shopId: "gid://shopify/Shop/86254518563";
        appClientId: "2db0555e4848a8264383dc0edfcfb8fe";
        apiVersion: "2026-07";
        productId: "gid://shopify/Product/10345525412131";
        variantId: "gid://shopify/ProductVariant/55519196250403";
        title: "Pipeline Test";
        sku: "PIPELINE-TEST-20260826";
        requiredTag: "product-pipeline-test-lane";
        currency: "USD";
        price: "99.99";
        quantity: 1;
    }>;
    ebay: Readonly<{
        identityHost: "apiz.sandbox.ebay.com";
        sellHost: "api.sandbox.ebay.com";
        sellerId: "testuser_ppcanary-3c55629b";
        marketplaceId: "EBAY_US";
        merchantLocationKey: "pp-test-lane";
        sku: "PIPELINE-TEST-20260826";
        format: "FIXED_PRICE";
        listingDuration: "GTC";
    }>;
}>;
export type SandboxAlignmentAction = 'price-align' | 'quantity-seed' | 'quantity-align';
export type SandboxSourceState = Readonly<{
    storeDomain: string;
    shopId: string;
    appClientId: string;
    scopes: readonly string[];
    productId: string;
    variantId: string;
    title: string;
    status: 'ACTIVE';
    tags: readonly string[];
    publishedAt: null;
    sku: string;
    currency: 'USD';
    price: '99.99';
    quantity: 1;
}>;
export type SandboxEbayState = Readonly<{
    sellerId: string;
    registrationMarketplaceId: 'EBAY_US';
    sku: string;
    offerId: string;
    listingId: string;
    marketplaceId: 'EBAY_US';
    merchantLocationKey: 'pp-test-lane';
    format: 'FIXED_PRICE';
    listingDuration: 'GTC';
    status: 'PUBLISHED';
    listingStatus: 'ACTIVE';
    itemQuantity: number;
    offerQuantity: number;
    tradingQuantity: number;
    price: Readonly<{
        currency: 'USD';
        value: string;
    }>;
    tradingPrice: Readonly<{
        currency: 'USD';
        value: string;
    }>;
}>;
export type SandboxAlignmentManifest = Readonly<{
    schemaVersion: 1;
    scope: typeof SANDBOX_ALIGNMENT_SCOPE;
    listingProvenanceDigest: `sha256:${string}`;
    action: SandboxAlignmentAction;
    target: Readonly<{
        sku: typeof SANDBOX_ALIGNMENT_SCOPE.ebay.sku;
        offerId: string;
        listingId: string;
    }>;
    sourceDigest: `sha256:${string}`;
    before: Readonly<{
        price?: Readonly<{
            currency: 'USD';
            value: string;
        }>;
        quantity?: number;
    }>;
    after: Readonly<{
        price?: Readonly<{
            currency: 'USD';
            value: string;
        }>;
        quantity?: number;
    }>;
}>;
export declare class SandboxAlignmentError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare const deny: (code: string) => never;
export declare function digest(value: unknown): `sha256:${string}`;
export declare const SANDBOX_ALIGNMENT_SCOPE_DIGEST: `sha256:${string}`;
export declare function assertDigest(value: string): asserts value is `sha256:${string}`;
export declare function assertTarget(input: {
    sku: string;
    offerId: string;
    listingId: string;
}): void;
export declare function assertSource(source: SandboxSourceState): void;
export declare function assertEbay(state: SandboxEbayState, target: {
    sku: string;
    offerId: string;
    listingId: string;
}): void;
export declare function deriveManifest(input: {
    action: SandboxAlignmentAction;
    listingProvenanceDigest: string;
    target: {
        sku: string;
        offerId: string;
        listingId: string;
    };
    source: SandboxSourceState;
    ebay: SandboxEbayState;
}): {
    manifest: SandboxAlignmentManifest;
    manifestDigest: `sha256:${string}`;
};
export declare function classifyObserved(manifest: SandboxAlignmentManifest, state: SandboxEbayState): 'effect_observed' | 'effect_absent' | 'partial';
