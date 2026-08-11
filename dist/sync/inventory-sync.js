import { updateInventoryQuantity, getInventoryItem, getOffersBySku, withdrawOffer, publishOffer, createOffer, getBusinessPolicies } from '../ebay/inventory.js';
import { getDb } from '../db/client.js';
import { productMappings, syncLog } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { info, warn, error as logError } from '../utils/logger.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
/**
 * Update eBay inventory quantity for a specific SKU.
 * CRITICAL: If quantity is 0, the eBay listing MUST be ended (withdrawn).
 * If quantity goes from 0 to >0, the listing is republished.
 */
export const updateEbayInventory = async (ebayToken, sku, quantity, options = {}) => {
    denyExternalWrite('inventory', 'update eBay inventory');
    try {
        // Check if inventory item exists on eBay
        const existing = await getInventoryItem(ebayToken, sku);
        if (!existing) {
            return { success: false, error: 'Inventory item not found on eBay' };
        }
        const currentQuantity = existing.availability.shipToLocationAvailability.quantity;
        // Get offers for this SKU to check listing status
        const offersResult = await getOffersBySku(ebayToken, sku);
        const offer = offersResult.offers?.[0];
        const offerStatus = offer?.status;
        // If quantity is 0 and offer is still published, we MUST withdraw — don't skip!
        const needsWithdraw = quantity === 0 && offerStatus === 'PUBLISHED';
        if (currentQuantity === quantity && !needsWithdraw) {
            return { success: false, error: `Quantity unchanged (${quantity})` };
        }
        if (options.dryRun) {
            info(`[DRY RUN] Would update ${sku}: ${currentQuantity} → ${quantity}${needsWithdraw ? ' (+ withdraw offer)' : ''}`);
            return { success: true };
        }
        // *** CRITICAL RULE: Quantity 0 → END the listing ***
        if (quantity === 0) {
            info(`🚨 Inventory → 0 for ${sku} — ENDING eBay listing`);
            // Step 1: Withdraw (end) the offer FIRST — eBay rejects qty=0 on published offers
            if (offer?.offerId) {
                try {
                    await withdrawOffer(ebayToken, offer.offerId);
                    info(`✅ eBay listing ENDED for SKU ${sku} (offer ${offer.offerId})`);
                }
                catch (withdrawErr) {
                    // Offer may already be unpublished
                    if (withdrawErr.message?.includes('INVALID_OFFER_STATUS') ||
                        withdrawErr.message?.includes('25014')) {
                        info(`Offer ${offer.offerId} was already unpublished/ended`);
                    }
                    else {
                        throw withdrawErr;
                    }
                }
            }
            // Step 2: Now set inventory to 0 (safe since listing is ended)
            try {
                await updateInventoryQuantity(ebayToken, sku, 0);
            }
            catch (invErr) {
                // Some eBay errors on 0-qty are acceptable after withdraw
                info(`Note: Could not set qty to 0 after withdraw: ${invErr.message?.substring(0, 100)}`);
            }
            // Update local mapping status to 'ended'
            const db = await getDb();
            await db
                .update(productMappings)
                .set({ status: 'ended', updatedAt: new Date() })
                .where(eq(productMappings.ebayInventoryItemId, sku))
                .run();
            await db
                .insert(syncLog)
                .values({
                direction: 'shopify_to_ebay',
                entityType: 'inventory',
                entityId: sku,
                status: 'success',
                detail: `Listing ENDED: quantity ${currentQuantity} → 0`,
                createdAt: new Date(),
            })
                .run();
            return { success: true, action: 'ended' };
        }
        // *** RESTOCK RELIST: Quantity was 0, now >0 → republish ***
        const db = await getDb();
        const mapping = await db
            .select()
            .from(productMappings)
            .where(eq(productMappings.ebayInventoryItemId, sku))
            .get();
        if (mapping?.status === 'ended' && quantity > 0) {
            info(`📦 Restocking ${sku}: 0 → ${quantity} — RELISTING on eBay`);
            // Update inventory quantity first
            await updateInventoryQuantity(ebayToken, sku, quantity);
            // Try to republish the existing offer
            if (offer?.offerId) {
                try {
                    const publishResult = await publishOffer(ebayToken, offer.offerId);
                    const newListingId = publishResult.listingId;
                    info(`✅ eBay listing RELISTED: ${newListingId} for SKU ${sku}`);
                    // Update mapping to active with new listing ID
                    await db
                        .update(productMappings)
                        .set({
                        status: 'active',
                        ebayListingId: newListingId,
                        updatedAt: new Date()
                    })
                        .where(eq(productMappings.ebayInventoryItemId, sku))
                        .run();
                    await db
                        .insert(syncLog)
                        .values({
                        direction: 'shopify_to_ebay',
                        entityType: 'inventory',
                        entityId: sku,
                        status: 'success',
                        detail: `Listing RELISTED: ${newListingId}, quantity 0 → ${quantity}`,
                        createdAt: new Date(),
                    })
                        .run();
                    return { success: true, action: 'relisted' };
                }
                catch (pubErr) {
                    warn(`Failed to republish offer ${offer.offerId}: ${pubErr.message}`);
                    // Fall through to try creating a new offer
                }
            }
            // If no existing offer or republish failed, create a new one
            info(`Creating new offer for relisting ${sku}...`);
            try {
                const policies = await getBusinessPolicies(ebayToken);
                // Get category from the offer or default
                const categoryId = offer?.categoryId || '48519';
                const newOffer = await createOffer(ebayToken, {
                    sku,
                    marketplaceId: 'EBAY_US',
                    format: 'FIXED_PRICE',
                    availableQuantity: quantity,
                    pricingSummary: offer?.pricingSummary || {
                        price: { value: '19.99', currency: 'USD' },
                    },
                    listingPolicies: {
                        fulfillmentPolicyId: policies.fulfillmentPolicyId,
                        paymentPolicyId: policies.paymentPolicyId,
                        returnPolicyId: policies.returnPolicyId,
                    },
                    categoryId,
                    merchantLocationKey: 'pictureline-slc',
                    tax: { applyTax: true },
                });
                const publishResult = await publishOffer(ebayToken, newOffer.offerId);
                const newListingId = publishResult.listingId;
                info(`✅ eBay listing RELISTED (new offer): ${newListingId} for SKU ${sku}`);
                await db
                    .update(productMappings)
                    .set({
                    status: 'active',
                    ebayListingId: newListingId,
                    updatedAt: new Date()
                })
                    .where(eq(productMappings.ebayInventoryItemId, sku))
                    .run();
                await db
                    .insert(syncLog)
                    .values({
                    direction: 'shopify_to_ebay',
                    entityType: 'inventory',
                    entityId: sku,
                    status: 'success',
                    detail: `Listing RELISTED (new offer): ${newListingId}, quantity 0 → ${quantity}`,
                    createdAt: new Date(),
                })
                    .run();
                return { success: true, action: 'relisted' };
            }
            catch (newOfferErr) {
                logError(`Failed to create new offer for relist of ${sku}: ${newOfferErr.message}`);
                return { success: false, error: `Relist failed: ${newOfferErr.message}` };
            }
        }
        // *** Normal inventory update ***
        await updateInventoryQuantity(ebayToken, sku, quantity);
        info(`Updated eBay inventory: ${sku} → ${quantity} units`);
        // Log sync
        await db
            .insert(syncLog)
            .values({
            direction: 'shopify_to_ebay',
            entityType: 'inventory',
            entityId: sku,
            status: 'success',
            detail: `Updated quantity: ${currentQuantity} → ${quantity}`,
            createdAt: new Date(),
        })
            .run();
        return { success: true, action: 'updated' };
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logError(`Failed to update eBay inventory for ${sku}: ${errorMsg}`);
        // Log failure
        const db = await getDb();
        await db
            .insert(syncLog)
            .values({
            direction: 'shopify_to_ebay',
            entityType: 'inventory',
            entityId: sku,
            status: 'failed',
            detail: errorMsg,
            createdAt: new Date(),
        })
            .run();
        return { success: false, error: errorMsg };
    }
};
/**
 * Sync inventory levels for all mapped products.
 */
