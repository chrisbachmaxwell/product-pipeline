import type { Digest } from '../migration-store/index.js';
export declare const SANDBOX_API_ORIGIN: "https://api.sandbox.ebay.com";
export declare const SANDBOX_IDENTITY_ORIGIN: "https://apiz.sandbox.ebay.com";
export declare const SANDBOX_MARKETPLACE: "EBAY_US";
export declare const SANDBOX_MARKER: "PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY";
export declare class SandboxManifestError extends Error {
    readonly code: string;
    constructor(code: string);
}
export type SandboxTarget = Readonly<{
    storeDomain: string;
    productGid: string;
    variantGid: string;
    sku: string;
    shopifyEvidenceDigest: Digest;
}>;
export type SandboxListingManifest = Readonly<{
    schemaVersion: 1;
    environment: 'sandbox';
    marketplaceId: 'EBAY_US';
    target: SandboxTarget;
    listing: Readonly<{
        title: string;
        description: string;
        imageUrls: readonly string[];
        categoryId: string;
        condition: string;
        conditionDescription: string;
        quantity: 1;
        price: Readonly<{
            currency: 'USD';
            value: '1.00';
        }>;
        merchantLocationKey: string;
        fulfillmentPolicyId: string;
        paymentPolicyId: string;
        returnPolicyId: string;
    }>;
}>;
export declare function validateTarget(input: {
    storeDomain: string;
    productGid: string;
    variantGid: string;
    sku: string;
    shopifyEvidenceDigest: string;
}): SandboxTarget;
export declare function readSandboxManifest(filePath: string, exactTarget: SandboxTarget): {
    manifest: SandboxListingManifest;
    digest: Digest;
};
export declare function buildPayloads(manifest: SandboxListingManifest): {
    inventory: Record<string, unknown>;
    offer: Record<string, unknown>;
};
