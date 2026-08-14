import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
export declare const PRODUCT_PIPELINE_PRODUCTION_RUNTIME: Readonly<{
    projectId: "f8c050c9-11c3-4611-8805-092289941aa4";
    environmentId: "544d8896-b900-48ad-b42e-95272e1ad397";
    serviceId: "32ef14cc-2c85-447d-a890-53c422d81de1";
    databasePath: "/data/ebaysync.db";
    backupDirectory: "/data/product-pipeline/credential-backups/shopify";
    singleWriterAck: "product-pipeline-shopify-credential-rotation-v1";
}>;
export declare const SHOPIFY_ROTATION_ENVIRONMENT: Readonly<{
    readonly clientId: "SHOPIFY_CLIENT_ID";
    readonly clientSecret: "SHOPIFY_CLIENT_SECRET";
    readonly previousClientSecret: "SHOPIFY_PREVIOUS_CLIENT_SECRET";
    readonly previousClientSecretExpiresAtUtc: "SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC";
    readonly refreshToken: "SHOPIFY_ROTATION_REFRESH_TOKEN";
    readonly databasePath: "DATABASE_PATH";
    readonly projectId: "RAILWAY_PROJECT_ID";
    readonly environmentId: "RAILWAY_ENVIRONMENT_ID";
    readonly serviceId: "RAILWAY_SERVICE_ID";
    readonly singleWriterAck: "SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK";
    readonly singleWriterAckExpiresAtUtc: "SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK_EXPIRES_AT_UTC";
    readonly listingWriterAck: "LISTING_CONTROL_SINGLE_WRITER_ACK";
}>;
export type ShopifyCredentialRotationConfig = Readonly<{
    databasePath: typeof PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
    clientId: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId;
    clientSecret: string;
    previousClientSecret: string | null;
    previousClientSecretExpiresAtEpochMs: number | null;
    refreshToken: string | null;
    storeDomain: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain;
    authorizationExpiresAtEpochMs: number;
}>;
type Environment = Readonly<Record<string, string | undefined>>;
export type LegacyDatabaseIdentity = Readonly<{
    dev: number;
    ino: number;
    size: number;
}>;
export declare function assertLegacyDatabasePath(databasePath: string, expectedDatabasePath?: string): LegacyDatabaseIdentity;
export declare function assertLegacyDatabaseIdentity(databasePath: string, expected: LegacyDatabaseIdentity, expectedDatabasePath?: string): void;
export declare function loadShopifyCredentialRotationConfig(input: Readonly<{
    environment?: Environment;
    now?: number;
    requireRefreshToken: boolean;
    validateDatabasePath?: (databasePath: string) => unknown;
}>): ShopifyCredentialRotationConfig;
export declare function assertShopifyCredentialRotationAuthorizationActive(config: ShopifyCredentialRotationConfig, now: number): void;
/**
 * Last time-based gate before the single no-retry provider request. A verified
 * token is committed forward after issuance even if wall clock time later
 * crosses a deadline; abandoning it would orphan the provider-side effect.
 */
export declare function assertShopifyCredentialRotationDispatchAuthorized(config: ShopifyCredentialRotationConfig, now: number): void;
export declare const SHOPIFY_CREDENTIAL_ROTATION_CONFIG_LIMITS: Readonly<{
    maximumAckLifetimeMs: number;
    minimumRotationDispatchWindowMs: number;
}>;
export {};
