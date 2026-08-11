import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { type Digest, type IntegrationScope, type OwnershipOwner, type Responsibility } from './types.js';
export type MigrationStoreProjectionCounts = {
    externalIdentities: number;
    orderWatermarks: number;
    orderLinks: number;
    orderPages: number;
    orderObservations: number;
    orderObservationResolutions: number;
    cursorAdvances: number;
    ownershipVersions: number;
    idempotencyIntents: number;
    actionApprovals: number;
    approvalConsumptions: number;
    executionJobs: number;
    intentAttempts: number;
    attemptResolutions: number;
    reconciliationRuns: number;
    reconciliationExceptions: number;
    auditEvents: number;
};
export type MigrationStoreOwnershipProjection = {
    responsibility: Responsibility;
    configured: boolean;
    version: number | null;
    owner: OwnershipOwner | null;
    singleWriterVerified: boolean;
};
export type MigrationStoreProjection = {
    status: 'verified' | 'unavailable' | 'invalid';
    schemaVersion: typeof CURRENT_SCHEMA_VERSION | null;
    scope: {
        scopeKey: Digest;
        shopifyStoreDomain: string;
        ebayEnvironment: IntegrationScope['ebayEnvironment'];
        ebayMarketplaceId: string;
    } | null;
    access: {
        writable: false;
        readOnly: true;
        externallyWired: false;
        externalWritesSupported: false;
        historicalBackfillAllowed: false;
    };
    counts: MigrationStoreProjectionCounts | null;
    ownership: MigrationStoreOwnershipProjection[];
    orders: {
        watermarkUtc: string | null;
        watermarkEstablished: boolean;
        eligibleForCreation: 0;
        historicalBackfillAllowed: false;
    };
    audit: {
        valid: boolean;
        recordCount: number;
        headHash: string | null;
    };
    readiness: {
        canaryReady: false;
        cutoverReady: false;
        blockers: string[];
    };
};
/**
 * Returns a fixed, redacted, non-authorizing view of a migration store. This
 * facade never returns the underlying handle, database path, raw rows,
 * approval identifiers, or verification error details.
 */
export declare function inspectMigrationStoreReadOnly(input: {
    databasePath: string;
    expectedScope: IntegrationScope;
}): MigrationStoreProjection;
