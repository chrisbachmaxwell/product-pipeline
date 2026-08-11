/**
 * AI Listing Management — actively manages eBay listings for optimal performance.
 *
 * Features:
 *   1. Stale listing auto-republish (withdraw → republish after N days)
 *   2. Price drop schedule (reduce price on listings with no sales)
 *   3. Listing health dashboard data
 *   4. Promoted Listings setup via eBay Marketing API
 */
import { getOffersBySku, withdrawOffer, publishOffer, updateOffer, } from '../ebay/inventory.js';
import { ebayRequest } from '../ebay/client.js';
import { getDb, getRawDb } from '../db/client.js';
import { syncLog } from '../db/schema.js';
import { info, warn, error as logError } from '../utils/logger.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
/**
 * Republish stale listings to give them a fresh boost in the eBay algorithm.
 * Withdraws the offer, waits briefly, then re-publishes it.
 *
 * @param ebayToken  Valid eBay access token
 * @param maxAgeDays Listings older than this are considered stale (default: 30)
 */
export async function republishStaleListings(ebayToken, maxAgeDays = 30) {
    denyExternalWrite('listingLifecycle', 'republish stale eBay listings');
    const result = {
        processed: 0,
        republished: 0,
        skipped: 0,
        failed: 0,
        errors: [],
    };
    const db = await getDb();
    const rawDb = await getRawDb();
    // Cutoff: listings created/last-republished more than maxAgeDays ago
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const cutoffUnix = Math.floor(cutoff.getTime() / 1000);
    // Query active listings whose effective "last publish" date is older than cutoff.
    // Effective date = COALESCE(last_republished_at, created_at)
    const staleRows = rawDb
        .prepare(`SELECT * FROM product_mappings
       WHERE status = 'active'
         AND COALESCE(last_republished_at, created_at) < ?
       ORDER BY COALESCE(last_republished_at, created_at) ASC`)
        .all(cutoffUnix);
    info(`[ListingManager] Found ${staleRows.length} stale listings (older than ${maxAgeDays} days)`);
    for (const row of staleRows) {
        result.processed++;
        const sku = row.ebay_inventory_item_id;
        if (!sku) {
            result.skipped++;
            continue;
        }
        try {
            // Get the active offer for this SKU
            const offersResult = await getOffersBySku(ebayToken, sku);
            const offer = offersResult.offers?.[0];
            if (!offer?.offerId) {
                info(`[ListingManager] No offer found for SKU ${sku}, skipping`);
                result.skipped++;
                continue;
            }
            // Step 1: Withdraw the offer
            info(`[ListingManager] Withdrawing offer ${offer.offerId} (SKU: ${sku})`);
            try {
                await withdrawOffer(ebayToken, offer.offerId);
            }
            catch (err) {
                // Already withdrawn — that's fine, we'll re-publish
                if (!err.message?.includes('INVALID_OFFER_STATUS') && !err.message?.includes('25014')) {
                    throw err;
                }
                info(`[ListingManager] Offer ${offer.offerId} was already withdrawn`);
            }
            // Brief pause before republishing (eBay needs a moment)
            await new Promise((r) => setTimeout(r, 2000));
            // Step 2: Re-publish the offer
            info(`[ListingManager] Re-publishing offer ${offer.offerId} (SKU: ${sku})`);
            const published = await publishOffer(ebayToken, offer.offerId);
            const newListingId = published.listingId;
            // Update mapping
            const now = new Date();
            rawDb
                .prepare(`UPDATE product_mappings
           SET last_republished_at = ?, ebay_listing_id = ?, updated_at = ?
           WHERE id = ?`)
                .run(Math.floor(now.getTime() / 1000), newListingId || row.ebay_listing_id, Math.floor(now.getTime() / 1000), row.id);
            // Log sync
            await db.insert(syncLog).values({
                direction: 'shopify_to_ebay',
                entityType: 'republish',
                entityId: sku,
                status: 'success',
                detail: `Republished stale listing (was ${row.ebay_listing_id} → ${newListingId || 'same'})`,
                createdAt: now,
            }).run();
            info(`[ListingManager] ✅ Republished SKU ${sku} → listing ${newListingId || row.ebay_listing_id}`);
            result.republished++;
            // Rate limit
            await new Promise((r) => setTimeout(r, 500));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`[ListingManager] Failed to republish SKU ${sku}: ${msg}`);
            result.failed++;
            result.errors.push({ sku, error: msg });
        }
    }
    info(`[ListingManager] Republish complete: ${result.republished} republished, ${result.skipped} skipped, ${result.failed} failed`);
    return result;
}
/**
 * Apply automatic price drops to listings that haven't sold within a threshold.
 *
 * Settings (from DB):
 *   - price_drop_after_days (default 14)
 *   - price_drop_percent   (default 10)
 *
 * Tracks original price in productMappings.original_price so drops don't compound.
 */
