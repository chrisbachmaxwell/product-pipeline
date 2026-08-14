import { type Digest, type CreateListingProposalJobInput, type ApproveListingProposalInput, type CompleteListingProposalInput, type ListingBaseDigests, type ListingControlAuditVerification, type ListingControlScope, type ListingFieldInput, type ListingIdentity, type ListingProposal, type ListingProposalEvent, type ListingProposalEvidenceItem, type ListingProposalJob, type ListingProposalResult, type ListingRevision, type ListingRevisionInput, type MarkListingProposalGeneratingInput, type ReviewListingProposalInput } from './types.js';
export declare const LISTING_CONTROL_STORE_CAPABILITIES: Readonly<{
    readonly localDraftRuntimeWired: true;
    readonly providerRuntimeWired: false;
    readonly providerReadSupported: false;
    readonly providerWriteSupported: false;
    readonly externalWritesSupported: false;
    readonly credentialCapability: false;
    readonly publishAuthorizationSupported: false;
    readonly contentReviewOnly: true;
    readonly aiProposalPersistenceSupported: true;
    readonly localContentApprovalSupported: true;
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
/** Timestamp-free fact digests shared with the listing-draft DTO contract. */
export declare function deriveListingSemanticDigests(input: {
    scope: ListingControlScope;
    identity: ListingIdentity;
    fields: readonly ListingFieldInput[];
}): ListingBaseDigests;
export declare function deriveListingProposalEvidenceDigest(evidenceInput: readonly ListingProposalEvidenceItem[]): Digest;
export interface ListingControlStore {
    readonly databasePath: string;
    readonly scope: ListingControlScope;
    readonly scopeKey: Digest;
    readonly writable: boolean;
    readonly capabilities: typeof LISTING_CONTROL_STORE_CAPABILITIES;
    createRevision(input: ListingRevisionInput): ListingRevision;
    createProposalJob(input: CreateListingProposalJobInput): {
        job: ListingProposalJob;
        deduplicated: boolean;
    };
    markProposalGenerating(input: MarkListingProposalGeneratingInput): ListingProposalEvent;
    completeProposal(input: CompleteListingProposalInput): {
        result: ListingProposalResult;
        event: ListingProposalEvent;
    };
    approveProposal(input: ApproveListingProposalInput): {
        revision: ListingRevision;
        event: ListingProposalEvent;
    };
    rejectProposal(input: ReviewListingProposalInput): ListingProposalEvent;
    markProposalStale(input: ReviewListingProposalInput): ListingProposalEvent;
    getProposalJob(jobId: string): ListingProposal | null;
    getLatestProposal(shopifyVariantGid: string): ListingProposal | null;
    getLatestProposalForCatalog(shopifyVariantGid: string, catalogId: string): ListingProposal | null;
    countProposalJobsForSubjectSince(shopifyVariantGid: string, sinceUtc: string): number;
    countProposalJobsForScopeSince(sinceUtc: string): number;
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
/** Explicit admin-only migration. Runtime open/request paths never invoke it. */
export declare function upgradeListingControlStoreV2ToV3(input: {
    databasePath: string;
    expectedScope: ListingControlScope;
    appliedAtUtc: string;
}): ListingControlStore;
