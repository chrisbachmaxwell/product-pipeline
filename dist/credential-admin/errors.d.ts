export type ShopifyCredentialRotationErrorCode = 'configuration-denied' | 'database-denied' | 'token-row-denied' | 'provider-denied' | 'verification-denied' | 'backup-denied' | 'concurrency-denied';
export declare class ShopifyCredentialRotationError extends Error {
    readonly code: ShopifyCredentialRotationErrorCode;
    constructor(code: ShopifyCredentialRotationErrorCode);
}
export declare function rotationDenied(code: ShopifyCredentialRotationErrorCode): never;
export declare function translateRotationError(error: unknown, fallback: ShopifyCredentialRotationErrorCode): never;
export declare function fixedShopifyCredentialRotationFailure(error: unknown): string;
