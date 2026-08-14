import fs from 'node:fs';
import Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;
export declare const SHOPIFY_DATABASE_DIAGNOSTIC_STAGES: readonly ["file-missing", "file-inspection-denied", "file-type-denied", "file-link-denied", "file-empty-denied", "file-size-denied", "file-permissions-denied", "parent-inspection-denied", "parent-type-denied", "parent-permissions-denied", "sidecar-inspection-denied", "sidecar-present", "descriptor-open-denied", "descriptor-inspection-denied", "descriptor-identity-denied", "snapshot-read-denied", "snapshot-header-denied", "sqlite-open-denied", "sqlite-memory-denied", "sqlite-readonly-denied", "sqlite-temp-store-denied", "sqlite-query-only-denied", "schema-table-definition-denied", "schema-table-storage-denied", "schema-columns-denied", "schema-index-denied", "schema-trigger-denied", "schema-foreign-key-denied", "schema-mutation-denied", "integrity-check-denied", "shopify-row-cardinality-denied", "sqlite-close-denied", "descriptor-post-inspection-denied", "descriptor-post-identity-denied", "snapshot-post-read-denied", "snapshot-post-stability-denied", "path-post-inspection-denied", "path-post-identity-denied", "sidecar-post-inspection-denied", "sidecar-post-present", "descriptor-close-denied", "verified"];
export type ShopifyDatabaseDiagnosticStage = (typeof SHOPIFY_DATABASE_DIAGNOSTIC_STAGES)[number];
export type ShopifyDatabaseDiagnosticChecks = Readonly<{
    runtimeBindingVerified: boolean;
    fixedDatabaseTargetVerified: boolean;
    listingWriterAckAbsent: boolean;
    filePresent: boolean;
    fileRegular: boolean;
    fileSymlinkAbsent: boolean;
    fileSingleLink: boolean;
    fileNonEmpty: boolean;
    fileWithinSnapshotLimit: boolean;
    fileMode0600: boolean;
    parentDirectory: boolean;
    parentSymlinkAbsent: boolean;
    parentGroupWorldWritableAbsent: boolean;
    sqliteSidecarsAbsentBeforeSnapshot: boolean;
    descriptorOpenedReadOnly: boolean;
    descriptorInspectedBeforeSnapshot: boolean;
    descriptorIdentityStableBeforeSnapshot: boolean;
    snapshotReadFromDescriptor: boolean;
    snapshotHeaderCanonical: boolean;
    snapshotContentProofCaptured: boolean;
    sqliteOpenedFromPrivateSnapshot: boolean;
    sqlitePrivateMemory: boolean;
    sqliteOpenedReadOnly: boolean;
    sqliteTempStoreMemory: boolean;
    sqliteQueryOnly: boolean;
    authTokensTableDefinitionCanonical: boolean;
    authTokensTableStorageCanonical: boolean;
    authTokensColumnsCanonical: boolean;
    authTokensUniquePlatformIndexCanonical: boolean;
    authTokensTriggersAbsent: boolean;
    authTokensForeignKeysAbsent: boolean;
    authTokensMutationStatementCompiles: boolean;
    sqliteIntegrityOk: boolean;
    shopifyRowCardinalityOne: boolean;
    sqliteClosed: boolean;
    descriptorInspectedAfterSnapshot: boolean;
    descriptorIdentityStableAfterSnapshot: boolean;
    snapshotStableAfterInspection: boolean;
    pathIdentityStableAfterSnapshot: boolean;
    sqliteSidecarsAbsentAfterSnapshot: boolean;
    descriptorClosed: boolean;
}>;
export type ShopifyDatabaseDiagnosticReport = Readonly<{
    status: 'database_diagnostic_verified' | 'database_diagnostic_failed_closed';
    stage: ShopifyDatabaseDiagnosticStage;
    checks: ShopifyDatabaseDiagnosticChecks;
    databaseWritesPerformed: 0;
    providerNetworkRequestsPerformed: 0;
    providerCredentialMutationsPerformed: 0;
    externalCommerceWritesPerformed: 0;
}>;
type DiagnosticFilesystem = Pick<typeof fs, 'lstatSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'>;
export type ShopifyDatabaseDiagnosticDependencies = Readonly<{
    filesystem?: DiagnosticFilesystem;
    openPrivateSnapshotReadOnly?: (snapshot: Buffer) => Sqlite;
}>;
type Environment = Readonly<Record<string, string | undefined>>;
/**
 * Inspects only the fixed Production legacy database. SQLite never receives a
 * filesystem path: it opens a bounded private copy read from the verified
 * O_RDONLY/O_NOFOLLOW descriptor, which remains open through SQLite close and
 * post-inspection identity/content/sidecar checks.
 */
export declare function diagnoseFixedProductionShopifyDatabase(environment?: Environment, dependencies?: ShopifyDatabaseDiagnosticDependencies): ShopifyDatabaseDiagnosticReport;
export {};
