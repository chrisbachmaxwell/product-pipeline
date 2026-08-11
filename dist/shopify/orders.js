import { loadShopifyCredentials } from '../config/credentials.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
/**
 * Create an order in Shopify via REST Admin API.
 */
export const createShopifyOrder = async (accessToken, order) => {
    denyExternalWrite('orderImport', 'create Shopify order from eBay');
    const creds = await loadShopifyCredentials();
    const url = `https://${creds.storeDomain}/admin/api/2024-01/orders.json`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ order }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Shopify order creation failed (${response.status}): ${body}`);
    }
    const data = (await response.json());
    return data.order;
};
/**
 * Check if an eBay order was already imported into Shopify.
 * Uses multiple search methods to prevent duplicates:
 * 1. Tag-based search (eBay-{orderId}) - for orders created by this app
 * 2. source_identifier search - for standards compliance
 * 3. Note content search - for orders created by legacy apps like Codisto
 */
export const findExistingShopifyOrder = async (accessToken, ebayOrderId) => {
    const creds = await loadShopifyCredentials();
    // Method 1: Search by our tag (eBay-{orderId})
    const tagUrl = `https://${creds.storeDomain}/admin/api/2024-01/orders.json?status=any&tag=${encodeURIComponent(`eBay-${ebayOrderId}`)}&limit=1`;
    const tagResponse = await fetch(tagUrl, {
        headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (tagResponse.ok) {
        const tagData = (await tagResponse.json());
        if (tagData.orders[0]) {
            return tagData.orders[0];
        }
    }
    // Method 2: Search by source_identifier matching eBay order ID
    // Rate limit: wait 500ms between requests
    await new Promise(resolve => setTimeout(resolve, 500));
    const sourceUrl = `https://${creds.storeDomain}/admin/api/2024-01/orders.json?status=any&source_identifier=${encodeURIComponent(ebayOrderId)}&limit=1`;
    const sourceResponse = await fetch(sourceUrl, {
        headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (sourceResponse.ok) {
        const sourceData = (await sourceResponse.json());
        if (sourceData.orders[0]) {
            return sourceData.orders[0];
        }
    }
    // Method 3: Search recent orders and check note field for eBay order ID
    // This catches orders created by Codisto or other legacy apps
    await new Promise(resolve => setTimeout(resolve, 500));
    const recentUrl = `https://${creds.storeDomain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()}`;
    const recentResponse = await fetch(recentUrl, {
        headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (recentResponse.ok) {
        const recentData = (await recentResponse.json());
        for (const order of recentData.orders) {
            // Only a match if THIS eBay order's ID appears in the note or tags.
            // (A bare source_name === 'ebay' check used to falsely flag every new
            // order as a duplicate once any eBay-sourced order existed.)
            if ((order.note && order.note.includes(ebayOrderId)) ||
                (order.tags && order.tags.includes(ebayOrderId))) {
                return { id: order.id, name: order.name };
            }
        }
    }
    return null;
};
/**
 * Fetch recent Shopify orders (for listing/status).
 */
export const fetchShopifyOrders = async (accessToken, options = {}) => {
    const creds = await loadShopifyCredentials();
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 50));
    if (options.status)
        params.set('status', options.status);
    if (options.sinceId)
        params.set('since_id', options.sinceId);
    const url = `https://${creds.storeDomain}/admin/api/2024-01/orders.json?${params.toString()}`;
    const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Shopify orders fetch failed (${response.status}): ${body}`);
    }
    const data = (await response.json());
    return data.orders;
};
