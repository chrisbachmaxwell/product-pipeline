export declare function isInventoryTopic(rawTopic: string | undefined): boolean;
/**
 * The operator-supplied argv, as a JSON array of strings passed to `node`.
 * Absent, malformed, empty, or implausibly long means the trigger stays off —
 * it never falls back to a built-in command, because a default would be this
 * module deciding what to dispatch.
 */
export declare function configuredSweepArgv(env?: NodeJS.ProcessEnv): readonly string[] | null;
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
    debounceMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
}>): {
    /** Returns true when the change was accepted for an alignment run. */
    notifyInventoryChanged(): boolean;
};
