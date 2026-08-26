import Database from 'better-sqlite3';
import { type AttemptResolution, type AuditContext, type AuditVerification, type Digest, type ExternalIdentity, type ExternalIdentityInput, type IntegrationScope, type IntentAction, type OwnershipOwner, type OperationalStoreMonitoring, type ListingReviseObservationInput, type TargetEffectObservationInput, type ReconciliationExceptionInput, type ReconciliationMode, type ReconciliationStatus, type Responsibility } from './types.js';
/** The seven writer responsibilities enabled through the schema-v4 fulfillment slice. */
export declare const PRODUCTION_ENABLED_RESPONSIBILITIES: readonly Responsibility[];
type Sqlite = InstanceType<typeof Database>;
type IntentRow = {
    intent_key: string;
    responsibility: Responsibility;
    action: IntentAction;
    source_identity_key: string;
    target_identity_key: string | null;
    approval_target_identity_key: string;
    desired_state_digest: string;
};
export type MigrationStoreErrorCode = 'INVALID_INPUT' | 'PATH_REJECTED' | 'SCHEMA_MISMATCH' | 'ACCOUNT_DRIFT' | 'CONFLICT' | 'NOT_FOUND' | 'WATERMARK_REQUIRED' | 'OWNERSHIP_DENIED' | 'APPROVAL_DENIED' | 'READ_ONLY';
export declare class MigrationStoreError extends Error {
    readonly code: MigrationStoreErrorCode;
    constructor(code: MigrationStoreErrorCode, message: string);
}
export declare function sha256Digest(value: unknown): Digest;
export declare function deriveScopeKey(input: IntegrationScope): Digest;
export declare function createMigrationStore(input: {
    databasePath: string;
    scope: IntegrationScope;
    createdAtUtc: string;
}): MigrationStore;
export declare function openMigrationStore(input: {
    databasePath: string;
    expectedScope: IntegrationScope;
}): MigrationStore;
/**
 * Explicit operator-run schema upgrade. Runtime code never calls this: a
 * store at an older verified schema version fails every ordinary open until
 * an operator deliberately upgrades it. The stored version is only trusted
 * after its complete migration history and catalog digest verify, and the
 * pending migrations apply inside one immediate transaction followed by a
 * full current-version verification.
 */
