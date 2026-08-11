import { loadShopifyCredentials } from '../config/credentials.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
/**
 * Fetch inventory levels for specific inventory item IDs.
 */
export const fetchInventoryLevels = async (accessToken, inventoryItemIds) => {
    const creds = await loadShopifyCredentials();
    const allLevels = [];
    // Shopify limits to 50 IDs per request
    for (let i = 0; i < inventoryItemIds.length; i += 50) {
        const chunk = inventoryItemIds.slice(i, i + 50);
        const ids = chunk.join(',');
        const url = `https://${creds.storeDomain}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${ids}`;
        const response = await fetch(url, {
            headers: { 'X-Shopify-Access-Token': accessToken },
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Shopify inventory levels fetch failed (${response.status}): ${body}`);
        }
        const data = (await response.json());
        for (const level of data.inventory_levels) {
            allLevels.push({
                inventoryItemId: level.inventory_item_id,
                locationId: level.location_id,
                available: level.available ?? 0,
            });
        }
    }
    return allLevels;
};
/**
 * Set inventory level for a specific item at a location.
 */
export const setInventoryLevel = async (accessToken, inventoryItemId, locationId, available) => {
    denyExternalWrite('inventory', 'set Shopify inventory level');
    const creds = await loadShopifyCredentials();
    const url = `https://${creds.storeDomain}/admin/api/2024-01/inventory_levels/set.json`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            location_id: locationId,
            inventory_item_id: inventoryItemId,
            available,
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Shopify set inventory failed (${response.status}): ${body}`);
    }
};
/**
 * Get all locations for the store.
 */
export const fetchLocations = async (accessToken) => {
    const creds = await loadShopifyCredentials();
    const url = `https://${creds.storeDomain}/admin/api/2024-01/locations.json`;
    const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Shopify locations fetch failed (${response.status}): ${body}`);
    }
    const data = (await response.json());
    return data.locations;
};
