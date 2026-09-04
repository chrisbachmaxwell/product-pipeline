export declare function readLastFullSweepMs(): number | null;
export declare function writeLastFullSweepMs(completedAtMs: number): void;
export declare function isInventoryTopic(rawTopic: string | undefined): boolean;
export declare function configuredSweepArgv(env?: NodeJS.ProcessEnv): readonly string[] | null;
export declare function configuredFullSweepArgv(env?: NodeJS.ProcessEnv): readonly string[] | null;
export declare function configuredFullSweepIntervalMs(env?: NodeJS.ProcessEnv): number;
export type SweepRunner = () => Promise<{
    ok: boolean;
    summary: string;
}>;
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
export declare function summarizeSweepStdout(stdout: string): string | null;
/**
 * The refusal code a sweep printed on stderr, or a fixed label when it printed
 * nothing recognisable. Never surfaces free-form error text: only the CLI's
 * own code field, which is drawn from a fixed set.
 */
export declare function deniedCode(stderr: string): string;
export declare function createConfiguredRunner(argv: readonly string[]): SweepRunner;
/**
 * Debounced single-flight trigger.
 *
 * At most one run happens at a time. Webhooks arriving during a run set a
 * trailing flag so exactly one more follows — a burst can never fan out into
 * concurrent runs competing over the same listings, and a change landing
 * mid-run is never dropped.
 */
export declare function createInventorySweepTrigger(dependencies?: Readonly<{
    runSweep?: SweepRunner | null;
    runFullSweep?: SweepRunner | null;
    debounceMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    setTicker?: (callback: () => void, ms: number) => unknown;
    fullSweepIntervalMs?: number;
    readDueState?: () => number | null;
    writeDueState?: (completedAtMs: number) => void;
    now?: () => number;
    delay?: (ms: number) => Promise<void>;
}>): {
    /** Returns true when the change was accepted for an alignment run. */
    notifyInventoryChanged(): boolean;
    /**
     * Begins the periodic full sweep. Deliberately NOT run at load: nothing
     * dispatches on deploy. The first tick is a quarter hour out, and only
     * runs then if genuinely overdue by the persisted due time — which is what
     * stops frequent redeploys from postponing it forever.
     */
    startFullSweepSchedule: () => void;
    fullSweepDue: () => boolean;
};
/**
 * The one shared trigger.
 *
 * The webhook route and the periodic schedule MUST use the same instance:
 * each instance owns its own single-flight lock, so two instances would let a
 * full sweep and a webhook sweep run at once over the same listings, each
 * able to dispatch for the same drift.
 */
export declare const inventorySweepTrigger: {
    /** Returns true when the change was accepted for an alignment run. */
    notifyInventoryChanged(): boolean;
    /**
     * Begins the periodic full sweep. Deliberately NOT run at load: nothing
     * dispatches on deploy. The first tick is a quarter hour out, and only
     * runs then if genuinely overdue by the persisted due time — which is what
     * stops frequent redeploys from postponing it forever.
     */
    startFullSweepSchedule: () => void;
    fullSweepDue: () => boolean;
};