export declare function upgradeMigrationStore(input: {
    databasePath: string;
    expectedScope: IntegrationScope;
    appliedAtUtc: string;
}): {
    fromVersion: number;
    toVersion: number;
};
export declare function openMigrationStoreReadOnly(input: {
    databasePath: string;
    expectedScope: IntegrationScope;
}): MigrationStore;
export declare function deriveExternalIdentityKey(input: ExternalIdentityInput): Digest;
export declare function deriveIdempotencyKey(input: {
    scopeKey: string;
    action: IntentAction;
    sourceIdentityKey: string;
    targetIdentityKey?: string | null;
    desiredStateDigest: string;
}): Digest;
declare class MigrationStoreImpl {
    private readonly database;
    readonly databasePath: string;
    readonly scope: IntegrationScope;
    readonly scopeKey: Digest;
    readonly writable: boolean;
    readonly externallyWired: false;
    readonly externalWritesSupported: false;
    private closed;
    constructor(database: Sqlite, databasePath: string, scope: IntegrationScope & {
        scopeKey: Digest;
    }, writable: boolean);
    close(): void;
    private assertOpen;
    private immediate;
    registerIdentity(input: ExternalIdentityInput, audit: AuditContext): ExternalIdentity;
    getIdentity(identityKey: string): ExternalIdentity | null;
    establishOrderWatermark(input: {
        boundaryExclusiveUtc: string;
        ownershipVersion: number;
        ownershipEvidenceDigest: string;
        acceptedEvidenceDigest: string;
        createdAtUtc: string;
        audit: AuditContext;
    }): {
        watermarkKey: Digest;
        eventField: 'creationDate';
        boundaryExclusiveUtc: string;
    };
    getOrderWatermark(): {
        eventField: 'creationDate';
        boundaryMode: 'exclusive';
        boundaryExclusiveUtc: string;
        boundaryExclusiveEpochMs: number;
    } | null;
    isOrderEligible(sourceCreationDateUtc: string): boolean;
    recordOwnershipVersion(input: {
        responsibility: Responsibility;
        version: number;
        owner: OwnershipOwner;
        singleWriterVerified: boolean;
        evidenceDigest: string;
        effectiveAtUtc: string;
        recordedAtUtc: string;
        audit: AuditContext;
    }): string;
    getCurrentOwnership(responsibility: Responsibility): {
        version: number;
        owner: OwnershipOwner;
        singleWriterVerified: boolean;
        evidenceDigest: Digest;
    } | null;
    createIdempotencyIntent(input: {
        action: IntentAction;
        sourceIdentityKey: string;
        targetIdentityKey?: string | null;
        desiredStateDigest: string;
        createdAtUtc: string;
        audit: AuditContext;
    }): Digest;
    getIntent(intentKey: string): IntentRow | null;
    hasExactOrderLink(input: {
        shopifyOrderIdentityKey: string;
        ebayOrderIdentityKey: string;
    }): boolean;
    getJobStatus(jobIdInput: string): {
        jobId: string;
        intentKey: Digest;
        responsibility: Responsibility;
        ownershipVersion: number;
        state: string;
        attemptOutcome: 'outcome_unknown' | null;
    } | null;
    issueActionApproval(input: {
        approvalToken: string;
        intentKey: string;
        responsibility: Responsibility;
        targetIdentityKey: string;
        ownershipVersion: number;
        issuedAtUtc: string;
        expiresAtUtc: string;
        evidenceDigest: string;
        audit: AuditContext;
    }): Digest;
    reserveExecutionJob(input: {
        jobId: string;
        approvalToken: string;
        intentKey: string;
        responsibility: Responsibility;
        targetIdentityKey: string;
        ownershipVersion: number;
        approvalEvidenceDigest: string;
        orderObservationId?: string | null;
        reservedAtUtc: string;
        evidenceDigest: string;
        audit: AuditContext;
    }): string;
    markDispatchingOutcomeUnknown(input: {
        jobId: string;
        attemptId: string;
        approvalToken: string;
        approvalEvidenceDigest: string;
        occurredAtUtc: string;
        evidenceDigest: string;
        audit: AuditContext;
    }): string;
    requirePostDispatchReconciliation(input: {
        jobId: string;
        attemptId: string;
        occurredAtUtc: string;
        evidenceDigest: string;
        audit: AuditContext;
    }): void;
    resolveUnknownAttempt(input: {
        jobId: string;
        attemptId: string;
        resolution: Extract<AttemptResolution, 'resolved_existing' | 'confirmed_missing'>;
        reconciliationRunId: string;
        reconciliationResultDigest: string;
        shopifyOrderIdentityKey?: string | null;
        orderLinkId?: string | null;
        reconciledAtUtc: string;
        audit: AuditContext;
    }): void;
    linkObservedExistingOrder(input: {
        linkId: string;
        ebayOrderIdentityKey: string;
        shopifyOrderIdentityKey: string;
        evidenceDigest: string;
        linkedAtUtc: string;
        audit: AuditContext;
    }): string;
    recordOrderPage(input: {
        pageId: string;
        cursorBefore: string | null;
        cursorAfter: string;
        observedAtUtc: string;
        snapshotDigest: string;
        orders: Array<{
            observationId: string;
            ebayOrderIdentityKey: string;
            sourceCreationDateUtc: string;
        }>;
        audit: AuditContext;
    }): string;
    resolveOrderObservation(input: {
        resolutionId: string;
        observationId: string;
        disposition: 'excluded_by_watermark' | 'linked_existing';
        referenceKey?: string | null;
        evidenceDigest: string;
        resolvedAtUtc: string;
        audit: AuditContext;
    }): string;
    advanceOrderCursor(input: {
        cursorAdvanceId: string;
        pageId: string;
        ordinal: number;
        cursorValue: string;
        advancedAtUtc: string;
        audit: AuditContext;
    }): number;
    recordReconciliationRun(input: {
        runId: string;
        responsibility: Responsibility;
        targetIdentityKey: string;
        mode: ReconciliationMode;
        status: ReconciliationStatus;
        sourceSnapshotDigest: string;
        targetSnapshotDigest: string;
        resultDigest: string;
        authoritative: boolean;
        authorityEvidenceDigest: string;
        externalWritesObserved: number;
        startedAtUtc: string;
        completedAtUtc: string;
        exceptions: ReconciliationExceptionInput[];
        listingReviseObservation?: ListingReviseObservationInput | null;
        targetEffectObservation?: TargetEffectObservationInput | null;
        audit: AuditContext;
    }): string;
    verifyAuditChain(): AuditVerification;
    getCounts(): Record<string, number>;
    /**
     * Aggregate-only operational monitoring. It returns no identity, job,
     * attempt, exception code, digest, or provider/customer value. The window
     * is the previous completed UTC day. Every write bucket uses the same
     * dispatch-attempt cohort. Only resolutions recorded before the cohort
     * window closes classify an attempt as succeeded/failed; later resolution
     * leaves it truthfully unresolved in this immutable daily view.
     */
    getOperationalMonitoring(nowUtc: string): OperationalStoreMonitoring;
    /**
     * Counts every execution-authority row (intent, approval, consumption, job,
     * event, attempt, resolution) whose responsibility is not the given one.
     * Kept as a convenience wrapper over the set-based counter.
     */
    countExecutionRowsOutsideResponsibility(responsibility: Responsibility): number;
    /**
     * Counts every execution-authority row (intent, approval, consumption, job,
     * event, attempt, resolution) whose responsibility is outside the given
     * set. The read-only projection uses this to prove a production store's
     * execution state is scoped exclusively to the reviewed enabled slice.
     */
    countExecutionRowsOutsideResponsibilities(responsibilities: readonly Responsibility[]): number;
    private assertShopifyScope;
    private assertEbayScope;
    private validateShopifyGid;
    private requireIdentity;
    private requireIntent;
    private requireJob;
    private assertActionIdentityShape;
    private insertJobEvent;
    private insertAttemptResolution;
}
export type MigrationStore = MigrationStoreImpl;
export {};
