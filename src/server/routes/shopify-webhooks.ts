import { Router, type Request, type Response } from 'express';
import { verifyShopifyWebhookHmac } from '../../shopify/request-verification.js';
import { info, warn } from '../../utils/logger.js';
import { getLiveListingCatalogSnapshot } from '../live-listing-catalog-source.js';
import {
  inventorySweepTrigger,
  isInventoryTopic,
} from '../inventory-sweep-trigger.js';

async function verifyShopifyWebhook(req: Request): Promise<boolean> {
  return verifyShopifyWebhookHmac(
    req.get('X-Shopify-Hmac-Sha256'),
    (req as Request & { rawBody?: Buffer }).rawBody,
  );
}

/**
 * Shopify webhooks retain verified process-log observability, but every former
 * dispatch path and database receipt write is intentionally absent during the
 * Marketplace Connect incumbent phase.
 */
export function createShopifyWebhookRouter(
  dependencies: Readonly<{
    verify: (request: Request) => Promise<boolean>;
    refreshListings: () => Promise<unknown>;
    /**
     * Event-driven inventory alignment. Off unless
     * INVENTORY_SWEEP_ARGV, so this changes nothing on deploy.
     */
    notifyInventoryChanged?: () => boolean;
  }> = {
    verify: verifyShopifyWebhook,
    refreshListings: () => getLiveListingCatalogSnapshot.refresh(),
    notifyInventoryChanged: () => inventorySweepTrigger.notifyInventoryChanged(),
  },
): Router {
  const router = Router();

  router.post('/webhooks/shopify/:topic', async (req: Request, res: Response) => {
    res.status(200).send('OK_READ_ONLY');
    const rawTopic = req.params.topic || req.get('X-Shopify-Topic') || 'unknown';
    const suppliedTopic = Array.isArray(rawTopic) ? rawTopic[0] : rawTopic;
    const topic = /^[A-Za-z0-9._-]{1,80}$/.test(suppliedTopic) ? suppliedTopic : 'unknown';

    if (!(await dependencies.verify(req))) {
      warn(`[Shopify Webhook] HMAC verification failed: ${topic}`);
      return;
    }

    info(`[Shopify Webhook] ${topic} verified in shadow mode; refreshing read-only listing evidence`);
    // The refresh must land BEFORE any sweep: the sweep compares remembered
    // eBay quantities against the catalog snapshot, and a stale snapshot would
    // make the change that triggered this webhook invisible.
    void dependencies.refreshListings().then(() => {
      if (!isInventoryTopic(topic) || !dependencies.notifyInventoryChanged) return;
      if (dependencies.notifyInventoryChanged()) {
        info(`[Shopify Webhook] ${topic} queued an inventory alignment sweep`);
      }
    }).catch(() => {
      warn('LISTING_CATALOG_SHOPIFY_WEBHOOK_REFRESH_FAILED');
    });
  });

  return router;
}

export default createShopifyWebhookRouter();
