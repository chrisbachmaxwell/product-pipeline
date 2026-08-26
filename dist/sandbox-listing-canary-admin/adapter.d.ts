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
export type SandboxSnapshot = Readonly<{
    inventoryPresent: boolean;
    offers: readonly Readonly<{
        offerId: string;
        status: string;
        listingId: string | null;
    }>[];
    tradingSkuMatches: number;
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
    snapshot: (sku: string) => Promise<SandboxSnapshot>;
    putInventory: (sku: string, payload: Record<string, unknown>) => Promise<void>;
    createOffer: (payload: Record<string, unknown>) => Promise<string>;
    publish: (offerId: string) => Promise<string>;
    withdraw: (offerId: string) => Promise<void>;
    deleteOffer: (offerId: string) => Promise<void>;
    deleteInventory: (sku: string) => Promise<void>;
}>;
