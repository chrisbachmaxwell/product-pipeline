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
import fs from 'node:fs';
import { info, warn } from '../utils/logger.js';
/**
 * Where the last full-sweep completion is recorded. On the volume so it
 * survives restarts and redeploys — an in-memory timer would be reset by every
 * deploy, letting a busy day postpone the backstop indefinitely. Operator
 * supplied, so this module holds no knowledge of the data layout.
 */
function fullSweepStatePath(env = process.env) {
    const raw = env.INVENTORY_FULL_SWEEP_STATE_PATH;
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}
export function readLastFullSweepMs() {
    const statePath = fullSweepStatePath();
    if (statePath === null)
        return null;
    try {
        const parsed = Number(fs.readFileSync(statePath, 'utf8').trim());
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
export function writeLastFullSweepMs(completedAtMs) {
    const statePath = fullSweepStatePath();
    if (statePath === null)
        return;
    fs.writeFileSync(statePath, String(completedAtMs), 'utf8');
}
/** Coalesce a burst of webhooks (a multi-line order moves several items). */
const DEBOUNCE_MS = 5_000;
/**
 * Retries for a run that never produced a summary.
 *
 * The catalog capture fails transiently in production — LISTING_CATALOG_
 * SHOPIFY_CAPTURE_FAILED and LISTING_CATALOG_INVENTORY_CAPTURE_FAILED are both
 * observed — and a sweep that dies that way emits nothing. Without a retry a
 * single blip silently drops the inventory change until the next full sweep,
 * which is exactly the oversell gap this whole path exists to close.
 *
 * Only whole-process failures retry. A run that produced a summary already
 * did its work and is never repeated, so retries can never multiply provider
 * writes.
 */
/**
 * Failing listings named in a single summary line. A sweep is capped at 50
 * actions, so this bounds the log line without hiding a systemic failure:
 * the counters still report the true total.
 */
const MAX_LOGGED_FAILURES = 8;
const RUN_MAX_ATTEMPTS = 4;
/**
 * Linear backoff step between attempts: 5s, 10s, 15s.
 *
 * The target is the incumbent's behaviour -- an inventory change reaching eBay
 * in about 30 seconds -- and a retry schedule is part of that budget, not
 * separate from it. An earlier 20s step meant two transient capture failures
 * pushed a real change past two minutes, which reads to a seller as simply
 * broken. Four attempts inside ~30s of waiting beats three spread over a
 * minute: the failures being absorbed are brief Shopify read blips, so trying
 * sooner is both faster and likelier to land.
 */
const RUN_RETRY_BASE_MS = 5_000;
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
function parseArgv(raw) {
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
export function configuredSweepArgv(env = process.env) {
    return parseArgv(env.INVENTORY_SWEEP_ARGV);
}
/**
 * The periodic FULL sweep, which the webhook path cannot replace.
 *
 * A webhook only fires when Shopify changes. Three things it will never tell
 * us: a delivery Shopify dropped, eBay ending or relisting a listing on its
 * own, and a manual quantity edit in Seller Hub. The full sweep re-reads every
 * active listing and re-grounds every remembered eBay quantity.
 *
 * It lives here rather than in an external scheduler because the alternatives
 * do not hold: a sibling Railway cron service cannot mount the /data volume
 * (a volume attaches to exactly ONE service), and a laptop cron only runs when
 * that laptop is awake — neither is a backstop you can rely on.
 *
 * The due time is persisted on the volume, so it survives restarts and
 * redeploys: a deploy cannot indefinitely postpone the sweep by resetting an
 * in-memory timer, and an overdue sweep runs on the next tick.
 */
const FULL_SWEEP_TICK_MS = 15 * 60_000;
const DEFAULT_FULL_SWEEP_INTERVAL_HOURS = 12;
const MAX_FULL_SWEEP_INTERVAL_HOURS = 24 * 7;
export function configuredFullSweepArgv(env = process.env) {
    return parseArgv(env.INVENTORY_FULL_SWEEP_ARGV);
}
export function configuredFullSweepIntervalMs(env = process.env) {
    const raw = env.INVENTORY_FULL_SWEEP_INTERVAL_HOURS;
    const hours = raw === undefined ? DEFAULT_FULL_SWEEP_INTERVAL_HOURS : Number(raw);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_FULL_SWEEP_INTERVAL_HOURS) {
        return DEFAULT_FULL_SWEEP_INTERVAL_HOURS * 3_600_000;
    }
    return Math.round(hours * 3_600_000);
}
/**
 * Spawns the operator's command. Never imports writer code into this process.
 *
 * A NON-ZERO EXIT IS NOT NECESSARILY A FAILED RUN. `align-sweep` exits 1
 * whenever any single listing failed, even though it swept every other one
 * successfully. Treating that as a failed run was actively harmful: the
 * periodic backstop only records its completion on success, so one
 * permanently-stuck listing meant completion was never recorded, the sweep
 * was always "overdue", and a full 124-read sweep ran every 15 minutes
 * instead of every 12 hours — roughly 11,900 eBay reads a day, straight
 * through the rate limit.
 *
 * The run is therefore judged by whether it produced its summary, not by the
 * exit code. A parseable summary means the sweep ran to completion and its
 * per-listing outcomes are already reported in the counters. Only a genuine
 * process failure — crash, timeout, no output — counts as failed.
 */
/**
 * Reduce a sweep's stdout to one bounded log line, or null when the process
 * produced no parseable summary at all (crash, timeout, no output) -- which is
 * the sole condition that marks a run failed and eligible for retry.
 *
 * Reports bounded counters and failure codes only, never provider payloads.
 * Exported for testing: this used to be inline in the spawn callback, where it
 * could not be exercised without launching a real sweep.
 */
export function summarizeSweepStdout(stdout) {
    try {
        const line = stdout.split('\n').find((entry) => entry.startsWith('{'));
        if (!line)
            return null;
        const parsed = JSON.parse(line);
        let summary = `status=${parsed.status} candidates=${parsed.candidates} `
            + `aligned=${parsed.aligned} skippedNoDrift=${parsed.skippedNoDrift} `
            + `failed=${parsed.failed}`;
        // Name the listings that did not align. Counters alone proved insufficient
        // in production: a sweep reporting failed=1 gave no way to tell WHICH
        // listing was left unsynced, and an unsynced listing is the exact oversell
        // risk this path exists to close. Only entries carrying a code are
        // failures, and every code comes from safeErrorCode -- a fixed code set
        // that never carries an error message or a provider payload. Capped so a
        // wholly failing sweep cannot flood the log.
        const failures = (Array.isArray(parsed.results) ? parsed.results : [])
            .filter((entry) => typeof entry?.code === 'string')
            .slice(0, MAX_LOGGED_FAILURES)
            .map((entry) => {
            const { sku, code } = entry;
            return `${typeof sku === 'string' ? sku : 'unknown'}:${code}`;
        });
        if (failures.length > 0)
            summary += ` failures=${failures.join(',')}`;
        return summary;
    }
    catch {
        return null;
    }
}
/**
 * The refusal code a sweep printed on stderr, or a fixed label when it printed
 * nothing recognisable. Never surfaces free-form error text: only the CLI's
 * own code field, which is drawn from a fixed set.
 */
export function deniedCode(stderr) {
    try {
        const line = stderr.split('\n').reverse().find((entry) => entry.startsWith('{'));
        if (!line)
            return stderr.trim().length > 0 ? 'no-code' : 'no-output';
        const parsed = JSON.parse(line);
        return typeof parsed.code === 'string' ? parsed.code : 'no-code';
    }
    catch {
        return 'unparseable';
    }
}
export function createConfiguredRunner(argv) {
    return () => new Promise((resolve) => {
        execFile(process.execPath, [...argv], { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
            const summary = summarizeSweepStdout(stdout);
            if (summary !== null) {
                resolve({ ok: true, summary });
                return;
            }
            // No summary: the process did not complete a sweep. Say WHY.
            //
            // This callback used to discard stderr entirely, so a sweep that died
            // before emitting anything was undiagnosable from the logs -- three
            // separate production failures were each chased blind because of it.
            // The CLI reports its refusals as {status:'denied', code} on stderr,
            // and every such code comes from safeErrorCode: a fixed code set that
            // never carries a message or a provider payload.
            const reason = error && error.killed
                ? 'timed out'
                : `produced no summary (${deniedCode(stderr)})`;
            resolve({ ok: false, summary: `alignment run ${reason}` });
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
    const configuredFull = configuredFullSweepArgv();
    const runFullSweep = dependencies.runFullSweep !== undefined
        ? dependencies.runFullSweep
        : (configuredFull === null ? null : createConfiguredRunner(configuredFull));
    const debounceMs = dependencies.debounceMs ?? DEBOUNCE_MS;
    const now = dependencies.now ?? Date.now;
    const fullIntervalMs = dependencies.fullSweepIntervalMs ?? configuredFullSweepIntervalMs();
    const readDueState = dependencies.readDueState ?? readLastFullSweepMs;
    const writeDueState = dependencies.writeDueState ?? writeLastFullSweepMs;
    const setTimer = dependencies.setTimer
        ?? ((callback, ms) => setTimeout(callback, ms).unref?.());
    const setTicker = dependencies.setTicker
        ?? ((callback, ms) => setInterval(callback, ms).unref?.());
    const delay = dependencies.delay
        ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    let running = false;
    let pendingFast = false;
    let pendingFull = false;
    let scheduled = false;
    // One lock for both kinds. A full sweep and a webhook sweep must never run
    // at once: they would read the same listings and could both dispatch for the
    // same drift. A queued full sweep wins, since it supersedes a fast one.
    async function drain() {
        running = true;
        try {
            while (pendingFull || pendingFast) {
                const full = pendingFull;
                pendingFull = false;
                pendingFast = false;
                const run = full ? runFullSweep : runSweep;
                if (run === null)
                    continue;
                // Retry ONLY a run that produced no summary, i.e. one that never
                // completed a sweep. A completed run is never repeated.
                let result = await run();
                for (let attempt = 2; !result.ok && attempt <= RUN_MAX_ATTEMPTS; attempt += 1) {
                    warn(`INVENTORY_ALIGNMENT_RETRY_${attempt}`);
                    await delay(RUN_RETRY_BASE_MS * (attempt - 1));
                    result = await run();
                }
                if (result.ok) {
                    info(`[Inventory Alignment${full ? ' full' : ''}] ${result.summary}`);
                    if (full) {
                        try {
                            writeDueState(now());
                        }
                        catch {
                            warn('INVENTORY_FULL_SWEEP_STATE_WRITE_FAILED');
                        }
                    }
                }
                else {
                    warn(full ? 'INVENTORY_FULL_SWEEP_FAILED' : 'INVENTORY_WEBHOOK_ALIGNMENT_FAILED');
                }
            }
        }
        finally {
            running = false;
        }
    }
    function requestFast() {
        if (runSweep === null)
            return false;
        if (running) {
            pendingFast = true;
            return true;
        }
        if (scheduled)
            return true;
        scheduled = true;
        setTimer(() => {
            scheduled = false;
            pendingFast = true;
            void drain();
        }, debounceMs);
        return true;
    }
    function fullSweepDue() {
        if (runFullSweep === null)
            return false;
        const last = readDueState();
        // No recorded run means overdue: the first tick after enabling grounds it.
        if (last === null)
            return true;
        return now() - last >= fullIntervalMs;
    }
    function startFullSweepSchedule() {
        if (runFullSweep === null)
            return;
        setTicker(() => {
            if (!fullSweepDue())
                return;
            pendingFull = true;
            if (!running)
                void drain();
        }, FULL_SWEEP_TICK_MS);
    }
    return {
        /** Returns true when the change was accepted for an alignment run. */
        notifyInventoryChanged() {
            return requestFast();
        },
        /**
         * Begins the periodic full sweep. Deliberately NOT run at load: nothing
         * dispatches on deploy. The first tick is a quarter hour out, and only
         * runs then if genuinely overdue by the persisted due time — which is what
         * stops frequent redeploys from postponing it forever.
         */
        startFullSweepSchedule,
        fullSweepDue,
    };
}
/**
 * The one shared trigger.
 *
 * The webhook route and the periodic schedule MUST use the same instance:
 * each instance owns its own single-flight lock, so two instances would let a
 * full sweep and a webhook sweep run at once over the same listings, each
 * able to dispatch for the same drift.
 */
export const inventorySweepTrigger = createInventorySweepTrigger();