export const syncAllInventory = async (ebayToken, shopifyToken, options = {}) => {
    denyExternalWrite('inventory', 'sync Shopify inventory to eBay');
    const result = {
        processed: 0,
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
    info(`Starting inventory sync for ${mappings.length} mapped products...`);
    for (const mapping of mappings) {
        result.processed++;
        try {
            // Get current Shopify inventory level
            const shopifyResponse = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${mapping.shopifyProductId}.json`, {
                headers: { 'X-Shopify-Access-Token': shopifyToken },
            });
            if (!shopifyResponse.ok) {
                result.failed++;
                result.errors.push({
                    sku: mapping.ebayInventoryItemId || 'unknown',
                    error: `Failed to fetch Shopify product: ${shopifyResponse.status}`
                });
                continue;
            }
            const shopifyData = (await shopifyResponse.json());
            // Find variant with matching SKU
            const variant = shopifyData.product.variants.find(v => v.sku === mapping.ebayInventoryItemId);
            if (!variant) {
                result.failed++;
                result.errors.push({
                    sku: mapping.ebayInventoryItemId || 'unknown',
                    error: 'Matching variant not found'
                });
                continue;
            }
            const shopifyQuantity = Math.max(0, variant.inventory_quantity || 0);
            // Update eBay inventory
            const updateResult = await updateEbayInventory(ebayToken, mapping.ebayInventoryItemId, shopifyQuantity, options);
            if (updateResult.success) {
                result.updated++;
            }
            else {
                if (updateResult.error?.includes('unchanged')) {
                    result.skipped++;
                }
                else {
                    result.failed++;
                    result.errors.push({
                        sku: mapping.ebayInventoryItemId || 'unknown',
                        error: updateResult.error || 'Unknown error'
                    });
                }
            }
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        catch (err) {
            result.failed++;
            result.errors.push({
                sku: mapping.ebayInventoryItemId || 'unknown',
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
    info(`Inventory sync complete: ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`);
    return result;
};
/**
 * Handle Shopify inventory webhook update.
 * Called when a product variant's inventory changes in Shopify.
 */
export const handleInventoryWebhook = async (ebayToken, productId, variantId, newQuantity) => {
    denyExternalWrite('inventory', 'handle Shopify inventory webhook');
    try {
        const db = await getDb();
        // Find mapping by product ID
        const mapping = await db
            .select()
            .from(productMappings)
            .where(eq(productMappings.shopifyProductId, productId))
            .get();
        if (!mapping) {
            info(`[Webhook] No mapping found for product ${productId}`);
            return;
        }
        // Update eBay inventory
        const result = await updateEbayInventory(ebayToken, mapping.ebayInventoryItemId, Math.max(0, newQuantity));
        if (result.success) {
            info(`[Webhook] Updated eBay inventory: ${mapping.ebayInventoryItemId} → ${newQuantity}`);
        }
        else {
            warn(`[Webhook] Failed to update eBay inventory: ${result.error}`);
        }
    }
    catch (err) {
        logError(`[Webhook] Inventory update error: ${err}`);
    }
};
