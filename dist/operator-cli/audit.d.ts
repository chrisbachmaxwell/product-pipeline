import { type EbayEnvironment, type OperatorLane } from './config.js';
export declare const DEFAULT_AUDIT_LOG_PATH = ".local/operator-audit/operator-cli.jsonl";
export type AuditOutcome = 'passed' | 'blocked' | 'denied';
export type AuditEventInput = {
    command: 'preflight' | 'ownership' | 'reconcile';
    lane: OperatorLane | 'unavailable';
    mode: 'read-only' | 'unavailable';
    outcome: AuditOutcome;
    configDigest: string | null;
    target: {
        shopifyStoreDomain: string | null;
        ebayEnvironment: EbayEnvironment | null;
        ebaySellerAccount: string | null;
        marketplaceConnectAccount: string | null;
    };
    ownershipDigest: string | null;
    checks: Array<{
        id: string;
        result: 'pass' | 'block' | 'deny';
    }>;
};
export type AuditRecord = AuditEventInput & {
    schemaVersion: 1;
    sequence: number;
    timestampUtc: string;
    runId: string;
    previousHash: string;
    recordHash: string;
};
export type AuditVerification = {
    valid: boolean;
    recordCount: number;
    headHash: string | null;
    error?: string;
};
export declare class AuditIntegrityError extends Error {
    constructor(message: string);
}
export declare function verifyAuditText(text: string): AuditVerification;
export declare function verifyAuditLog(repoRoot: string, requestedPath: string, allowMissing?: boolean): Promise<AuditVerification>;
export declare function appendAuditRecord(repoRoot: string, requestedPath: string, input: AuditEventInput, options?: {
    now?: () => Date;
    createRunId?: () => string;
}): Promise<AuditRecord>;
