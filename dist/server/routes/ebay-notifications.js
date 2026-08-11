import { Router } from 'express';
import { info } from '../../utils/logger.js';
const router = Router();
/**
 * eBay notifications have no authenticated evidence role in shadow mode. Keep a
 * static acknowledgement to avoid creating a retry storm, but do not parse or
 * persist caller-controlled data and never dispatch commerce work.
 */
router.post('/webhooks/ebay/notifications', (_req, res) => {
    res.status(202).send('ACCEPTED_READ_ONLY');
    info('[eBay Notification] Untrusted notification acknowledged without parsing, persistence, or dispatch');
});
export default router;
