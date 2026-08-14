/**
 * Bounded eBay Inventory-API adapter for the isolated listing-revise operator
 * CLI. It can reach exactly two resource paths on exactly one host, with
 * exactly two methods each (GET to round-trip the raw resource, PUT to write
 * the manifest-derived payload). Every other host, path, or method is
 * structurally impossible. Errors are redacted to fixed codes; no token,
 * URL, payload, or provider body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its PUT methods are reachable only
 * from the dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { createTransientEbayTokenProvider, exchangeRuntimeEbayToken, } from '../server/live-listing-catalog-source.js';
import { loadEbayCredentials } from '../config/credentials.js';
import { openShadowDatabase } from '../server/shadow-db.js';
const EBAY_API_HOST = 'https://api.ebay.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export class ListingReviseDispatchError extends Error {
    code;
    constructor(code) {
        super('Listing revise dispatch adapter failed');
        this.code = code;
        this.name = 'ListingReviseDispatchError';
    }
}
const deny = (code) => {
    throw new ListingReviseDispatchError(code);
};
function exactResourceUrl(kind, identifier) {
    if (!SAFE_SEGMENT.test(identifier))
        deny('DISPATCH_TARGET_INVALID');
    return kind === 'inventory_item'
        ? `${EBAY_API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(identifier)}`
        : `${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(identifier)}`;
}
async function boundedRequest(fetchImpl, url, init, failure) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, {
            ...init,
            redirect: 'error',
            signal: controller.signal,
        });
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
            deny(failure);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
            deny(failure);
        return { status: response.status, text };
    }
    catch (error) {
        if (error instanceof ListingReviseDispatchError)
            throw error;
        return deny(failure);
    }
    finally {
        clearTimeout(timeout);
    }
}
export function createListingReviseDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function authorizedHeaders() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('DISPATCH_AUTHORITY_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            deny('DISPATCH_AUTHORITY_UNAVAILABLE');
        }
        return {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
            Accept_Language: 'en-US',
        };
    }
    async function getResource(kind, identifier) {
        const headers = await authorizedHeaders();
        const response = await boundedRequest(fetchImpl, exactResourceUrl(kind, identifier), { method: 'GET', headers }, 'DISPATCH_READ_FAILED');
        if (response.status !== 200)
            deny('DISPATCH_READ_FAILED');
        try {
            const parsed = JSON.parse(response.text);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return deny('DISPATCH_READ_FAILED');
            }
            return parsed;
        }
        catch (error) {
            if (error instanceof ListingReviseDispatchError)
                throw error;
            return deny('DISPATCH_READ_FAILED');
        }
    }
    async function putResource(kind, identifier, payload) {
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES)
            deny('DISPATCH_PAYLOAD_TOO_LARGE');
        const headers = await authorizedHeaders();
        const response = await boundedRequest(fetchImpl, exactResourceUrl(kind, identifier), { method: 'PUT', headers, body }, 'DISPATCH_WRITE_FAILED');
        if (response.status !== 200 && response.status !== 204)
            deny('DISPATCH_WRITE_FAILED');
    }
    return Object.freeze({
        getInventoryItem: (sku) => getResource('inventory_item', sku),
        getOffer: (offerId) => getResource('offer', offerId),
        putInventoryItem: (sku, payload) => putResource('inventory_item', sku, payload),
        putOffer: (offerId, payload) => putResource('offer', offerId, payload),
    });
}
async function readDispatchAuthMaterial() {
    const database = openShadowDatabase();
    try {
        const rows = database.prepare(`SELECT platform, access_token, refresh_token
       FROM auth_tokens
       WHERE platform IN ('shopify', 'ebay')`).all();
        const shopifyAccessToken = rows.find((row) => row.platform === 'shopify')?.access_token;
        const ebayRefreshToken = rows.find((row) => row.platform === 'ebay')?.refresh_token;
        const credentials = await loadEbayCredentials();
        if (!shopifyAccessToken || !ebayRefreshToken || !credentials.appId || !credentials.certId) {
            throw new ListingReviseDispatchError('DISPATCH_AUTHORITY_UNAVAILABLE');
        }
        return Object.freeze({
            shopifyAccessToken,
            ebayRefreshToken,
            ebayAppId: credentials.appId,
            ebayCertId: credentials.certId,
        });
    }
    finally {
        database.close();
    }
}
/**
 * Default production dispatch authority: mints one transient in-memory user
 * token from the existing eBay refresh grant with the same two scopes the
 * read path uses (`api_scope` + `sell.inventory`). The token is never
 * persisted, logged, or returned outside the adapter.
 */
export function createProductionDispatchTokenProvider() {
    return createTransientEbayTokenProvider({
        loadAuth: readDispatchAuthMaterial,
        exchange: exchangeRuntimeEbayToken,
    });
}
