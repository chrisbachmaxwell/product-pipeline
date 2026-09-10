import { Router } from 'express';
import { getEbayTradingQuota } from '../ebay-quota-monitor.js';
/**
 * GET /api/ebay-quota — read-only Trading-quota tripwire for the operator
 * UI. One cached Developer Analytics read (no Trading quota consumed, no
 * writes); any failure degrades to `{ available: false }`, never a 500.
 */
export function createEbayQuotaRouter(dependencies = {}) {
    const readQuota = dependencies.readQuota ?? getEbayTradingQuota;
    const router = Router();
    router.get('/api/ebay-quota', async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await readQuota());
    });
    return router;
}
export default createEbayQuotaRouter();
