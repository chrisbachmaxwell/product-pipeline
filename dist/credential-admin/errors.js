export class ShopifyCredentialRotationError extends Error {
    code;
    constructor(code) {
        super('Shopify credential rotation failed closed');
        this.name = 'ShopifyCredentialRotationError';
        this.code = code;
    }
}
export function rotationDenied(code) {
    throw new ShopifyCredentialRotationError(code);
}
export function translateRotationError(error, fallback) {
    if (error instanceof ShopifyCredentialRotationError)
        throw error;
    return rotationDenied(fallback);
}
export function fixedShopifyCredentialRotationFailure(error) {
    const code = error instanceof ShopifyCredentialRotationError
        ? error.code
        : 'unexpected-denied';
    return JSON.stringify(Object.freeze({ status: 'failed_closed', code }));
}
