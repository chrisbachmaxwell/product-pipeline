import { Router } from 'express';
type ReceiverCredentials = Readonly<{
    devId: string;
    appId: string;
    certId: string;
}> | null;
/**
 * eBay Platform Notifications receiver. READ-ONLY: a verified sale, end,
 * revise, or (re)list event triggers the same catalog refresh and armed
 * alignment sweep the Shopify webhook triggers -- so an eBay-side change
 * reaches the catalog in seconds instead of waiting for the periodic full
 * sweep. Unverified payloads are dropped after logging a fixed reason code;
 * caller-controlled text is never logged or persisted. Order import is NOT
 * performed here: that responsibility stays with the incumbent until its own
 * ceremony-gated cutover.
 *
 * Always 202: eBay retries aggressively on other statuses, and a retry storm
 * of unverifiable payloads helps no one.
 */
export declare function createEbayNotificationRouter(dependencies?: Readonly<{
    credentials: () => Promise<ReceiverCredentials>;
    refreshListings: () => Promise<unknown>;
    notifyInventoryChanged: () => boolean;
    now: () => number;
}>): Router;
declare const _default: Router;
export default _default;
