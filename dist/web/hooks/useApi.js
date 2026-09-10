import { useQuery } from '@tanstack/react-query';
/**
 * Trimmed 2026-09-10: this file once exported ~30 hooks for endpoints the
 * shadow server answers with 404/423. Only what the live pages call remains.
 */
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
export const useActivity = () => useQuery({
    queryKey: ['activity-feed'],
    queryFn: () => apiClient.get('/activity'),
    refetchInterval: 60_000,
    retry: false,
});
export const usePriceCheck = (id, enabled) => useQuery({
    queryKey: ['price-check', id],
    queryFn: () => apiClient.get(`/price-check?id=${encodeURIComponent(id ?? '')}`),
    enabled: enabled && Boolean(id),
    staleTime: 60 * 60_000,
    retry: false,
});
