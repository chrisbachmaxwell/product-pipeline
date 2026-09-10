import Database from 'better-sqlite3';
import { loadMigrationAdminConfig } from '../migration-admin/config.js';
/**
 * Only event kinds that the migration store schema records unambiguously are
 * emitted. `listing_ended` and `listing_relisted` exist in the operator
 * vocabulary but are intentionally never produced: an end-at-zero or a
 * relist-after-restock is journaled as an ordinary `inventory` alignment job
 * (the dispatch mode lives only in CLI results and evidence digests, not in
 * any relational column), so the store cannot distinguish them from a plain
 * quantity update. Guessing would tell the operator a listing ended when it
 * did not.
 */
export type ActivityEventKind = 'order_imported' | 'listing_ended' | 'listing_relisted' | 'quantity_updated' | 'price_updated' | 'tracking_sent' | 'listing_created';
export type ActivityEvent = {
    atUtc: string;
    kind: ActivityEventKind;
    label: string;
    sku?: string;
    ebayOrderId?: string;
    listingId?: string;
};
export type ActivityFeedProjection = Readonly<{
    /** False whenever the migration store is not configured or not readable. */
    available: boolean;
    windowHours: number;
    events: readonly ActivityEvent[];
}>;
/** Read-only open following the established shadow-db pattern: no file
 * creation, no schema work, and SQLite-enforced query_only. */
declare function openReadOnlyDatabase(databasePath: string): InstanceType<typeof Database>;
/**
 * Read-only "Today" activity: the most recent classified sync events from
 * the migration store's journal tables. Request-time only — it opens the
 * configured store read-only, runs bounded SELECTs, and closes it. It never
 * writes anywhere, never contacts a provider, and never returns buyer data,
 * tracking numbers, credentials, digests, or raw payloads.
 */
export declare function readActivityFeed(options?: {
    environment?: NodeJS.ProcessEnv;
    now?: () => Date;
    limit?: number;
    windowHours?: number;
    repositoryRoot?: string;
    loadConfig?: typeof loadMigrationAdminConfig;
    openDatabase?: typeof openReadOnlyDatabase;
}): Promise<ActivityFeedProjection>;
export {};
