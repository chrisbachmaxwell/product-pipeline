import { Router } from 'express';
import { type EbayTradingQuota } from '../ebay-quota-monitor.js';
export type EbayQuotaRouteDependencies = {
    readQuota?: () => Promise<EbayTradingQuota>;
};
/**
 * GET /api/ebay-quota — read-only Trading-quota tripwire for the operator
 * UI. One cached Developer Analytics read (no Trading quota consumed, no
 * writes); any failure degrades to `{ available: false }`, never a 500.
 */
export declare function createEbayQuotaRouter(dependencies?: EbayQuotaRouteDependencies): Router;
declare const _default: Router;
export default _default;
