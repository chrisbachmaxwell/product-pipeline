import { getValidEbayToken } from '../ebay/token-manager.js';
import { getRawDb } from '../db/client.js';
import { info, error as logError } from '../utils/logger.js';
import type { SyncResult } from '../sync/order-sync.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

/**
 * Run order sync with automatic token retrieval.
 * Returns null if tokens aren't configured yet.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ SAFETY: confirm defaults to false (DRY RUN).                           ║
 * ║ You MUST pass confirm=true to create real Shopify orders.              ║
 * ║ Duplicates cascade into Lightspeed POS — see PROJECT.md / AGENTS.md    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
export async function runOrderSync(options: {
  /** Must be true to create real Shopify orders. Default: false (dry run). */
  confirm?: boolean;
  /** @deprecated Use confirm instead */
  dryRun?: boolean;
  /** ISO date to sync from (defaults to 24h ago, max 7-day lookback enforced) */
  since?: string;
} = {}): Promise<SyncResult | null> {
  denyExternalWrite('orderImport', 'run eBay-to-Shopify order sync');
  try {
    const ebayToken = await getValidEbayToken();
    if (!ebayToken) {
      info('[SyncHelper] No eBay token — skipping order sync');
      return null;
    }

    const db = await getRawDb();
    const shopifyRow = db.prepare(
      `SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`
    ).get() as any;

    if (!shopifyRow?.access_token) {
      info('[SyncHelper] No Shopify token — skipping order sync');
      return null;
    }

    // SAFETY: Always default to 24h ago. Core syncOrders() also enforces 7-day max lookback.
    // After the 2026-02-11 incident where all historical orders were pulled, we NEVER sync without a date filter.
    const createdAfter = options.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const isLive = options.confirm === true || options.dryRun === false;
    info(`[SyncHelper] Syncing orders created after: ${createdAfter} (${isLive ? 'LIVE' : 'DRY RUN'})`);

    const { syncOrders } = await import('../sync/order-sync.js');
    return await syncOrders(ebayToken, shopifyRow.access_token, {
      createdAfter,
      confirm: options.confirm,
      dryRun: options.dryRun,
    });
  } catch (err) {
    logError(`[SyncHelper] Order sync error: ${err}`);
    return null;
  }
}
