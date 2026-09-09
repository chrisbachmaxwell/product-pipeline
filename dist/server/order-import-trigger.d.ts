export declare function configuredOrderPollArgv(env?: NodeJS.ProcessEnv): readonly string[] | null;
export declare function configuredOrderImportArgv(env?: NodeJS.ProcessEnv): readonly string[] | null;
export declare function configuredOrderReconcileArgv(env?: NodeJS.ProcessEnv): readonly string[] | null;
export declare function configuredPollIntervalMs(env?: NodeJS.ProcessEnv): number;
/** Substitute placeholders with validated values only. */
export declare function substituteArgv(template: readonly string[], values: Readonly<Record<string, string>>): readonly string[];
export type StepResult = Readonly<{
    json: Record<string, unknown> | null;
}>;
export type StepRunner = (argv: readonly string[]) => Promise<StepResult>;
export declare function createProcessStepRunner(): StepRunner;
export declare function createOrderImportTrigger(dependencies?: Readonly<{
    runStep?: StepRunner;
    pollArgv?: readonly string[] | null;
    importArgv?: readonly string[] | null;
    reconcileArgv?: readonly string[] | null;
    pollIntervalMs?: number;
    setTicker?: (callback: () => void, ms: number) => unknown;
    delay?: (ms: number) => Promise<void>;
    now?: () => number;
}>): {
    /** Verified eBay sale notification: cycle now (rate-limited). */
    notifySale(): boolean;
    startSchedule(): void;
    /** Exposed for tests. */
    runCycle: (reason: string) => Promise<void>;
    armed: boolean;
};
export declare const orderImportTrigger: {
    /** Verified eBay sale notification: cycle now (rate-limited). */
    notifySale(): boolean;
    startSchedule(): void;
    /** Exposed for tests. */
    runCycle: (reason: string) => Promise<void>;
    armed: boolean;
};
