import { ebayRequest } from './client.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
/**
 * Fetch eBay orders using the Fulfillment API.
 */
export const fetchEbayOrders = async (accessToken, options = {}) => {
    const filters = [];
    if (options.createdAfter) {
        filters.push(`creationdate:[${options.createdAfter}..]`);
    }
    if (options.modifiedAfter) {
        filters.push(`lastmodifieddate:[${options.modifiedAfter}..]`);
    }
    if (options.fulfillmentStatus) {
        filters.push(`orderfulfillmentstatus:{${options.fulfillmentStatus}}`);
    }
    const params = new URLSearchParams();
    if (filters.length)
        params.set('filter', filters.join(','));
    if (options.limit)
        params.set('limit', String(options.limit));
    if (options.offset)
        params.set('offset', String(options.offset));
    const query = params.toString();
    const path = `/sell/fulfillment/v1/order${query ? '?' + query : ''}`;
    return ebayRequest({ path, accessToken });
};
/**
 * Fetch ALL eBay orders with automatic pagination.
 */
export const fetchAllEbayOrders = async (accessToken, options = {}) => {
    const allOrders = [];
    let offset = 0;
    const limit = 200;
    while (true) {
        const response = await fetchEbayOrders(accessToken, {
            ...options,
            limit,
            offset,
        });
        if (response.orders) {
            allOrders.push(...response.orders);
        }
        if (allOrders.length >= response.total || !response.next)
            break;
        offset += limit;
    }
    return allOrders;
};
/**
 * Fetch a single eBay order by ID.
 */
export const fetchEbayOrder = async (accessToken, orderId) => {
    return ebayRequest({
        path: `/sell/fulfillment/v1/order/${orderId}`,
        accessToken,
    });
};
/**
 * Create a shipping fulfillment for an eBay order.
 * POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
 */
export const createShippingFulfillment = async (accessToken, orderId, fulfillment) => {
    denyExternalWrite('fulfillment', 'create eBay shipping fulfillment');
    return ebayRequest({
        method: 'POST',
        path: `/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`,
        accessToken,
        body: fulfillment,
    });
};
/**
 * Get shipping fulfillments for an eBay order.
 */
export const getShippingFulfillments = async (accessToken, orderId) => {
    return ebayRequest({
        path: `/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`,
        accessToken,
    });
};
