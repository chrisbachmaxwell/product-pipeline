import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAppStore } from '../store';
class ApiClient {
    baseUrl = '/api';
    async request(endpoint, options) {
        const response = await fetch(`${this.baseUrl}${endpoint}`, options);
        const text = await response.text();
        let payload = undefined;
        if (text) {
            try {
                payload = JSON.parse(text);
            }
            catch {
                payload = text;
            }
        }
        if (!response.ok) {
            const message = typeof payload === 'object' && payload !== null && 'error' in payload
                ? String(payload.error)
                : typeof payload === 'string'
                    ? payload
                    : `Request failed with status ${response.status}`;
            throw new Error(message);
        }
        return payload;
    }
    get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    }
    post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: data ? JSON.stringify(data) : undefined,
        });
    }
    put(endpoint, data) {
        return this.request(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: data ? JSON.stringify(data) : undefined,
        });
    }
    delete(endpoint, data) {
        return this.request(endpoint, {
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
        queryFn: () => apiClient.get('/status'),
        refetchInterval: 15000,
    });
    useEffect(() => {
        if (!query.data)
            return;
        if (typeof query.data.shopifyConnected === 'boolean') {
            setConnectionStatus('shopify', query.data.shopifyConnected);
        }
        if (typeof query.data.ebayConnected === 'boolean') {
            setConnectionStatus('ebay', query.data.ebayConnected);
        }
    }, [query.data, setConnectionStatus]);
    return query;
};
/** Single source for the operator-facing migration and quarantine state. */
export const useMigrationStatus = () => useQuery({
    queryKey: ['migration-status'],
    queryFn: () => apiClient.get('/migration/status'),
    refetchInterval: 15_000,
});
export const useOperationalMonitoring = () => useQuery({
    queryKey: ['operational-monitoring'],
    queryFn: () => apiClient.get('/monitoring/digest'),
    refetchInterval: 60_000,
});
export const useListings = (params) => {
    return useQuery({
        queryKey: ['listings', params],
        queryFn: () => {
            const searchParams = new URLSearchParams();
            if (params?.limit)
                searchParams.set('limit', String(params.limit));
            if (params?.offset)
                searchParams.set('offset', String(params.offset));
            if (params?.search)
                searchParams.set('search', params.search);
            if (params?.status)
                searchParams.set('status', params.status);
            const query = searchParams.toString();
            return apiClient.get(`/listings${query ? `?${query}` : ''}`);
        },
        placeholderData: keepPreviousData,
    });
};
export const useOrders = (params) => {
    return useQuery({
        queryKey: ['orders', params],
        queryFn: () => {
            const searchParams = new URLSearchParams();
            if (params?.limit)
                searchParams.set('limit', String(params.limit));
            if (params?.offset)
                searchParams.set('offset', String(params.offset));
            if (params?.search)
                searchParams.set('search', params.search);
            if (params?.status)
                searchParams.set('status', params.status);
            if (params?.startDate)
                searchParams.set('startDate', params.startDate);
            if (params?.endDate)
                searchParams.set('endDate', params.endDate);
            const query = searchParams.toString();
            return apiClient.get(`/orders${query ? `?${query}` : ''}`);
        },
        placeholderData: keepPreviousData,
    });
};
export const useMappings = () => {
    return useQuery({
        queryKey: ['mappings'],
        queryFn: () => apiClient.get('/mappings'),
        staleTime: 60000,
    });
};
export const useSettings = () => {
    return useQuery({
        queryKey: ['settings'],
        queryFn: () => apiClient.get('/settings'),
        staleTime: 60000,
    });
};
export const useLogs = (limit = 100) => {
    return useQuery({
        queryKey: ['logs', limit],
        queryFn: () => apiClient.get(`/logs?limit=${limit}`),
        refetchInterval: 20000,
    });
};
export const useListingHealth = () => {
    return useQuery({
        queryKey: ['listings-health'],
        queryFn: () => apiClient.get('/listings/health'),
        staleTime: 60000,
    });
};
export const useUpdateMapping = () => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    return useMutation({
        mutationFn: (variables) => apiClient.put(`/mappings/${variables.category}/${variables.fieldName}`, variables.updates),
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
        mutationFn: (mappings) => apiClient.post('/mappings/bulk', { mappings }),
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
export const useProductOverrides = (shopifyProductId) => {
    return useQuery({
        queryKey: ['product-overrides', shopifyProductId],
        queryFn: () => apiClient.get(`/product-overrides/${shopifyProductId}`),
        enabled: Boolean(shopifyProductId),
    });
};
export const useSaveProductOverrides = () => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    return useMutation({
        mutationFn: ({ shopifyProductId, overrides, }) => apiClient.put(`/product-overrides/${shopifyProductId}`, { overrides }),
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
        mutationFn: (productIds) => {
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
        mutationFn: (settings) => apiClient.put('/settings', settings),
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
export const useEbayOrders = (params) => {
    return useQuery({
        queryKey: ['ebay-orders', params],
        queryFn: () => {
            const sp = new URLSearchParams();
            if (params?.limit)
                sp.set('limit', String(params.limit));
            if (params?.offset)
                sp.set('offset', String(params.offset));
            if (params?.search)
                sp.set('search', params.search);
            if (params?.fulfillmentStatus)
                sp.set('fulfillmentStatus', params.fulfillmentStatus);
            if (params?.paymentStatus)
                sp.set('paymentStatus', params.paymentStatus);
            if (params?.synced)
                sp.set('synced', params.synced);
            const q = sp.toString();
            return apiClient.get(`/ebay/orders${q ? `?${q}` : ''}`);
        },
        placeholderData: keepPreviousData,
    });
};
export const useEbayOrderStats = () => {
    return useQuery({
        queryKey: ['ebay-order-stats'],
        queryFn: () => apiClient.get('/ebay/orders/stats'),
        refetchInterval: 30000,
    });
};
export const useImportEbayOrders = () => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    return useMutation({
        mutationFn: (params) => apiClient.post('/ebay/orders/import', params),
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
export const useEbayOrderImportStatus = () => {
    return useQuery({
        queryKey: ['ebay-order-import-status'],
        queryFn: () => apiClient.get('/ebay/orders/import-status'),
        refetchInterval: 30000,
    });
};
export const useEnableEbayOrderImport = () => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    return useMutation({
        mutationFn: () => apiClient.post('/ebay/orders/enable-import', {
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
        mutationFn: () => apiClient.post('/ebay/orders/disable-import', {}),
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
export const useProductNotes = (productId) => {
    return useQuery({
        queryKey: ['product-notes', productId],
        queryFn: () => apiClient.get(`/products/${productId}/notes`),
        enabled: !!productId,
    });
};
export const useSaveProductNotes = () => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    return useMutation({
        mutationFn: (params) => apiClient.put(`/products/${params.productId}/notes`, { notes: params.notes }),
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
            const data = await response.json();
            return {
                connected: data.authenticated === true && !data.expired,
                tokenExpires: data.expiresAt,
                hasRefreshToken: data.hasRefreshToken,
            };
        },
        refetchInterval: 30000,
    });
};
export const useTimCondition = (productId) => {
    return useQuery({
        queryKey: ['tim-condition', productId],
        queryFn: () => apiClient.get(`/tim/condition/${productId}`),
        enabled: !!productId,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
};
export const useTagProductCondition = (productId) => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => apiClient.post(`/tim/tag/${productId}`),
        onSuccess: () => {
            // Invalidate product data to refresh tags
            queryClient.invalidateQueries({ queryKey: ['shopify-product', productId] });
            queryClient.invalidateQueries({ queryKey: ['tim-condition', productId] });
        },
    });
};
export const useRunPipeline = (productId) => {
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    return useMutation({
        mutationFn: () => apiClient.post(`/pipeline/trigger/${productId}`),
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
            }
            else {
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
export const useDriveSearch = (productId) => {
    return useQuery({
        queryKey: ['drive-search', productId],
        queryFn: () => apiClient.get(`/pipeline/drive-search/${productId}`),
        enabled: false, // Only fetch on demand
    });
};
