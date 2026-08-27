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
import { sha256Digest } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
/** eBay offer ids and SKUs share the adapter's safe-segment shape. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
export class ListingCreateRecoveryError extends Error {
    code;
    constructor(code) {
        super('Listing create recovery derivation failed');
        this.code = code;
        this.name = 'ListingCreateRecoveryError';
    }
}
const deny = (code) => {
    throw new ListingCreateRecoveryError(code);
};
/**
 * Derive the deterministic recovery manifest for exactly one unresolved
 * create job's unpublished-offer residue. Every identity is validated for
 * shape only — binding against the durable store state is the ceremony's job.
 */
export function deriveListingCreateRecoveryManifest(input) {
    const priorRecoveryJobId = input.priorRecoveryJobId ?? null;
    const priorRecoveryAttemptId = input.priorRecoveryAttemptId ?? null;
    if (!IDENTIFIER_PATTERN.test(input.sourceJobId)
        || !IDENTIFIER_PATTERN.test(input.sourceAttemptId)
        || !DIGEST_PATTERN.test(input.sourceIntentKey)
        || !DIGEST_PATTERN.test(input.sourceApprovalEvidenceDigest)
        || !SAFE_SEGMENT.test(input.sku) || input.sku.length > 50
        || !SAFE_SEGMENT.test(input.offerId)
        // Prior recovery binding is all-or-nothing and shape-valid.
        || (priorRecoveryJobId === null) !== (priorRecoveryAttemptId === null)
        || (priorRecoveryJobId !== null && !IDENTIFIER_PATTERN.test(priorRecoveryJobId))
        || (priorRecoveryAttemptId !== null && !IDENTIFIER_PATTERN.test(priorRecoveryAttemptId))) {
        deny('RECOVER_INPUT_INVALID');
    }
    const manifest = Object.freeze({
        schemaVersion: 1,
        scope: LISTING_DRAFT_SCOPE,
        action: 'recover_create_ebay_listing',
        expectedResidue: 'offer_unpublished',
        sourceJobId: input.sourceJobId,
        sourceAttemptId: input.sourceAttemptId,
        sourceIntentKey: input.sourceIntentKey,
        sourceApprovalEvidenceDigest: input.sourceApprovalEvidenceDigest,
        sku: input.sku,
        offerId: input.offerId,
        priorRecoveryJobId,
        priorRecoveryAttemptId,
    });
    return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}
/**
 * Recompute the exact reconciliation result digest that the lifecycle CLI
 * recorded for the created-offer-but-publish-failed (`artifact`) outcome.
 * This is the digest preimage used by `runLifecycleReconciliation` in
 * `program.ts`; it must stay byte-compatible with the recorded evidence, so
 * the recovery ceremony can prove the store authoritatively recorded EXACTLY
 * the offer id the operator named — the offer id itself never appears in the
 * store outside this digest.
 */
export function recomputeUnpublishedArtifactResultDigest(input) {
    return sha256Digest({
        schemaVersion: 1,
        responsibility: 'listingCreate',
        manifestDigest: input.sourceApprovalEvidenceDigest,
        kind: 'artifact',
        observedListingId: null,
        observedOfferId: input.offerId,
        observedDigest: input.targetSnapshotDigest,
    });
}
/**
 * Verify that at least one durable `CREATE_OFFER_UNPUBLISHED` reconciliation
 * run's recorded result digest binds exactly the given offer id. The caller
 * passes the store's artifact-evidence rows (run result digest + target
 * snapshot digest); this function re-derives each candidate digest and denies
 * unless one matches exactly.
 */
export function requireRecordedUnpublishedOffer(input) {
    const matched = input.evidenceRuns.some((run) => recomputeUnpublishedArtifactResultDigest({
        sourceApprovalEvidenceDigest: input.sourceApprovalEvidenceDigest,
        offerId: input.offerId,
        targetSnapshotDigest: run.targetSnapshotDigest,
    }) === run.resultDigest);
    if (!matched)
        deny('RECOVER_ARTIFACT_EVIDENCE_MISMATCH');
}
