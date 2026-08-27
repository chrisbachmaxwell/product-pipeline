/**
 * Bounded eBay Inventory-API adapter for the isolated listing-lifecycle
 * operator CLI's RECOVER-CREATE cleanup dispatch. It can reach exactly two
 * resource paths on exactly one host, with exactly two methods each:
 *
 *   GET    /sell/inventory/v1/offer/{offerId}
 *   DELETE /sell/inventory/v1/offer/{offerId}
 *   GET    /sell/inventory/v1/inventory_item/{sku}
 *   DELETE /sell/inventory/v1/inventory_item/{sku}
 *
 * Every other host, path, or method is structurally impossible — in
 * particular no publish, create, or revise call exists here, so this adapter
 * can never finish, replay, or alter a listing; it can only observe and
 * remove the exact named residue. Requests and responses are bounded
 * (2 MB / 20 s), redirects are errors, and errors are redacted to fixed
 * codes; no token, URL, payload, or provider body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its writes are reachable only from the
 * recover-create ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
const EBAY_API_HOST = 'https://api.ebay.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OFFER_STATUSES = ['PUBLISHED', 'UNPUBLISHED'];
export class ListingRecoverDispatchError extends Error {
    code;
    outcomeClass;
    constructor(code, outcomeClass) {
        super('Listing recover dispatch adapter failed');
        this.code = code;
        this.outcomeClass = outcomeClass;
        this.name = 'ListingRecoverDispatchError';
    }
}
const deny = (code, outcomeClass) => {
    throw new ListingRecoverDispatchError(code, outcomeClass);
};
export function createListingRecoverDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function authorizedHeaders() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE', 'definite_no_effect');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            deny('RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE', 'definite_no_effect');
        }
        return {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Accept-Language': 'en-US',
        };
    }
    async function boundedRequest(url, init, failureCode, failureOutcome) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(url, {
                ...init,
                redirect: 'error',
                signal: controller.signal,
            });
            const declaredLength = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
                deny(failureCode, failureOutcome);
            }
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                deny(failureCode, failureOutcome);
            }
            return { status: response.status, text };
        }
        catch (error) {
            if (error instanceof ListingRecoverDispatchError)
                throw error;
            return deny(failureCode, failureOutcome);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    function parseJsonObject(text) {
        try {
            const parsed = JSON.parse(text);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
            }
            return parsed;
        }
        catch (error) {
            if (error instanceof ListingRecoverDispatchError)
                throw error;
            return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
        }
    }
    async function getOffer(offerId) {
        if (!SAFE_SEGMENT.test(offerId)) {
            deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
        }
        const headers = await authorizedHeaders();
        const response = await boundedRequest(`${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'GET', headers }, 'RECOVER_DISPATCH_READ_FAILED', 'definite_no_effect');
        if (response.status === 404) {
            return Object.freeze({ found: false, sku: null, status: null });
        }
        if (response.status !== 200) {
            deny('RECOVER_DISPATCH_READ_FAILED', 'definite_no_effect');
        }
        const parsed = parseJsonObject(response.text);
        const sku = parsed.sku;
        const status = parsed.status;
        if (typeof sku !== 'string' || !SAFE_SEGMENT.test(sku)
            || typeof status !== 'string'
            || !OFFER_STATUSES.includes(status)
            || (typeof parsed.offerId === 'string' && parsed.offerId !== offerId)) {
            return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'definite_no_effect');
        }
        return Object.freeze({ found: true, sku, status: status });
    }
    async function deleteOffer(offerId) {
        if (!SAFE_SEGMENT.test(offerId)) {
            deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
        }
        const headers = await authorizedHeaders();
        const response = await boundedRequest(`${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'DELETE', headers }, 'RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
        if (response.status !== 204) {
            deny('RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
        }
    }
    async function getInventoryItem(sku) {
        if (!SAFE_SEGMENT.test(sku)) {
            deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
        }
        const headers = await authorizedHeaders();
        const response = await boundedRequest(`${EBAY_API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'GET', headers }, 'RECOVER_DISPATCH_READ_FAILED', 'definite_no_effect');
        if (response.status === 404) {
            return Object.freeze({ found: false, sku: null });
        }
        if (response.status !== 200) {
            deny('RECOVER_DISPATCH_READ_FAILED', 'definite_no_effect');
        }
        const parsed = parseJsonObject(response.text);
        const parsedSku = parsed.sku;
        if (typeof parsedSku !== 'string' || !SAFE_SEGMENT.test(parsedSku)) {
            return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'definite_no_effect');
        }
        return Object.freeze({ found: true, sku: parsedSku });
    }
    async function deleteInventoryItem(sku) {
        if (!SAFE_SEGMENT.test(sku)) {
            deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
        }
        const headers = await authorizedHeaders();
        const response = await boundedRequest(`${EBAY_API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'DELETE', headers }, 'RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
        if (response.status !== 204) {
            deny('RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
        }
    }
    return Object.freeze({ getOffer, deleteOffer, getInventoryItem, deleteInventoryItem });
}
