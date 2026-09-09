import { Router, type Request, type Response } from 'express';
import { info, warn } from '../../utils/logger.js';
import { loadEbayCredentials } from '../../config/credentials.js';
import {
  verifyEbayNotification,
  type EbayNotificationVerdict,
} from '../ebay-notification-receiver.js';
import { getLiveListingCatalogSnapshot } from '../live-listing-catalog-source.js';
import { inventorySweepTrigger } from '../inventory-sweep-trigger.js';
import { orderImportTrigger } from '../order-import-trigger.js';

type ReceiverCredentials = Readonly<{ devId: string; appId: string; certId: string }> | null;

let cachedCredentials: ReceiverCredentials = null;
async function receiverCredentials(): Promise<ReceiverCredentials> {
  if (cachedCredentials !== null) return cachedCredentials;
  try {
    const loaded = await loadEbayCredentials();
    cachedCredentials = Object.freeze({
      devId: loaded.devId, appId: loaded.appId, certId: loaded.certId,
    });
  } catch {
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
 * Always 200: eBay counts anything else as a failed delivery, retries
 * aggressively, and can suspend a persistently failing endpoint.
 */
export function createEbayNotificationRouter(
  dependencies: Readonly<{
    credentials: () => Promise<ReceiverCredentials>;
    refreshListings: () => Promise<unknown>;
    notifyInventoryChanged: () => boolean;
    notifySale?: () => boolean;
    now: () => number;
  }> = {
    credentials: receiverCredentials,
    refreshListings: () => getLiveListingCatalogSnapshot.refresh(),
    notifyInventoryChanged: () => inventorySweepTrigger.notifyInventoryChanged(),
    notifySale: () => orderImportTrigger.notifySale(),
    now: Date.now,
  },
): Router {
  const router = Router();

  router.post('/webhooks/ebay/notifications', async (req: Request, res: Response) => {
    // eBay's delivery contract wants 200 OK as the acknowledgement; a 202
    // risks being counted a failed delivery and the endpoint backed off.
    res.status(200).send('OK_READ_ONLY');
    let verdict: EbayNotificationVerdict;
    try {
      verdict = verifyEbayNotification({
        body: req.body,
        credentials: await dependencies.credentials(),
        nowMs: dependencies.now(),
      });
    } catch {
      warn('EBAY_NOTIFICATION_VERIFY_ERROR');
      return;
    }
    if (verdict.outcome !== 'verified') {
      warn(`EBAY_NOTIFICATION_REJECTED: ${verdict.reason}`);
      return;
    }
    const item = verdict.itemId ?? 'unknown-item';
    info(`[eBay Notification] ${verdict.eventName ?? 'unnamed-event'} verified for item ${item}`);
    if (!verdict.alignmentRelevant) return;
    // Refresh FIRST, as with the Shopify webhook: the sweep compares against
    // the catalog snapshot, and a stale snapshot hides the very change that
    // arrived.
    try {
      await dependencies.refreshListings();
    } catch {
      warn('EBAY_NOTIFICATION_REFRESH_FAILED');
    }
    if (dependencies.notifyInventoryChanged()) {
      info(`[eBay Notification] ${verdict.eventName} queued an inventory alignment sweep`);
    }
    const saleEvent = verdict.eventName === 'FixedPriceTransaction'
      || verdict.eventName === 'ItemSold'
      || verdict.eventName === 'AuctionCheckoutComplete';
    if (saleEvent && dependencies.notifySale && dependencies.notifySale()) {
      info(`[eBay Notification] ${verdict.eventName} queued an order import cycle`);
    }
  });

  return router;
}

export default createEbayNotificationRouter();
