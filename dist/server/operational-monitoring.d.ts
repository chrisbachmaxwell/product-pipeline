import { readConfiguredMigrationState, type MigrationStateApiProjection } from './migration-state-reader.js';
import { type LiveListingCatalogCacheStatus } from './live-listing-catalog-source.js';
type ShadowSummary = Readonly<{
    status: 'clean' | 'attention' | 'stale' | 'not-configured' | 'unavailable';
    arrivedAtUtc: string | null;
    observedCount: number;
    matchedCount: number;
    unmatchedCount: number;
    blockedCount: number;
}>;
export type OperationalMonitoringProjection = Readonly<{
    schemaVersion: 1;
    status: 'green' | 'attention' | 'critical';
    generatedAtUtc: string;
    readOnly: true;
    externalWritesPerformed: 0;
    providerReadsPerformed: 0;
    notificationsSent: 0;
    health: Readonly<{
        migrationStore: 'verified' | 'unavailable';
        auditChain: 'verified' | 'unavailable';
        catalogRead: 'current' | 'pending' | 'failed';
        shadowParity: ShadowSummary['status'];
    }>;
    counters: Readonly<{
        unresolvedJobs: number;
        failedJobs: number;
        reconciliationExceptions: number;
        shadowUnmatchedOrders: number;
        shadowBlockedOrders: number;
        catalogReadFailures: number;
    }>;
    dailyDigest: Readonly<{
        dateUtc: string | null;
        windowStartUtc: string | null;
        windowEndUtc: string | null;
        digest: `sha256:${string}`;
        writes: Readonly<{
            performed: number;
            succeeded: number;
            failed: number;
            unresolved: number;
            skipped: null;
            skippedStatus: 'not-journaled-until-g18';
        }>;
        reconciliations: Readonly<{
            passed: number;
            blocked: number;
            failed: number;
        }>;
        exceptions: Readonly<{
            info: number;
            warning: number;
            critical: number;
        }>;
        shadow: ShadowSummary;
        automationObserved: false;
    }>;
}>;
export type CachedOperationalHealthProjection = Readonly<{
    snapshotStatus: 'current' | 'stale' | 'unavailable';
    ageSeconds: number | null;
    status: OperationalMonitoringProjection['status'] | 'unavailable';
    health: OperationalMonitoringProjection['health'] | null;
    counters: OperationalMonitoringProjection['counters'] | null;
    dailyDigest: Readonly<{
        dateUtc: string | null;
        digest: `sha256:${string}`;
    }> | null;
    readOnly: true;
    externalWritesPerformed: 0;
    providerReadsPerformed: 0;
    notificationsSent: 0;
}>;
export declare function cacheOperationalMonitoringSnapshot(projection: OperationalMonitoringProjection, cachedAtEpochMs: number): void;
/** Cheap public-health projection. It never opens a database or filesystem report. */
export declare function getCachedOperationalHealth(nowEpochMs?: number): CachedOperationalHealthProjection;
/**
 * Reads only the aggregate summary from the newest operator-created shadow
 * report. Raw order IDs, SKUs, and observed rows are discarded and never
 * enter the returned projection or digest.
 */
export declare function readLatestShadowSummary(input: {
    directoryPath?: string;
    nowEpochMs: number;
}): ShadowSummary;
export declare function buildOperationalMonitoring(input: {
    migrationState: MigrationStateApiProjection;
    catalogStatus: LiveListingCatalogCacheStatus;
    shadowSummary: ShadowSummary;
    now: Date;
}): OperationalMonitoringProjection;
/** Request-time read-only assembly. No refresh or provider call is triggered. */
export declare function readOperationalMonitoring(options?: {
    environment?: NodeJS.ProcessEnv;
    now?: () => Date;
    readMigrationState?: typeof readConfiguredMigrationState;
    getCatalogStatus?: () => LiveListingCatalogCacheStatus;
    readShadowSummary?: typeof readLatestShadowSummary;
}): Promise<OperationalMonitoringProjection>;
export {};
