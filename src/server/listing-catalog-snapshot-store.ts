/**
 * Disk persistence for the last GOOD listing-catalog snapshot — a local
 * cache file on the service volume, nothing more. Motivated 2026-09-10:
 * the snapshot lived only in process memory, so the day's deploys wiped it
 * repeatedly, and once eBay's Trading quota was exhausted there was nothing
 * left to serve — the whole listings UI went dark when it could have shown
 * honest, labeled, hours-old state instead.
 *
 * READ-side only by design: the UI may render a stale snapshot (its
 * `observedAtUtc` travels with it and the UI labels the age); every WRITE
 * ceremony still captures its own fresh state and fails closed. Loading
 * trusts nothing structurally: bounded size, JSON parse, and a shape check
 * on the fields the server serves. Saving is atomic (tmp + rename) and
 * swallow-on-failure — the cache must never take the capture path down.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LiveListingCatalogSnapshot } from './live-listing-catalog.js';

const DEFAULT_PATH = '/data/cache/listing-catalog-snapshot.json';
const MAX_FILE_BYTES = 64_000_000;

export type ListingCatalogSnapshotStore = Readonly<{
  load: () => LiveListingCatalogSnapshot | null;
  save: (snapshot: LiveListingCatalogSnapshot) => void;
}>;

export function createListingCatalogSnapshotStore(
  filePath: string = process.env.LISTING_SNAPSHOT_CACHE_PATH ?? DEFAULT_PATH,
): ListingCatalogSnapshotStore {
  return Object.freeze({
    load(): LiveListingCatalogSnapshot | null {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const snapshot = parsed as Record<string, unknown>;
        if (snapshot.schemaVersion !== 3
          || typeof snapshot.observedAtUtc !== 'string'
          || Number.isNaN(Date.parse(snapshot.observedAtUtc))
          || !Array.isArray(snapshot.rows)
          || snapshot.summary === null
          || typeof snapshot.summary !== 'object') return null;
        return snapshot as unknown as LiveListingCatalogSnapshot;
      } catch {
        return null;
      }
    },
    save(snapshot: LiveListingCatalogSnapshot): void {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(snapshot));
        fs.renameSync(temporaryPath, filePath);
      } catch {
        // Cache write failure is silent by design; the in-memory copy and
        // the capture path are unaffected.
      }
    },
  });
}
