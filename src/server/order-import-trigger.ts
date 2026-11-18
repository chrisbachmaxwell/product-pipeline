import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { info, warn } from '../utils/logger.js';

/**
 * Recent import-failure memory (L80): the denial code that explains a
 * blocked order pipeline previously lived only in log lines nobody reads —
 * on 2026-09-25 the SHOPIFY_TARGET_INVALID that froze seven orders for 40h
 * was right here in warn() output. The last few failures persist to a tiny
 * state file so the incident watchdog can put the CODE into the incident
 * itself (and the fix-proposal agent, which cannot read server logs, can
 * grep the codebase for it). Order ids and ceremony codes only — no PII.
 */
const FAILURE_MEMORY_FILE = '/data/product-pipeline/order-import-failures.json';
const FAILURE_MEMORY_CAP = 20;

export type OrderImportFailureEntry = { orderId: string; code: string; atUtc: string };

function readFailureEntries(): OrderImportFailureEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(FAILURE_MEMORY_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed)
      ? (parsed as unknown[]).filter((entry): entry is OrderImportFailureEntry => {
        const candidate = entry as Partial<OrderImportFailureEntry> | null;
        return candidate !== null && typeof candidate === 'object'
          && typeof candidate.orderId === 'string' && typeof candidate.code === 'string'
          && typeof candidate.atUtc === 'string';
      })
      : [];
  } catch {
    return [];
  }
}

function writeFailureEntries(entries: readonly OrderImportFailureEntry[]): void {
  fs.mkdirSync(path.dirname(FAILURE_MEMORY_FILE), { recursive: true });
  fs.writeFileSync(FAILURE_MEMORY_FILE, JSON.stringify(entries.slice(-FAILURE_MEMORY_CAP)));
}

/**
 * Latest failure per order (#256): a stuck order is retried every cycle, so
 * appending would let one order's repeats evict every other order's entry.
 */
export function recordOrderImportFailure(orderId: string, code: string): void {
  try {
    const entries = readFailureEntries().filter((entry) => entry.orderId !== orderId);
    entries.push({ orderId, code: code.slice(0, 80), atUtc: new Date().toISOString() });
    writeFailureEntries(entries);
  } catch { /* best effort */ }
}

/** The order got past the denial (dispatched or dedup-linked): forget it. */
export function clearOrderImportFailure(orderId: string): void {
  try {
    const entries = readFailureEntries();
    const kept = entries.filter((entry) => entry.orderId !== orderId);
    if (kept.length !== entries.length) writeFailureEntries(kept);
  } catch { /* best effort */ }
}

export function listOrderImportFailures(): OrderImportFailureEntry[] {
  return readFailureEntries();
}

