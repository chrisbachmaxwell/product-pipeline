import { describe, expect, it, vi } from 'vitest';
import { startLiveListingCatalogRefresher } from './live-listing-catalog-source.js';
describe('live listing catalog background refresher', () => {
    it('starts one read-only refresh, schedules bounded refreshes, and stops cleanly', async () => {
        const refresh = vi.fn(async () => undefined);
        let scheduled = null;
        const unref = vi.fn();
        const setIntervalImpl = vi.fn((callback, intervalMs) => {
            expect(intervalMs).toBe(60_000);
            scheduled = callback;
            return { unref };
        });
        const stop = startLiveListingCatalogRefresher({ refresh }, { setIntervalImpl });
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(unref).toHaveBeenCalledOnce();
        const scheduledCallback = scheduled;
        scheduledCallback?.();
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
        expect(() => stop()).not.toThrow();
    });
    it('contains a failed refresh and rejects unsafe intervals', async () => {
        const refresh = vi.fn(async () => { throw new Error('unavailable'); });
        const setIntervalImpl = (vi.fn(() => ({ unref: vi.fn() })));
        expect(() => startLiveListingCatalogRefresher({ refresh }, { intervalMs: 1_000, setIntervalImpl })).toThrow('Live listing catalog is unavailable');
        expect(() => startLiveListingCatalogRefresher({ refresh }, { setIntervalImpl })).not.toThrow();
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    });
});
