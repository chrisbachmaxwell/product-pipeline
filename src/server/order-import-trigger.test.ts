import { describe, expect, it } from 'vitest';
import {
  createOrderImportTrigger,
  RETRYABLE_PRE_INTENT_IMPORT_CODES,
  substituteArgv,
  type OrderImportFailureEntry,
  type OrderImportFailureMemory,
} from './order-import-trigger.js';

function memoryStore(initial: OrderImportFailureEntry[] = []) {
  let entries = [...initial];
  const memory: OrderImportFailureMemory = {
    record: (orderId, code) => {
      entries = entries.filter((entry) => entry.orderId !== orderId);
      entries.push({ orderId, code, atUtc: new Date().toISOString() });
    },
    clear: (orderId) => { entries = entries.filter((entry) => entry.orderId !== orderId); },
    list: () => [...entries],
  };
  return { memory, entries: () => entries };
}

const createdRecently = new Date(Date.now() - 1_000).toISOString();
const POLL = ['dist/order-import-admin/index.js', 'poll', '--migration-store', '/data/x', '--max-orders', '50'];
const IMPORT = ['dist/order-import-admin/index.js', 'import', '--migration-store', '/data/x', '--order-id', '{orderId}', '--confirm-lightspeed'];
const RECONCILE = ['dist/order-import-admin/index.js', 'reconcile', '--migration-store', '/data/x', '--order-id', '{orderId}', '--job-id', '{jobId}', '--attempt-id', '{attemptId}'];
const JOB = 'order-import-job:892acb8e-f039-4a5b-a5d1-860a5985f9b0';
const ATTEMPT = 'order-import-attempt:a45d0216-ccb8-4eeb-b569-0f539c3e3a55';

