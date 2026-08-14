export declare const EBAY_PRODUCTION_SCOPES: readonly ["https://api.ebay.com/oauth/api_scope", "https://api.ebay.com/oauth/api_scope/sell.inventory"];
export declare const EBAY_ROTATION_ENVIRONMENT: "production";
export declare const EBAY_ROTATION_SELLER: "usedcameragear";
export declare const EBAY_ROTATION_MARKETPLACE: "EBAY_US";
export declare const EBAY_REVOKE_CONFIRMATION: "revoke-productpipeline-ebay-grant";
export declare const EBAY_RECONCILIATION_RESET_CONFIRMATION: "provider-reconciled-reset-ebay-consent";
export declare const EBAY_STALE_LOCK_RECOVERY_CONFIRMATION: "recover-stale-ebay-credential-lock";
export declare const EBAY_PRODUCTION_DATABASE_PATH: "/data/ebaysync.db";
export declare const EBAY_PRODUCTION_WORK_DIRECTORY: "/data/product-pipeline/credential-maintenance/ebay";
export declare const EBAY_PRODUCTION_BACKUP_DIRECTORY: "/data/product-pipeline/credential-backups/ebay";
export declare const EBAY_PRODUCTION_EVIDENCE_ARCHIVE_DIRECTORY: "/data/product-pipeline/credential-maintenance/evidence-archive";
export declare const EBAY_PRODUCTION_LOCK_ARCHIVE_DIRECTORY: "/data/product-pipeline/credential-maintenance/lock-archive";
export declare const EBAY_ROTATION_ERROR_CODES: readonly ["EBAY_ROTATION_ARGUMENT_DENIED", "EBAY_ROTATION_CONFIGURATION_DENIED", "EBAY_ROTATION_FILE_BOUNDARY_DENIED", "EBAY_ROTATION_LOCKED", "EBAY_ROTATION_STATE_INVALID", "EBAY_ROTATION_STATE_EXPIRED", "EBAY_ROTATION_STATE_ALREADY_USED", "EBAY_ROTATION_AUTH_RESULT_INVALID", "EBAY_ROTATION_AUTH_RESULT_MISMATCH", "EBAY_ROTATION_PROVIDER_EXCHANGE_FAILED", "EBAY_ROTATION_PROVIDER_RESPONSE_INVALID", "EBAY_ROTATION_PROVIDER_SCOPE_MISMATCH", "EBAY_ROTATION_PROVIDER_IDENTITY_MISMATCH", "EBAY_ROTATION_PROVIDER_ENVIRONMENT_MISMATCH", "EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED", "EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED", "EBAY_ROTATION_DATABASE_BACKUP_FAILED", "EBAY_ROTATION_DATABASE_CAS_FAILED", "EBAY_ROTATION_DATABASE_READBACK_FAILED", "EBAY_ROTATION_GRANT_BINDING_MISMATCH", "EBAY_ROTATION_REVOCATION_DENIED", "EBAY_ROTATION_REVOCATION_FAILED", "EBAY_ROTATION_RECONCILIATION_DENIED", "EBAY_ROTATION_LOCK_RECOVERY_DENIED", "EBAY_ROTATION_CLEANUP_REQUIRED", "EBAY_ROTATION_FAILED_CLOSED"];
export type EbayRotationErrorCode = (typeof EBAY_ROTATION_ERROR_CODES)[number];
export type EbayRotationFailureEffects = Readonly<{
    databaseRowsChanged: 0 | 1 | 'unknown';
    credentialProviderMutation: boolean;
    reconciliationRequired: boolean;
}>;
export declare class EbayRotationError extends Error {
    readonly code: EbayRotationErrorCode;
    readonly effects: EbayRotationFailureEffects;
    constructor(code: EbayRotationErrorCode, effects?: EbayRotationFailureEffects);
}
export type EbayRotationCredentials = Readonly<{
    appId: string;
    ruName: string;
    newCertId?: string;
}>;
export type EbayProviderRequest = Readonly<{
    method: 'GET' | 'POST';
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
}>;
export type EbayProviderResponse = Readonly<{
    status: number;
    bodyText: string;
}>;
export type EbayProviderTransport = (request: EbayProviderRequest) => Promise<EbayProviderResponse>;
export type EbayDirectorySyncPhase = 'directory-create' | 'new-private-file' | 'state-temporary-create' | 'state-replace' | 'lock-create' | 'lock-release' | 'backup-finalize' | 'evidence-archive-target' | 'evidence-archive-source' | 'reset-publish' | 'stale-lock-archive-target' | 'stale-lock-archive-source';
export type EbayRotationDependencies = Readonly<{
    now?: () => Date;
    randomBytes?: (size: number) => Buffer;
    transport?: EbayProviderTransport;
    beforeLedgerCas?: () => void | Promise<void>;
    afterCommitAppliedBeforeResult?: () => void | Promise<void>;
    beforeCommittedStateWrite?: () => void | Promise<void>;
    beforeLockRelease?: () => void | Promise<void>;
    isLockOwnerAlive?: (pid: number) => boolean;
    beforeDirectorySync?: (directory: string, phase: EbayDirectorySyncPhase) => void | Promise<void>;
    afterDirectorySync?: (directory: string, phase: EbayDirectorySyncPhase) => void | Promise<void>;
}>;
export type EbayRotationResult = Readonly<{
    ok: true;
    code: 'EBAY_CONSENT_PREPARED' | 'EBAY_CONSENT_REGISTERED' | 'EBAY_GRANT_INSTALLED' | 'EBAY_GRANT_VERIFIED' | 'EBAY_GRANT_REVOKED' | 'EBAY_GRANT_ALREADY_REVOKED' | 'EBAY_CONSENT_RESET_AFTER_RECONCILIATION' | 'EBAY_STALE_LOCK_ARCHIVED';
    environment: 'production';
    sellerVerified: boolean;
    scopesVerified: boolean;
    backupCreated: boolean;
    databaseRowsChanged: 0 | 1;
    credentialProviderMutation: boolean;
    commerceWritesPerformed: 0;
    historicalOrdersTouched: 0;
}>;
export declare function createBoundedEbayProviderTransport(fetchImplementation?: typeof fetch): EbayProviderTransport;
export declare function beginEbayProductionConsent(input: {
    workDirectory: string;
    credentials: EbayRotationCredentials;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
export declare function registerEbayProductionConsent(input: {
    workDirectory: string;
    stateDigest: string;
    requestDigest: string;
    credentials: EbayRotationCredentials;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
export declare function archiveAndResetEbayProductionConsent(input: {
    workDirectory: string;
    archiveDirectory: string;
    databasePath: string;
    backupDirectory: string;
    stateDigest: string;
    requestDigest: string;
    confirmation: string;
    credentials: EbayRotationCredentials;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
export declare function recoverStaleEbayOperationLock(input: {
    workDirectory: string;
    archiveDirectory: string;
    ownerId: string;
    createdAtUtc: string;
    confirmation: string;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
export declare function ensureEbayProductionPrivateParents(): Promise<void>;
export declare function installEbayProductionGrant(input: {
    workDirectory: string;
    databasePath: string;
    backupDirectory: string;
    authorizationResult: string;
    credentials: Required<EbayRotationCredentials>;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
export declare function verifyInstalledEbayGrant(input: {
    workDirectory: string;
    databasePath: string;
    credentials: Required<EbayRotationCredentials>;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
export declare function revokeInstalledEbayGrant(input: {
    workDirectory: string;
    databasePath: string;
    confirmation: string;
    credentials: Required<EbayRotationCredentials>;
    dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult>;
