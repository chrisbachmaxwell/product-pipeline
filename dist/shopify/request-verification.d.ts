import { type ShopifyCredentials } from '../config/credentials.js';
type VerificationEnvironment = Readonly<Record<string, string | undefined>>;
export type ShopifySessionClaims = Readonly<{
    aud: string;
    dest: string;
    exp: number;
    iat: number;
    iss: string;
    nbf: number;
    sub: string;
}> & Readonly<Record<string, unknown>>;
export type ShopifyRequestVerificationDependencies = Readonly<{
    environment?: VerificationEnvironment;
    loadCredentials?: () => Promise<ShopifyCredentials>;
    now?: () => number;
}>;
/**
 * Decode an App Bridge session token against the current secret and, only
 * during a bounded rotation window, the previous secret. No token exchange or
 * provider request is performed here.
 */
export declare function decodeShopifySessionTokenForRequest(token: string, dependencies?: ShopifyRequestVerificationDependencies): Promise<ShopifySessionClaims | null>;
/** Verify a Shopify webhook without parsing or retaining its body. */
export declare function verifyShopifyWebhookHmac(hmacHeader: string | undefined, rawBody: Buffer | undefined, dependencies?: ShopifyRequestVerificationDependencies): Promise<boolean>;
export declare const SHOPIFY_REQUEST_VERIFICATION_TESTING: Readonly<{
    maximumPreviousSecretLifetimeMs: number;
}>;
export {};
