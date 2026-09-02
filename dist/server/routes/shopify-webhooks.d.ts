import { Router, type Request } from 'express';
/**
 * Shopify webhooks retain verified process-log observability, but every former
 * dispatch path and database receipt write is intentionally absent during the
 * Marketplace Connect incumbent phase.
 */
export declare function createShopifyWebhookRouter(dependencies?: Readonly<{
    verify: (request: Request) => Promise<boolean>;
    refreshListings: () => Promise<unknown>;
    /**
     * Event-driven inventory alignment. Off unless
     * INVENTORY_WEBHOOK_SWEEP_ENABLED=1, so this changes nothing on deploy.
     */
    notifyInventoryChanged?: () => boolean;
}>): Router;
declare const _default: Router;
export default _default;
