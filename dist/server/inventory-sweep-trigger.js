/**
 * Event-driven inventory alignment: a verified Shopify inventory webhook
 * triggers an operator-configured alignment command.
 *
 * WHY THIS EXISTS. Marketplace Connect's inventory sync was switched off when
 * `inventory` ownership moved to product_pipeline. Without a replacement, an
 * item selling in-store never decrements eBay and a one-of-one listing
 * oversells. Polling for that is expensive — a full sweep is ~117 eBay reads —
 * so the change signal has to come from Shopify instead.
 *
 * WHAT THIS DOES NOT DO. The server never writes to a provider, and it holds
 * no knowledge of the migration store, the scope key, or the alignment flags:
 * a boundary test asserts nothing in `src/server` references the migration
 * store, and that guard is correct. The whole command lives in
 * INVENTORY_SWEEP_ARGV, supplied by the operator. This module only decides
 * WHEN to run it and guarantees it never runs concurrently with itself.
 *
 * That is a deliberate reading of the writer quarantine: the server may
 * trigger a write, never perform one, and never describe one.
 *
 * OFF BY DEFAULT. Nothing dispatches on deploy. With INVENTORY_SWEEP_ARGV
 * unset the trigger is inert, so shipping this changes no behavior until an
 * operator opts in. The ownership kill switch still applies underneath:
 * recording `inventory` back to `paused` makes every spawned run deny before
 * it touches anything.
 */
import { execFile } from 'node:child_process';
import { info, warn } from '../utils/logger.js';
/** Coalesce a burst of webhooks (a multi-line order moves several items). */
const DEBOUNCE_MS = 5_000;
/** A run that has not finished in this long is treated as stuck. */
const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARGV_ENTRIES = 40;
/** Topics that can change sellable stock. Anything else is ignored. */
const INVENTORY_TOPICS = Object.freeze([
    'inventory_levels/update',
    'inventory_levels/connect',
    'inventory_levels/disconnect',
    'inventory_items/update',
]);
export function isInventoryTopic(rawTopic) {
    if (typeof rawTopic !== 'string')
        return false;
    // Accept both the header form (inventory_levels/update) and the path form
    // this router receives (inventory_levels-update).
    const normalized = rawTopic.trim().toLocaleLowerCase('en-US').replace(/-/gu, '/');
    return INVENTORY_TOPICS.includes(normalized);
}
/**
 * The operator-supplied argv, as a JSON array of strings passed to `node`.
 * Absent, malformed, empty, or implausibly long means the trigger stays off —
 * it never falls back to a built-in command, because a default would be this
 * module deciding what to dispatch.
 */
export function configuredSweepArgv(env = process.env) {
    const raw = env.INVENTORY_SWEEP_ARGV;
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ARGV_ENTRIES) {
        return null;
    }
    if (!parsed.every((entry) => typeof entry === 'string' && entry.length > 0))
        return null;
    return Object.freeze([...parsed]);
}
/** Spawns the operator's command. Never imports writer code into this process. */
export function createConfiguredRunner(argv) {
    return () => new Promise((resolve) => {
        execFile(process.execPath, [...argv], { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
            if (error) {
                resolve({ ok: false, summary: 'alignment process failed' });
                return;
            }
            // Report only bounded counters, never provider payloads.
            let summary = 'completed';
            try {
                const line = stdout.split('\n').find((entry) => entry.startsWith('{'));
                if (line) {
                    const parsed = JSON.parse(line);
                    summary = `candidates=${parsed.candidates} aligned=${parsed.aligned} `
                        + `skippedNoDrift=${parsed.skippedNoDrift} failed=${parsed.failed}`;
                }
            }
            catch {
                summary = 'completed with unparseable output';
            }
            resolve({ ok: true, summary });
        });
    });
}
/**
 * Debounced single-flight trigger.
 *
 * At most one run happens at a time. Webhooks arriving during a run set a
 * trailing flag so exactly one more follows — a burst can never fan out into
 * concurrent runs competing over the same listings, and a change landing
 * mid-run is never dropped.
 */
export function createInventorySweepTrigger(dependencies = {}) {
    const configured = configuredSweepArgv();
    const runSweep = dependencies.runSweep !== undefined
        ? dependencies.runSweep
        : (configured === null ? null : createConfiguredRunner(configured));
    const debounceMs = dependencies.debounceMs ?? DEBOUNCE_MS;
    const setTimer = dependencies.setTimer
        ?? ((callback, ms) => setTimeout(callback, ms).unref?.());
    let running = false;
    let pending = false;
    let scheduled = false;
    async function drain(run) {
        running = true;
        try {
            do {
                pending = false;
                const result = await run();
                if (result.ok)
                    info(`[Inventory Alignment] ${result.summary}`);
                else
                    warn('INVENTORY_WEBHOOK_ALIGNMENT_FAILED');
            } while (pending);
        }
        finally {
            running = false;
        }
    }
    return {
        /** Returns true when the change was accepted for an alignment run. */
        notifyInventoryChanged() {
            if (runSweep === null)
                return false;
            if (running) {
                // A run is mid-flight; guarantee one more pass after it.
                pending = true;
                return true;
            }
            if (scheduled)
                return true;
            scheduled = true;
            setTimer(() => {
                scheduled = false;
                void drain(runSweep);
            }, debounceMs);
            return true;
        },
    };
}
