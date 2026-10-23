import { getPublishAllStatus } from './publish-all.js';
import { type IncidentLedgerSignals } from './migration-state-reader.js';
export type Incident = {
    /** Stable fingerprint: code + subject. */
    id: string;
    severity: 'critical' | 'warning';
    code: 'ORDER_PIPELINE_BLOCKED' | 'OVERSELL_EXPOSURE' | 'END_DISPATCH_REJECTED' | 'PRICE_SYNC_REJECTED' | 'UNRESOLVED_CREATE_AGING' | 'FULFILLMENT_STUCK' | 'PUBLISH_RUN_STOPPED' | 'PUBLISH_ITEM_BLOCKED' | 'SNAPSHOT_STALE';
    sku: string | null;
    title: string;
    detail: string;
    detectedAtUtc: string;
    lastSeenAtUtc: string;
    diagnosisState: 'none' | 'pending' | 'done' | 'failed';
    diagnosis: string | null;
    githubIssueUrl: string | null;
    notifiedAtUtc: string | null;
    /**
     * A publish block whose every item is verified store data only the
     * operator can change (no photos, no title), or a price refusal caused by
     * a listing setting only the operator can change (a price-locking markdown
     * sale). Shown to the operator, never sent to the fix agent: no code change
     * can clear it (incidents #194, #221).
     */
    operatorOnly?: boolean;
};
type SnapshotRow = {
    shopify: {
        sku: string;
        title: string;
        available: number | null;
        productStatus: string;
    } | null;
    ebay: {
        listingId: string | null;
    } | null;
    /** Catalog classification; the sell-out sweep scans only 'active' rows. */
    lifecycleStatus?: string;
    audit?: {
        attentionReasons: readonly string[];
    };
};
type Snapshot = {
    observedAtUtc: string;
    rows: readonly SnapshotRow[];
};
export type WatchdogDependencies = Readonly<{
    getSnapshot?: () => Promise<Snapshot>;
    getLedgerSignals?: (sinceUtc: string) => IncidentLedgerSignals | null;
    now?: () => number;
    stateFile?: string;
    diagnose?: (incident: Incident, context: string) => Promise<string>;
    openIssue?: (incident: Incident) => Promise<string | null>;
    notify?: (incident: Incident) => Promise<void>;
    learningsContext?: () => string;
    getPublishStatus?: () => Pick<ReturnType<typeof getPublishAllStatus>, 'state' | 'stopReason' | 'items'>;
    /** Test seam; defaults to the adapter's provider-rejections ring. */
    getProviderRejections?: () => unknown;
}>;
/**
 * Publish-All items the run could not publish, grouped by root cause so one
 * defect hitting ten SKUs is ONE incident (and one fix PR), not ten. The
 * class is the first error code in the reason (CREATE_IDENTITY_MISMATCH,
 * …) or, without one, the reason with SKUs and listed names stripped.
 * Items the operator deliberately holds never reach the run (no-ebay tag,
 * L90). Skips for store data only the operator can fix (no photos, no
 * title) are marked `operatorOnly`; everything else is something the
 * pipeline failed to handle.
 */
export declare function publishBlockCandidates(items: ReadonlyArray<{
    sku: string;
    status: string;
    reason?: string;
}>): Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail' | 'operatorOnly'>>;
/**
 * Pure detection over one observation. Persistence (the two-sighting rule
 * for oversell exposure) is the runner's job.
 */
export declare function evaluateIncidentCandidates(input: {
    snapshot: Snapshot;
    signals: IncidentLedgerSignals | null;
    nowMs: number;
    /** Test seam; defaults to the adapter's provider-rejections ring. */
    providerRejections?: unknown;
}): Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail' | 'operatorOnly'>>;
export declare function priceRejectionStoreState(reason: string): string | null;
/**
 * The latest non-empty rejection of `call` for this listing (#209: the
 * incident quoted the ring's LAST entry, whatever its call or listing, and
 * printed an empty reason verbatim). Entries written before the adapter
 * recorded `listingId` match on call alone.
 */
export declare function providerRejectionFor(entries: unknown, call: string | readonly string[], listingId: string | null): string | null;
export declare function getIncidents(): readonly Incident[];
export declare function runWatchdogOnce(dependencies?: WatchdogDependencies): Promise<void>;
export declare function initIncidentWatchdog(dependencies?: WatchdogDependencies): NodeJS.Timeout;
export {};
