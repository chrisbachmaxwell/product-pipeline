/**
 * Pure derivation for the Production listing-create recovery-cleanup ceremony
 * (`recover-create`, Brain L34). No store, network, credential, or provider
 * access happens here.
 *
 * A recovery manifest binds, deterministically and completely, the ONE
 * unresolved create job whose residue may be removed: the source job id,
 * attempt id, intent key, and approval evidence digest (L29), plus the exact
 * SKU and the exact unpublished offer id the store's reconciliation evidence
 * recorded. The digest of this manifest is the recovery intent's desired-state
 * digest and the recovery job's approval evidence digest, so the same
 * invocation always derives the same intent (idempotent denial on re-run) and
 * a different target can never share it.
 */
import { type Digest } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export declare class ListingCreateRecoveryError extends Error {
    readonly code: 'RECOVER_INPUT_INVALID' | 'RECOVER_ARTIFACT_EVIDENCE_MISMATCH';
    constructor(code: 'RECOVER_INPUT_INVALID' | 'RECOVER_ARTIFACT_EVIDENCE_MISMATCH');
}
export type ListingCreateRecoveryManifest = Readonly<{
    schemaVersion: 1;
    scope: typeof LISTING_DRAFT_SCOPE;
    action: 'recover_create_ebay_listing';
    expectedResidue: 'offer_unpublished';
    sourceJobId: string;
    sourceAttemptId: string;
    sourceIntentKey: Digest;
    sourceApprovalEvidenceDigest: Digest;
    sku: string;
    offerId: string;
    /**
     * L29 recovery chain: when a prior recovery ceremony's provider phase
     * failed and its job stays unresolved, the next recovery intent binds that
     * exact prior job/attempt, yielding a new deterministic digest — never a
     * replay of the spent intent. Null for the first recovery ceremony.
     */
    priorRecoveryJobId: string | null;
    priorRecoveryAttemptId: string | null;
}>;
export type DerivedListingCreateRecoveryManifest = Readonly<{
    manifest: ListingCreateRecoveryManifest;
    manifestDigest: Digest;
}>;
/**
 * Derive the deterministic recovery manifest for exactly one unresolved
 * create job's unpublished-offer residue. Every identity is validated for
 * shape only — binding against the durable store state is the ceremony's job.
 */
export declare function deriveListingCreateRecoveryManifest(input: {
    sourceJobId: string;
    sourceAttemptId: string;
    sourceIntentKey: string;
    sourceApprovalEvidenceDigest: string;
    sku: string;
    offerId: string;
    priorRecoveryJobId?: string | null;
    priorRecoveryAttemptId?: string | null;
}): DerivedListingCreateRecoveryManifest;
/**
 * Recompute the exact reconciliation result digest that the lifecycle CLI
 * recorded for the created-offer-but-publish-failed (`artifact`) outcome.
 * This is the digest preimage used by `runLifecycleReconciliation` in
 * `program.ts`; it must stay byte-compatible with the recorded evidence, so
 * the recovery ceremony can prove the store authoritatively recorded EXACTLY
 * the offer id the operator named — the offer id itself never appears in the
 * store outside this digest.
 */
export declare function recomputeUnpublishedArtifactResultDigest(input: {
    sourceApprovalEvidenceDigest: Digest;
    offerId: string;
    targetSnapshotDigest: Digest;
}): Digest;
/**
 * Verify that at least one durable `CREATE_OFFER_UNPUBLISHED` reconciliation
 * run's recorded result digest binds exactly the given offer id. The caller
 * passes the store's artifact-evidence rows (run result digest + target
 * snapshot digest); this function re-derives each candidate digest and denies
 * unless one matches exactly.
 */
export declare function requireRecordedUnpublishedOffer(input: {
    sourceApprovalEvidenceDigest: Digest;
    offerId: string;
    evidenceRuns: ReadonlyArray<{
        resultDigest: Digest;
        targetSnapshotDigest: Digest;
    }>;
}): void;
