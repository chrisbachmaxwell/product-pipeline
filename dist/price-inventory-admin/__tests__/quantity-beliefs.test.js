import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openQuantityBeliefStore } from '../quantity-beliefs.js';
const roots = [];
afterEach(() => {
    while (roots.length > 0)
        fs.rmSync(roots.pop(), { recursive: true, force: true });
});
function storePath() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantity-beliefs-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    return path.join(root, 'beliefs.sqlite');
}
const belief = (overrides = {}) => ({
    sku: 'STE2-U809',
    listingId: '147527016926',
    quantity: 1,
    source: 'observed_no_drift',
    observedAtUtc: '2026-09-02T00:00:00.000Z',
    ...overrides,
});
describe('quantity belief store', () => {
    it('round-trips a belief and overwrites by sku', () => {
        const store = openQuantityBeliefStore(storePath());
        try {
            store.record(belief());
            expect(store.all().get('STE2-U809')).toMatchObject({ quantity: 1, source: 'observed_no_drift' });
            store.record(belief({ quantity: 0, source: 'aligned' }));
            expect(store.all().size).toBe(1);
            expect(store.all().get('STE2-U809')).toMatchObject({ quantity: 0, source: 'aligned' });
        }
        finally {
            store.close();
        }
    });
    it('forgets a sku so the next sweep re-reads it', () => {
        const store = openQuantityBeliefStore(storePath());
        try {
            store.record(belief());
            store.forget('STE2-U809');
            expect(store.all().has('STE2-U809')).toBe(false);
        }
        finally {
            store.close();
        }
    });
    it('refuses a nonsensical quantity rather than remembering it', () => {
        const store = openQuantityBeliefStore(storePath());
        try {
            store.record(belief({ quantity: -1 }));
            store.record(belief({ sku: 'X', quantity: 1.5 }));
            store.record(belief({ sku: 'Y', quantity: Number.NaN }));
            expect(store.all().size).toBe(0);
        }
        finally {
            store.close();
        }
    });
    it('persists across reopen, since a sweep is a separate process each run', () => {
        const databasePath = storePath();
        const first = openQuantityBeliefStore(databasePath);
        first.record(belief({ quantity: 3 }));
        first.close();
        const second = openQuantityBeliefStore(databasePath);
        try {
            expect(second.all().get('STE2-U809')?.quantity).toBe(3);
        }
        finally {
            second.close();
        }
    });
    it('starts empty, so a first run behaves like a full sweep', () => {
        const store = openQuantityBeliefStore(storePath());
        try {
            expect(store.all().size).toBe(0);
        }
        finally {
            store.close();
        }
    });
});
