export interface SyncResult {
    imported: number;
    skipped: number;
    failed: number;
    dryRun: boolean;
    errors: Array<{
        ebayOrderId: string;
        error: string;
    }>;
    safetyBlocks: Array<{
        ebayOrderId: string;
        reason: string;
    }>;
}
/**
 * Read the go-live cutoff for eBay order import (set when switching off
 * Marketplace Connect). Empty/missing = import not enabled.
 */
export declare function getOrderImportCutoff(): Promise<string | null>;
/**
 * Clamp a createdAfter date to the go-live cutoff: never look at orders
 * created before the cutoff. Pure — exported for tests.
 */
export declare function applyCutoff(createdAfter: string, cutoff: string | null): string;
/**
 * Sync eBay orders to Shopify.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ SAFETY CRITICAL: DRY RUN IS THE DEFAULT                                ║
 * ║                                                                         ║
 * ║ You MUST pass confirm=true to create real Shopify orders.               ║
 * ║ Without confirm=true, this function logs what WOULD happen but creates  ║
 * ║ nothing. This is intentional — duplicates cascade into Lightspeed POS.  ║
 * ║                                                                         ║
 * ║ Three layers of duplicate detection:                                    ║
 * ║  1. order_mappings DB (fastest)                                         ║
 * ║  2. Shopify tag search (eBay-{orderId})                                 ║
 * ║  3. Shopify total+date+buyer match                                      ║
 * ║                                                                         ║
 * ║ SAFETY_MODE (default "safe") rate-limits creation to 5/hr, 1/10s.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
export declare const syncOrders: (ebayAccessToken: string, shopifyAccessToken: string, options?: {
    createdAfter?: string;
    /**
     * DEPRECATED: use `confirm` instead. Still honoured for backward compat.
     * @deprecated
     */
    dryRun?: boolean;
    /**
     * MUST be explicitly set to `true` to actually create Shopify orders.
     * Defaults to false (dry-run mode).
     */
    confirm?: boolean;
}) => Promise<SyncResult>;
