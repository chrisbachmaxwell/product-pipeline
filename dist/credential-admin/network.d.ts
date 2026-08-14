import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import type { ShopifyCredentialRotationConfig } from './config.js';
export declare const SHOPIFY_ROTATION_GRAPHQL_DOCUMENT: "query ProductPipelineShopifyCredentialRotationVerify {\n  shop {\n    id\n    myshopifyDomain\n  }\n  currentAppInstallation {\n    app {\n      apiKey\n    }\n    accessScopes {\n      handle\n    }\n  }\n}";
export declare const CANONICAL_SHOPIFY_SCOPE_TEXT: string;
export type CredentialRotationFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Timer = ReturnType<typeof setTimeout>;
export type ShopifyCredentialRotationNetworkDependencies = Readonly<{
    fetchImpl?: CredentialRotationFetch;
    scheduleTimeout?: (callback: () => void, milliseconds: number) => Timer;
    clearScheduledTimeout?: (timer: Timer) => void;
}>;
export type RotatedShopifyAccessToken = Readonly<{
    accessToken: string;
    refreshToken: null;
    scope: typeof CANONICAL_SHOPIFY_SCOPE_TEXT;
    expiresAt: null;
}>;
export type VerifiedShopifyAuthority = Readonly<{
    storeDomain: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain;
    shopGid: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid;
    clientId: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId;
    scopes: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes;
}>;
export declare function verifyShopifyAccessToken(accessToken: string, dependencies?: ShopifyCredentialRotationNetworkDependencies): Promise<VerifiedShopifyAuthority>;
/** One request only. Callers must never blindly retry an ambiguous result. */
export declare function requestRotatedShopifyAccessToken(input: Readonly<{
    config: ShopifyCredentialRotationConfig;
    currentAccessToken: string;
    dependencies?: ShopifyCredentialRotationNetworkDependencies;
}>): Promise<RotatedShopifyAccessToken>;
export declare const SHOPIFY_CREDENTIAL_ROTATION_NETWORK_LIMITS: Readonly<{
    requestTimeoutMs: 10000;
    tokenResponseMaxBytes: number;
    graphqlResponseMaxBytes: number;
}>;
export {};
