import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadMigrationAdminConfig } from '../migration-admin/config.js';
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_EVENTS = 50;
const DEFAULT_EVENTS = 50;
const MAX_WINDOW_HOURS = 7 * 24;
const DEFAULT_WINDOW_HOURS = 24;
/** Rows stamped further in the future than this clock skew are dropped. */
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_IDENTIFIER_LENGTH = 128;
const RESPONSIBILITY_EVENT = Object.freeze({
    inventory: { kind: 'quantity_updated', label: 'Quantity updated' },
    price: { kind: 'price_updated', label: 'Price updated' },
    fulfillment: { kind: 'tracking_sent', label: 'Tracking sent to eBay' },
    listingCreate: { kind: 'listing_created', label: 'Listing created' },
});
/**
 * Provider-confirmed writes only: rows whose post-dispatch reconciliation
 * resolved `resolved_existing` (the desired state was observed on the
 * target). Unresolved and confirmed-missing attempts are operational
 * incidents, not activity stories, and stay out of this feed.
 */
const RESOLVED_DISPATCH_SQL = `
SELECT resolution.reconciled_at_utc AS atUtc,
       resolution.reconciled_epoch_ms AS atEpochMs,
       job.responsibility AS responsibility,
       target.resource_kind AS targetKind,
       target.external_id AS targetExternalId
FROM attempt_resolutions AS resolution
JOIN intent_attempts AS attempt ON attempt.attempt_id = resolution.attempt_id
JOIN execution_jobs AS job ON job.job_id = attempt.job_id
JOIN external_identities AS target ON target.identity_key = job.target_identity_key
WHERE resolution.resolution = 'resolved_existing'
  AND job.responsibility IN ('inventory', 'price', 'fulfillment', 'listingCreate')
  AND resolution.reconciled_epoch_ms > ?
  AND resolution.reconciled_epoch_ms <= ?
ORDER BY resolution.reconciled_epoch_ms DESC
LIMIT ?`;
/**
 * Orders ProductPipeline actually created in Shopify. `observed_existing`
 * links (incumbent-created orders matched during shadow polling) are
 * deliberately excluded: reporting them as "imported" would claim writes
 * ProductPipeline never performed.
 */
const ORDER_LINK_SQL = `
SELECT link.linked_at_utc AS atUtc,
       link.linked_epoch_ms AS atEpochMs,
       ebay_order.external_id AS ebayOrderId
FROM order_links AS link
JOIN external_identities AS ebay_order
  ON ebay_order.identity_key = link.ebay_order_identity_key
WHERE link.link_kind = 'product_pipeline_created'
  AND ebay_order.platform = 'ebay'
  AND ebay_order.resource_kind = 'order'
  AND link.linked_epoch_ms > ?
  AND link.linked_epoch_ms <= ?
ORDER BY link.linked_epoch_ms DESC
LIMIT ?`;
function clampInteger(value, fallback, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const floored = Math.floor(value);
    if (floored < 1)
        return 1;
    return floored > maximum ? maximum : floored;
}
function isExactUtc(value) {
    if (typeof value !== 'string')
        return false;
    try {
        return new Date(value).toISOString() === value;
    }
    catch {
        return false;
    }
}
/**
 * SKUs, eBay order ids, and listing ids are the ONLY row values this feed
 * ever surfaces. Anything that does not look like a short printable
 * identifier is silently dropped rather than exposed.
 */
function safeIdentifier(value) {
    if (typeof value !== 'string')
        return undefined;
    if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH)
        return undefined;
    if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(value))
        return undefined;
    return value;
}
/** Read-only open following the established shadow-db pattern: no file
 * creation, no schema work, and SQLite-enforced query_only. */
