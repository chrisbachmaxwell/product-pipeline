/**
 * Publish-everything-ready runner — the in-app version of the operator's
 * proven box script (scripts/publish-ready.mjs, Brain L63/L69/L71).
 *
 * ZERO provider writes happen in this process: every eBay write goes through
 * the standalone listing-lifecycle-admin ceremonies (preflight-create →
 * dispatch-create → reconcile / recover chain), spawned from the SAME
 * operator-armed PUBLISH_*_ARGV templates the one-item publish route uses.
 * The G18 batch-approval precedent applies exactly as it does to the
 * inventory align-sweep: the operator's single action (the Publish-All
 * click, or arming the schedule interval) approves the bounded batch, and
 * every item still runs the full per-target ceremony with its idempotent
 * intent, single-use approval, and post-dispatch reconciliation.
 *
 * Behavior mirrors the script, learned failure by failure:
 * - one item at a time, 40s between preflight and dispatch, 60s between
 *   items (each ceremony captures the whole store — Shopify's rate budget
 *   is a first-class parameter, L63)
 * - missing drafts get a pure-inherit save (auto-defaults fill everything
 *   derivable, including title-marker conditions, L69)
 * - CREATE_BASE_STALE auto-rebases the draft and retries (L69)
 * - a dispatch refused for a reason a fresh preflight can
 *   clear is re-checked and re-dispatched once (L97)
 * - an eBay server error (5xx) gets one more attempt from a refreshed
 *   draft once its leftovers are cleared, and a draft an earlier closed
 *   attempt used is refreshed instead of skipped (L105)
 * - known-benign blockers (missing condition, eBay-illegal SKU, missing
 *   required field, already-listed) are per-item skips with reasons the
 *   UI shows; unknown failure shapes STOP the run loudly (L65)
 * - a failed dispatch runs the residue-recovery chain so nothing wedges
 * - runs are bounded (MAX_ITEMS) and single-flight, sharing the same lock
 *   as the one-item publish route
 */
import { type AspectFillRequest, type AspectFillResult } from './aspect-filler.js';
import { type StepRunner } from './order-import-trigger.js';
/**
 * Read a failed dispatch-create summary (incident #212). `transient` is an
 * eBay server error (HTTP 5xx, or eBay's system-error id): eBay's own
 * trouble, not a refusal of the payload, so one more attempt may succeed.
 * `detail` names the stage, HTTP status and eBay error ids (digits only,
 * never provider text) for the log and the item reason.
 */
export declare function providerFailure(json: Record<string, unknown>): {
    transient: boolean;
    detail: string;
};
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
    /** Plain-language description of what the run is doing right now. */
    currentStep: string | null;
    /** When currentStep began, so the UI can show how long it has taken. */
    stepStartedAtUtc: string | null;
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
        imageCount?: number;
    } | null;
    audit?: {
        attentionReasons?: readonly string[];
    };
};
/** An operator override leaf the Publish-All saves must carry, not drop. */
type OverrideLeaf = {
    draft: string | null;
} | undefined;
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
                    shopify?: string | null;
                };
                category: {
                    draft: string | null;
                    shopify: string | null;
                };
                condition?: OverrideLeaf;
                conditionDescription: {
                    draft: string | null;
                    shopify: string | null;
                };
            };
            content: {
                itemSpecifics: {
                    draft: string | null;
                    shopify: string | null;
                };
                description?: {
                    draft: string | null;
                    shopify: string | null;
                };
                images?: {
                    draft: string | null;
                    shopify?: string | null;
                };
            };
            delivery?: {
                fulfillmentPolicyId?: OverrideLeaf;
                paymentPolicyId?: OverrideLeaf;
                returnPolicyId?: OverrideLeaf;
                merchantLocation?: OverrideLeaf;
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
    /** Read the newest usable snapshot; production reuses a still-fresh cache entry. */
    getSnapshot?: () => Promise<{
        rows: readonly SnapshotRow[];
    }>;
    /** Force a provider census after a recovery write or a catalog-gated refusal. */
    refreshSnapshot?: () => Promise<{
        rows: readonly SnapshotRow[];
    }>;
    draftService?: DraftServiceLike;
    runStep?: StepRunner;
    sleep?: (ms: number) => Promise<void>;
    now?: () => string;
    maxItems?: number;
    getCategoryAspects?: (categoryId: string) => Promise<{
        available: boolean;
        aspects: ReadonlyArray<{
            name: string;
            required: boolean;
            mode?: 'FREE_TEXT' | 'SELECTION_ONLY';
            values?: readonly string[];
        }>;
    }>;
    /** Item-specifics agent; null disables it. Default: armed when a Claude key is connected. */
    fillAspects?: ((request: AspectFillRequest) => Promise<AspectFillResult>) | null;
    findUnresolvedCreate?: (sku: string) => Readonly<{
        jobId: string;
        attemptId: string;
        intentKey: string;
        evidenceDigest: string;
    }> | null;
    latestRevisionDigest?: (catalogId: string) => string | null;
    /** SKUs whose create dispatched but never resolved, older than an hour. */
    agingUnresolvedCreateSkus?: () => ReadonlySet<string>;
}>;
/**
 * Skip reasons that are verified store data only the operator can change
 * (incident #194). No code change can publish these items, so the watchdog
 * shows them to the operator but does not send them to the fix agent.
 */
export declare const OPERATOR_DATA_SKIP_REASONS: readonly string[];
/**
 * Fit a store title into eBay's 80 characters (incident #180). The create
 * manifest refuses a longer title as `CREATE_REQUIRED_FIELD_MISSING: title`,
 * and the draft inherits the Shopify title verbatim, so every long store
 * title skipped on every run. A title that already fits is returned
 * unchanged. A longer one first loses the store-only markers (`(#123)`
 * inventory suffixes, `*USED*`-style banners; condition is its own eBay
 * field), then is cut at the last whole word. Returns null when there is no
 * usable text at all.
 */
export declare function fitEbayTitle(raw: string | null | undefined): string | null;
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
