/**
 * Trimmed 2026-09-10: this file once exported ~30 hooks for endpoints the
 * shadow server answers with 404/423. Only what the live pages call remains.
 */
declare class ApiClient {
    private baseUrl;
    private request;
    get<T>(endpoint: string): Promise<T>;
    post<T>(endpoint: string, data?: unknown): Promise<T>;
    put<T>(endpoint: string, data?: unknown): Promise<T>;
    delete<T>(endpoint: string, data?: unknown): Promise<T>;
}
export declare const apiClient: ApiClient;
export interface MigrationResponsibilityStatus {
    responsibility: string;
    owner: string;
    productPipelineAccess: 'disabled' | 'read-only';
    writesAllowed?: boolean;
    reason?: string;
}
export interface MigrationException {
    id?: string;
    code?: string;
    severity?: 'info' | 'warning' | 'critical';
    message?: string;
    detail?: string;
    setting?: string;
    observed?: unknown;
    expected?: unknown;
    effectiveBehavior?: string;
    [key: string]: unknown;
}
export interface MigrationReconciliationSummary {
    scope?: string;
    /** Legacy response-generation fields; never treat these as source observation time. */
    observedAt?: string;
    generatedAt?: string;
    counts?: Record<string, number>;
    exceptions?: MigrationException[];
    audit?: {
        valid?: boolean;
        recordCount?: number;
        headHash?: string | null;
        verifiedAt?: string | null;
        availableInWebRuntime?: boolean;
        note?: string;
    };
    [key: string]: unknown;
}
export type MigrationEvidenceClass = 'authoritative-direct-read' | 'platform-generated-export' | 'operator-attested-browser-observation' | 'local-ledger-observation' | 'unavailable' | string;
/**
 * Defensive projection of one redacted evidence source. The UI deliberately
 * reads only the explicitly safe fields below; arbitrary payload fields are
 * never rendered.
 */
