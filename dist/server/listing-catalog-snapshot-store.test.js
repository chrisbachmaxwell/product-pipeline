import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createListingCatalogSnapshotStore } from './listing-catalog-snapshot-store.js';
import { createLiveListingCatalogCache } from './live-listing-catalog-source.js';
const directories = [];
afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
function temporaryPath() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-store-'));
    directories.push(directory);
    return path.join(directory, 'cache', 'snapshot.json');
}
function fakeSnapshot(observedAtUtc) {
    return {
        schemaVersion: 3,
        observedAtUtc,
        rows: [],
        summary: { active: 1, notListed: 0, attention: 0, unknown: 0, totalInStock: 1 },
    };
}
describe('listing catalog snapshot persistence', () => {
    it('round-trips a snapshot and survives restarts', () => {
        const filePath = temporaryPath();
        const store = createListingCatalogSnapshotStore(filePath);
        expect(store.load()).toBeNull();
        store.save(fakeSnapshot('2026-09-10T18:00:00.000Z'));
        const reopened = createListingCatalogSnapshotStore(filePath);
        expect(reopened.load()).toMatchObject({ observedAtUtc: '2026-09-10T18:00:00.000Z' });
    });
    it('refuses corrupt, wrong-schema, or empty files without throwing', () => {
        const filePath = temporaryPath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        for (const content of ['not json{', '[]', '{"schemaVersion":2,"observedAtUtc":"2026-01-01T00:00:00.000Z","rows":[],"summary":{}}', '']) {
            fs.writeFileSync(filePath, content);
            expect(createListingCatalogSnapshotStore(filePath).load()).toBeNull();
        }
    });
    it('seeds the cache expired: reads try live capture first, fall back to the seed on failure, and a success overwrites the file', async () => {
        const filePath = temporaryPath();
        const store = createListingCatalogSnapshotStore(filePath);
        store.save(fakeSnapshot('2026-09-10T18:00:00.000Z'));
        let captures = 0;
        let failCapture = true;
        const fresh = fakeSnapshot('2026-09-10T21:00:00.000Z');
        const cache = createLiveListingCatalogCache(async () => {
            captures += 1;
            if (failCapture)
                throw new Error('quota exhausted');
            return fresh;
        }, { persist: createListingCatalogSnapshotStore(filePath) });
        // Outage at boot: the read attempts a capture, then serves the seed.
        const served = await cache();
        expect(captures).toBe(1);
        expect(served.observedAtUtc).toBe('2026-09-10T18:00:00.000Z');
        // Recovery: the next refresh serves fresh data and persists it.
        failCapture = false;
        await expect(cache.refresh()).resolves.toMatchObject({
            observedAtUtc: '2026-09-10T21:00:00.000Z',
        });
        expect(createListingCatalogSnapshotStore(filePath).load()).toMatchObject({
            observedAtUtc: '2026-09-10T21:00:00.000Z',
        });
    });
});
