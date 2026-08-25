import { createProductionOrderReadTokenProvider } from '../order-import-admin/ebay-order-adapter.js';
const EBAY_API_HOST = 'https://api.ebay.com';
const SAFE_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
export class EbayFulfillmentAdapterError extends Error {
    code;
    constructor(code) {
        super('eBay fulfillment adapter denied');
        this.code = code;
        this.name = 'EbayFulfillmentAdapterError';
    }
}
const deny = (code) => {
    throw new EbayFulfillmentAdapterError(code);
};
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : deny('FULFILLMENT_EBAY_READ_FAILED');
}
function text(value, maximum = 256) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum
        ? value
        : deny('FULFILLMENT_EBAY_READ_FAILED');
}
function positiveQuantity(value) {
    return Number.isSafeInteger(value) && value > 0
        ? value
        : deny('FULFILLMENT_EBAY_READ_FAILED');
}
export function buildShippingFulfillmentBody(manifest) {
    if (!SAFE_ORDER_ID.test(manifest.ebayOrderId) || manifest.lineItems.length === 0) {
        deny('FULFILLMENT_EBAY_TARGET_INVALID');
    }
    const body = JSON.stringify({
        lineItems: manifest.lineItems,
        shippedDate: manifest.shippedDate,
        shippingCarrierCode: manifest.shippingCarrierCode,
        trackingNumber: manifest.trackingNumber,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
        deny('FULFILLMENT_EBAY_TARGET_INVALID');
    }
    return body;
}
export function createEbayFulfillmentAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function request(orderId, suffix, init, failure) {
        if (!SAFE_ORDER_ID.test(orderId))
            deny('FULFILLMENT_EBAY_TARGET_INVALID');
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('FULFILLMENT_EBAY_AUTHORITY_UNAVAILABLE');
        }
        if (!token || token.length > 4_096)
            deny('FULFILLMENT_EBAY_AUTHORITY_UNAVAILABLE');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(`${EBAY_API_HOST}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}${suffix}`, {
                ...init,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
                },
                redirect: 'error',
                signal: controller.signal,
            });
            const declared = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
                deny(failure);
            const body = await response.text();
            if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES)
                deny(failure);
            return { status: response.status, body };
        }
        catch (error) {
            if (error instanceof EbayFulfillmentAdapterError)
                throw error;
            return deny(failure);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async function getOrder(orderId) {
        const [orderResponse, fulfillmentResponse] = await Promise.all([
            request(orderId, '', { method: 'GET' }, 'FULFILLMENT_EBAY_READ_FAILED'),
            request(orderId, '/shipping_fulfillment', { method: 'GET' }, 'FULFILLMENT_EBAY_READ_FAILED'),
        ]);
        if (orderResponse.status !== 200 || fulfillmentResponse.status !== 200) {
            deny('FULFILLMENT_EBAY_READ_FAILED');
        }
        try {
            const order = record(JSON.parse(orderResponse.body));
            const fulfillmentsBody = record(JSON.parse(fulfillmentResponse.body));
            if (order.orderId !== orderId)
                deny('FULFILLMENT_EBAY_READ_FAILED');
            const lineItems = (Array.isArray(order.lineItems) ? order.lineItems : deny('FULFILLMENT_EBAY_READ_FAILED'))
                .map((raw) => {
                const item = record(raw);
                return Object.freeze({
                    lineItemId: text(item.lineItemId, 128),
                    quantity: positiveQuantity(item.quantity),
                });
            });
            const rawFulfillments = Array.isArray(fulfillmentsBody.fulfillments)
                ? fulfillmentsBody.fulfillments
                : [];
            const shippingFulfillments = rawFulfillments.map((raw) => {
                const fulfillment = record(raw);
                return Object.freeze({
                    fulfillmentId: text(fulfillment.fulfillmentId, 128),
                    trackingNumber: typeof fulfillment.shipmentTrackingNumber === 'string'
                        ? fulfillment.shipmentTrackingNumber.slice(0, 128)
                        : null,
                    shippingCarrierCode: typeof fulfillment.shippingCarrierCode === 'string'
                        ? fulfillment.shippingCarrierCode.slice(0, 64)
                        : null,
                });
            });
            return Object.freeze({
                orderId,
                fulfillmentStatus: text(order.orderFulfillmentStatus ?? 'UNKNOWN', 64),
                lineItems: Object.freeze(lineItems),
                shippingFulfillments: Object.freeze(shippingFulfillments),
            });
        }
        catch (error) {
            if (error instanceof EbayFulfillmentAdapterError)
                throw error;
            return deny('FULFILLMENT_EBAY_READ_FAILED');
        }
    }
    return Object.freeze({
        getOrder,
        createShippingFulfillment: async (manifest) => {
            const response = await request(manifest.ebayOrderId, '/shipping_fulfillment', { method: 'POST', body: buildShippingFulfillmentBody(manifest) }, 'FULFILLMENT_EBAY_WRITE_FAILED');
            if (response.status !== 201)
                deny('FULFILLMENT_EBAY_WRITE_FAILED');
        },
    });
}
export function createProductionEbayFulfillmentAdapter() {
    return createEbayFulfillmentAdapter({
        getAccessToken: createProductionOrderReadTokenProvider(),
    });
}