export interface MigrationEvidenceSourceProjection {
    sourceId?: string;
    source?: string;
    system?: string;
    label?: string;
    evidenceClass?: MigrationEvidenceClass;
    acquisition?: string;
    status?: string;
    capturedAtUtc?: string | null;
    capturedAt?: string | null;
    baselineDate?: string | null;
    asOfUtc?: string | null;
    asOf?: string | null;
    completeness?: unknown;
    freshness?: unknown;
    recordCount?: number;
    records?: number;
    counts?: Record<string, number>;
    coverage?: {
        status?: string;
        complete?: boolean;
        records?: number;
        pages?: number;
        [key: string]: unknown;
    };
    provenance?: {
        availability?: string;
        method?: string;
        attestation?: string;
        capturedAtUtc?: string | null;
        asOfStartUtc?: string | null;
        asOfEndUtc?: string | null;
        paginationComplete?: boolean;
        recordCount?: number | null;
        reportedTotal?: number | null;
        datasetDigest?: string | null;
        [key: string]: unknown;
    };
    digest?: string | null;
    normalizedPayloadDigest?: string | null;
    evidenceDigest?: string | null;
    limitations?: string[];
    [key: string]: unknown;
}
export interface MigrationEvidenceProjection {
    sources?: MigrationEvidenceSourceProjection[] | Record<string, MigrationEvidenceSourceProjection | undefined>;
    integrity?: {
        status?: string;
        digest?: string | null;
        signatureVerified?: boolean;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export interface MigrationResponsibilityEvidenceProjection {
    responsibility?: string;
    evidenceStatus?: string;
    status?: string;
    observedOwner?: string | null;
    sourceId?: string | null;
    evidenceClass?: MigrationEvidenceClass;
    capturedAtUtc?: string | null;
    asOfUtc?: string | null;
    baselineDate?: string | null;
    summary?: string;
    [key: string]: unknown;
}
export interface DurableMigrationStateScope {
    scopeKey?: string;
    shopifyStoreDomain?: string;
    ebayEnvironment?: string;
    ebayMarketplaceId?: string;
}
export interface DurableMigrationStateProjection {
    status?: 'verified' | 'unavailable' | 'invalid' | 'not-configured' | string;
    schemaVersion?: number | null;
    scope?: DurableMigrationStateScope | null;
    access?: {
        writable?: boolean;
        readOnly?: boolean;
        externallyWired?: boolean;
        externalWritesSupported?: boolean;
        historicalBackfillAllowed?: boolean;
    };
    counts?: Record<string, number> | null;
    ownership?: Array<{
        responsibility?: string;
        owner?: string | null;
        version?: number | null;
        [key: string]: unknown;
    }>;
    orders?: {
        watermarkUtc?: string | null;
        watermarkEstablished?: boolean;
        eligibleForCreation?: number;
        orderCreationEligible?: boolean;
        [key: string]: unknown;
    };
    audit?: {
        valid?: boolean;
        recordCount?: number;
        headHash?: string | null;
        [key: string]: unknown;
    };
    readiness?: {
        canaryReady?: boolean;
        cutoverReady?: boolean;
        blockers?: string[];
        [key: string]: unknown;
    };
    errorCode?: string;
}
export interface MigrationStatusResponse {
    phase?: string;
    effectiveMode?: string;
    externalWritesAllowed?: boolean;
    historicalBackfillAllowed?: boolean;
    cutoverWatermarkUtc?: string | null;
    remoteVerification?: string;
    /** HTTP response time only. It is not evidence capture/as-of time. */
    servedAt?: string;
    /** Legacy field retained for compatibility; the UI must not label it as observation time. */
    observedAt?: string;
    responsibilities?: MigrationResponsibilityStatus[];
    quarantine?: {
        enabled: boolean;
        channels: string[];
    };
    reconciliation?: MigrationReconciliationSummary;
    evidence?: MigrationEvidenceProjection | MigrationEvidenceSourceProjection[];
    responsibilityEvidence?: MigrationResponsibilityEvidenceProjection[] | Record<string, MigrationResponsibilityEvidenceProjection | undefined>;
    /** Local durable migration-control state only; never platform truth or live parity proof. */
    migrationState?: DurableMigrationStateProjection;
}
/** Single source for the operator-facing migration and quarantine state. */
export declare const useMigrationStatus: () => import("@tanstack/react-query").UseQueryResult<MigrationStatusResponse, Error>;
export interface OperationalMonitoringResponse {
    schemaVersion: 1;
    status: 'green' | 'attention' | 'critical';
    generatedAtUtc: string;
    readOnly: true;
    externalWritesPerformed: 0;
    providerReadsPerformed: 0;
    notificationsSent: 0;
    health: {
        migrationStore: 'verified' | 'unavailable';
        auditChain: 'verified' | 'unavailable';
        catalogRead: 'current' | 'pending' | 'failed';
        shadowParity: 'clean' | 'attention' | 'stale' | 'not-configured' | 'unavailable';
    };
    counters: {
        unresolvedJobs: number;
        failedJobs: number;
        reconciliationExceptions: number;
        shadowUnmatchedOrders: number;
        shadowBlockedOrders: number;
        catalogReadFailures: number;
    };
    dailyDigest: {
        dateUtc: string | null;
        windowStartUtc: string | null;
        windowEndUtc: string | null;
        digest: string;
        writes: {
            performed: number;
            succeeded: number;
            failed: number;
            unresolved: number;
            skipped: null;
            skippedStatus: 'not-journaled-until-g18';
        };
        reconciliations: {
            passed: number;
            blocked: number;
            failed: number;
        };
        exceptions: {
            info: number;
            warning: number;
            critical: number;
        };
        shadow: {
            status: string;
            arrivedAtUtc: string | null;
            observedCount: number;
            matchedCount: number;
            unmatchedCount: number;
            blockedCount: number;
        };
        automationObserved: false;
    };
}
export declare const useOperationalMonitoring: () => import("@tanstack/react-query").UseQueryResult<OperationalMonitoringResponse, Error>;
/** One plain-English line per recent sync event (read-only). */
export interface ActivityEvent {
    atUtc: string;
    kind: 'order_imported' | 'listing_ended' | 'listing_relisted' | 'quantity_updated' | 'price_updated' | 'tracking_sent' | 'listing_created';
    label: string;
    sku?: string;
    ebayOrderId?: string;
    listingId?: string;
}
export interface ActivityResponse {
    schemaVersion: 1;
    available?: boolean;
    events: ActivityEvent[];
    windowHours: number;
    generatedAtUtc: string;
    externalWritesPerformed: 0;
}
export declare const useActivity: () => import("@tanstack/react-query").UseQueryResult<ActivityResponse, Error>;
export interface PriceCheckResponse {
    schemaVersion: 1;
    query: string;
    median: string | null;
    currency: string | null;
    sampleSize: number;
    comps: Array<{
        title: string;
        price: {
            value: string;
            currency: string;
        };
        condition: string;
    }>;
    externalWritesPerformed: 0;
}
export declare const usePriceCheck: (id: string | undefined, enabled: boolean) => import("@tanstack/react-query").UseQueryResult<PriceCheckResponse, Error>;
export {};
