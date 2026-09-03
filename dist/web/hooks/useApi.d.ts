export interface StatusResponse {
    status: string;
    products: {
        mapped: number;
    };
    orders: {
        imported: number;
    };
    lastSyncs: Array<Record<string, unknown>>;
    settings: Record<string, string>;
    uptime: number;
    inventory?: {
        synced?: number;
    };
    revenue?: {
        total?: number;
        today?: number;
    };
    shopifyConnected?: boolean;
    ebayConnected?: boolean;
}
export interface LogEntry {
    id: number | string;
    source?: string;
    topic?: string;
    status?: string;
    created_at?: string;
    createdAt?: string;
    payload?: string;
    message?: string;
    detail?: string;
}
export interface ListingItem {
    id: number | string;
    shopify_product_id?: string;
    ebay_listing_id?: string;
    status?: string;
    price?: number;
    last_synced?: string;
    updated_at?: string;
    created_at?: string;
    shopifyProductId?: string;
    ebayListingId?: string;
    lastSynced?: string;
    updatedAt?: string;
}
export interface OrderItem {
    id: number | string;
    ebay_order_id?: string;
    shopify_order_id?: string;
    status?: string;
    total?: number;
    ebay_created_at?: string;
    created_at?: string;
    shopifyOrderId?: string;
    ebayOrderId?: string;
    createdAt?: string;
}
export interface AttributeMapping {
    category: string;
    field_name: string;
    mapping_type: 'shopify_field' | 'constant' | 'formula' | 'edit_in_grid';
    source_value: string | null;
    target_value: string | null;
    variation_mapping: string | null;
    is_enabled: boolean;
    display_order: number;
}
export interface MappingsResponse {
    sales: AttributeMapping[];
    listing: AttributeMapping[];
    payment: AttributeMapping[];
    shipping: AttributeMapping[];
}
export interface ListingsResponse {
    data: ListingItem[];
    total: number;
    limit: number;
    offset: number;
}
export interface OrdersResponse {
    data: OrderItem[];
    total: number;
    limit: number;
    offset: number;
}
declare class ApiClient {
    private baseUrl;
    private request;
    get<T>(endpoint: string): Promise<T>;
    post<T>(endpoint: string, data?: unknown): Promise<T>;
    put<T>(endpoint: string, data?: unknown): Promise<T>;
    delete<T>(endpoint: string, data?: unknown): Promise<T>;
}
export declare const apiClient: ApiClient;
export declare const useStatus: () => import("@tanstack/react-query").UseQueryResult<StatusResponse, Error>;
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
export declare const useListings: (params?: {
    limit?: number;
    offset?: number;
    search?: string;
    status?: string;
}) => import("@tanstack/react-query").UseQueryResult<ListingsResponse, Error>;
export declare const useOrders: (params?: {
    limit?: number;
    offset?: number;
    search?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
}) => import("@tanstack/react-query").UseQueryResult<OrdersResponse, Error>;
export declare const useMappings: () => import("@tanstack/react-query").UseQueryResult<MappingsResponse, Error>;
export declare const useSettings: () => import("@tanstack/react-query").UseQueryResult<Record<string, string>, Error>;
export declare const useLogs: (limit?: number) => import("@tanstack/react-query").UseQueryResult<{
    data: LogEntry[];
}, Error>;
export interface ListingHealthData {
    totalActive: number;
    totalEnded: number;
    ageBuckets: Record<'0-7d' | '7-14d' | '14-30d' | '30d+', number>;
    averageDaysListed: number;
    priceDropped: number;
    republished: number;
    promoted: number;
    revenue: number;
}
export declare const useListingHealth: () => import("@tanstack/react-query").UseQueryResult<ListingHealthData, Error>;
export declare const useUpdateMapping: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, {
    category: string;
    fieldName: string;
    updates: Partial<AttributeMapping>;
}, unknown>;
export declare const useBulkUpdateMappings: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, AttributeMapping[], unknown>;
export declare const useProductOverrides: (shopifyProductId: string | undefined) => import("@tanstack/react-query").UseQueryResult<{
    data: Array<{
        category: string;
        field_name: string;
        value: string | null;
    }>;
}, Error>;
export declare const useSaveProductOverrides: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, {
    shopifyProductId: string;
    overrides: Array<{
        category: string;
        field_name: string;
        value: string;
    }>;
}, unknown>;
export declare const useSyncProducts: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, string[] | undefined, unknown>;
export declare const useSyncOrders: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
export declare const useSyncInventory: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
export declare const useUpdateSettings: () => import("@tanstack/react-query").UseMutationResult<unknown, Error, Record<string, string | number | boolean>, unknown>;
export interface EbayOrderItem {
    id: number;
    ebay_order_id: string;
    legacy_order_id: string | null;
    buyer_username: string | null;
    order_status: string | null;
    fulfillment_status: string | null;
    payment_status: string | null;
    total_amount: number | null;
    currency: string;
    item_count: number | null;
    line_items_json: string | null;
    shipping_address_json: string | null;
    ebay_created_at: string | null;
    ebay_modified_at: string | null;
    synced_to_shopify: number;
    shopify_order_id: string | null;
    imported_at: number;
}
export interface EbayOrdersResponse {
    data: EbayOrderItem[];
    total: number;
    limit: number;
    offset: number;
}
export interface EbayOrderStats {
    total: number;
    synced: number;
    unsynced: number;
    lastImportedAt: number | null;
    byFulfillmentStatus: Record<string, number>;
    byPaymentStatus: Record<string, number>;
}
export declare const useEbayOrders: (params?: {
    limit?: number;
    offset?: number;
    search?: string;
    fulfillmentStatus?: string;
    paymentStatus?: string;
    synced?: string;
}) => import("@tanstack/react-query").UseQueryResult<EbayOrdersResponse, Error>;
export declare const useEbayOrderStats: () => import("@tanstack/react-query").UseQueryResult<EbayOrderStats, Error>;
export declare const useImportEbayOrders: () => import("@tanstack/react-query").UseMutationResult<{
    success: boolean;
    fetched: number;
    upserted: number;
}, Error, {
    days?: number;
    limit?: number;
    fulfillmentStatus?: string;
} | undefined, unknown>;
export interface EbayOrderImportStatus {
    enabled: boolean;
    cutoff: string | null;
    autoSyncEnabled: boolean;
}
export declare const useEbayOrderImportStatus: () => import("@tanstack/react-query").UseQueryResult<EbayOrderImportStatus, Error>;
export declare const useEnableEbayOrderImport: () => import("@tanstack/react-query").UseMutationResult<{
    ok: boolean;
    enabled: boolean;
    cutoff: string;
}, Error, void, unknown>;
export declare const useDisableEbayOrderImport: () => import("@tanstack/react-query").UseMutationResult<{
    ok: boolean;
    enabled: boolean;
}, Error, void, unknown>;
export declare const useProductNotes: (productId: string | undefined) => import("@tanstack/react-query").UseQueryResult<{
    ok: boolean;
    notes: string;
}, Error>;
export declare const useSaveProductNotes: () => import("@tanstack/react-query").UseMutationResult<{
    ok: boolean;
}, Error, {
    productId: string;
    notes: string;
}, unknown>;
export declare const useEbayAuthStatus: () => import("@tanstack/react-query").UseQueryResult<{
    connected: boolean;
    tokenExpires: string | undefined;
    hasRefreshToken: boolean | undefined;
}, Error>;
export interface TimConditionResponse {
    match: {
        timItemId: number;
        condition: string | null;
        conditionNotes: string | null;
        graderNotes: string | null;
        serialNumber: string | null;
        brand: string | null;
        productName: string;
        sku: string;
        itemStatus: string;
    } | null;
    matchedSku?: string;
    reason?: string;
}
export declare const useTimCondition: (productId: string | undefined) => import("@tanstack/react-query").UseQueryResult<TimConditionResponse, Error>;
interface TagProductResponse {
    success: boolean;
    productId: string;
    condition?: string;
    previousTag?: string;
    newTag?: string;
    skipped?: boolean;
    error?: string;
}
export declare const useTagProductCondition: (productId: string | undefined) => import("@tanstack/react-query").UseMutationResult<TagProductResponse, Error, void, unknown>;
export interface PipelineTriggerResult {
    success: boolean;
    error?: string;
    product?: {
        id: string;
        title: string;
        status: string;
    };
    photos?: {
        found: boolean;
        count: number;
        presetName: string;
        folderName: string;
    };
    draft?: {
        id: number;
    };
    description?: {
        generated: boolean;
        preview?: string;
    };
    condition?: {
        tagApplied: boolean;
        tag?: string;
    };
    pipelineJobId?: string;
}
export interface DriveSearchResult {
    success: boolean;
    error?: string;
    product?: {
        id: string;
        title: string;
    };
    drive?: {
        folderPath: string;
        presetName: string;
        folderName: string;
        imageCount: number;
    } | null;
}
export declare const useRunPipeline: (productId: string | undefined) => import("@tanstack/react-query").UseMutationResult<PipelineTriggerResult, Error, void, unknown>;
export declare const useDriveSearch: (productId: string | undefined) => import("@tanstack/react-query").UseQueryResult<DriveSearchResult, Error>;
export {};
