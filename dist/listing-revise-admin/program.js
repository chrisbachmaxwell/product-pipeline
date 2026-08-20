/**
 * Isolated listing-revise operator CLI — the goal-G4 provider dispatch slice.
 *
 * It is never imported or mounted by the server. One `dispatch` invocation is
 * the one-action, exact-target operator approval: the operator must name the
 * exact catalog row, SKU, listing id, offer id (the literal `none` for a
 * Trading-model target, which has no offer), draft revision digest, AND
 * the manifest digest previously printed by `preflight`. Any mismatch, stale
 * remote state, missing ownership, consumed approval, or foreign target
 * fails closed before a provider write. Every intent, approval, job,
 * attempt, reconciliation run, and resolution is recorded durably in the
 * migration-state store's hash-chained audit before and after the bounded
 * provider calls.
 */
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { deriveExternalIdentityKey, deriveIdempotencyKey, deriveScopeKey, openMigrationStore, MigrationStoreError, } from '../migration-store/index.js';
import { openListingControlStoreReadOnly, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import { deriveListingDraftBasis, } from '../server/listing-draft-service.js';
import { readListingWorkspace } from '../server/listing-workspace-reader.js';
import { applyListingDescriptionTemplate, assertFreshBasisMatchesRevision, buildListingRevisePayloads, compareDispatchedState, deriveListingReviseManifest, ListingReviseManifestError, ListingRevisePayloadError, } from './manifest.js';
import { LISTING_DESCRIPTION_TEMPLATE_VERSION, } from '../server/listing-description-template.js';
import { createListingReviseDispatchAdapter, createProductionDispatchTokenProvider, ListingReviseDispatchError, } from './dispatch-adapter.js';
import { createTradingDispatchAdapter, TradingDispatchError, } from './trading-dispatch-adapter.js';
const APPROVAL_TTL_MS = 10 * 60_000;
const VALUE_PREVIEW_LENGTH = 120;
const defaultIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
    setExitCode: (code) => {
        process.exitCode = code;
    },
};
const MIGRATION_SCOPE = Object.freeze({
    shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
    ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
    ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
    ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});
class ListingReviseAdminError extends Error {
    code;
    constructor(code) {
        super('Listing revise operation denied');
        this.code = code;
        this.name = 'ListingReviseAdminError';
    }
}
const deny = (code) => {
    throw new ListingReviseAdminError(code);
};
function safeErrorCode(error) {
    if (error instanceof ListingReviseAdminError)
        return error.code;
    if (error instanceof ListingReviseManifestError)
        return error.code;
    if (error instanceof ListingRevisePayloadError)
        return error.code;
    if (error instanceof ListingReviseDispatchError)
        return error.code;
    if (error instanceof TradingDispatchError)
        return error.code;
    if (error instanceof MigrationStoreError)
        return `MIGRATION_STORE_${error.code}`;
    return 'LISTING_REVISE_DENIED';
}
function preview(value) {
    if (value === null)
        return { preview: null, length: 0 };
    return {
        preview: value.length > VALUE_PREVIEW_LENGTH
            ? `${value.slice(0, VALUE_PREVIEW_LENGTH)}…`
            : value,
        length: value.length,
    };
}
/**
 * Opt-in branded description templating. The flag is fail-closed: absent
 * means byte-identical legacy behavior, and any value other than the literal
 * `ucg-branded-v1` is a fixed-code denial before any store or remote read.
 */
function assertDescriptionTemplateFlag(value) {
    if (value !== undefined && value !== LISTING_DESCRIPTION_TEMPLATE_VERSION) {
        deny('REVISE_TEMPLATE_UNSUPPORTED');
    }
}
function applyTemplateOption(derived, revision, descriptionTemplate) {
    if (descriptionTemplate === undefined)
        return { derived, note: null };
    const templated = applyListingDescriptionTemplate({
        derived,
        revision,
        templateVersion: descriptionTemplate,
    });
    return {
        derived: { manifest: templated.manifest, manifestDigest: templated.manifestDigest },
        note: Object.freeze({
            templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION,
            applied: templated.descriptionTemplateApplied,
        }),
    };
}
/**
 * Exact-target offer-id acceptance: an inventory-model target must be named
 * by its exact offer id, while a Trading-model target (which has no offer)
 * must be named with the literal `none` — any other combination is a
 * mismatch, so `none` can never select an inventory-managed listing.
 */
