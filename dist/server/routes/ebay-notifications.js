import { Router } from 'express';
import { info, warn } from '../../utils/logger.js';
import { loadEbayCredentials } from '../../config/credentials.js';
import { verifyEbayNotification, } from '../ebay-notification-receiver.js';
import { getLiveListingCatalogSnapshot } from '../live-listing-catalog-source.js';
import { inventorySweepTrigger } from '../inventory-sweep-trigger.js';
let cachedCredentials = null;
async function receiverCredentials() {
    if (cachedCredentials !== null)
        return cachedCredentials;
    try {
        const loaded = await loadEbayCredentials();
        cachedCredentials = Object.freeze({
            devId: loaded.devId, appId: loaded.appId, certId: loaded.certId,
        });
    }
    catch {
        // Missing credentials mean every notification is rejected, never that
        // verification is skipped.
        return null;
    }
    return cachedCredentials;
}
/**
 * eBay Platform Notifications receiver. READ-ONLY: a verified sale, end,
 * revise, or (re)list event triggers the same catalog refresh and armed
 * alignment sweep the Shopify webhook triggers -- so an eBay-side change
 * reaches the catalog in seconds instead of waiting for the periodic full
 * sweep. Unverified payloads are dropped after logging a fixed reason code;
 * caller-controlled text is never logged or persisted. Order import is NOT
 * performed here: that responsibility stays with the incumbent until its own
 * ceremony-gated cutover.
 *
 * Always 202: eBay retries aggressively on other statuses, and a retry storm
 * of unverifiable payloads helps no one.
 */
export function createEbayNotificationRouter(dependencies = {
    credentials: receiverCredentials,
    refreshListings: () => getLiveListingCatalogSnapshot.refresh(),
    notifyInventoryChanged: () => inventorySweepTrigger.notifyInventoryChanged(),
    now: Date.now,
}) {
    const router = Router();
    router.post('/webhooks/ebay/notifications', async (req, res) => {
        res.status(202).send('ACCEPTED_READ_ONLY');
        let verdict;
        try {
            verdict = verifyEbayNotification({
                body: req.body,
                credentials: await dependencies.credentials(),
                nowMs: dependencies.now(),
            });
        }
        catch {
            warn('EBAY_NOTIFICATION_VERIFY_ERROR');
            return;
        }
        if (verdict.outcome !== 'verified') {
            warn(`EBAY_NOTIFICATION_REJECTED: ${verdict.reason}`);
            return;
        }
        const item = verdict.itemId ?? 'unknown-item';
        info(`[eBay Notification] ${verdict.eventName ?? 'unnamed-event'} verified for item ${item}`);
        if (!verdict.alignmentRelevant)
            return;
        // Refresh FIRST, as with the Shopify webhook: the sweep compares against
        // the catalog snapshot, and a stale snapshot hides the very change that
        // arrived.
        try {
            await dependencies.refreshListings();
        }
        catch {
            warn('EBAY_NOTIFICATION_REFRESH_FAILED');
        }
        if (dependencies.notifyInventoryChanged()) {
            info(`[eBay Notification] ${verdict.eventName} queued an inventory alignment sweep`);
        }
    });
    return router;
}
export default createEbayNotificationRouter();
