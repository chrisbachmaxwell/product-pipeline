import { type StepRunner } from './order-import-trigger.js';
export declare function createFulfillmentTrackingTrigger(dependencies?: Readonly<{
    runStep?: StepRunner;
    discoverArgv?: readonly string[] | null;
    preflightArgv?: readonly string[] | null;
    dispatchArgv?: readonly string[] | null;
    pollIntervalMs?: number;
    setTicker?: (callback: () => void, ms: number) => unknown;
}>): {
    startSchedule(): void;
    runCycle: () => Promise<void>;
    armed: boolean;
};
export declare const fulfillmentTrackingTrigger: {
    startSchedule(): void;
    runCycle: () => Promise<void>;
    armed: boolean;
};