function harness(outputs: {
  poll?: Record<string, unknown> | null;
  importResult?: Record<string, unknown> | null;
  reconcile?: Record<string, unknown> | null;
}, memory: OrderImportFailureMemory = memoryStore().memory) {
  const calls: string[][] = [];
  const trigger = createOrderImportTrigger({
    failureMemory: memory,
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
      poll: { eligibleOrders: [{ orderId: '03-15157-73729', creationDateUtc: createdRecently }] },
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
      poll: { eligibleOrders: [{ orderId: '03-15157-73729', creationDateUtc: createdRecently }] },
      importResult: { status: 'dispatched-unresolved', jobId: 'evil', attemptId: ATTEMPT },
    });
    await h.trigger.runCycle('test');
    expect(h.calls).toHaveLength(2); // poll + import, no reconcile
  });

  it('continues past a denied import to the next order', async () => {
    const h = harness({
      poll: { eligibleOrders: [{ orderId: '03-15157-73729', creationDateUtc: createdRecently }, { orderId: '21-15124-43444', creationDateUtc: createdRecently }] },
      importResult: { status: 'denied', code: 'IMPORT_ALREADY_RESOLVED' },
    });
    await h.trigger.runCycle('test');
    expect(h.calls).toHaveLength(3); // poll + two imports, no reconciles
  });

  // Incident #256 (L130): order 19-15430-77787 was denied once with
  // SHOPIFY_READ_FAILED. The poll lists an order as eligible only on first
  // observation, so the trigger never tried it again and the blocked poll
  // froze every paid order behind it.
  describe('retry of a pre-intent denial (#256)', () => {
    const STUCK = '19-15430-77787';
    const NEWER = '19-15431-00001';

    it('re-imports the stuck order on the next cycle even though the poll no longer lists it', async () => {
      const store = memoryStore();
      let importStatus: Record<string, unknown> = { status: 'denied', code: 'SHOPIFY_READ_FAILED' };
      const calls: string[][] = [];
      let pollJson: Record<string, unknown> = { status: 'polled', eligibleOrders: [{ orderId: STUCK, creationDateUtc: createdRecently }] };
      const trigger = createOrderImportTrigger({
        pollArgv: POLL, importArgv: IMPORT, reconcileArgv: RECONCILE,
        failureMemory: store.memory,
        runStep: async (argv) => {
          calls.push([...argv]);
          if (argv[1] === 'poll') return { json: pollJson };
          if (argv[1] === 'import') return { json: importStatus };
          return { json: { outcome: 'resolved_existing' } };
        },
        delay: async () => {}, setTicker: () => {},
      });

      // Cycle 1: first observation, transient read failure.
      await trigger.runCycle('test');
      expect(store.entries()).toEqual([expect.objectContaining({ orderId: STUCK, code: 'SHOPIFY_READ_FAILED' })]);

      // Cycle 2: the poll is now BLOCKED behind the unresolved observation
      // and lists nothing eligible. The stuck order must still be imported.
      pollJson = {
        status: 'blocked',
        code: 'POLL_PREVIOUS_PAGE_UNRESOLVED',
        pendingPreIntentOrderIds: [STUCK],
        newOrdersNotRecorded: [{ orderId: NEWER, creationDateUtc: createdRecently }],
      };
      importStatus = { status: 'dispatched-unresolved', jobId: JOB, attemptId: ATTEMPT };
      calls.length = 0;
      await trigger.runCycle('test');
      expect(calls.map((argv) => argv[1])).toEqual(['poll', 'import', 'reconcile']);
      expect(calls[1]).toContain(STUCK);
      // Never an import of an order the poll did not record (L11 boundary
      // stays with the ceremony): the blocked poll's NEWER is not touched.
      expect(calls.flat()).not.toContain(NEWER);
      // Past the denial: forgotten, so it is never retried by the trigger again.
      expect(store.entries()).toEqual([]);

      calls.length = 0;
      pollJson = { status: 'polled', eligibleOrders: [] };
      await trigger.runCycle('test');
      expect(calls.map((argv) => argv[1])).toEqual(['poll']);
    });

    it('retries the stuck order before newly eligible orders, once each', async () => {
      const store = memoryStore([{ orderId: STUCK, code: 'SHOPIFY_READ_FAILED', atUtc: '2026-11-18T18:57:14.973Z' }]);
      const h = harness({
        poll: { eligibleOrders: [{ orderId: NEWER, creationDateUtc: createdRecently }, { orderId: STUCK, creationDateUtc: createdRecently }], pendingPreIntentOrderIds: [STUCK] },
        importResult: { status: 'denied', code: 'SHOPIFY_READ_FAILED' },
      }, store.memory);
      await h.trigger.runCycle('test');
      expect(h.calls.filter((argv) => argv[1] === 'import').map((argv) => argv[5]))
        .toEqual([STUCK, NEWER]);
    });

    it('does not retry a code that may sit past the dispatch boundary or is terminal', async () => {
      for (const code of ['no-summary', 'IMPORT_INTENT_ALREADY_RECORDED', 'IMPORT_ALREADY_RESOLVED',
        'MIGRATION_STORE_CONFLICT', 'ORDER_IMPORT_DENIED']) {
        expect(RETRYABLE_PRE_INTENT_IMPORT_CODES.has(code)).toBe(false);
        const store = memoryStore([{ orderId: STUCK, code, atUtc: '2026-11-18T18:57:14.973Z' }]);
        const h = harness({ poll: { eligibleOrders: [], pendingPreIntentOrderIds: [STUCK] } }, store.memory);
        await h.trigger.runCycle('test');
        expect(h.calls).toHaveLength(1); // poll only
      }
    });

    it('stops retrying once the ceremony answers with a terminal code', async () => {
      const store = memoryStore([{ orderId: STUCK, code: 'SHOPIFY_READ_FAILED', atUtc: '2026-11-18T18:57:14.973Z' }]);
      const h = harness({
        poll: { eligibleOrders: [], pendingPreIntentOrderIds: [STUCK] },
        importResult: { status: 'denied', code: 'IMPORT_ALREADY_RESOLVED' },
      }, store.memory);
      await h.trigger.runCycle('test');
      await h.trigger.runCycle('test');
      expect(h.calls.filter((argv) => argv[1] === 'import')).toHaveLength(1);
    });

    it('ignores legacy failure entries outside the active page and a denied poll', async () => {
      const store = memoryStore([{ orderId: STUCK, code: 'SHOPIFY_READ_FAILED', atUtc: '2026-09-26T00:00:00.000Z' }]);
      for (const poll of [{ pendingPreIntentOrderIds: [] }, { status: 'denied' }]) {
        const h = harness({ poll }, store.memory);
        await h.trigger.runCycle('test');
        expect(h.calls).toHaveLength(1);
      }
    });

    it('defers the rest of a rate-limited page and excludes out-of-window fresh orders', async () => {
      const h = harness({
        poll: { eligibleOrders: [
          { orderId: NEWER, creationDateUtc: '2020-01-01T00:00:00.000Z' },
          { orderId: NEWER },
        ], pendingPreIntentOrderIds: [STUCK, '20-00000-00001'] },
        importResult: { status: 'denied', code: 'MIGRATION_STORE_ORDER_RATE_LIMITED' },
      });
      await h.trigger.runCycle('test');
      expect(h.calls.map((argv) => argv[1])).toEqual(['poll', 'import']);
      expect(h.calls[1]).toContain(STUCK);
    });

    it('does not retry when the poll itself produced no summary', async () => {
      const store = memoryStore([{ orderId: STUCK, code: 'SHOPIFY_READ_FAILED', atUtc: '2026-11-18T18:57:14.973Z' }]);
      const h = harness({ poll: null }, store.memory);
      await h.trigger.runCycle('test');
      expect(h.calls).toHaveLength(1);
    });

    it('treats a dedup link as success: no reconcile, memory cleared', async () => {
      const store = memoryStore([{ orderId: STUCK, code: 'SHOPIFY_READ_FAILED', atUtc: '2026-11-18T18:57:14.973Z' }]);
      const h = harness({
        poll: { eligibleOrders: [], pendingPreIntentOrderIds: [STUCK] },
        importResult: { status: 'DEDUP_LINKED_EXISTING', orderId: STUCK },
      }, store.memory);
      await h.trigger.runCycle('test');
      expect(h.calls.map((argv) => argv[1])).toEqual(['poll', 'import']);
      expect(store.entries()).toEqual([]);
    });
  });

  it('rate-limits sale notifications to one cycle per minute', async () => {
    let clock = 1_000_000;
    const calls: string[][] = [];
    const trigger = createOrderImportTrigger({
      pollArgv: POLL, importArgv: IMPORT, reconcileArgv: RECONCILE,
      runStep: async (argv) => { calls.push([...argv]); return { json: { eligibleOrders: [] } }; },
      failureMemory: memoryStore().memory,
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