export async function applyPriceDropSchedule(ebayToken, _shopifyToken) {
    denyExternalWrite('price', 'apply automatic eBay price drops');
    const result = {
        processed: 0,
        dropped: 0,
        skipped: 0,
        failed: 0,
        errors: [],
    };
    const rawDb = await getRawDb();
    const db = await getDb();
    // Read settings
    const settingsRows = rawDb.prepare(`SELECT key, value FROM settings WHERE key IN ('price_drop_after_days', 'price_drop_percent')`).all();
    const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));
    const dropAfterDays = parseInt(settings.price_drop_after_days || '14', 10);
    const dropPercent = parseFloat(settings.price_drop_percent || '10');
    if (dropPercent <= 0 || dropPercent >= 100) {
        warn('[ListingManager] Invalid price_drop_percent, skipping');
        return result;
    }
    const cutoff = new Date(Date.now() - dropAfterDays * 24 * 60 * 60 * 1000);
    const cutoffUnix = Math.floor(cutoff.getTime() / 1000);
    // Get active listings older than the threshold that haven't been price-dropped yet
    // "Haven't been dropped" = original_price IS NULL (we set it on first drop)
    const eligibleRows = rawDb
        .prepare(`SELECT * FROM product_mappings
       WHERE status = 'active'
         AND original_price IS NULL
         AND created_at < ?
       ORDER BY created_at ASC`)
        .all(cutoffUnix);
    info(`[ListingManager] Found ${eligibleRows.length} listings eligible for price drop (>${dropAfterDays} days, no prior drop)`);
    for (const row of eligibleRows) {
        result.processed++;
        const sku = row.ebay_inventory_item_id;
        if (!sku) {
            result.skipped++;
            continue;
        }
        try {
            // Get current eBay offer
            const offersResult = await getOffersBySku(ebayToken, sku);
            const offer = offersResult.offers?.[0];
            if (!offer?.offerId || !offer.pricingSummary?.price?.value) {
                result.skipped++;
                continue;
            }
            const currentPrice = parseFloat(offer.pricingSummary.price.value);
            if (isNaN(currentPrice) || currentPrice <= 0) {
                result.skipped++;
                continue;
            }
            // Check if this listing had any eBay sales (check order_mappings referencing this listing)
            // For now, we treat "no orders in order_mappings" as no sales for this listing
            // A more accurate check would query eBay orders API, but this is sufficient
            const hasSale = rawDb
                .prepare(`SELECT COUNT(*) as c FROM order_mappings WHERE ebay_order_id LIKE '%' || ? || '%'`)
                .get(row.ebay_listing_id);
            if (hasSale?.c > 0) {
                result.skipped++;
                continue;
            }
            // Calculate new price
            const dropAmount = currentPrice * (dropPercent / 100);
            const newPrice = Math.max(0.99, currentPrice - dropAmount); // never go below $0.99
            // Update eBay offer
            const { offerId, ...offerData } = offer;
            offerData.pricingSummary.price.value = newPrice.toFixed(2);
            await updateOffer(ebayToken, offerId, offerData);
            // Save original price so we don't compound
            const now = new Date();
            rawDb
                .prepare(`UPDATE product_mappings SET original_price = ?, updated_at = ? WHERE id = ?`)
                .run(currentPrice, Math.floor(now.getTime() / 1000), row.id);
            // Log
            await db.insert(syncLog).values({
                direction: 'shopify_to_ebay',
                entityType: 'price_drop',
                entityId: sku,
                status: 'success',
                detail: `Price drop: $${currentPrice.toFixed(2)} → $${newPrice.toFixed(2)} (-${dropPercent}%)`,
                createdAt: now,
            }).run();
            info(`[ListingManager] 💰 Price drop: ${sku} $${currentPrice.toFixed(2)} → $${newPrice.toFixed(2)} (-${dropPercent}%)`);
            result.dropped++;
            // Rate limit
            await new Promise((r) => setTimeout(r, 300));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`[ListingManager] Failed price drop for SKU ${sku}: ${msg}`);
            result.failed++;
            result.errors.push({ sku, error: msg });
        }
    }
    info(`[ListingManager] Price drops complete: ${result.dropped} dropped, ${result.skipped} skipped, ${result.failed} failed`);
    return result;
}
/**
 * Get listings eligible for actions (stale/price drop).
 */
