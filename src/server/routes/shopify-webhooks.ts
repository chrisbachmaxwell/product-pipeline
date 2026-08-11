import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { loadShopifyCredentials } from '../../config/credentials.js';
import { getRawDb } from '../../db/client.js';
import { MARKETPLACE_CONNECT_BASELINE } from '../../safety/writer-quarantine.js';
import { info, warn, error as logError } from '../../utils/logger.js';

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
 * Shopify webhooks remain observable, but every former dispatch path is
 * intentionally unmounted during the Marketplace Connect incumbent phase.
 */
router.post('/webhooks/shopify/:topic', async (req: Request, res: Response) => {
  res.status(200).send('OK_READ_ONLY');
  const rawTopic = req.params.topic || req.get('X-Shopify-Topic') || 'unknown';
  const topic = Array.isArray(rawTopic) ? rawTopic[0] : rawTopic;

  if (!(await verifyShopifyWebhook(req))) {
    warn(`[Shopify Webhook] HMAC verification failed: ${topic}`);
    return;
  }

  try {
    const evidence = JSON.stringify({
      mode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
      topic,
      writerDispatched: false,
      payloadStored: false,
    });
    const db = await getRawDb();
    db.prepare(
      `INSERT INTO notification_log (source, topic, message, processed_at) VALUES (?, ?, ?, unixepoch())`,
    ).run('shopify', topic, evidence);
    info(`[Shopify Webhook] ${topic} verified in shadow mode; no writer dispatched`);
  } catch (error) {
    logError(
      `[Shopify Webhook] Redacted receipt error: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
});

export default router;
