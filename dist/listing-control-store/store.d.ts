import { type Digest, type ListingBaseDigests, type ListingControlAuditVerification, type ListingControlScope, type ListingFieldInput, type ListingIdentity, type ListingRevision, type ListingRevisionInput } from './types.js';
export declare const LISTING_CONTROL_STORE_CAPABILITIES: Readonly<{
    readonly localDraftRuntimeWired: true;
    readonly providerRuntimeWired: false;
    readonly providerReadSupported: false;
    readonly providerWriteSupported: false;
    readonly externalWritesSupported: false;
    readonly credentialCapability: false;
    readonly publishAuthorizationSupported: false;
    readonly contentReviewOnly: true;
}>;
export type ListingControlStoreErrorCode = 'INVALID_INPUT' | 'PATH_REJECTED' | 'SCHEMA_MISMATCH' | 'ACCOUNT_DRIFT' | 'CONFLICT' | 'STALE_BASE' | 'NOT_FOUND' | 'READ_ONLY';
export declare class ListingControlStoreError extends Error {
    readonly code: ListingControlStoreErrorCode;
    constructor(code: ListingControlStoreErrorCode, message: string);
}
export declare function sha256Digest(value: unknown): Digest;
export declare function deriveListingSubjectKey(input: {
    scope: ListingControlScope;
    identity: ListingIdentity;
}): Digest;
export declare function deriveListingBaseDigests(input: {
    scope: ListingControlScope;
    identity: ListingIdentity;
    baseSourceObservedAtUtc: string;
    baseEbayObservedAtUtc: string;
    fields: readonly ListingFieldInput[];
}): ListingBaseDigests;
export interface ListingControlStore {
    readonly databasePath: string;
    readonly scope: ListingControlScope;
    readonly scopeKey: Digest;
    readonly writable: boolean;
    readonly capabilities: typeof LISTING_CONTROL_STORE_CAPABILITIES;
    createRevision(input: ListingRevisionInput): ListingRevision;
    getRevision(revisionId: string): ListingRevision | null;
    getLatestRevision(shopifyVariantGid: string): ListingRevision | null;
    verifyAudit(): ListingControlAuditVerification;
    verifyIntegrity(): void;
    close(): void;
}
export declare function initializeListingControlStore(input: {
    databasePath: string;
    scope: ListingControlScope;
    createdAtUtc: string;
}): ListingControlStore;
export declare function openListingControlStore(input: {
    databasePath: string;
    expectedScope: ListingControlScope;
}): ListingControlStore;
export declare function openListingControlStoreReadOnly(input: {
    databasePath: string;
    expectedScope: ListingControlScope;
}): ListingControlStore;
/**
 * Explicit operational migration for a pre-existing canonical V1 file. This
 * is intentionally absent from every runtime open/request path.
 */
export declare function upgradeListingControlStoreV1ToV2(input: {
    databasePath: string;
    expectedScope: ListingControlScope;
    appliedAtUtc: string;
}): ListingControlStore;
