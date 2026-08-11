import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { loadShopifyCredentials } from '../../config/credentials.js';
import { info, warn } from '../../utils/logger.js';

const router = Router();

async function verifyShopifyWebhook(req: Request): Promise<boolean> {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!hmacHeader || !rawBody) return false;
    const { clientSecret } = await loadShopifyCredentials();
    const expected = crypto.createHmac('sha256', clientSecret).update(rawBody).digest();
    const received = Buffer.from(hmacHeader, 'base64');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/**
 * Shopify webhooks retain verified process-log observability, but every former
 * dispatch path and database receipt write is intentionally absent during the
 * Marketplace Connect incumbent phase.
 */
router.post('/webhooks/shopify/:topic', async (req: Request, res: Response) => {
  res.status(200).send('OK_READ_ONLY');
  const rawTopic = req.params.topic || req.get('X-Shopify-Topic') || 'unknown';
  const suppliedTopic = Array.isArray(rawTopic) ? rawTopic[0] : rawTopic;
  const topic = /^[A-Za-z0-9._-]{1,80}$/.test(suppliedTopic) ? suppliedTopic : 'unknown';

  if (!(await verifyShopifyWebhook(req))) {
    warn(`[Shopify Webhook] HMAC verification failed: ${topic}`);
    return;
  }

  info(`[Shopify Webhook] ${topic} verified in shadow mode; no payload persisted or writer dispatched`);
});

export default router;
