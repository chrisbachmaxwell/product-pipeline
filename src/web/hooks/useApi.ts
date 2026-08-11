import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAppStore } from '../store';

export interface StatusResponse {
  status: string;
  products: { mapped: number };
  orders: { imported: number };
  lastSyncs: Array<Record<string, unknown>>;
  settings: Record<string, string>;
  uptime: number;
  inventory?: { synced?: number };
  revenue?: { total?: number; today?: number };
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
      const message =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? String((payload as { error?: string }).error)
          : typeof payload === 'string'
            ? payload
            : `Request failed with status ${response.status}`;
      throw new Error(message);
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

export const useStatus = () => {
  const { setConnectionStatus } = useAppStore();

  const query = useQuery({
    queryKey: ['status'],
    queryFn: () => apiClient.get<StatusResponse>('/status'),
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (!query.data) return;
    if (typeof query.data.shopifyConnected === 'boolean') {
      setConnectionStatus('shopify', query.data.shopifyConnected);
    }
    if (typeof query.data.ebayConnected === 'boolean') {
      setConnectionStatus('ebay', query.data.ebayConnected);
    }
  }, [query.data, setConnectionStatus]);

  return query;
};

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
}

/** Single source for the operator-facing migration and quarantine state. */
export const useMigrationStatus = () =>
  useQuery({
    queryKey: ['migration-status'],
    queryFn: () => apiClient.get<MigrationStatusResponse>('/migration/status'),
    refetchInterval: 15_000,
  });

export const useListings = (params?: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
}) => {
  return useQuery({
    queryKey: ['listings', params],
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.offset) searchParams.set('offset', String(params.offset));
      if (params?.search) searchParams.set('search', params.search);
      if (params?.status) searchParams.set('status', params.status);
      const query = searchParams.toString();
      return apiClient.get<ListingsResponse>(`/listings${query ? `?${query}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });
};

export const useOrders = (params?: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}) => {
  return useQuery({
    queryKey: ['orders', params],
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.offset) searchParams.set('offset', String(params.offset));
      if (params?.search) searchParams.set('search', params.search);
      if (params?.status) searchParams.set('status', params.status);
      if (params?.startDate) searchParams.set('startDate', params.startDate);
      if (params?.endDate) searchParams.set('endDate', params.endDate);
      const query = searchParams.toString();
      return apiClient.get<OrdersResponse>(`/orders${query ? `?${query}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });
};

export const useMappings = () => {
  return useQuery({
    queryKey: ['mappings'],
    queryFn: () => apiClient.get<MappingsResponse>('/mappings'),
    staleTime: 60000,
  });
};

export const useSettings = () => {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => apiClient.get<Record<string, string>>('/settings'),
    staleTime: 60000,
  });
};

export const useLogs = (limit = 100) => {
  return useQuery({
    queryKey: ['logs', limit],
    queryFn: () => apiClient.get<{ data: LogEntry[] }>(`/logs?limit=${limit}`),
    refetchInterval: 20000,
  });
};

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

export const useListingHealth = () => {
  return useQuery({
    queryKey: ['listings-health'],
    queryFn: () => apiClient.get<ListingHealthData>('/listings/health'),
    staleTime: 60000,
  });
};

