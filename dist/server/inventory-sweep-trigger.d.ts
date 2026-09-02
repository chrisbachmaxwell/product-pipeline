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
/** Spawns the operator's command. Never imports writer code into this process. */
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
