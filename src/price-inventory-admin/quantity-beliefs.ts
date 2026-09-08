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

export type QuantityBeliefSource =
  /** We wrote this value to eBay and reconciliation confirmed it landed. */
  | 'aligned'
  /** A real eBay read showed eBay already agreed with Shopify. */
  | 'observed_no_drift';

export type QuantityBelief = Readonly<{
  sku: string;
  listingId: string;
  quantity: number;
  source: QuantityBeliefSource;
  observedAtUtc: string;
}>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quantity_beliefs (
  sku TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  source TEXT NOT NULL CHECK (source IN ('aligned', 'observed_no_drift')),
  observed_at_utc TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS ended_listings (
  sku TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  ended_at_utc TEXT NOT NULL
) STRICT;
`;

/**
 * Memory of a listing OUR sweep ended at quantity zero, kept so a restock can
 * relist it automatically. Recorded only after reconciliation confirmed the
 * end landed. Like a belief this is a HINT, not authority: the relist
 * dispatch is what verifies -- eBay refuses a relist of a listing that is not
 * ours, not ended, or past the 90-day window, and the post-dispatch check
 * confirms a live listing actually exists before the job resolves. A stale
 * or deleted marker only costs an automatic relist, never a wrong write.
 */
export type EndedListingMarker = Readonly<{
  sku: string;
  listingId: string;
  endedAtUtc: string;
}>;

export type QuantityBeliefStore = Readonly<{
  all: () => Map<string, QuantityBelief>;
  record: (belief: QuantityBelief) => void;
  forget: (sku: string) => void;
  recordEnded: (marker: EndedListingMarker) => void;
  endedFor: (sku: string) => EndedListingMarker | null;
  forgetEnded: (sku: string) => void;
  close: () => void;
}>;

export function openQuantityBeliefStore(databasePath: string): QuantityBeliefStore {
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec(SCHEMA);

  const selectAll = database.prepare(
    'SELECT sku, listing_id, quantity, source, observed_at_utc FROM quantity_beliefs',
  );
  const upsert = database.prepare(
    `INSERT INTO quantity_beliefs (sku, listing_id, quantity, source, observed_at_utc)
     VALUES (@sku, @listingId, @quantity, @source, @observedAtUtc)
     ON CONFLICT(sku) DO UPDATE SET
       listing_id = excluded.listing_id,
       quantity = excluded.quantity,
       source = excluded.source,
       observed_at_utc = excluded.observed_at_utc`,
  );
  const remove = database.prepare('DELETE FROM quantity_beliefs WHERE sku = ?');
  const upsertEnded = database.prepare(
    `INSERT INTO ended_listings (sku, listing_id, ended_at_utc)
     VALUES (@sku, @listingId, @endedAtUtc)
     ON CONFLICT(sku) DO UPDATE SET
       listing_id = excluded.listing_id,
       ended_at_utc = excluded.ended_at_utc`,
  );
  const selectEnded = database.prepare(
    'SELECT sku, listing_id, ended_at_utc FROM ended_listings WHERE sku = ?',
  );
  const removeEnded = database.prepare('DELETE FROM ended_listings WHERE sku = ?');

  return Object.freeze({
    all(): Map<string, QuantityBelief> {
      const beliefs = new Map<string, QuantityBelief>();
      for (const row of selectAll.all() as Array<{
        sku: string;
        listing_id: string;
        quantity: number;
        source: QuantityBeliefSource;
        observed_at_utc: string;
      }>) {
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
    record(belief: QuantityBelief): void {
      if (!Number.isSafeInteger(belief.quantity) || belief.quantity < 0) return;
      upsert.run(belief);
    },
    forget(sku: string): void {
      remove.run(sku);
    },
    recordEnded(marker: EndedListingMarker): void {
      if (!/^[0-9]{6,20}$/u.test(marker.listingId)) return;
      upsertEnded.run(marker);
    },
    endedFor(sku: string): EndedListingMarker | null {
      const row = selectEnded.get(sku) as
        { sku: string; listing_id: string; ended_at_utc: string } | undefined;
      return row
        ? Object.freeze({ sku: row.sku, listingId: row.listing_id, endedAtUtc: row.ended_at_utc })
        : null;
    },
    forgetEnded(sku: string): void {
      removeEnded.run(sku);
    },
    close(): void {
      database.close();
    },
  });
}