export async function getStaleListings(maxAgeDays = 14) {
    const rawDb = await getRawDb();
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const cutoffUnix = Math.floor(cutoff.getTime() / 1000);
    return rawDb
        .prepare(`SELECT *,
        CAST((unixepoch('now') - COALESCE(last_republished_at, created_at)) / 86400 AS INTEGER) AS days_listed,
        CASE WHEN original_price IS NOT NULL THEN 1 ELSE 0 END AS price_dropped
       FROM product_mappings
       WHERE status = 'active'
         AND created_at < ?
       ORDER BY created_at ASC`)
        .all(cutoffUnix);
}
export async function getListingHealth() {
    const rawDb = await getRawDb();
    const now = Math.floor(Date.now() / 1000);
    // Total counts by status
    const statusCounts = rawDb
        .prepare(`SELECT status, COUNT(*) as c FROM product_mappings GROUP BY status`)
        .all();
    const countMap = {};
    for (const row of statusCounts) {
        countMap[row.status] = row.c;
    }
    // Age buckets (based on effective listing date)
    const bucketQuery = rawDb
        .prepare(`SELECT
         SUM(CASE WHEN age <= 7 THEN 1 ELSE 0 END)  AS d7,
         SUM(CASE WHEN age > 7 AND age <= 14 THEN 1 ELSE 0 END) AS d14,
         SUM(CASE WHEN age > 14 AND age <= 30 THEN 1 ELSE 0 END) AS d30,
         SUM(CASE WHEN age > 30 THEN 1 ELSE 0 END) AS d30plus,
         AVG(age) AS avg_age
       FROM (
         SELECT CAST((? - COALESCE(last_republished_at, created_at)) / 86400.0 AS REAL) AS age
         FROM product_mappings WHERE status = 'active'
       )`)
        .get(now);
    // Count special states
    const priceDropped = rawDb
        .prepare(`SELECT COUNT(*) as c FROM product_mappings WHERE status = 'active' AND original_price IS NOT NULL`)
        .get();
    const republished = rawDb
        .prepare(`SELECT COUNT(*) as c FROM product_mappings WHERE status = 'active' AND last_republished_at IS NOT NULL`)
        .get();
    const promoted = rawDb
        .prepare(`SELECT COUNT(*) as c FROM product_mappings WHERE status = 'active' AND promoted_at IS NOT NULL`)
        .get();
    // Revenue — sum from sync_log entries recording order amounts, or count of orders
    // Since we may not track per-order revenue, just count imported orders as proxy
    const orderCount = rawDb
        .prepare(`SELECT COUNT(*) as c FROM order_mappings`)
        .get();
    // Try to get revenue from sync_log details (best effort)
    let revenue = 0;
    try {
        const revRows = rawDb
            .prepare(`SELECT detail FROM sync_log
         WHERE entity_type = 'order' AND status = 'success' AND detail LIKE '%$%'`)
            .all();
        for (const row of revRows) {
            const match = row.detail?.match(/\$(\d+(?:\.\d{1,2})?)/);
            if (match) {
                revenue += parseFloat(match[1]);
            }
        }
    }
    catch {
        // Fine — revenue is best-effort
    }
    return {
        totalActive: countMap['active'] || 0,
        totalEnded: countMap['ended'] || 0,
        ageBuckets: {
            '0-7d': bucketQuery?.d7 || 0,
            '7-14d': bucketQuery?.d14 || 0,
            '14-30d': bucketQuery?.d30 || 0,
            '30d+': bucketQuery?.d30plus || 0,
        },
        averageDaysListed: Math.round(bucketQuery?.avg_age || 0),
        priceDropped: priceDropped?.c || 0,
        republished: republished?.c || 0,
        promoted: promoted?.c || 0,
        revenue,
    };
}
/**
 * Enable Promoted Listings Standard for the given listing IDs.
 *
 * Uses the eBay Marketing API — Promoted Listings Standard (cost-per-sale).
 * Creates a single campaign (or reuses if one exists) and adds listings to it.
 *
 * @param ebayToken   Valid eBay access token with sell.marketing scope
 * @param listingIds  Array of eBay listing IDs to promote
 * @param adRate      Ad rate percentage (default 2.0 = 2%)
 */
