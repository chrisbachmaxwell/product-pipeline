import Database from 'better-sqlite3';
import { type SandboxAlignmentManifest } from './contracts.js';
export type StoredIntent = Readonly<{
    manifestDigest: `sha256:${string}`;
    manifest: SandboxAlignmentManifest;
    status: string;
    approvalId: string | null;
    approvalTokenDigest: string | null;
    approvalDigest: string | null;
    approvalExpiresAtUtc: string | null;
    approvalConsumedAtUtc: string | null;
    attemptId: string | null;
    providerOutcome: string | null;
    resolution: string | null;
}>;
export declare class SandboxAlignmentStore {
    private readonly db;
    constructor(db: InstanceType<typeof Database>);
    close(): void;
    private appendAudit;
    private computeIntentStateDigest;
    private sealIntent;
    recordInitialization(now: string): void;
    verify(): Readonly<{
        schemaVersion: 1;
        scopeDigest: string;
        auditValid: true;
        intentCount: number;
    }>;
    recordIntent(manifestDigest: `sha256:${string}`, manifest: SandboxAlignmentManifest, now: string): void;
    approve(manifestDigest: string, now: string, expiresAtUtc: string): Readonly<{
        approvalId: string;
        approvalToken: string;
        approvalDigest: `sha256:${string}`;
    }>;
    getIntent(manifestDigest: string): StoredIntent;
    beginDispatch(manifestDigest: string, approvalToken: string, approvalDigest: string, now: string): string;
    markReconciliationRequired(manifestDigest: string, providerOutcome: 'reported-success' | 'unknown', now: string): void;
    recordObservation(manifestDigest: string, effect: string, observedDigest: string, now: string): string;
}
export declare function initializeSandboxAlignmentStore(storePath: string, confirmScope: string, now: string): SandboxAlignmentStore;
export declare function openSandboxAlignmentStore(storePath: string): SandboxAlignmentStore;
