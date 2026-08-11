import { Router } from 'express';
import { parseStringPromise } from 'xml2js';
import { getRawDb } from '../../db/client.js';
import { MARKETPLACE_CONNECT_BASELINE } from '../../safety/writer-quarantine.js';
import { info, warn, error as logError } from '../../utils/logger.js';
const router = Router();
function findNotificationType(value) {
    if (!value || typeof value !== 'object')
        return null;
    const record = value;
    if (typeof record.NotificationType === 'string')
        return record.NotificationType;
    for (const child of Object.values(record)) {
        const found = findNotificationType(child);
        if (found)
            return found;
    }
    return null;
}
/**
 * eBay notifications are acknowledged and recorded as redacted metadata only.
 * They can never dispatch order, price, inventory, listing, or fulfillment work
 * while Marketplace Connect owns production writes.
 */
router.post('/webhooks/ebay/notifications', async (req, res) => {
    res.status(202).send('ACCEPTED_READ_ONLY');
    try {
        const rawBody = typeof req.body === 'string' ? req.body : '';
        const parsed = rawBody
            ? await parseStringPromise(rawBody, { explicitArray: false, ignoreAttrs: false })
            : null;
        const notificationType = findNotificationType(parsed) || 'unknown';
        const evidence = JSON.stringify({
            mode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
            notificationType,
            writerDispatched: false,
            payloadStored: false,
        });
        const db = await getRawDb();
        db.prepare(`INSERT INTO notification_log (source, topic, message, processed_at) VALUES (?, ?, ?, unixepoch())`).run('ebay', notificationType, evidence);
        info(`[eBay Notification] ${notificationType} acknowledged in shadow mode; no writer dispatched`);
    }
    catch (error) {
        warn('[eBay Notification] Redacted receipt could not be recorded');
        logError(`[eBay Notification] Receipt error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
});
export default router;
