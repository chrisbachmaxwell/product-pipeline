import { Router } from 'express';
import { verifyShopifyWebhookHmac } from '../../shopify/request-verification.js';
import { info, warn } from '../../utils/logger.js';
import { getLiveListingCatalogSnapshot } from '../live-listing-catalog-source.js';
async function verifyShopifyWebhook(req) {
    return verifyShopifyWebhookHmac(req.get('X-Shopify-Hmac-Sha256'), req.rawBody);
}
/**
 * Shopify webhooks retain verified process-log observability, but every former
 * dispatch path and database receipt write is intentionally absent during the
 * Marketplace Connect incumbent phase.
 */
export function createShopifyWebhookRouter(dependencies = {
    verify: verifyShopifyWebhook,
    refreshListings: () => getLiveListingCatalogSnapshot.refresh(),
}) {
    const router = Router();
    router.post('/webhooks/shopify/:topic', async (req, res) => {
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