export function lastOrderImportFailure(orderId: string): { code: string; atUtc: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(FAILURE_MEMORY_FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      const entry = parsed[index] as { orderId?: unknown; code?: unknown; atUtc?: unknown };
      if (entry.orderId === orderId && typeof entry.code === 'string'
        && typeof entry.atUtc === 'string') {
        return { code: entry.code, atUtc: entry.atUtc };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Automated order import: poll -> import -> reconcile, on a timer and on
 * verified eBay sale notifications.
 *
 * This module decides only WHEN the standalone order-import-admin ceremonies
 * run; the ceremonies themselves carry every guarantee (immutable watermark
 * eligibility, one-intent-per-order natural-key idempotency, dual-marker
 * dedup that links instead of creating, post-verified links, PII confined to
 * the one provider call). It exists because the gap between an eBay sale and
 * its import is a live inconsistency window: Shopify still shows the sold
 * item in stock, so in-store can oversell it and the alignment sweep trusts
 * a stale truth. Observed 2026-09-09 with three overnight orders. Five
 * minutes of window instead of overnight is the point.
 *
 * OFF BY DEFAULT. Nothing runs at load. Arming requires the operator to set
 * ORDER_POLL_ARGV, ORDER_IMPORT_ARGV, and ORDER_RECONCILE_ARGV; the import
 * and reconcile argvs carry literal placeholders ({orderId}, {jobId},
 * {attemptId}) that are substituted only with values matching strict
 * grammars, so nothing the poll returns can smuggle an argument.
 */

/**
 * Incident #256 (L130): the poll lists an order as eligible ONLY on the poll
 * that first observes it; afterwards it is "already observed". The trigger
 * imported only that list, so ONE denied import was never attempted again —
 * and the strictly-ordered poll blocks every newer page behind the
 * unresolved observation. A single transient SHOPIFY_READ_FAILED therefore
 * froze the whole order pipeline until an operator ran import by hand, and
 * the watchdog's "fix the cause and the pipeline drains automatically" was
 * false.
 *
 * Now every cycle re-runs import for each order whose LATEST recorded failure
 * is one of these codes. Every one of them is raised strictly BEFORE the
 * import ceremony creates an intent (dedup/variant/scope reads, the eBay
 * single-order read, the SKU grammar, the write-scope check), so no intent,
 * approval, job, or Shopify write exists for the order and re-running the
 * full ceremony is exactly what an operator would do: dedup pre-check
 * first, then the one-intent guard. Every other code (and a crash with no
 * summary, which may have died past the dispatch boundary) is left to
 * reconcile/the operator. The ceremony itself re-checks watermark
 * eligibility, resolution, and linkage, so this cannot widen what imports.
 */
export const RETRYABLE_PRE_INTENT_IMPORT_CODES: ReadonlySet<string> = new Set([
  'SHOPIFY_READ_FAILED',
  'SHOPIFY_AUTHORITY_UNAVAILABLE',
  'SHOPIFY_TARGET_INVALID',
  'SHOPIFY_SKU_INVALID',
  'ORDER_READ_FAILED',
  'ORDER_READ_AUTHORITY_UNAVAILABLE',
  'IMPORT_SKU_UNRESOLVED',
  'IMPORT_SHOPIFY_WRITE_SCOPE_MISSING',
]);

export type OrderImportFailureMemory = Readonly<{
  record: (orderId: string, code: string) => void;
  clear: (orderId: string) => void;
  list: () => readonly OrderImportFailureEntry[];
}>;

const fileFailureMemory: OrderImportFailureMemory = Object.freeze({
  record: recordOrderImportFailure,
  clear: clearOrderImportFailure,
  list: listOrderImportFailures,
});

const ORDER_ID = /^[0-9]{2}-[0-9]{5}-[0-9]{5,8}$/u;
const JOB_ID = /^order-import-job:[0-9a-f-]{36}$/u;
const ATTEMPT_ID = /^order-import-attempt:[0-9a-f-]{36}$/u;

const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Orders imported per cycle; the next cycle takes the rest. */
const MAX_IMPORTS_PER_CYCLE = 10;
/** Between import and reconcile, so the post-verify read can observe. */
const RECONCILE_DELAY_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
/** A sale notification triggers an immediate cycle, at most this often. */
const NOTIFY_MIN_INTERVAL_MS = 60_000;

function parseArgvEnv(name: string, env: NodeJS.ProcessEnv): readonly string[] | null {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64
      || !parsed.every((entry) => typeof entry === 'string' && entry.length <= 512)) {
      return null;
    }
    return Object.freeze(parsed as string[]);
  } catch {
    return null;
  }
}

export function configuredOrderPollArgv(env: NodeJS.ProcessEnv = process.env) {
  return parseArgvEnv('ORDER_POLL_ARGV', env);
}
export function configuredOrderImportArgv(env: NodeJS.ProcessEnv = process.env) {
  return parseArgvEnv('ORDER_IMPORT_ARGV', env);
}
export function configuredOrderReconcileArgv(env: NodeJS.ProcessEnv = process.env) {
  return parseArgvEnv('ORDER_RECONCILE_ARGV', env);
}
export function configuredPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.ORDER_POLL_INTERVAL_MINUTES);
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 120
    ? minutes * 60_000
    : DEFAULT_POLL_INTERVAL_MS;
}

/** Substitute placeholders with validated values only. */
export function substituteArgv(
  template: readonly string[],
  values: Readonly<Record<string, string>>,
): readonly string[] {
  return template.map((entry) => entry.replace(/\{([a-zA-Z]+)\}/gu, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`ORDER_TRIGGER_PLACEHOLDER_${key}`);
    return value;
  }));
}

export type StepResult = Readonly<{ json: Record<string, unknown> | null }>;
export type StepRunner = (argv: readonly string[]) => Promise<StepResult>;

export function createProcessStepRunner(): StepRunner {
  return (argv) => new Promise((resolve) => {
    execFile(
      process.execPath,
      [...argv],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (_error, stdout, stderr) => {
        for (const stream of [stdout, stderr]) {
          const line = stream.split('\n').reverse().find((entry) => entry.startsWith('{'));
          if (line) {
            try {
              resolve({ json: JSON.parse(line) as Record<string, unknown> });
              return;
            } catch { /* fall through */ }
          }
        }
        resolve({ json: null });
      },
    );
  });
}

