import { type StepRunner } from './order-import-trigger.js';
export declare function tryAcquirePublishLock(): boolean;
export declare function releasePublishLock(): void;
export type PublishAllItem = Readonly<{
    sku: string;
    title: string;
    status: 'published' | 'skipped' | 'failed';
    listingId?: string;
    reason?: string;
}>;
export type PublishAllStatus = Readonly<{
    state: 'idle' | 'running' | 'finished' | 'stopped';
    startedAtUtc: string | null;
    finishedAtUtc: string | null;
    startedBy: string | null;
    totalReady: number;
    currentSku: string | null;
    items: readonly PublishAllItem[];
    /** Set when an unknown failure shape stopped the run. */
    stopReason: string | null;
}>;
export declare function getPublishAllStatus(): PublishAllStatus;
type SnapshotRow = {
    id: string;
    readyToList?: boolean;
    readyToListGaps?: readonly string[];
    shopify: {
        sku: string;
        title: string;
    } | null;
};
type DraftServiceLike = {
    get: (catalogId: string) => Promise<{
        revision: null | {
            revisionDigest: string;
        };
        base: {
            sourceDigest: string;
            ebayDigest: string;
        };
        sections: {
            listing: {
                title: {
                    draft: string | null;
                };
                conditionDescription: {
                    draft: string | null;
                    shopify: string | null;
                };
            };
            content: {
                itemSpecifics: {
                    draft: string | null;
                };
            };
        };
    }>;
    save: (request: unknown, actor: string) => Promise<{
        revision: {
            revisionDigest: string;
        };
    }>;
};
export type PublishAllDependencies = Readonly<{
    getSnapshot?: () => Promise<{
        rows: readonly SnapshotRow[];
    }>;
    draftService?: DraftServiceLike;
    runStep?: StepRunner;
    sleep?: (ms: number) => Promise<void>;
    now?: () => string;
    maxItems?: number;
}>;
/**
 * Start a publish-all run in the background. Returns false when another
 * publish (single or batch) is already holding the lock. The returned
 * promise settles when the run ends but callers normally fire-and-forget.
 */
export declare function startPublishAllRun(startedBy: string, dependencies?: PublishAllDependencies): {
    started: boolean;
    run?: Promise<void>;
};
/**
 * Operator-armed schedule: PUBLISH_ALL_INTERVAL_MINUTES (min 60). Arming the
 * variable is the operator's standing batch approval, exactly like the
 * armed inventory sweep. Off by default; absent or invalid = no schedule.
 */
export declare function initPublishAllSchedule(dependencies?: PublishAllDependencies): NodeJS.Timeout | null;
export {};
