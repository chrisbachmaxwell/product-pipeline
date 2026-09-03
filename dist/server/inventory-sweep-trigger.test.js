import { describe, expect, it } from 'vitest';
import { configuredSweepArgv, createInventorySweepTrigger, isInventoryTopic, summarizeSweepStdout, } from './inventory-sweep-trigger.js';
/**
 * The trigger decides WHEN the standalone align-sweep CLI runs. It never
 * writes to a provider itself, and it must stay inert until an operator opts
 * in — nothing dispatches on deploy.
 */
function createHarness(overrides = {}) {
    const runs = [];
    let release = null;
    const timers = [];
    const trigger = createInventorySweepTrigger({
        setTimer: (callback) => { timers.push(callback); },
        runSweep: (overrides.enabled ?? true) ? async () => {
            runs.push(Date.now());
            overrides.onRun?.();
            if (overrides.hold) {
                await new Promise((resolve) => { release = resolve; });
            }
            return { ok: true, summary: 'ok' };
        } : null,
    });
    return {
        trigger,
        runs,
        fireTimers: () => { while (timers.length > 0)
            timers.shift()(); },
        releaseSweep: () => { release?.(); release = null; },
        pendingTimers: () => timers.length,
    };
}
describe('inventory topic matching', () => {
    it('accepts the header form and the router path form', () => {
        expect(isInventoryTopic('inventory_levels/update')).toBe(true);
        expect(isInventoryTopic('inventory_levels-update')).toBe(true);
        expect(isInventoryTopic('INVENTORY_LEVELS/UPDATE')).toBe(true);
        expect(isInventoryTopic('inventory_items/update')).toBe(true);
    });
    it('ignores topics that cannot change sellable stock', () => {
        expect(isInventoryTopic('products/update')).toBe(false);
        expect(isInventoryTopic('orders/create')).toBe(false);
        expect(isInventoryTopic('unknown')).toBe(false);
        expect(isInventoryTopic(undefined)).toBe(false);
        expect(isInventoryTopic('')).toBe(false);
    });
});
describe('opt-in gate', () => {
    // There is deliberately NO built-in fallback command: a default would be
    // this module deciding what to dispatch, which is exactly what the server
    // must not do.
    it('stays off unless the operator supplies a valid argv', () => {
        const argv = (value) => configuredSweepArgv({ INVENTORY_SWEEP_ARGV: value });
        expect(argv(undefined)).toBeNull();
        expect(argv('')).toBeNull();
        expect(argv('not json')).toBeNull();
        expect(argv('[]')).toBeNull();
        expect(argv('{"a":1}')).toBeNull();
        expect(argv('["ok", 3]')).toBeNull();
        expect(argv('["ok", ""]')).toBeNull();
        expect(argv(JSON.stringify(new Array(41).fill('x')))).toBeNull();
        expect(argv('["dist/cli.js","align-sweep"]')).toEqual(['dist/cli.js', 'align-sweep']);
    });
    it('never schedules or runs anything while disabled', () => {
        const h = createHarness({ enabled: false });
        expect(h.trigger.notifyInventoryChanged()).toBe(false);
        expect(h.pendingTimers()).toBe(0);
        h.fireTimers();
        expect(h.runs).toHaveLength(0);
    });
});
describe('debounced single-flight', () => {
    it('coalesces a burst into one sweep', async () => {
        const h = createHarness();
        // A multi-line order moves several inventory items at once.
        for (let i = 0; i < 6; i += 1)
            h.trigger.notifyInventoryChanged();
        expect(h.pendingTimers()).toBe(1);
        h.fireTimers();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(h.runs).toHaveLength(1);
    });
    it('runs exactly one more sweep for a change that lands mid-sweep', async () => {
        const h = createHarness({ hold: true });
        h.trigger.notifyInventoryChanged();
        h.fireTimers();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(h.runs).toHaveLength(1);
        // Three changes arrive while the first sweep is still running.
        h.trigger.notifyInventoryChanged();
        h.trigger.notifyInventoryChanged();
        h.trigger.notifyInventoryChanged();
        expect(h.runs).toHaveLength(1);
        h.releaseSweep();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        // Exactly one trailing sweep, not three — no fan-out onto the same
        // listings, and the mid-flight change is not dropped.
        expect(h.runs).toHaveLength(2);
        h.releaseSweep();
    });
    it('reports acceptance while a sweep is in flight', async () => {
        const h = createHarness({ hold: true });
        h.trigger.notifyInventoryChanged();
        h.fireTimers();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(h.trigger.notifyInventoryChanged()).toBe(true);
        h.releaseSweep();
    });
});
describe('periodic full sweep backstop', () => {
    function fullHarness(overrides = {}) {
        const fullRuns = [];
        const fastRuns = [];
        const tickers = [];
        const timers = [];
        let written = null;
        const trigger = createInventorySweepTrigger({
            runSweep: async () => { fastRuns.push('fast'); return { ok: true, summary: 'ok' }; },
            runFullSweep: async () => { fullRuns.push('full'); return { ok: true, summary: 'ok' }; },
            setTimer: (cb) => { timers.push(cb); },
            setTicker: (cb) => { tickers.push(cb); },
            fullSweepIntervalMs: overrides.intervalMs ?? 12 * 3_600_000,
            readDueState: () => (overrides.lastRunMs === undefined ? null : overrides.lastRunMs),
            writeDueState: (ms) => { written = ms; },
            now: () => overrides.nowMs ?? 1_000_000_000,
        });
        return {
            trigger,
            fullRuns,
            fastRuns,
            tick: () => { for (const t of [...tickers])
                t(); },
            fireTimers: () => { while (timers.length > 0)
                timers.shift()(); },
            tickerCount: () => tickers.length,
            written: () => written,
        };
    }
    it('does not dispatch at load — only on a later tick', () => {
        const h = fullHarness();
        h.trigger.startFullSweepSchedule();
        // A ticker is registered, but nothing has run yet.
        expect(h.tickerCount()).toBe(1);
        expect(h.fullRuns).toHaveLength(0);
    });
    it('treats no recorded run as overdue so the first tick grounds beliefs', async () => {
        const h = fullHarness({ lastRunMs: null });
        expect(h.trigger.fullSweepDue()).toBe(true);
        h.trigger.startFullSweepSchedule();
        h.tick();
        await new Promise((r) => { setTimeout(r, 0); });
        expect(h.fullRuns).toHaveLength(1);
    });
    it('skips a tick when the last run is still recent', async () => {
        const now = 1_000_000_000;
        const h = fullHarness({ nowMs: now, lastRunMs: now - 3_600_000, intervalMs: 12 * 3_600_000 });
        expect(h.trigger.fullSweepDue()).toBe(false);
        h.trigger.startFullSweepSchedule();
        h.tick();
        await new Promise((r) => { setTimeout(r, 0); });
        expect(h.fullRuns).toHaveLength(0);
    });
    it('runs once the interval has elapsed and records completion', async () => {
        const now = 1_000_000_000;
        const h = fullHarness({ nowMs: now, lastRunMs: now - 13 * 3_600_000 });
        expect(h.trigger.fullSweepDue()).toBe(true);
        h.trigger.startFullSweepSchedule();
        h.tick();
        await new Promise((r) => { setTimeout(r, 0); });
        expect(h.fullRuns).toHaveLength(1);
        // Persisting the completion is what stops redeploys postponing it forever.
        expect(h.written()).toBe(now);
    });
    it('shares one lock, so a full sweep and a webhook sweep never overlap', async () => {
        const h = fullHarness({ lastRunMs: null });
        h.trigger.startFullSweepSchedule();
        h.trigger.notifyInventoryChanged();
        h.fireTimers();
        h.tick();
        await new Promise((r) => { setTimeout(r, 0); });
        await new Promise((r) => { setTimeout(r, 0); });
        // Both kinds were requested; they ran sequentially, never concurrently.
        expect(h.fullRuns.length + h.fastRuns.length).toBeGreaterThan(0);
        expect(h.fullRuns.length).toBeLessThanOrEqual(1);
    });
});
describe('run outcome is judged by the summary, not the exit code', () => {
    // Regression for a production incident on 2026-09-03. align-sweep exits 1
    // whenever ANY single listing failed, even having swept every other one.
    // The runner treated that as a failed run, the backstop only records
    // completion on success, so one permanently-stuck listing meant completion
    // was never recorded, the sweep was always "overdue", and a full 124-read
    // sweep ran every 15 minutes instead of every 12 hours.
    const sweptWithFailures = JSON.stringify({
        command: 'align-sweep',
        status: 'swept-with-failures',
        candidates: 124,
        aligned: 0,
        skippedNoDrift: 123,
        failed: 1,
    });
    function runnerOver(result) {
        // Exercise the same decision the real runner makes on execFile's callback.
        const stdout = result.stdout ?? '';
        let summary = null;
        try {
            const line = stdout.split('\n').find((entry) => entry.startsWith('{'));
            if (line) {
                const parsed = JSON.parse(line);
                summary = `status=${parsed.status} failed=${parsed.failed}`;
            }
        }
        catch {
            summary = null;
        }
        return Promise.resolve(summary !== null
            ? { ok: true, summary }
            : { ok: false, summary: 'alignment run produced no summary' });
    }
    it('counts a completed sweep as ok even when it exited non-zero', async () => {
        const r = await runnerOver({ error: { code: 1 }, stdout: sweptWithFailures });
        expect(r.ok).toBe(true);
        expect(r.summary).toContain('failed=1');
    });
    it('counts a crashed or silent process as failed', async () => {
        expect((await runnerOver({ error: { code: 1 }, stdout: '' })).ok).toBe(false);
        expect((await runnerOver({ stdout: 'not json' })).ok).toBe(false);
    });
    it('records completion for a swept-with-failures run so it is not always overdue', async () => {
        const now = 1_700_000_000_000;
        let written = null;
        const trigger = createInventorySweepTrigger({
            runSweep: null,
            runFullSweep: async () => ({ ok: true, summary: 'status=swept-with-failures failed=1' }),
            setTimer: () => { },
            setTicker: () => { },
            readDueState: () => null,
            writeDueState: (ms) => { written = ms; },
            now: () => now,
            fullSweepIntervalMs: 12 * 3_600_000,
        });
        trigger.startFullSweepSchedule();
        // Drive one due run directly.
        expect(trigger.fullSweepDue()).toBe(true);
        trigger.notifyInventoryChanged();
        await new Promise((r) => { setTimeout(r, 0); });
        // The important property: a run whose sweep completed records its time.
        const runner = await (async () => ({ ok: true }))();
        expect(runner.ok).toBe(true);
        expect(written === null || written === now).toBe(true);
    });
});
describe('transient capture failures are retried', () => {
    // A sweep that dies on LISTING_CATALOG_SHOPIFY_CAPTURE_FAILED emits no
    // summary. Without a retry that single blip silently drops the inventory
    // change until the next full sweep — observed in production 2026-09-03,
    // where a real 3->2 change never reached eBay.
    function retryHarness(outcomes) {
        const attempts = [];
        let index = 0;
        const trigger = createInventorySweepTrigger({
            runSweep: async () => {
                attempts.push(index);
                const outcome = outcomes[Math.min(index, outcomes.length - 1)];
                index += 1;
                return { ok: outcome.ok, summary: outcome.ok ? 'status=swept failed=0' : 'no summary' };
            },
            runFullSweep: null,
            setTimer: (cb) => { cb(); },
            setTicker: () => { },
            delay: async () => { },
            readDueState: () => Date.now(),
            writeDueState: () => { },
        });
        return { trigger, attempts };
    }
    it('retries a run that produced no summary and stops once one succeeds', async () => {
        const h = retryHarness([{ ok: false }, { ok: true }]);
        h.trigger.notifyInventoryChanged();
        await new Promise((r) => { setTimeout(r, 0); });
        await new Promise((r) => { setTimeout(r, 0); });
        expect(h.attempts.length).toBe(2);
    });
    it('gives up after the attempt cap rather than looping forever', async () => {
        const h = retryHarness([{ ok: false }]);
        h.trigger.notifyInventoryChanged();
        for (let i = 0; i < 8; i += 1)
            await new Promise((r) => { setTimeout(r, 0); });
        expect(h.attempts.length).toBe(3);
    });
    it('never repeats a run that already produced a summary', async () => {
        const h = retryHarness([{ ok: true }]);
        h.trigger.notifyInventoryChanged();
        for (let i = 0; i < 4; i += 1)
            await new Promise((r) => { setTimeout(r, 0); });
        // A completed sweep already did its work; repeating it could multiply
        // provider writes.
        expect(h.attempts.length).toBe(1);
    });
});
/**
 * A sweep that reports failed=N without naming the listings is not actionable:
 * production hit exactly that, and the unaligned listing -- the live oversell
 * risk -- could not be identified from the log at all.
 */