export async function enablePromotedListings(ebayToken, listingIds, adRate = 2.0) {
    denyExternalWrite('listingLifecycle', 'enable eBay promoted listings');
    const result = {
        processed: 0,
        promoted: 0,
        failed: 0,
        errors: [],
    };
    if (!listingIds.length)
        return result;
    const rawDb = await getRawDb();
    const db = await getDb();
    try {
        // Step 1: Find or create a Promoted Listings Standard campaign
        let campaignId = await findOrCreateCampaign(ebayToken, adRate);
        result.campaignId = campaignId;
        // Step 2: Add listings to the campaign
        for (const listingId of listingIds) {
            result.processed++;
            try {
                await addListingToCampaign(ebayToken, campaignId, listingId, adRate);
                // Update mapping
                const now = new Date();
                rawDb
                    .prepare(`UPDATE product_mappings SET promoted_at = ?, ad_rate = ?, updated_at = ? WHERE ebay_listing_id = ?`)
                    .run(Math.floor(now.getTime() / 1000), adRate, Math.floor(now.getTime() / 1000), listingId);
                await db.insert(syncLog).values({
                    direction: 'shopify_to_ebay',
                    entityType: 'promote',
                    entityId: listingId,
                    status: 'success',
                    detail: `Promoted listing at ${adRate}% ad rate (campaign ${campaignId})`,
                    createdAt: now,
                }).run();
                info(`[ListingManager] 📈 Promoted listing ${listingId} at ${adRate}%`);
                result.promoted++;
                await new Promise((r) => setTimeout(r, 300));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logError(`[ListingManager] Failed to promote listing ${listingId}: ${msg}`);
                result.failed++;
                result.errors.push({ listingId, error: msg });
            }
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[ListingManager] Campaign creation failed: ${msg}`);
        result.failed = listingIds.length;
        result.errors.push({ listingId: '*', error: msg });
    }
    info(`[ListingManager] Promote complete: ${result.promoted} promoted, ${result.failed} failed`);
    return result;
}
/**
 * Find an existing PLS campaign or create one.
 */
async function findOrCreateCampaign(ebayToken, adRate) {
    // Try to find existing active PLS campaign
    try {
        const campaigns = await ebayRequest({
            path: '/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=10',
            accessToken: ebayToken,
        });
        if (campaigns?.campaigns?.length) {
            // Use the first running campaign
            const existing = campaigns.campaigns[0];
            info(`[ListingManager] Using existing campaign: ${existing.campaignId} (${existing.campaignName})`);
            return existing.campaignId;
        }
    }
    catch {
        // No existing campaigns — create one
    }
    // Create a new Promoted Listings Standard campaign
    const body = {
        campaignName: `AI Managed - ${new Date().toISOString().split('T')[0]}`,
        marketplaceId: 'EBAY_US',
        fundingStrategy: {
            fundingModel: 'COST_PER_SALE',
            bidPercentage: String(adRate),
        },
        // Start immediately, no end date
        startDate: new Date().toISOString().split('T')[0] + 'T00:00:00.000Z',
    };
    const created = await ebayRequest({
        method: 'POST',
        path: '/sell/marketing/v1/ad_campaign',
        accessToken: ebayToken,
        body,
    });
    // eBay returns campaign URI in headers — parse campaign ID
    // The response may contain campaignId or we extract from Location header
    const campaignId = created?.campaignId;
    if (!campaignId) {
        throw new Error('Failed to create PLS campaign — no campaignId returned');
    }
    info(`[ListingManager] Created new PLS campaign: ${campaignId}`);
    return campaignId;
}
/**
 * Add a single listing to a Promoted Listings campaign.
 */
async function addListingToCampaign(ebayToken, campaignId, listingId, adRate) {
    await ebayRequest({
        method: 'POST',
        path: `/sell/marketing/v1/ad_campaign/${campaignId}/ad`,
        accessToken: ebayToken,
        body: {
            listingId,
            bidPercentage: String(adRate),
        },
    });
}
// ---------------------------------------------------------------------------
// Daily scheduler entry point
// ---------------------------------------------------------------------------
/**
 * Run all AI listing management tasks. Called by the scheduler.
 */
export async function runListingManagement(ebayToken) {
    denyExternalWrite('listingLifecycle', 'run automated listing management');
    const rawDb = await getRawDb();
    // Check if listing management is enabled
    const enabledSetting = rawDb
        .prepare(`SELECT value FROM settings WHERE key = 'listing_management_enabled'`)
        .get();
    if (enabledSetting?.value !== 'true') {
        info('[ListingManager] Listing management disabled. Enable with setting listing_management_enabled=true');
        return {
            republish: { processed: 0, republished: 0, skipped: 0, failed: 0, errors: [] },
            priceDrop: { processed: 0, dropped: 0, skipped: 0, failed: 0, errors: [] },
        };
    }
    info('[ListingManager] 🤖 Running AI listing management...');
    // Read max age setting (default 30 days for republish)
    const maxAgeSetting = rawDb
        .prepare(`SELECT value FROM settings WHERE key = 'republish_max_age_days'`)
        .get();
    const maxAgeDays = parseInt(maxAgeSetting?.value || '30', 10);
    const republishResult = await republishStaleListings(ebayToken, maxAgeDays);
    const priceDropResult = await applyPriceDropSchedule(ebayToken);
    info('[ListingManager] 🤖 AI listing management complete');
    return {
        republish: republishResult,
        priceDrop: priceDropResult,
    };
}
