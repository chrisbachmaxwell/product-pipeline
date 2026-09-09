import { describe, expect, it } from 'vitest';
import {
  createOrderImportTrigger,
  substituteArgv,
} from './order-import-trigger.js';

const POLL = ['dist/order-import-admin/index.js', 'poll', '--migration-store', '/data/x', '--max-orders', '50'];
const IMPORT = ['dist/order-import-admin/index.js', 'import', '--migration-store', '/data/x', '--order-id', '{orderId}', '--confirm-lightspeed'];
const RECONCILE = ['dist/order-import-admin/index.js', 'reconcile', '--migration-store', '/data/x', '--order-id', '{orderId}', '--job-id', '{jobId}', '--attempt-id', '{attemptId}'];
const JOB = 'order-import-job:892acb8e-f039-4a5b-a5d1-860a5985f9b0';
const ATTEMPT = 'order-import-attempt:a45d0216-ccb8-4eeb-b569-0f539c3e3a55';

function harness(outputs: {
  poll?: Record<string, unknown> | null;
  importResult?: Record<string, unknown> | null;
  reconcile?: Record<string, unknown> | null;
}) {
  const calls: string[][] = [];
  const trigger = createOrderImportTrigger({
    pollArgv: POLL,
    importArgv: IMPORT,
    reconcileArgv: RECONCILE,
    runStep: async (argv) => {
      calls.push([...argv]);
      const command = argv[1];
      if (command === 'poll') return { json: outputs.poll ?? null };
      if (command === 'import') return { json: outputs.importResult ?? null };
      return { json: outputs.reconcile ?? null };
    },
    delay: async () => {},
    setTicker: () => {},
  });
  return { trigger, calls };
}

describe('order import trigger', () => {
  it('stays fully inert without all three operator argvs', () => {
    const trigger = createOrderImportTrigger({
      pollArgv: null, importArgv: IMPORT, reconcileArgv: RECONCILE,
      runStep: async () => { throw new Error('must not run'); },
      setTicker: () => { throw new Error('must not schedule'); },
    });
    expect(trigger.armed).toBe(false);
    expect(trigger.notifySale()).toBe(false);
    trigger.startSchedule();
  });

  it('runs poll -> import -> reconcile for each eligible order with substituted ids', async () => {
    const h = harness({
      poll: { eligibleOrders: [{ orderId: '03-15157-73729' }] },
      importResult: { status: 'dispatched-unresolved', jobId: JOB, attemptId: ATTEMPT },
      reconcile: { status: 'reconciled', outcome: 'resolved_existing' },
    });
    await h.trigger.runCycle('test');
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1]).toContain('03-15157-73729');
    expect(h.calls[1]).not.toContain('{orderId}');
    expect(h.calls[2]).toContain(JOB);
    expect(h.calls[2]).toContain(ATTEMPT);
  });

  it('refuses an order id that does not match the strict grammar', async () => {
    // The poll output crosses a process boundary; nothing in it may reach an
    // argv without matching the exact eBay order id shape.
    const h = harness({
      poll: { eligibleOrders: [
        { orderId: '../../etc/passwd' },
        { orderId: '03-15157-73729; rm -rf /' },
        { orderId: 42 },
      ] },
    });
    await h.trigger.runCycle('test');
    expect(h.calls).toHaveLength(1); // poll only, zero imports
  });

  it('skips reconcile when the import returned malformed job ids', async () => {
    const h = harness({
      poll: { eligibleOrders: [{ orderId: '03-15157-73729' }] },
      importResult: { status: 'dispatched-unresolved', jobId: 'evil', attemptId: ATTEMPT },
    });
    await h.trigger.runCycle('test');
    expect(h.calls).toHaveLength(2); // poll + import, no reconcile
  });

  it('continues past a denied import to the next order', async () => {
    const h = harness({
      poll: { eligibleOrders: [{ orderId: '03-15157-73729' }, { orderId: '21-15124-43444' }] },
      importResult: { status: 'denied', code: 'IMPORT_ALREADY_RESOLVED' },
    });
    await h.trigger.runCycle('test');
    expect(h.calls).toHaveLength(3); // poll + two imports, no reconciles
  });

  it('rate-limits sale notifications to one cycle per minute', async () => {
    let clock = 1_000_000;
    const calls: string[][] = [];
    const trigger = createOrderImportTrigger({
      pollArgv: POLL, importArgv: IMPORT, reconcileArgv: RECONCILE,
      runStep: async (argv) => { calls.push([...argv]); return { json: { eligibleOrders: [] } }; },
      delay: async () => {},
      setTicker: () => {},
      now: () => clock,
    });
    expect(trigger.notifySale()).toBe(true);
    await new Promise((r) => { setTimeout(r, 0); });
    clock += 30_000;
    trigger.notifySale();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(calls).toHaveLength(1);
    clock += 40_000;
    trigger.notifySale();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(calls).toHaveLength(2);
  });
});

describe('substituteArgv', () => {
  it('substitutes every placeholder and throws on unknown ones', () => {
    expect(substituteArgv(['a', '{orderId}'], { orderId: 'x' })).toEqual(['a', 'x']);
    expect(() => substituteArgv(['{mystery}'], {})).toThrow(/PLACEHOLDER/);
  });
});