export const useUpdateMapping = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: (variables: {
      category: string;
      fieldName: string;
      updates: Partial<AttributeMapping>;
    }) => apiClient.put(`/mappings/${variables.category}/${variables.fieldName}`, variables.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to update mapping',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useBulkUpdateMappings = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: (mappings: AttributeMapping[]) => apiClient.post('/mappings/bulk', { mappings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to update mappings',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

// ── Per-product overrides (edit_in_grid) ──

export const useProductOverrides = (shopifyProductId: string | undefined) => {
  return useQuery({
    queryKey: ['product-overrides', shopifyProductId],
    queryFn: () =>
      apiClient.get<{ data: Array<{ category: string; field_name: string; value: string | null }> }>(
        `/product-overrides/${shopifyProductId}`,
      ),
    enabled: Boolean(shopifyProductId),
  });
};

export const useSaveProductOverrides = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: ({
      shopifyProductId,
      overrides,
    }: {
      shopifyProductId: string;
      overrides: Array<{ category: string; field_name: string; value: string }>;
    }) => apiClient.put(`/product-overrides/${shopifyProductId}`, { overrides }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['product-overrides', variables.shopifyProductId] });
      addNotification({ type: 'success', title: 'Overrides saved', autoClose: 4000 });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to save overrides',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useSyncProducts = () => {
  const queryClient = useQueryClient();
  const { addNotification, addSyncOperation, removeSyncOperation } = useAppStore();

  return useMutation({
    mutationFn: (productIds?: string[]) => {
      addSyncOperation('products');
      return apiClient.post('/sync/products', { productIds: productIds ?? [] });
    },
    onSuccess: () => {
      removeSyncOperation('products');
      queryClient.invalidateQueries({ queryKey: ['listings'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      addNotification({
        type: 'success',
        title: 'Product sync started',
        autoClose: 4000,
      });
    },
    onError: (error) => {
      removeSyncOperation('products');
      addNotification({
        type: 'error',
        title: 'Product sync failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useSyncOrders = () => {
  const queryClient = useQueryClient();
  const { addNotification, addSyncOperation, removeSyncOperation } = useAppStore();

  return useMutation({
    mutationFn: () => {
      addSyncOperation('orders');
      return apiClient.post('/sync/trigger', { scope: 'orders' });
    },
    onSuccess: () => {
      removeSyncOperation('orders');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      addNotification({
        type: 'success',
        title: 'Order sync started',
        autoClose: 4000,
      });
    },
    onError: (error) => {
      removeSyncOperation('orders');
      addNotification({
        type: 'error',
        title: 'Order sync failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useSyncInventory = () => {
  const queryClient = useQueryClient();
  const { addNotification, addSyncOperation, removeSyncOperation } = useAppStore();

  return useMutation({
    mutationFn: () => {
      addSyncOperation('inventory');
      return apiClient.post('/sync/inventory');
    },
    onSuccess: () => {
      removeSyncOperation('inventory');
      queryClient.invalidateQueries({ queryKey: ['listings'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      addNotification({
        type: 'success',
        title: 'Inventory sync started',
        autoClose: 4000,
      });
    },
    onError: (error) => {
      removeSyncOperation('inventory');
      addNotification({
        type: 'error',
        title: 'Inventory sync failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useUpdateSettings = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: (settings: Record<string, string | number | boolean>) =>
      apiClient.put('/settings', settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      addNotification({
        type: 'success',
        title: 'Settings saved',
        autoClose: 4000,
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to save settings',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

// ── eBay Orders (imported) ──

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

export const useEbayOrders = (params?: {
  limit?: number;
  offset?: number;
  search?: string;
  fulfillmentStatus?: string;
  paymentStatus?: string;
  synced?: string;
}) => {
  return useQuery({
    queryKey: ['ebay-orders', params],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (params?.limit) sp.set('limit', String(params.limit));
      if (params?.offset) sp.set('offset', String(params.offset));
      if (params?.search) sp.set('search', params.search);
      if (params?.fulfillmentStatus) sp.set('fulfillmentStatus', params.fulfillmentStatus);
      if (params?.paymentStatus) sp.set('paymentStatus', params.paymentStatus);
      if (params?.synced) sp.set('synced', params.synced);
      const q = sp.toString();
      return apiClient.get<EbayOrdersResponse>(`/ebay/orders${q ? `?${q}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });
};

export const useEbayOrderStats = () => {
  return useQuery({
    queryKey: ['ebay-order-stats'],
    queryFn: () => apiClient.get<EbayOrderStats>('/ebay/orders/stats'),
    refetchInterval: 30000,
  });
};

export const useImportEbayOrders = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: (params?: { days?: number; limit?: number; fulfillmentStatus?: string }) =>
      apiClient.post<{ success: boolean; fetched: number; upserted: number }>('/ebay/orders/import', params),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ebay-orders'] });
      queryClient.invalidateQueries({ queryKey: ['ebay-order-stats'] });
      addNotification({
        type: 'success',
        title: 'eBay orders imported',
        message: `Fetched ${data.fetched} orders, upserted ${data.upserted}`,
        autoClose: 6000,
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'eBay order import failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export interface EbayOrderImportStatus {
  enabled: boolean;
  cutoff: string | null;
  autoSyncEnabled: boolean;
}

export const useEbayOrderImportStatus = () => {
  return useQuery({
    queryKey: ['ebay-order-import-status'],
    queryFn: () => apiClient.get<EbayOrderImportStatus>('/ebay/orders/import-status'),
    refetchInterval: 30000,
  });
};

export const useEnableEbayOrderImport = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: () =>
      apiClient.post<{ ok: boolean; enabled: boolean; cutoff: string }>('/ebay/orders/enable-import', {
        confirm: true,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ebay-order-import-status'] });
      addNotification({
        type: 'success',
        title: 'eBay order import enabled',
        message: `Only orders created after ${new Date(data.cutoff).toLocaleString()} will be imported`,
        autoClose: 8000,
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to enable order import',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useDisableEbayOrderImport = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: () => apiClient.post<{ ok: boolean; enabled: boolean }>('/ebay/orders/disable-import', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ebay-order-import-status'] });
      addNotification({
        type: 'success',
        title: 'eBay order import disabled',
        autoClose: 6000,
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to disable order import',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

// ---------------------------------------------------------------------------
// Product Notes
// ---------------------------------------------------------------------------

export const useProductNotes = (productId: string | undefined) => {
  return useQuery({
    queryKey: ['product-notes', productId],
    queryFn: () => apiClient.get<{ ok: boolean; notes: string }>(`/products/${productId}/notes`),
    enabled: !!productId,
  });
};

export const useSaveProductNotes = () => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: (params: { productId: string; notes: string }) =>
      apiClient.put<{ ok: boolean }>(`/products/${params.productId}/notes`, { notes: params.notes }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['product-notes', variables.productId] });
      addNotification({
        type: 'success',
        title: 'Notes saved',
        autoClose: 3000,
      });
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Failed to save notes',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });
};

export const useEbayAuthStatus = () => {
  return useQuery({
    queryKey: ['ebay-auth-status'],
    queryFn: async () => {
      // eBay auth status is outside /api prefix
      const response = await fetch('/ebay/auth/status');
      const data = await response.json() as {
        authenticated?: boolean;
        expired?: boolean;
        hasRefreshToken?: boolean;
        expiresAt?: string;
        scope?: string;
      };
      return {
        connected: data.authenticated === true && !data.expired,
        tokenExpires: data.expiresAt,
        hasRefreshToken: data.hasRefreshToken,
      };
    },
    refetchInterval: 30000,
  });
};

// ---------------------------------------------------------------------------
// TIM Condition Data
// ---------------------------------------------------------------------------

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

export const useTimCondition = (productId: string | undefined) => {
  return useQuery({
    queryKey: ['tim-condition', productId],
    queryFn: () => apiClient.get<TimConditionResponse>(`/tim/condition/${productId}`),
    enabled: !!productId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

interface TagProductResponse {
  success: boolean;
  productId: string;
  condition?: string;
  previousTag?: string;
  newTag?: string;
  skipped?: boolean;
  error?: string;
}

export const useTagProductCondition = (productId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<TagProductResponse>(`/tim/tag/${productId}`),
    onSuccess: () => {
      // Invalidate product data to refresh tags
      queryClient.invalidateQueries({ queryKey: ['shopify-product', productId] });
      queryClient.invalidateQueries({ queryKey: ['tim-condition', productId] });
    },
  });
};

// ---------------------------------------------------------------------------
// Pipeline Manual Trigger
// ---------------------------------------------------------------------------

export interface PipelineTriggerResult {
  success: boolean;
  error?: string;
  product?: { id: string; title: string; status: string };
  photos?: { found: boolean; count: number; presetName: string; folderName: string };
  draft?: { id: number };
  description?: { generated: boolean; preview?: string };
  condition?: { tagApplied: boolean; tag?: string };
  pipelineJobId?: string;
}

export interface DriveSearchResult {
  success: boolean;
  error?: string;
  product?: { id: string; title: string };
  drive?: { folderPath: string; presetName: string; folderName: string; imageCount: number } | null;
}

export const useRunPipeline = (productId: string | undefined) => {
  const queryClient = useQueryClient();
  const { addNotification } = useAppStore();

  return useMutation({
    mutationFn: () => apiClient.post<PipelineTriggerResult>(`/pipeline/trigger/${productId}`),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['product-info', productId] });
      queryClient.invalidateQueries({ queryKey: ['product-pipeline-status', productId] });
      queryClient.invalidateQueries({ queryKey: ['pipeline-jobs', productId] });
      queryClient.invalidateQueries({ queryKey: ['active-photos', productId] });
      if (data.success) {
        addNotification({
          type: 'info',
          title: 'Pipeline started',
          message: 'Processing in background — check the status bar for progress.',
          autoClose: 4000,
        });
      } else {
        addNotification({
          type: 'warning',
          title: 'Pipeline incomplete',
          message: data.error || 'No photos found',
          autoClose: 8000,
        });
      }
    },
    onError: (error) => {
      addNotification({
        type: 'error',
        title: 'Pipeline trigger failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        autoClose: 8000,
      });
    },
  });
};

export const useDriveSearch = (productId: string | undefined) => {
  return useQuery({
    queryKey: ['drive-search', productId],
    queryFn: () => apiClient.get<DriveSearchResult>(`/pipeline/drive-search/${productId}`),
    enabled: false, // Only fetch on demand
  });
};
