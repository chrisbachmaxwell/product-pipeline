import { useQuery } from '@tanstack/react-query';

/**
 * Trimmed 2026-09-10: this file once exported ~30 hooks for endpoints the
 * shadow server answers with 404/423. Only what the live pages call remains.
 */

class ApiClient {
  private baseUrl = '/api';

  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    const text = await response.text();
    let payload: unknown = undefined;

    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const body = typeof payload === 'object' && payload !== null
        ? payload as { error?: string; code?: string; field?: string }
        : null;
      const base = body?.error
        ?? (typeof payload === 'string' ? payload : `Request failed with status ${response.status}`);
      // Machine-readable suffix so callers can map precise guidance:
      // "... (CREATE_REQUIRED_FIELD_MISSING: return_policy)".
      const detail = typeof body?.code === 'string'
        ? ` (${body.code}${typeof body.field === 'string' ? `: ${body.field}` : ''})`
        : '';
      throw new Error(`${base}${detail}`);
    }

    return payload as T;
  }

  get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  delete<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
  }
}

export const apiClient = new ApiClient();

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

export type MigrationEvidenceClass =
  | 'authoritative-direct-read'
  | 'platform-generated-export'
  | 'operator-attested-browser-observation'
  | 'local-ledger-observation'
  | 'unavailable'
  | string;

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
  sources?:
    | MigrationEvidenceSourceProjection[]
    | Record<string, MigrationEvidenceSourceProjection | undefined>;
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
  responsibilityEvidence?:
    | MigrationResponsibilityEvidenceProjection[]
    | Record<string, MigrationResponsibilityEvidenceProjection | undefined>;
  /** Local durable migration-control state only; never platform truth or live parity proof. */
  migrationState?: DurableMigrationStateProjection;
}


/** Single source for the operator-facing migration and quarantine state. */
export const useMigrationStatus = () =>
  useQuery({
    queryKey: ['migration-status'],
    queryFn: () => apiClient.get<MigrationStatusResponse>('/migration/status'),
    refetchInterval: 15_000,
  });

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
    reconciliations: { passed: number; blocked: number; failed: number };
    exceptions: { info: number; warning: number; critical: number };
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

export const useOperationalMonitoring = () =>
  useQuery({
    queryKey: ['operational-monitoring'],
    queryFn: () => apiClient.get<OperationalMonitoringResponse>('/monitoring/digest'),
    refetchInterval: 60_000,
  });

/** One plain-English line per recent sync event (read-only). */
export interface ActivityEvent {
  atUtc: string;
  kind: 'order_imported' | 'listing_ended' | 'listing_relisted' | 'quantity_updated'
    | 'price_updated' | 'tracking_sent' | 'listing_created';
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

export const useActivity = () =>
  useQuery({
    queryKey: ['activity-feed'],
    queryFn: () => apiClient.get<ActivityResponse>('/activity'),
    refetchInterval: 60_000,
    retry: false,
  });

export interface EbayQuotaResponse {
  available: boolean;
  checkedAtUtc: string | null;
  aggregateCount: number | null;
  aggregateLimit: number | null;
  usedFraction: number | null;
  resetAtUtc: string | null;
  topCalls: Array<{ name: string; count: number }>;
  warning: boolean;
}

export const useEbayQuota = () =>
  useQuery({
    queryKey: ['ebay-quota'],
    queryFn: () => apiClient.get<EbayQuotaResponse>('/ebay-quota'),
    refetchInterval: 30 * 60_000,
    staleTime: 25 * 60_000,
    retry: false,
  });

export interface EbayCategoryAspect {
  name: string;
  required: boolean;
  mode: 'FREE_TEXT' | 'SELECTION_ONLY';
  values: string[];
}

export interface EbayCategoryAspectsResponse {
  available: boolean;
  categoryId: string;
  aspects: EbayCategoryAspect[];
}

/** The category's item specifics (required first); cached a day per id. */
export const useEbayCategoryAspects = (categoryId: string | null) =>
  useQuery({
    queryKey: ['ebay-category-aspects', categoryId ?? ''],
    queryFn: () => apiClient.get<EbayCategoryAspectsResponse>(
      `/ebay-category-aspects?id=${encodeURIComponent(categoryId ?? '')}`,
    ),
    enabled: categoryId !== null && /^\d+$/.test(categoryId),
    staleTime: 24 * 60 * 60_000,
    retry: false,
  });

export interface PriceCheckResponse {
  schemaVersion: 1;
  query: string;
  median: string | null;
  currency: string | null;
  sampleSize: number;
  comps: Array<{ title: string; price: { value: string; currency: string }; condition: string }>;
  externalWritesPerformed: 0;
}

export const usePriceCheck = (id: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['price-check', id],
    queryFn: () => apiClient.get<PriceCheckResponse>(`/price-check?id=${encodeURIComponent(id ?? '')}`),
    enabled: enabled && Boolean(id),
    staleTime: 60 * 60_000,
    retry: false,
  });