export function createOrderImportTrigger(dependencies: Readonly<{
  runStep?: StepRunner;
  pollArgv?: readonly string[] | null;
  importArgv?: readonly string[] | null;
  reconcileArgv?: readonly string[] | null;
  pollIntervalMs?: number;
  setTicker?: (callback: () => void, ms: number) => unknown;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  failureMemory?: OrderImportFailureMemory;
}> = {}) {
  const failureMemory = dependencies.failureMemory ?? fileFailureMemory;
  const runStep = dependencies.runStep ?? createProcessStepRunner();
  const pollArgv = dependencies.pollArgv !== undefined
    ? dependencies.pollArgv : configuredOrderPollArgv();
  const importArgv = dependencies.importArgv !== undefined
    ? dependencies.importArgv : configuredOrderImportArgv();
  const reconcileArgv = dependencies.reconcileArgv !== undefined
    ? dependencies.reconcileArgv : configuredOrderReconcileArgv();
  const pollIntervalMs = dependencies.pollIntervalMs ?? configuredPollIntervalMs();
  const setTicker = dependencies.setTicker
    ?? ((callback: () => void, ms: number) => setInterval(callback, ms).unref?.());
  const delay = dependencies.delay
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const now = dependencies.now ?? Date.now;

  const armed = pollArgv !== null && importArgv !== null && reconcileArgv !== null;
  let running = false;
  let lastCycleStartedMs = Number.NEGATIVE_INFINITY;

  async function runCycle(reason: string): Promise<void> {
    if (!armed || running) return;
    running = true;
    lastCycleStartedMs = now();
    try {
      const poll = await runStep(pollArgv as readonly string[]);
      const eligible = Array.isArray(poll.json?.eligibleOrders)
        ? (poll.json.eligibleOrders as Array<Record<string, unknown>>)
        : [];
      const freshIds = eligible
        .map((entry) => entry?.orderId)
        .filter((value): value is string => typeof value === 'string' && ORDER_ID.test(value));
      if (poll.json === null) {
        warn('ORDER_IMPORT_POLL_FAILED: produced no summary');
        return;
      }
      // Previously denied pre-intent orders first: they are older than
      // anything this poll just recorded, and while one is unresolved the
      // poll blocks every newer page (#256). Runs even on a blocked poll.
      const retryIds = failureMemory.list()
        .filter((entry) => RETRYABLE_PRE_INTENT_IMPORT_CODES.has(entry.code)
          && ORDER_ID.test(entry.orderId))
        .sort((left, right) => left.atUtc.localeCompare(right.atUtc))
        .map((entry) => entry.orderId);
      const orderIds = [...new Set([...retryIds, ...freshIds])].slice(0, MAX_IMPORTS_PER_CYCLE);
      if (orderIds.length === 0) return;
      info(`[Order Import] ${reason}: ${orderIds.length} order(s) to import`
        + (retryIds.length > 0 ? ` (${retryIds.length} retry of a pre-intent denial)` : ''));
      for (const orderId of orderIds) {
        const imported = await runStep(
          substituteArgv(importArgv as readonly string[], { orderId }),
        );
        const status = typeof imported.json?.status === 'string' ? imported.json.status : 'no-summary';
        if (imported.json === null || status === 'denied') {
          const code = typeof imported.json?.code === 'string' ? imported.json.code : 'no-summary';
          warn(`ORDER_IMPORT_FAILED: ${orderId} ${code}`);
          failureMemory.record(orderId, code);
          continue;
        }
        // Past the denial: the ceremony dispatched or dedup-linked. Never
        // retry this order again from the trigger; reconcile owns it now.
        failureMemory.clear(orderId);
        if (status === 'DEDUP_LINKED_EXISTING') {
          info(`[Order Import] ${orderId} already in Shopify; linked, no order created`);
          continue;
        }
        const jobId = imported.json.jobId;
        const attemptId = imported.json.attemptId;
        if (typeof jobId !== 'string' || !JOB_ID.test(jobId)
          || typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
          warn(`ORDER_IMPORT_FAILED: ${orderId} MALFORMED_JOB_IDS`);
          continue;
        }
        await delay(RECONCILE_DELAY_MS);
        const reconciled = await runStep(
          substituteArgv(reconcileArgv as readonly string[], { orderId, jobId, attemptId }),
        );
        const outcome = typeof reconciled.json?.outcome === 'string'
          ? reconciled.json.outcome : 'no-summary';
        if (outcome === 'resolved_existing') {
          info(`[Order Import] ${orderId} imported and resolved`);
        } else {
          // The order is typically created (providerDispatchReported true) and
          // only the verification read lagged; the next cycle's poll skips it
          // as already-observed and a later reconcile closes the job.
          warn(`ORDER_IMPORT_UNRESOLVED: ${orderId} ${outcome}`);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** Verified eBay sale notification: cycle now (rate-limited). */
    notifySale(): boolean {
      if (!armed) return false;
      if (now() - lastCycleStartedMs < NOTIFY_MIN_INTERVAL_MS) return true;
      void runCycle('sale notification');
      return true;
    },
    startSchedule(): void {
      if (!armed) return;
      setTicker(() => { void runCycle('scheduled poll'); }, pollIntervalMs);
    },
    /** Exposed for tests. */
    runCycle,
    armed,
  };
}

export const orderImportTrigger = createOrderImportTrigger();
