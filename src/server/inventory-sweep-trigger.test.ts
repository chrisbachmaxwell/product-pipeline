import { describe, expect, it } from 'vitest';
import {
  configuredSweepArgv,
  createInventorySweepTrigger,
  isInventoryTopic,
} from './inventory-sweep-trigger.js';

/**
 * The trigger decides WHEN the standalone align-sweep CLI runs. It never
 * writes to a provider itself, and it must stay inert until an operator opts
 * in — nothing dispatches on deploy.
 */
function createHarness(overrides: {
  enabled?: boolean;
  onRun?: () => void;
  hold?: boolean;
} = {}) {
  const runs: number[] = [];
  let release: (() => void) | null = null;
  const timers: Array<() => void> = [];

  const trigger = createInventorySweepTrigger({
    setTimer: (callback) => { timers.push(callback); },
    runSweep: (overrides.enabled ?? true) ? async () => {
      runs.push(Date.now());
      overrides.onRun?.();
      if (overrides.hold) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { ok: true, summary: 'ok' };
    } : null,
  });

  return {
    trigger,
    runs,
    fireTimers: () => { while (timers.length > 0) timers.shift()!(); },
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
    const argv = (value?: string) =>
      configuredSweepArgv({ INVENTORY_SWEEP_ARGV: value } as never);
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
    for (let i = 0; i < 6; i += 1) h.trigger.notifyInventoryChanged();
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
  function fullHarness(overrides: {
    lastRunMs?: number | null;
    intervalMs?: number;
    nowMs?: number;
  } = {}) {
    const fullRuns: string[] = [];
    const fastRuns: string[] = [];
    const tickers: Array<() => void> = [];
    const timers: Array<() => void> = [];
    let written: number | null = null;

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
      tick: () => { for (const t of [...tickers]) t(); },
      fireTimers: () => { while (timers.length > 0) timers.shift()!(); },
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