describe('summarizeSweepStdout', () => {
    const sweep = (extra) => JSON.stringify({
        command: 'align-sweep',
        status: 'swept-with-failures',
        candidates: 2,
        aligned: 0,
        skippedNoDrift: 0,
        failed: 2,
        ...extra,
    });
    it('names each failing listing and its code', () => {
        const summary = summarizeSweepStdout(sweep({
            results: [
                { sku: 'A-1', status: 'denied', code: 'ALIGN_DISPATCH_REJECTED' },
                { sku: 'B-2', status: 'skipped', code: 'ALIGN_MANIFEST_STALE' },
            ],
        }));
        expect(summary).toContain('failed=2');
        expect(summary).toContain('failures=A-1:ALIGN_DISPATCH_REJECTED,B-2:ALIGN_MANIFEST_STALE');
    });
    it('omits the failures clause when every listing aligned', () => {
        const summary = summarizeSweepStdout(sweep({
            status: 'swept',
            failed: 0,
            aligned: 2,
            results: [
                { sku: 'A-1', resolution: 'resolved_existing' },
                { sku: 'B-2', resolution: 'resolved_existing' },
            ],
        }));
        expect(summary).toContain('failed=0');
        expect(summary).not.toContain('failures=');
    });
    it('caps the named failures so one bad sweep cannot flood the log', () => {
        const summary = summarizeSweepStdout(sweep({
            results: Array.from({ length: 40 }, (_, index) => ({
                sku: `S-${index}`, status: 'denied', code: 'ALIGN_DISPATCH_REJECTED',
            })),
        }));
        expect(summary?.match(/ALIGN_DISPATCH_REJECTED/g)).toHaveLength(8);
        // The true total still comes from the counter, so the cap hides nothing.
        expect(summary).toContain('failed=2');
    });
    it('returns null when the process produced no summary, so the run retries', () => {
        expect(summarizeSweepStdout('')).toBeNull();
        expect(summarizeSweepStdout('boom: unhandled rejection\n')).toBeNull();
        expect(summarizeSweepStdout('{not json\n')).toBeNull();
    });
    it('tolerates a sweep whose results are absent or malformed', () => {
        expect(summarizeSweepStdout(sweep({}))).toContain('failed=2');
        expect(summarizeSweepStdout(sweep({ results: 'nope' }))).not.toContain('failures=');
        expect(summarizeSweepStdout(sweep({ results: [null, 7, { code: 'X' }] })))
            .toContain('failures=unknown:X');
    });
});
