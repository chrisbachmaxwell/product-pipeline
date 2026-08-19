/**
 * Bounded eBay Inventory-API alignment adapter for the isolated
 * price/inventory operator CLI. It can reach exactly one resource path on
 * exactly one host with exactly one method: POST
 * `/sell/inventory/v1/bulk_update_price_quantity`, carrying exactly ONE
 * request entry for exactly one SKU and one offer. A price dispatch and a
 * quantity dispatch are structurally cross-contamination-proof: before the
 * request leaves this module the serialized body is re-parsed and every key
 * is asserted — a price body can never contain a quantity/availability key
 * and a quantity body can never contain a price key. Errors are redacted to
 * fixed codes; no token, URL, payload, or provider body is ever thrown or
 * logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its single POST is reachable only
 * from the dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling it.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
const EBAY_BULK_UPDATE_URL = 'https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXACT_OFFER_ID = /^[0-9]{1,19}$/;
const PRICE_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
export class AlignDispatchError extends Error {
    code;
    constructor(code) {
        super('Price/inventory alignment dispatch adapter failed');
        this.code = code;
        this.name = 'AlignDispatchError';
    }
}
const deny = (code) => {
    throw new AlignDispatchError(code);
};
function collectKeys(value, keys) {
    if (Array.isArray(value)) {
        for (const entry of value)
            collectKeys(entry, keys);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            keys.push(key);
            collectKeys(entry, keys);
        }
    }
}
/**
 * Serialize the one bounded bulk_update_price_quantity body and assert its
 * structure on the serialized form: exactly one request entry, exactly one
 * offer, and zero cross-field contamination between price and quantity.
 */
export function buildBulkUpdateBody(field, input) {
    if (!SAFE_SKU.test(input.sku) || !EXACT_OFFER_ID.test(input.offerId)) {
        deny('ALIGN_DISPATCH_TARGET_INVALID');
    }
    let request;
    if (field === 'price') {
        const { price } = input;
        if (!price || typeof price.value !== 'string' || !PRICE_AMOUNT.test(price.value)
            || Number(price.value) <= 0 || typeof price.currency !== 'string'
            || !CURRENCY.test(price.currency)) {
            deny('ALIGN_DISPATCH_PAYLOAD_INVALID');
        }
        request = {
            sku: input.sku,
            offers: [{
                    offerId: input.offerId,
                    price: { value: price.value, currency: price.currency },
                }],
        };
    }
    else {
        const { quantity } = input;
        if (!Number.isSafeInteger(quantity) || quantity < 0) {
            deny('ALIGN_DISPATCH_PAYLOAD_INVALID');
        }
        request = {
            sku: input.sku,
            shipToLocationAvailability: { quantity },
            offers: [{ offerId: input.offerId, availableQuantity: quantity }],
        };
    }
    const body = JSON.stringify({ requests: [request] });
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
        deny('ALIGN_DISPATCH_PAYLOAD_TOO_LARGE');
    }
    // Structural assertions on the serialized body: re-parse it and inspect
    // every key so a value (e.g. an unusual SKU) can never fool the check.
    const reparsed = JSON.parse(body);
    if (!Array.isArray(reparsed.requests) || reparsed.requests.length !== 1) {
        deny('ALIGN_DISPATCH_PAYLOAD_INVALID');
    }
    const onlyRequest = reparsed.requests[0];
    if (!Array.isArray(onlyRequest.offers) || onlyRequest.offers.length !== 1) {
        deny('ALIGN_DISPATCH_PAYLOAD_INVALID');
    }
    const keys = [];
    collectKeys(reparsed, keys);
    if (field === 'price' && keys.some((key) => /quantity|availab/i.test(key))) {
        deny('ALIGN_DISPATCH_PAYLOAD_INVALID');
    }
    if (field === 'quantity' && keys.some((key) => /price/i.test(key))) {
        deny('ALIGN_DISPATCH_PAYLOAD_INVALID');
    }
    return body;
}
export function createPriceInventoryDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function authorizedHeaders() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('ALIGN_DISPATCH_AUTHORITY_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            deny('ALIGN_DISPATCH_AUTHORITY_UNAVAILABLE');
        }
        return {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
        };
    }
    async function boundedPost(body) {
        const headers = await authorizedHeaders();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(EBAY_BULK_UPDATE_URL, {
                method: 'POST',
                headers,
                body,
                redirect: 'error',
                signal: controller.signal,
            });
            const declaredLength = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
                deny('ALIGN_DISPATCH_WRITE_FAILED');
            }
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                deny('ALIGN_DISPATCH_WRITE_FAILED');
            }
            return { status: response.status, text };
        }
        catch (error) {
            if (error instanceof AlignDispatchError)
                throw error;
            return deny('ALIGN_DISPATCH_WRITE_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Exactly one bounded POST per dispatch. Accept only HTTP 200 with the
     * single entry's `statusCode` 200; every other shape is the fixed
     * redacted rejection.
     */
    async function dispatch(field, input) {
        const body = buildBulkUpdateBody(field, input);
        const response = await boundedPost(body);
        if (response.status !== 200)
            deny('ALIGN_DISPATCH_REJECTED');
        let parsed;
        try {
            parsed = JSON.parse(response.text);
        }
        catch {
            return deny('ALIGN_DISPATCH_REJECTED');
        }
        const responses = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed.responses
            : null;
        if (!Array.isArray(responses) || responses.length !== 1) {
            deny('ALIGN_DISPATCH_REJECTED');
        }
        const only = responses[0];
        const statusCode = only !== null && typeof only === 'object' && !Array.isArray(only)
            ? only.statusCode
            : null;
        if (statusCode !== 200)
            deny('ALIGN_DISPATCH_REJECTED');
    }
    return Object.freeze({
        updateOfferPrice: (input) => dispatch('price', input),
        updateOfferQuantity: (input) => dispatch('quantity', input),
    });
}
