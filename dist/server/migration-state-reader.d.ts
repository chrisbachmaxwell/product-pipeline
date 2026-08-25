import { inspectMigrationStoreReadOnly } from '../migration-store/projection.js';
import { loadMigrationAdminConfig } from '../migration-admin/config.js';
export type UnavailableMigrationStateProjection = {
    status: 'not-configured' | 'unavailable' | 'invalid';
    schemaVersion: null;
    scope: null;
    access: {
        writable: false;
        readOnly: true;
        externallyWired: false;
        externalWritesSupported: false;
        historicalBackfillAllowed: false;
    };
    counts: null;
    ownership: [];
    orders: {
        watermarkUtc: null;
        watermarkEstablished: false;
        eligibleForCreation: 0;
        historicalBackfillAllowed: false;
    };
    audit: {
        valid: false;
        recordCount: 0;
        headHash: null;
    };
    readiness: {
        canaryReady: false;
        cutoverReady: false;
        blockers: string[];
    };
    errorCode: 'MIGRATION_STATE_NOT_CONFIGURED' | 'MIGRATION_STATE_CONFIG_INVALID' | 'MIGRATION_STATE_STORE_UNAVAILABLE' | 'MIGRATION_STATE_STORE_INVALID';
};
export type MigrationStateApiProjection = {
    status: 'verified';
    schemaVersion: 4;
    scope: {
        scopeKey: string;
        shopifyStoreDomain: string;
        ebayEnvironment: 'sandbox' | 'production';
        ebayMarketplaceId: string;
    };
    access: UnavailableMigrationStateProjection['access'];
    counts: Record<string, number>;
    ownership: Array<{
        responsibility: string;
        configured: boolean;
        version: number | null;
        owner: 'marketplace_connect' | 'paused' | 'product_pipeline' | null;
        singleWriterVerified: boolean;
    }>;
    orders: {
        watermarkUtc: string | null;
        watermarkEstablished: boolean;
        eligibleForCreation: 0;
        historicalBackfillAllowed: false;
    };
    audit: {
        valid: true;
        recordCount: number;
        headHash: string;
    };
    readiness: {
        canaryReady: false;
        cutoverReady: false;
        blockers: string[];
    };
} | UnavailableMigrationStateProjection;
type ConfigLoader = typeof loadMigrationAdminConfig;
type StoreInspector = typeof inspectMigrationStoreReadOnly;
/**
 * Request-time-only bridge from explicit server configuration to the inert
 * durable-state projection. It never returns config paths/digests or a store
 * handle, and every error is collapsed to a stable non-sensitive state.
 */
export declare function readConfiguredMigrationState(options?: {
    environment?: NodeJS.ProcessEnv;
    repositoryRoot?: string;
    loadConfig?: ConfigLoader;
    inspectStore?: StoreInspector;
}): Promise<MigrationStateApiProjection>;
export {};
