import { type IncidentLedgerSignals } from './migration-state-reader.js';
export type Incident = {
    /** Stable fingerprint: code + subject. */
    id: string;
    severity: 'critical' | 'warning';
    code: 'ORDER_PIPELINE_BLOCKED' | 'OVERSELL_EXPOSURE' | 'END_DISPATCH_REJECTED' | 'UNRESOLVED_CREATE_AGING' | 'SNAPSHOT_STALE';
    sku: string | null;
    title: string;
    detail: string;
    detectedAtUtc: string;
    lastSeenAtUtc: string;
    diagnosisState: 'none' | 'pending' | 'done' | 'failed';
    diagnosis: string | null;
    githubIssueUrl: string | null;
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
}>;
/**
 * Pure detection over one observation. Persistence (the two-sighting rule
 * for oversell exposure) is the runner's job.
 */
export declare function evaluateIncidentCandidates(input: {
    snapshot: Snapshot;
    signals: IncidentLedgerSignals | null;
    nowMs: number;
}): Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail'>>;
export declare function getIncidents(): readonly Incident[];
export declare function runWatchdogOnce(dependencies?: WatchdogDependencies): Promise<void>;
export declare function initIncidentWatchdog(dependencies?: WatchdogDependencies): NodeJS.Timeout;
export {};
