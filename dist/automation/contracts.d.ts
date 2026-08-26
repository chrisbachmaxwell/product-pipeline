export declare const AUTOMATION_RESPONSIBILITIES: readonly ["inventory", "price", "orderImport", "fulfillment"];
export type AutomationResponsibility = (typeof AUTOMATION_RESPONSIBILITIES)[number];
export type Sha256Digest = `sha256:${string}`;
export type AutomationCeiling = Readonly<{
    minimumCadenceSeconds: number;
    maximumWritesPerRun: number;
    maximumWritesPerHour: number;
    minimumWriteSpacingMs: number;
}>;
export declare const MAXIMUM_AUTOMATION_AUTHORIZATION_MS: number;
export declare const AUTOMATION_CEILINGS: Readonly<{
    inventory: Readonly<{
        minimumCadenceSeconds: 60;
        maximumWritesPerRun: 25;
        maximumWritesPerHour: 100;
        minimumWriteSpacingMs: 1000;
    }>;
    price: Readonly<{
        minimumCadenceSeconds: 300;
        maximumWritesPerRun: 10;
        maximumWritesPerHour: 30;
        minimumWriteSpacingMs: 2000;
    }>;
    orderImport: Readonly<{
        minimumCadenceSeconds: 60;
        maximumWritesPerRun: 5;
        maximumWritesPerHour: 5;
        minimumWriteSpacingMs: 10000;
    }>;
    fulfillment: Readonly<{
        minimumCadenceSeconds: 60;
        maximumWritesPerRun: 5;
        maximumWritesPerHour: 20;
        minimumWriteSpacingMs: 10000;
    }>;
}>;
export type AutomationPolicy = Readonly<{
    schemaVersion: 1;
    decision: 'enable';
    scopeKey: Sha256Digest;
    responsibility: AutomationResponsibility;
    ownershipVersion: number;
    cadenceSeconds: number;
    maximumWritesPerRun: number;
    maximumWritesPerHour: number;
    minimumWriteSpacingMs: number;
    lightspeedCascadeAccepted: boolean;
    activationEvidenceDigest: Sha256Digest;
    userApprovalEvidenceDigest: Sha256Digest;
    authorizedAtUtc: string;
    expiresAtUtc: string;
}>;
export type AutomationPolicyInput = Omit<AutomationPolicy, 'schemaVersion' | 'decision'>;
export declare class AutomationContractError extends Error {
    readonly code: "AUTOMATION_POLICY_DENIED";
    constructor();
}
export declare function isAutomationResponsibility(value: unknown): value is AutomationResponsibility;
/**
 * Constructs the only canonical policy shape accepted by the future G18
 * persistence slice. It grants no authority and performs no I/O.
 */
export declare function buildAutomationPolicy(input: AutomationPolicyInput): AutomationPolicy;
/** The serialized bytes are the review boundary for a future operator approval. */
export declare function serializeAutomationPolicy(policy: AutomationPolicy): string;
export declare function digestAutomationPolicy(policy: AutomationPolicy): Sha256Digest;