function exactOfferIdMatches(ebayOfferId, optionValue) {
    return ebayOfferId === null ? optionValue === 'none' : ebayOfferId === optionValue;
}
function createMonotonicClock(now) {
    let lastMs = 0;
    return () => {
        const currentMs = Math.max(now().getTime(), lastMs);
        lastMs = currentMs;
        return new Date(currentMs).toISOString();
    };
}
async function deriveExactTarget(dependencies, options) {
    assertDescriptionTemplateFlag(options.descriptionTemplate);
    const workspaceDto = await dependencies.readWorkspace(options.catalogId);
    const basis = deriveListingDraftBasis(workspaceDto);
    const identity = basis.identity;
    if (identity.rawSku !== options.sku
        || identity.ebayListingId !== options.listingId
        || !exactOfferIdMatches(identity.ebayOfferId, options.offerId)) {
        deny('REVISE_EXACT_TARGET_MISMATCH');
    }
    const draftPath = dependencies.draftDatabasePath();
    if (typeof draftPath !== 'string' || draftPath.length === 0) {
        deny('REVISE_DRAFT_STORE_UNAVAILABLE');
    }
    const draftStore = dependencies.openDraftStoreReadOnly({
        databasePath: draftPath,
        expectedScope: LISTING_DRAFT_SCOPE,
    });
    let revision;
    try {
        revision = draftStore.getLatestRevision(identity.shopifyVariantGid);
    }
    finally {
        draftStore.close();
    }
    if (revision === null)
        deny('REVISE_DRAFT_REVISION_MISSING');
    if (revision.revisionDigest !== options.revisionDigest) {
        deny('REVISE_DRAFT_REVISION_MISMATCH');
    }
    const derivedBase = deriveListingReviseManifest(revision);
    assertFreshBasisMatchesRevision({ revision: revision, freshBasis: basis });
    const templated = applyTemplateOption(derivedBase, revision, options.descriptionTemplate);
    return {
        basis,
        revision: revision,
        derived: templated.derived,
        descriptionTemplate: templated.note,
    };
}
function ensureIdentity(store, input, occurredAtUtc) {
    const identityKey = deriveExternalIdentityKey(input);
    const existing = store.getIdentity(identityKey);
    if (existing)
        return identityKey;
    store.registerIdentity(input, {
        eventId: `identity:${identityKey.slice(7, 27)}`,
        occurredAtUtc,
    });
    return identityKey;
}
function reviseIdentityInputs(target) {
    const identity = target.basis.identity;
    return {
        source: {
            platform: 'shopify',
            kind: 'variant',
            bindingKey: `shopify-variant:${identity.shopifyVariantGid}`,
            storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
            externalGid: identity.shopifyVariantGid,
        },
        targetListing: {
            platform: 'ebay',
            kind: 'listing',
            bindingKey: `ebay-listing:${identity.ebayListingId}`,
            environment: MIGRATION_SCOPE.ebayEnvironment,
            sellerId: MIGRATION_SCOPE.ebaySellerId,
            marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
            externalId: identity.ebayListingId,
        },
    };
}
function manifestSummary(target) {
    const { manifest, manifestDigest } = target.derived;
    return {
        ...(target.descriptionTemplate === null
            ? {}
            : { descriptionTemplate: target.descriptionTemplate }),
        manifestDigest,
        revisionId: manifest.revisionId,
        revisionNumber: manifest.revisionNumber,
        revisionDigest: manifest.revisionDigest,
        identity: manifest.identity,
        changes: manifest.changes.map((change) => ({
            field: change.field,
            before: preview(change.before),
            after: preview(change.after),
        })),
        preserved: manifest.preserved,
        externalWritesPerformed: 0,
    };
}
async function runReconciliation(input) {
    const startedAtUtc = input.clock();
    const freshDto = await input.readWorkspace(input.catalogId);
    const freshBasis = deriveListingDraftBasis(freshDto);
    const comparison = compareDispatchedState({
        manifest: input.target.derived.manifest,
        freshBasis,
    });
    const completedAtUtc = input.clock();
    const runId = `listing-revise-run:${input.uuid()}`;
    const resultDigest = (await import('../listing-control-store/index.js')).sha256Digest({
        schemaVersion: 1,
        manifestDigest: input.target.derived.manifestDigest,
        effect: comparison.effect,
        matchedFields: comparison.matchedFields,
        unmatchedFields: comparison.unmatchedFields,
        freshEbayDigest: freshBasis.ebayDigest,
    });
    const resolvable = comparison.effect === 'revised_state_observed'
        || (comparison.effect === 'revised_state_absent' && input.resolveAbsent);
    const exceptions = [];
    if (comparison.effect === 'partial') {
        exceptions.push({
            exceptionId: `listing-revise-exception:${input.uuid()}`,
            code: 'PARTIAL_REVISE_STATE',
            severity: 'critical',
            subjectIdentityKey: input.targetIdentityKey,
            detailsDigest: resultDigest,
        });
    }
    else if (!resolvable) {
        exceptions.push({
            exceptionId: `listing-revise-exception:${input.uuid()}`,
            code: 'REVISED_STATE_NOT_YET_OBSERVED',
            severity: 'critical',
            subjectIdentityKey: input.targetIdentityKey,
            detailsDigest: resultDigest,
        });
    }
    const observation = comparison.effect === 'partial' ? null : {
        observationId: `listing-revise-observation:${input.uuid()}`,
        intentKey: input.intentKey,
        effect: comparison.effect,
        observedDigest: freshBasis.ebayDigest,
    };
    input.store.recordReconciliationRun({
        runId,
        responsibility: 'listingRevise',
        targetIdentityKey: input.targetIdentityKey,
        mode: 'production_canary',
        status: 'passed',
        sourceSnapshotDigest: input.target.derived.manifestDigest,
        targetSnapshotDigest: freshBasis.ebayDigest,
        resultDigest,
        authoritative: resolvable,
        authorityEvidenceDigest: input.target.derived.manifest.baseEbayObservationDigest,
        externalWritesObserved: 0,
        startedAtUtc,
        completedAtUtc,
        exceptions,
        listingReviseObservation: observation,
        audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: completedAtUtc },
    });
    if (!resolvable) {
        return { effect: comparison.effect, resolution: null, runId };
    }
    const resolution = comparison.effect === 'revised_state_observed'
        ? 'resolved_existing'
        : 'confirmed_missing';
    const reconciledAtUtc = input.clock();
    input.store.resolveUnknownAttempt({
        jobId: input.jobId,
        attemptId: input.attemptId,
        resolution,
        reconciliationRunId: runId,
        reconciliationResultDigest: resultDigest,
        reconciledAtUtc,
        audit: { eventId: `resolution:${runId}`, occurredAtUtc: reconciledAtUtc },
    });
    return { effect: comparison.effect, resolution, runId };
}
export function buildListingReviseAdminProgram(dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    const readWorkspace = dependencies.readWorkspace ?? readListingWorkspace;
    const draftDatabasePath = dependencies.draftDatabasePath
        ?? (() => process.env.LISTING_CONTROL_DATABASE_PATH);
    const openDraftStoreReadOnly = dependencies.openDraftStoreReadOnly
        ?? openListingControlStoreReadOnly;
    const openMigration = dependencies.openMigration ?? openMigrationStore;
    const createAdapter = dependencies.createAdapter ?? (() => createListingReviseDispatchAdapter({
        getAccessToken: createProductionDispatchTokenProvider(),
    }));
    const createTradingAdapter = dependencies.createTradingAdapter ?? (() => createTradingDispatchAdapter({
        getAccessToken: createProductionDispatchTokenProvider(),
    }));
    const now = dependencies.now ?? (() => new Date());
    const uuid = dependencies.uuid ?? randomUUID;
    const targetDependencies = { readWorkspace, draftDatabasePath, openDraftStoreReadOnly };
    const program = new Command();
    program
        .name('listing-revise-admin')
        .description('Isolated one-action listing-revise dispatch for exactly one approved local draft revision')
        .showHelpAfterError();
    const withTargetOptions = (command) => command
        .requiredOption('--catalog-id <id>', 'Exact listings catalog row id')
        .requiredOption('--sku <sku>', 'Exact raw SKU of the one target')
        .requiredOption('--listing-id <id>', 'Exact eBay listing id of the one target')
        .requiredOption('--offer-id <id>', 'Exact eBay offer id of the one target, or the literal "none" for a Trading-model target')
        .requiredOption('--revision-digest <sha256>', 'Exact approved draft revision digest')
        .option('--description-template <version>', 'Opt-in branded description templating; the only supported value is '
        + `"${LISTING_DESCRIPTION_TEMPLATE_VERSION}"`);
    withTargetOptions(program
        .command('preflight')
        .description('Derive and print the exact dispatch manifest without any store or provider write'))
        .action(async (options) => {
        try {
            const target = await deriveExactTarget(targetDependencies, options);
            io.stdout(JSON.stringify({
                command: 'preflight',
                status: 'preview',
                ...manifestSummary(target),
            }));
            io.setExitCode(2);
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'preflight', status: 'denied', code: safeErrorCode(error),
            }));
            io.setExitCode(1);
        }
    });
    program
        .command('establish-ownership')
        .description('Record the paused-genesis and product_pipeline listingRevise ownership chain once')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
        .requiredOption('--evidence-digest <sha256>', 'Digest of the reviewed single-writer evidence')
        .action((options) => {
        try {
            if (options.confirmScope !== deriveScopeKey(MIGRATION_SCOPE)) {
                deny('REVISE_SCOPE_CONFIRMATION_MISMATCH');
            }
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                let current = store.getCurrentOwnership('listingRevise');
                if (current && current.owner === 'product_pipeline') {
                    io.stdout(JSON.stringify({
                        command: 'establish-ownership', status: 'already-established',
                        version: current.version, externalWritesPerformed: 0,
                    }));
                    return;
                }
                if (!current) {
                    const genesisAt = clock();
                    store.recordOwnershipVersion({
                        responsibility: 'listingRevise',
                        version: 1,
                        owner: 'paused',
                        singleWriterVerified: true,
                        evidenceDigest: options.evidenceDigest,
                        effectiveAtUtc: genesisAt,
                        recordedAtUtc: genesisAt,
                        audit: { eventId: `ownership:listing-revise:v1:${uuid()}`, occurredAtUtc: genesisAt },
                    });
                    current = store.getCurrentOwnership('listingRevise');
                }
                if (!current || current.owner !== 'paused') {
                    throw new ListingReviseAdminError('REVISE_OWNERSHIP_CHAIN_INVALID');
                }
                const transferAt = clock();
                store.recordOwnershipVersion({
                    responsibility: 'listingRevise',
                    version: current.version + 1,
                    owner: 'product_pipeline',
                    singleWriterVerified: true,
                    evidenceDigest: options.evidenceDigest,
                    effectiveAtUtc: transferAt,
                    recordedAtUtc: transferAt,
                    audit: {
                        eventId: `ownership:listing-revise:v${current.version + 1}:${uuid()}`,
                        occurredAtUtc: transferAt,
                    },
                });
                io.stdout(JSON.stringify({
                    command: 'establish-ownership', status: 'established',
                    version: current.version + 1, externalWritesPerformed: 0,
                }));
            }
            finally {
                store.close();
            }
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'establish-ownership', status: 'denied', code: safeErrorCode(error),
            }));
            io.setExitCode(1);
        }
    });
    withTargetOptions(program
        .command('dispatch')
        .description('One-action exact-target dispatch of one approved draft revision to eBay, with durable '
        + 'idempotent job state and immediate post-action reconciliation'))
        .requiredOption('--manifest-digest <sha256>', 'Exact manifest digest printed by preflight')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .action(async (options) => {
        try {
            const target = await deriveExactTarget(targetDependencies, options);
            if (target.derived.manifestDigest !== options.manifestDigest) {
                deny('REVISE_MANIFEST_DIGEST_MISMATCH');
            }
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                const ownership = store.getCurrentOwnership('listingRevise');
                if (!ownership || ownership.owner !== 'product_pipeline'
                    || !ownership.singleWriterVerified) {
                    deny('REVISE_OWNERSHIP_NOT_ESTABLISHED');
                }
                const identityInputs = reviseIdentityInputs(target);
                const sourceIdentityKey = ensureIdentity(store, identityInputs.source, clock());
                const targetIdentityKey = ensureIdentity(store, identityInputs.targetListing, clock());
                const intentKey = deriveIdempotencyKey({
                    scopeKey: deriveScopeKey(MIGRATION_SCOPE),
                    action: 'revise_ebay_listing',
                    sourceIdentityKey,
                    targetIdentityKey,
                    desiredStateDigest: target.derived.manifestDigest,
                });
                if (store.getIntent(intentKey) !== null) {
                    deny('REVISE_INTENT_ALREADY_RECORDED');
                }
                const createdAtUtc = clock();
                store.createIdempotencyIntent({
                    action: 'revise_ebay_listing',
                    sourceIdentityKey,
                    targetIdentityKey,
                    desiredStateDigest: target.derived.manifestDigest,
                    createdAtUtc,
                    audit: { eventId: `intent:${intentKey.slice(7, 27)}`, occurredAtUtc: createdAtUtc },
                });
                const approvalToken = `listing-revise-approval:${uuid()}`;
                const issuedAtUtc = clock();
                const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + APPROVAL_TTL_MS).toISOString();
                const ownershipVersion = ownership.version;
                store.issueActionApproval({
                    approvalToken,
                    intentKey,
                    responsibility: 'listingRevise',
                    targetIdentityKey,
                    ownershipVersion,
                    issuedAtUtc,
                    expiresAtUtc,
                    evidenceDigest: target.derived.manifestDigest,
                    audit: { eventId: `approval:${uuid()}`, occurredAtUtc: issuedAtUtc },
                });
                const jobId = `listing-revise-job:${uuid()}`;
                const attemptId = `listing-revise-attempt:${uuid()}`;
                const reservedAtUtc = clock();
                store.reserveExecutionJob({
                    jobId,
                    approvalToken,
                    intentKey,
                    responsibility: 'listingRevise',
                    targetIdentityKey,
                    ownershipVersion,
                    approvalEvidenceDigest: target.derived.manifestDigest,
                    reservedAtUtc,
                    evidenceDigest: target.derived.manifestDigest,
                    audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reservedAtUtc },
                });
                const markDispatching = () => {
                    const dispatchAtUtc = clock();
                    store.markDispatchingOutcomeUnknown({
                        jobId,
                        attemptId,
                        approvalToken,
                        approvalEvidenceDigest: target.derived.manifestDigest,
                        occurredAtUtc: dispatchAtUtc,
                        evidenceDigest: target.derived.manifestDigest,
                        audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: dispatchAtUtc },
                    });
                };
                let dispatchFailed = false;
                let externalCommerceWritesAttempted = 0;
                if (target.derived.manifest.identity.managementModel === 'inventory_api') {
                    // Round-trip the raw provider resources and derive the exact
                    // payloads before the dispatch boundary; any binding or
                    // preservation failure stops the job while it is still reserved.
                    const adapter = createAdapter();
                    const sku = target.basis.identity.ebayInventorySku;
                    const offerId = target.basis.identity.ebayOfferId;
                    const rawInventoryItem = await adapter.getInventoryItem(sku);
                    const rawOffer = await adapter.getOffer(offerId);
                    const payloads = buildListingRevisePayloads({
                        manifest: target.derived.manifest,
                        rawInventoryItem,
                        rawOffer,
                    });
                    markDispatching();
                    externalCommerceWritesAttempted =
                        Number(payloads.inventoryItemChanged) + Number(payloads.offerChanged);
                    try {
                        if (payloads.inventoryItemChanged) {
                            await adapter.putInventoryItem(sku, payloads.inventoryItemPayload);
                        }
                        if (payloads.offerChanged) {
                            await adapter.putOffer(offerId, payloads.offerPayload);
                        }
                    }
                    catch {
                        dispatchFailed = true;
                    }
                }
                else {
                    // Trading-model dispatch: the fresh workspace read above already
                    // verified the current remote state against the revision's
                    // observed base, so there is no raw resource round-trip — exactly
                    // one bounded ReviseFixedPriceItem POST carries only the
                    // manifest's changed fields, and omission preserves price and
                    // quantity structurally (the adapter asserts no such element is
                    // ever serialized).
                    const tradingAdapter = createTradingAdapter();
                    markDispatching();
                    externalCommerceWritesAttempted = 1;
                    try {
                        await tradingAdapter.reviseFixedPriceItem({
                            listingId: target.basis.identity.ebayListingId,
                            changes: target.derived.manifest.changes,
                        });
                    }
                    catch {
                        dispatchFailed = true;
                    }
                }
                const requiredAtUtc = clock();
                store.requirePostDispatchReconciliation({
                    jobId,
                    attemptId,
                    occurredAtUtc: requiredAtUtc,
                    evidenceDigest: target.derived.manifestDigest,
                    audit: { eventId: `job:${jobId}:reconciliation-required`, occurredAtUtc: requiredAtUtc },
                });
                const reconciliation = await runReconciliation({
                    store,
                    target,
                    intentKey,
                    targetIdentityKey,
                    jobId,
                    attemptId,
                    readWorkspace,
                    catalogId: options.catalogId,
                    clock,
                    uuid,
                    resolveAbsent: dispatchFailed,
                });
                io.stdout(JSON.stringify({
                    command: 'dispatch',
                    status: reconciliation.resolution === 'resolved_existing'
                        ? 'dispatched-and-reconciled'
                        : 'dispatched-unresolved',
                    ...(target.descriptionTemplate === null
                        ? {}
                        : { descriptionTemplate: target.descriptionTemplate }),
                    jobId,
                    attemptId,
                    intentKey,
                    manifestDigest: target.derived.manifestDigest,
                    providerDispatchReported: !dispatchFailed,
                    effect: reconciliation.effect,
                    resolution: reconciliation.resolution,
                    reconciliationRunId: reconciliation.runId,
                    externalCommerceWritesAttempted,
                }));
                if (reconciliation.resolution !== 'resolved_existing')
                    io.setExitCode(1);
            }
            finally {
                store.close();
            }
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'dispatch', status: 'denied', code: safeErrorCode(error),
            }));
            io.setExitCode(1);
        }
    });
    withTargetOptions(program
        .command('reconcile')
        .description('Re-run post-dispatch reconciliation for an outstanding reconciliation_required job'))
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .requiredOption('--job-id <id>', 'Exact job id printed by dispatch')
        .requiredOption('--attempt-id <id>', 'Exact attempt id printed by dispatch')
        .option('--accept-absent', 'Explicitly accept a still-absent revise effect as the terminal confirmed_missing outcome')
        .action(async (options) => {
        try {
            assertDescriptionTemplateFlag(options.descriptionTemplate);
            const workspaceDto = await readWorkspace(options.catalogId);
            const freshBasis = deriveListingDraftBasis(workspaceDto);
            if (freshBasis.identity.rawSku !== options.sku
                || freshBasis.identity.ebayListingId !== options.listingId
                || !exactOfferIdMatches(freshBasis.identity.ebayOfferId, options.offerId)) {
                deny('REVISE_EXACT_TARGET_MISMATCH');
            }
            const draftPath = draftDatabasePath();
            if (typeof draftPath !== 'string' || draftPath.length === 0) {
                deny('REVISE_DRAFT_STORE_UNAVAILABLE');
            }
            const draftStore = openDraftStoreReadOnly({
                databasePath: draftPath,
                expectedScope: LISTING_DRAFT_SCOPE,
            });
            let revision;
            try {
                revision = draftStore.getLatestRevision(freshBasis.identity.shopifyVariantGid);
            }
            finally {
                draftStore.close();
            }
            if (revision === null || revision.revisionDigest !== options.revisionDigest) {
                deny('REVISE_DRAFT_REVISION_MISMATCH');
            }
            const derivedBase = deriveListingReviseManifest(revision);
            const templated = applyTemplateOption(derivedBase, revision, options.descriptionTemplate);
            const derived = templated.derived;
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                const identityInputs = reviseIdentityInputs({
                    basis: freshBasis, revision: revision, derived,
                    descriptionTemplate: templated.note,
                });
                const sourceIdentityKey = deriveExternalIdentityKey(identityInputs.source);
                const targetIdentityKey = deriveExternalIdentityKey(identityInputs.targetListing);
                const intentKey = deriveIdempotencyKey({
                    scopeKey: deriveScopeKey(MIGRATION_SCOPE),
                    action: 'revise_ebay_listing',
                    sourceIdentityKey,
                    targetIdentityKey,
                    desiredStateDigest: derived.manifestDigest,
                });
                if (store.getIntent(intentKey) === null)
                    deny('REVISE_INTENT_NOT_FOUND');
                const reconciliation = await runReconciliation({
                    store,
                    target: {
                        basis: freshBasis, revision: revision, derived,
                        descriptionTemplate: templated.note,
                    },
                    intentKey,
                    targetIdentityKey,
                    jobId: options.jobId,
                    attemptId: options.attemptId,
                    readWorkspace,
                    catalogId: options.catalogId,
                    clock,
                    uuid,
                    resolveAbsent: options.acceptAbsent === true,
                });
                io.stdout(JSON.stringify({
                    command: 'reconcile',
                    status: reconciliation.resolution === null ? 'unresolved' : 'reconciled',
                    jobId: options.jobId,
                    attemptId: options.attemptId,
                    effect: reconciliation.effect,
                    resolution: reconciliation.resolution,
                    reconciliationRunId: reconciliation.runId,
                    externalWritesPerformed: 0,
                }));
                if (reconciliation.resolution === null)
                    io.setExitCode(1);
            }
            finally {
                store.close();
            }
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'reconcile', status: 'denied', code: safeErrorCode(error),
            }));
            io.setExitCode(1);
        }
    });
    return program;
}
