/**
 * Believed eBay quantity per SKU — a read-scheduling cache, never a source of
 * truth.
 *
 * Why this exists: the live Shopify catalog refreshes every 60s and its
 * quantities are effectively free, while eBay reads are the scarce resource
 * (~5,000/day). eBay quantity only moves when we write it or when an eBay
 * order consumes stock, so a remembered value lets a sweep decide WHICH
 * listings are worth an eBay read instead of reading all ~117 every time.
 *
 * THE INVARIANT THAT MAKES THIS SAFE: a belief gates the READ, never the
 * WRITE. When a belief disagrees with Shopify the sweep still runs the real
 * `plan`, which reads eBay for the true `before` and builds the manifest from
 * it. A stale belief can therefore only cause an unnecessary check (cheap) or
 * a missed check (caught by the scheduled full sweep). It can never cause a
 * wrong value to be written to eBay.
 *
 * Deliberately NOT in the migration store: that store is the hash-chained
 * audit of what was actually done, and a scheduling hint is not evidence.
 * This is a separate, disposable cache — deleting it costs one full sweep to
 * rebuild and loses nothing auditable.
 */
import Database from 'better-sqlite3';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS quantity_beliefs (
  sku TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  source TEXT NOT NULL CHECK (source IN ('aligned', 'observed_no_drift')),
  observed_at_utc TEXT NOT NULL
) STRICT;
`;
export function openQuantityBeliefStore(databasePath) {
    const database = new Database(databasePath);
    database.pragma('journal_mode = WAL');
    database.exec(SCHEMA);
    const selectAll = database.prepare('SELECT sku, listing_id, quantity, source, observed_at_utc FROM quantity_beliefs');
    const upsert = database.prepare(`INSERT INTO quantity_beliefs (sku, listing_id, quantity, source, observed_at_utc)
     VALUES (@sku, @listingId, @quantity, @source, @observedAtUtc)
     ON CONFLICT(sku) DO UPDATE SET
       listing_id = excluded.listing_id,
       quantity = excluded.quantity,
       source = excluded.source,
       observed_at_utc = excluded.observed_at_utc`);
    const remove = database.prepare('DELETE FROM quantity_beliefs WHERE sku = ?');
    return Object.freeze({
        all() {
            const beliefs = new Map();
            for (const row of selectAll.all()) {
                beliefs.set(row.sku, Object.freeze({
                    sku: row.sku,
                    listingId: row.listing_id,
                    quantity: row.quantity,
                    source: row.source,
                    observedAtUtc: row.observed_at_utc,
                }));
            }
            return beliefs;
        },
        record(belief) {
            if (!Number.isSafeInteger(belief.quantity) || belief.quantity < 0)
                return;
            upsert.run(belief);
        },
        forget(sku) {
            remove.run(sku);
        },
        close() {
            database.close();
        },
    });
}