function openReadOnlyDatabase(databasePath) {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        database.pragma('query_only = ON');
        if (database.pragma('query_only', { simple: true }) !== 1) {
            throw new Error('SQLite query_only could not be enforced');
        }
        return database;
    }
    catch (error) {
        database.close();
        throw error;
    }
}
function unavailableFeed(windowHours) {
    return Object.freeze({ available: false, windowHours, events: Object.freeze([]) });
}
/**
 * Read-only "Today" activity: the most recent classified sync events from
 * the migration store's journal tables. Request-time only — it opens the
 * configured store read-only, runs bounded SELECTs, and closes it. It never
 * writes anywhere, never contacts a provider, and never returns buyer data,
 * tracking numbers, credentials, digests, or raw payloads.
 */
export async function readActivityFeed(options = {}) {
    const environment = options.environment ?? process.env;
    const limit = clampInteger(options.limit, DEFAULT_EVENTS, MAX_EVENTS);
    const windowHours = clampInteger(options.windowHours, DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS);
    const requestedConfigPath = environment.MIGRATION_STATE_CONFIG_PATH;
    if (typeof requestedConfigPath !== 'string' || requestedConfigPath.trim() === '') {
        return unavailableFeed(windowHours);
    }
    let databaseAbsolutePath;
    try {
        const loaded = await (options.loadConfig ?? loadMigrationAdminConfig)({
            repoRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
            requestedConfigPath,
        });
        databaseAbsolutePath = loaded.databaseAbsolutePath;
    }
    catch {
        return unavailableFeed(windowHours);
    }
    try {
        const nowEpochMs = (options.now ?? (() => new Date()))().getTime();
        if (!Number.isSafeInteger(nowEpochMs))
            return unavailableFeed(windowHours);
        const sinceEpochMs = nowEpochMs - windowHours * 3_600_000;
        const untilEpochMs = nowEpochMs + MAX_FUTURE_SKEW_MS;
        const database = (options.openDatabase ?? openReadOnlyDatabase)(databaseAbsolutePath);
        let orderRows;
        let dispatchRows;
        try {
            orderRows = database
                .prepare(ORDER_LINK_SQL)
                .all(sinceEpochMs, untilEpochMs, limit);
            dispatchRows = database
                .prepare(RESOLVED_DISPATCH_SQL)
                .all(sinceEpochMs, untilEpochMs, limit);
        }
        finally {
            database.close();
        }
        const collected = [];
        for (const row of orderRows) {
            if (!isExactUtc(row.atUtc) || !Number.isSafeInteger(row.atEpochMs))
                continue;
            const event = {
                atUtc: row.atUtc,
                kind: 'order_imported',
                label: 'eBay order imported',
            };
            const ebayOrderId = safeIdentifier(row.ebayOrderId);
            if (ebayOrderId !== undefined)
                event.ebayOrderId = ebayOrderId;
            collected.push({ epochMs: row.atEpochMs, event });
        }
        for (const row of dispatchRows) {
            if (!isExactUtc(row.atUtc) || !Number.isSafeInteger(row.atEpochMs))
                continue;
            const classified = typeof row.responsibility === 'string'
                ? RESPONSIBILITY_EVENT[row.responsibility]
                : undefined;
            if (classified === undefined)
                continue;
            const event = {
                atUtc: row.atUtc,
                kind: classified.kind,
                label: classified.label,
            };
            const identifier = safeIdentifier(row.targetExternalId);
            if (identifier !== undefined) {
                // The dispatch target's resource kind decides which allowed
                // identifier the external id is. eBay offer ids are internal
                // plumbing and are surfaced as nothing at all.
                if (row.targetKind === 'inventory_sku')
                    event.sku = identifier;
                else if (row.targetKind === 'listing')
                    event.listingId = identifier;
                else if (row.targetKind === 'order')
                    event.ebayOrderId = identifier;
            }
            collected.push({ epochMs: row.atEpochMs, event });
        }
        collected.sort((left, right) => right.epochMs - left.epochMs);
        return Object.freeze({
            available: true,
            windowHours,
            events: Object.freeze(collected.slice(0, limit).map((entry) => entry.event)),
        });
    }
    catch {
        return unavailableFeed(windowHours);
    }
}
