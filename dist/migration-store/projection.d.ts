import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { type Digest, type IntegrationScope, type OwnershipOwner, type OperationalStoreMonitoring, type Responsibility } from './types.js';
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
    listingReviseObservations: number;
    targetEffectObservations: number;
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
    monitoring: OperationalStoreMonitoring | null;
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
    nowUtc?: string;
}): MigrationStoreProjection;
export type UnresolvedListingCreateProjection = Readonly<{
    jobId: string;
    attemptId: string;
    intentKey: string;
    evidenceDigest: string;
}>;
/**
 * READ-ONLY lookup for the operator's publish-recovery retry: the most
 * recent listing-create job targeting the SKU whose attempt has no recorded
 * resolution. Same database-path discipline as inspectMigrationStoreReadOnly;
 * opens read-only, runs one SELECT, writes nothing. The identifiers returned
 * are re-verified by the recovery ceremonies before any provider action.
 */
export declare function findUnresolvedListingCreateReadOnly(input: {
    databasePath: string;
    sku: string;
}): UnresolvedListingCreateProjection | null;
export type IncidentLedgerSignals = Readonly<{
    /**
     * The oldest eBay order observation with no resolution. The poll cursor
     * is strictly ordered, so ONE stuck order freezes every order behind it
     * (L77) — this is the single highest-severity signal in the system.
     */
    oldestUnresolvedOrder: {
        orderId: string;
        observedAtUtc: string;
    } | null;
    /** Unresolved listing-create jobs (no attempt resolution yet). */
    unresolvedCreates: ReadonlyArray<{
        sku: string;
        jobId: string;
        reservedAtUtc: string;
    }>;
    /**
     * SKUs whose recent inventory dispatches keep closing confirmed_missing —
     * the L75 signature of a provider-rejected sell-out end. Grouped since
     * `sinceUtc`, only groups of three or more.
     */
    repeatedEndFailures: ReadonlyArray<{
        sku: string;
        count: number;
        lastAtUtc: string;
    }>;
}>;
/**
 * READ-ONLY incident signals for the watchdog (L75): the ledger records
 * every failure truthfully; this surfaces the shapes that demand a human.
 * Same database-path discipline as the other read-only projections.
 */
export declare function readIncidentLedgerSignalsReadOnly(input: {
    databasePath: string;
    sinceUtc: string;
}): IncidentLedgerSignals | null;
