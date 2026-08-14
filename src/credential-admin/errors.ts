export type ShopifyCredentialRotationErrorCode =
  | 'configuration-denied'
  | 'database-denied'
  | 'token-row-denied'
  | 'provider-denied'
  | 'verification-denied'
  | 'backup-denied'
  | 'concurrency-denied';

export class ShopifyCredentialRotationError extends Error {
  readonly code: ShopifyCredentialRotationErrorCode;

  constructor(code: ShopifyCredentialRotationErrorCode) {
    super('Shopify credential rotation failed closed');
    this.name = 'ShopifyCredentialRotationError';
    this.code = code;
  }
}

export function rotationDenied(code: ShopifyCredentialRotationErrorCode): never {
  throw new ShopifyCredentialRotationError(code);
}

export function translateRotationError(
  error: unknown,
  fallback: ShopifyCredentialRotationErrorCode,
): never {
  if (error instanceof ShopifyCredentialRotationError) throw error;
  return rotationDenied(fallback);
}

export function fixedShopifyCredentialRotationFailure(error: unknown): string {
  const code = error instanceof ShopifyCredentialRotationError
    ? error.code
    : 'unexpected-denied';
  return JSON.stringify(Object.freeze({ status: 'failed_closed', code }));
}
