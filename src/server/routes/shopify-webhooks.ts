import { Router, type Request, type Response } from 'express';
import { verifyShopifyWebhookHmac } from '../../shopify/request-verification.js';
import { info, warn } from '../../utils/logger.js';
import { getLiveListingCatalogSnapshot } from '../live-listing-catalog-source.js';

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
  }> = {
    verify: verifyShopifyWebhook,
    refreshListings: () => getLiveListingCatalogSnapshot.refresh(),
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
    void dependencies.refreshListings().catch(() => {
      warn('LISTING_CATALOG_SHOPIFY_WEBHOOK_REFRESH_FAILED');
    });
  });

  return router;
}

export default createShopifyWebhookRouter();
