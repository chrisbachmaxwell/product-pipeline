import type { Digest, IntegrationScope } from '../migration-store/types.js';
export declare const MIGRATION_DATABASE_RELATIVE_PATH = ".local/migration-state/product-pipeline-migration-v1.sqlite";
export declare const MIGRATION_DATABASE_BASENAME = "product-pipeline-migration-v1.sqlite";
export declare const MIGRATION_DATABASE_DIRECTORY_NAME = "migration-state";
export type MigrationAdminLane = 'development' | 'sandbox' | 'production-shadow';
export type MigrationAdminConfig = {
    schemaVersion: 1;
    project: 'product-pipeline';
    lane: MigrationAdminLane;
    mode: 'migration-state-admin';
    /**
     * Either the fixed repository-local path, or an exact absolute durable path
     * (e.g. on the deployment's persistent volume) whose final two components
     * are `migration-state/product-pipeline-migration-v1.sqlite`. The durable
     * form must resolve outside the repository checkout.
     */
    databasePath: string;
    scope: IntegrationScope;
    safety: {
        externalPlatformAccess: false;
        externalWrites: false;
        historicalBackfill: false;
        cutoverWatermarkUtc: null;
        ownershipTransferAllowed: false;
        credentialsAllowed: false;
    };
};
export type LoadedMigrationAdminConfig = {
    config: MigrationAdminConfig;
    repositoryRoot: string;
    configAbsolutePath: string;
    databaseAbsolutePath: string;
    scopeDigest: Digest;
    configDigest: Digest;
};
export declare class MigrationAdminConfigError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare function parseMigrationAdminConfig(value: unknown): MigrationAdminConfig;
export declare function isDurableMigrationDatabasePath(databasePath: string): boolean;
export declare function validateMigrationRepositoryRoot(repoRoot: string): string;
export declare function loadMigrationAdminConfig(input: {
    repoRoot: string;
    requestedConfigPath: string;
}): LoadedMigrationAdminConfig;
export declare function assertMigrationDatabaseParentForInit(loaded: LoadedMigrationAdminConfig): void;
export declare function assertMigrationDatabaseTargetAbsent(loaded: LoadedMigrationAdminConfig): void;
export declare function requireCanonicalCreationTime(value: string, now?: number): string;
