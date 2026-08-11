import { getOffers, updateOffer } from '../ebay/inventory.js';
import { getDb } from '../db/client.js';
import { productMappings, syncLog } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { info, error as logError } from '../utils/logger.js';
import { loadShopifyCredentials } from '../config/credentials.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
/**
 * Fetch variant prices from Shopify for mapped products.
 */
const fetchShopifyPrices = async (accessToken, productIds) => {
    const creds = await loadShopifyCredentials();
    const prices = new Map();
    for (const productId of productIds) {
        const numericId = productId.replace(/\D/g, '');
        const url = `https://${creds.storeDomain}/admin/api/2024-01/products/${numericId}.json?fields=id,variants`;
        try {
            const response = await fetch(url, {
                headers: { 'X-Shopify-Access-Token': accessToken },
            });
            if (!response.ok)
                continue;
            const data = (await response.json());
            for (const v of data.product.variants) {
                if (v.sku) {
                    prices.set(v.sku, v.price);
                }
            }
        }
        catch {
            // Skip products that fail to fetch
        }
    }
    return prices;
};
/**
 * Sync prices from Shopify to eBay.
 * Compares Shopify variant prices with eBay offer prices and updates if different.
 */
export const syncPrices = async (ebayAccessToken, shopifyAccessToken, options = {}) => {
    denyExternalWrite('price', 'sync Shopify prices to eBay');
    const result = {
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
    };
    const db = await getDb();
    // Get all active product mappings
    const mappings = await db
        .select()
        .from(productMappings)
        .where(eq(productMappings.status, 'active'))
        .all();
    if (!mappings.length) {
        info('No product mappings found. Run product sync first.');
        return result;
    }
    info(`Checking prices for ${mappings.length} mapped products...`);
    // Get Shopify prices
    const productIds = mappings.map((m) => m.shopifyProductId);
    const shopifyPrices = await fetchShopifyPrices(shopifyAccessToken, productIds);
    for (const mapping of mappings) {
        const sku = mapping.ebayInventoryItemId;
        if (!sku) {
            result.skipped++;
            continue;
        }
        try {
            const shopifyPrice = shopifyPrices.get(sku);
            if (!shopifyPrice) {
                result.skipped++;
                continue;
            }
            // Get eBay offer for this SKU
            let offers;
            try {
                offers = await getOffers(ebayAccessToken, sku);
            }
            catch {
                result.skipped++;
                continue;
            }
            if (!offers.offers?.length) {
                result.skipped++;
                continue;
            }
            const offer = offers.offers[0];
            const ebayPrice = offer.pricingSummary?.price?.value;
            // Compare prices
            if (ebayPrice === shopifyPrice) {
                result.skipped++;
                continue;
            }
            if (options.dryRun) {
                info(`[DRY RUN] Would update ${sku}: $${ebayPrice} → $${shopifyPrice}`);
                result.updated++;
                continue;
            }
            // Update eBay offer with new price
            const { offerId, ...offerData } = offer;
            if (offerId) {
                offerData.pricingSummary.price.value = shopifyPrice;
                await updateOffer(ebayAccessToken, offerId, offerData);
                await db
                    .insert(syncLog)
                    .values({
                    direction: 'shopify_to_ebay',
                    entityType: 'price',
                    entityId: sku,
                    status: 'success',
                    detail: `Updated price $${ebayPrice} → $${shopifyPrice}`,
                    createdAt: new Date(),
                })
                    .run();
                info(`Updated: ${sku} price $${ebayPrice} → $${shopifyPrice}`);
                result.updated++;
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`Failed to sync price for ${sku}: ${msg}`);
            result.failed++;
            result.errors.push({ sku: sku || 'unknown', error: msg });
        }
    }
    return result;
};
