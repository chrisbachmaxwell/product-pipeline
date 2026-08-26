import { type SandboxListingManifest } from './manifest.js';
export declare class SandboxAdapterError extends Error {
    readonly code: string;
    constructor(code: string);
}
export type CredentialPacket = Readonly<{
    accessToken: string;
    sellerId: string;
    scopes: readonly string[];
    issuedAtUtc: string;
    expiresAtUtc: string;
}>;
export type SandboxInventorySnapshot = Readonly<{
    sku: string;
    availability: Readonly<{
        shipToLocationAvailability: Readonly<{
            quantity: number;
        }>;
    }>;
    condition: string;
    conditionDescription: string;
    product: Readonly<{
        title: string;
        description: string;
        imageUrls: readonly string[];
    }>;
}>;
export type SandboxOfferSnapshot = Readonly<{
    offerId: string;
    sku: string;
    marketplaceId: 'EBAY_US';
    status: 'PUBLISHED' | 'UNPUBLISHED';
    format: 'FIXED_PRICE';
    listingDuration: 'GTC';
    listingId: string | null;
    availableQuantity: number;
    categoryId: string;
    listingDescription: string;
    listingPolicies: Readonly<{
        fulfillmentPolicyId: string;
        paymentPolicyId: string;
        returnPolicyId: string;
    }>;
    merchantLocationKey: string;
    pricingSummary: Readonly<{
        price: Readonly<{
            currency: string;
            value: string;
        }>;
    }>;
}>;
export type TradingListingSnapshot = Readonly<{
    itemId: string;
    sku: string;
    title: string;
    description: string;
    quantity: number;
    categoryId: string;
    price: string;
    currency: string;
    listingStatus: 'Active' | 'Completed' | 'Ended';
}>;
export type SandboxSnapshot = Readonly<{
    inventory: SandboxInventorySnapshot | null;
    offers: readonly SandboxOfferSnapshot[];
    tradingListings: readonly TradingListingSnapshot[];
}>;
export declare function readCredentialPacket(stream?: NodeJS.ReadableStream, now?: Date): Promise<CredentialPacket>;
/** Opaque, migration-scope-safe pseudonym; the private Sandbox seller id is never persisted. */
export declare function sellerDigest(sellerId: string): string;
export type SandboxAdapter = ReturnType<typeof createSandboxAdapter>;
export declare function createSandboxAdapter(input: {
    token: string;
    expectedSellerId: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
}): Readonly<{
    verifyIdentity: () => Promise<void>;
    validatePrerequisites: (manifest: SandboxListingManifest) => Promise<void>;
    snapshot: (sku: string) => Promise<SandboxSnapshot>;
    putInventory: (sku: string, payload: Record<string, unknown>) => Promise<void>;
    createOffer: (payload: Record<string, unknown>) => Promise<string>;
    publish: (offerId: string) => Promise<string>;
    withdraw: (offerId: string) => Promise<void>;
    deleteOffer: (offerId: string) => Promise<void>;
    deleteInventory: (sku: string) => Promise<void>;
}>;
