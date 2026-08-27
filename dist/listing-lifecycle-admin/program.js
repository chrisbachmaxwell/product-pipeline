/**
 * Isolated listing-lifecycle operator CLI — the listing CREATE and listing
 * END provider dispatch slice (Marketplace Connect replacement, migration
 * store schema v3).
 *
 * It is never imported or mounted by the server. One `dispatch-create` or
 * `dispatch-end` invocation is the one-action, exact-target operator
 * approval: the operator must name the exact catalog row, SKU (plus listing
 * id / offer id for an end), draft revision digest (for a create), AND the
 * manifest digest previously printed by the matching preflight. Any
 * mismatch, stale remote state, missing ownership, consumed approval, or
 * foreign target fails closed before a provider write. Every intent,
 * approval, job, attempt, reconciliation run, and resolution is recorded
 * durably in the migration-state store's hash-chained audit before and after
 * the bounded provider calls.
 *
 * Relist has no separate code path: relisting an ended item is a re-run of
 * the create ceremony once the item is a clean not-listed workspace row.
 */
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { deriveExternalIdentityKey, deriveIdempotencyKey, deriveScopeKey, openMigrationStore, MigrationStoreError, } from '../migration-store/index.js';
import { openListingControlStoreReadOnly, sha256Digest, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import { deriveListingDraftBasis, ListingDraftServiceError, } from '../server/listing-draft-service.js';
import { readListingWorkspace } from '../server/listing-workspace-reader.js';
import { applyListingCreateDescriptionTemplate, assertFreshBasisMatchesCreateRevision, buildListingCreatePayloads, classifyCreateOutcome, classifyEndOutcome, deriveListingCreateManifest, deriveListingEndManifest, ListingLifecycleManifestError, } from './manifest.js';
import { LISTING_DESCRIPTION_TEMPLATE_VERSION } from '../server/listing-description-template.js';
import { createListingCreateDispatchAdapter, createProductionDispatchTokenProvider, ListingCreateDispatchError, } from './create-dispatch-adapter.js';
import { createInventoryWithdrawDispatchAdapter, createTradingEndDispatchAdapter, ListingEndDispatchError, } from './end-dispatch-adapter.js';
const APPROVAL_TTL_MS = 10 * 60_000;
const VALUE_PREVIEW_LENGTH = 120;
const LIFECYCLE_RESPONSIBILITIES = Object.freeze(['listingCreate', 'listingEndRelist']);
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
class ListingLifecycleAdminError extends Error {
    code;
    constructor(code) {
        super('Listing lifecycle operation denied');
        this.code = code;
        this.name = 'ListingLifecycleAdminError';
    }
}
const deny = (code) => {
    throw new ListingLifecycleAdminError(code);
};
function safeError(error) {
    if (error instanceof ListingLifecycleAdminError)
        return { code: error.code };
    if (error instanceof ListingLifecycleManifestError) {
        return error.field === null
            ? { code: error.code }
            : { code: error.code, field: error.field };
    }
    if (error instanceof ListingCreateDispatchError)
        return { code: error.code };
    if (error instanceof ListingEndDispatchError)
        return { code: error.code };
    if (error instanceof ListingDraftServiceError)
        return { code: error.code };
    if (error instanceof MigrationStoreError)
        return { code: `MIGRATION_STORE_${error.code}` };
    return { code: 'LISTING_LIFECYCLE_DENIED' };
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
 * Exact-target offer-id acceptance for an end: an inventory-model target must
 * be named by its exact offer id, while a Trading-model target (which has no
 * offer) must be named with the literal `none` — any other combination is a
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
function sourceVariantIdentity(shopifyVariantGid) {
    return {
        platform: 'shopify',
        kind: 'variant',
        bindingKey: `shopify-variant:${shopifyVariantGid}`,
        storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
        externalGid: shopifyVariantGid,
    };
}
/**
 * The migration store requires a create_ebay_listing target of kind
 * `inventory_sku` (see assertActionIdentityShape): the target is registered
 * with the planned eBay inventory-item SKU — the raw SKU the Inventory/Offer
 * model will bind — because no listing or offer id exists yet.
 */
function createTargetIdentity(sku) {
    return {
        platform: 'ebay',
        kind: 'inventory_sku',
        bindingKey: `ebay-inventory-sku:${sku}`,
        environment: MIGRATION_SCOPE.ebayEnvironment,
        sellerId: MIGRATION_SCOPE.ebaySellerId,
        marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
        externalId: sku,
    };
}
/**
 * The migration store requires an end_or_relist_ebay_listing target of kind
 * `listing` (see assertActionIdentityShape): the exact live eBay listing id.
 */
function endTargetIdentity(listingId) {
    return {
        platform: 'ebay',
        kind: 'listing',
        bindingKey: `ebay-listing:${listingId}`,
        environment: MIGRATION_SCOPE.ebayEnvironment,
        sellerId: MIGRATION_SCOPE.ebaySellerId,
        marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
        externalId: listingId,
    };
}
function loadLatestRevision(dependencies, shopifyVariantGid, revisionDigest) {
    const draftPath = dependencies.draftDatabasePath();
    if (typeof draftPath !== 'string' || draftPath.length === 0) {
        deny('CREATE_DRAFT_STORE_UNAVAILABLE');
    }
    const draftStore = dependencies.openDraftStoreReadOnly({
        databasePath: draftPath,
        expectedScope: LISTING_DRAFT_SCOPE,
    });
    let revision;
    try {
        revision = draftStore.getLatestRevision(shopifyVariantGid);
    }
    finally {
        draftStore.close();
    }
    if (revision === null)
        deny('CREATE_DRAFT_REVISION_MISSING');
    if (revision.revisionDigest !== revisionDigest) {
        deny('CREATE_DRAFT_REVISION_MISMATCH');
    }
    return revision;
}
async function deriveCreateTarget(dependencies, options) {
    if (options.descriptionTemplate !== undefined
        && options.descriptionTemplate !== LISTING_DESCRIPTION_TEMPLATE_VERSION) {
        deny('CREATE_TEMPLATE_UNSUPPORTED');
    }
    const workspaceDto = await dependencies.readWorkspace(options.catalogId);
    const basis = deriveListingDraftBasis(workspaceDto);
    if (basis.identity.rawSku !== options.sku)
        deny('CREATE_EXACT_TARGET_MISMATCH');
    // A create requires a not-listed target: no eBay artifacts of any kind.
    if (basis.identity.managementModel !== 'unmanaged'
        || basis.identity.ebayListingId !== null
        || basis.identity.ebayOfferId !== null
        || basis.identity.ebayInventorySku !== null) {
        deny('CREATE_TARGET_ALREADY_LISTED');
    }
    const revision = loadLatestRevision(dependencies, basis.identity.shopifyVariantGid, options.revisionDigest);
    let derived = deriveListingCreateManifest(revision);
    assertFreshBasisMatchesCreateRevision({ revision, freshBasis: basis });
    let descriptionTemplate = null;
    if (options.descriptionTemplate !== undefined) {
        const templated = applyListingCreateDescriptionTemplate({
            derived,
            revision,
            templateVersion: options.descriptionTemplate,
        });
        derived = { manifest: templated.manifest, manifestDigest: templated.manifestDigest };
        descriptionTemplate = {
            templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION,
            applied: templated.descriptionTemplateApplied,
        };
    }
    return { basis, revision, derived, descriptionTemplate };
}
async function deriveEndTarget(dependencies, options) {
    const workspaceDto = await dependencies.readWorkspace(options.catalogId);
    const basis = deriveListingDraftBasis(workspaceDto);
    const derived = deriveListingEndManifest({ basis, reason: options.reason });
    const identity = basis.identity;
    if (identity.rawSku !== options.sku
        || identity.ebayListingId !== options.listingId
        || !exactOfferIdMatches(identity.ebayOfferId, options.offerId)) {
        deny('END_EXACT_TARGET_MISMATCH');
    }
    return { basis, derived };
}
function createManifestSummary(target) {
    const { manifest, manifestDigest } = target.derived;
    return {
        manifestSchemaVersion: manifest.schemaVersion,
        manifestDigest,
        action: manifest.action,
        descriptionPlacement: manifest.descriptionPlacement,
        revisionId: manifest.revisionId,
        revisionNumber: manifest.revisionNumber,
        revisionDigest: manifest.revisionDigest,
        identity: manifest.identity,
        proposed: {
            title: preview(manifest.proposed.title),
            categoryId: manifest.proposed.categoryId,
            conditionId: manifest.proposed.conditionId,
            conditionEnum: manifest.proposed.conditionEnum,
            conditionDescription: preview(manifest.proposed.conditionDescription),
            inventoryProductDescription: preview(manifest.proposed.inventoryProductDescription),
            description: preview(manifest.proposed.description),
            imageCount: manifest.proposed.images.length,
            aspects: manifest.proposed.aspects,
            fulfillmentPolicyId: manifest.proposed.fulfillmentPolicyId,
            paymentPolicyId: manifest.proposed.paymentPolicyId,
            returnPolicyId: manifest.proposed.returnPolicyId,
            merchantLocationKey: manifest.proposed.merchantLocationKey,
            price: manifest.proposed.price,
            quantity: manifest.proposed.quantity,
            listingDuration: manifest.proposed.listingDuration,
        },
        ...(target.descriptionTemplate === null
            ? {}
            : { descriptionTemplate: target.descriptionTemplate }),
        externalWritesPerformed: 0,
    };
}
function endManifestSummary(target) {
    const { manifest, manifestDigest } = target.derived;
    return {
        manifestDigest,
        action: manifest.action,
        reason: manifest.reason,
        identity: manifest.identity,
        observedTitleDigest: manifest.observedTitleDigest,
        externalWritesPerformed: 0,
    };
}
function effectLabel(responsibility, kind) {
    if (kind === 'artifact')
        return 'offer_unpublished';
    if (kind === 'unverified')
        return 'unverified';
    if (responsibility === 'listingCreate') {
        return kind === 'observed' ? 'created_state_observed' : 'created_state_absent';
    }
    return kind === 'observed' ? 'ended_state_observed' : 'ended_state_absent';
}
function unresolvedExceptionCode(responsibility, kind) {
    if (kind === 'artifact')
        return 'CREATE_OFFER_UNPUBLISHED';
    if (kind === 'unverified') {
        return responsibility === 'listingCreate' ? 'CREATE_STATE_UNVERIFIED' : 'END_STATE_UNVERIFIED';
    }
    return responsibility === 'listingCreate'
        ? 'CREATED_STATE_NOT_YET_OBSERVED'
        : 'ENDED_STATE_NOT_YET_OBSERVED';
}
async function runLifecycleReconciliation(input) {
    const startedAtUtc = input.clock();
    const freshDto = await input.readWorkspace(input.catalogId);
    const outcome = input.classify(freshDto);
    const completedAtUtc = input.clock();
    const runId = `listing-lifecycle-run:${input.uuid()}`;
    const resultDigest = sha256Digest({
        schemaVersion: 1,
        responsibility: input.responsibility,
        manifestDigest: input.manifestDigest,
        kind: outcome.kind,
        observedListingId: outcome.observedListingId,
        observedOfferId: outcome.observedOfferId,
        observedDigest: outcome.observedDigest,
    });
    const resolvable = outcome.kind === 'observed'
        || (outcome.kind === 'absent' && input.resolveAbsent);
    const effect = effectLabel(input.responsibility, outcome.kind);
    const unresolvedCode = resolvable
        ? null
        : unresolvedExceptionCode(input.responsibility, outcome.kind);
    const exceptions = unresolvedCode === null ? [] : [{
            exceptionId: `listing-lifecycle-exception:${input.uuid()}`,
            code: unresolvedCode,
            severity: 'critical',
            subjectIdentityKey: input.targetIdentityKey,
            detailsDigest: resultDigest,
        }];
    const observation = outcome.kind === 'observed' || outcome.kind === 'absent' ? {
        observationId: `listing-lifecycle-observation:${input.uuid()}`,
        intentKey: input.intentKey,
        responsibility: input.responsibility,
        effect: outcome.kind === 'observed' ? 'effect_observed' : 'effect_absent',
        observedDigest: outcome.observedDigest,
    } : null;
    input.store.recordReconciliationRun({
        runId,
        responsibility: input.responsibility,
        targetIdentityKey: input.targetIdentityKey,
        mode: 'production_canary',
        status: 'passed',
        sourceSnapshotDigest: input.manifestDigest,
        targetSnapshotDigest: outcome.observedDigest,
        resultDigest,
        authoritative: resolvable,
        authorityEvidenceDigest: input.authorityEvidenceDigest,
        externalWritesObserved: 0,
        startedAtUtc,
        completedAtUtc,
        exceptions,
        targetEffectObservation: observation,
        audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: completedAtUtc },
    });
    if (!resolvable) {
        return { effect, resolution: null, runId, unresolvedCode, outcome };
    }
    const resolution = outcome.kind === 'observed'
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
    return { effect, resolution, runId, unresolvedCode: null, outcome };
}
/**
 * The shared migration-store ceremony up to (but not across) the dispatch
 * boundary: ownership gate, identity registration, idempotent intent,
 * single-use 10-minute exact-target approval, and job reservation. The
 * returned `markDispatching` closure crosses the outcome-unknown boundary and
 * must be called immediately before the first provider write.
 */
function reserveLifecycleJob(input) {
    const { store } = input;
    const ownership = store.getCurrentOwnership(input.responsibility);
    if (!ownership || ownership.owner !== 'product_pipeline' || !ownership.singleWriterVerified) {
        deny(input.ownershipMissingCode);
    }
    const ownershipVersion = ownership.version;
    const sourceIdentityKey = ensureIdentity(store, input.sourceIdentity, input.clock());
    const targetIdentityKey = ensureIdentity(store, input.targetIdentity, input.clock());
    const intentKey = deriveIdempotencyKey({
        scopeKey: deriveScopeKey(MIGRATION_SCOPE),
        action: input.action,
        sourceIdentityKey,
        targetIdentityKey,
        desiredStateDigest: input.manifestDigest,
    });
    if (store.getIntent(intentKey) !== null)
        deny(input.replayDeniedCode);
    const createdAtUtc = input.clock();
    store.createIdempotencyIntent({
        action: input.action,
        sourceIdentityKey,
        targetIdentityKey,
        desiredStateDigest: input.manifestDigest,
        createdAtUtc,
        audit: { eventId: `intent:${intentKey.slice(7, 27)}`, occurredAtUtc: createdAtUtc },
    });
    const approvalToken = `${input.jobPrefix}-approval:${input.uuid()}`;
    const issuedAtUtc = input.clock();
    const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + APPROVAL_TTL_MS).toISOString();
    store.issueActionApproval({
        approvalToken,
        intentKey,
        responsibility: input.responsibility,
        targetIdentityKey,
        ownershipVersion,
        issuedAtUtc,
        expiresAtUtc,
        evidenceDigest: input.manifestDigest,
        audit: { eventId: `approval:${input.uuid()}`, occurredAtUtc: issuedAtUtc },
    });
    const jobId = `${input.jobPrefix}-job:${input.uuid()}`;
    const attemptId = `${input.jobPrefix}-attempt:${input.uuid()}`;
    const reservedAtUtc = input.clock();
    store.reserveExecutionJob({
        jobId,
        approvalToken,
        intentKey,
        responsibility: input.responsibility,
        targetIdentityKey,
        ownershipVersion,
        approvalEvidenceDigest: input.manifestDigest,
        reservedAtUtc,
        evidenceDigest: input.manifestDigest,
        audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reservedAtUtc },
    });
    const markDispatching = () => {
        const dispatchAtUtc = input.clock();
        store.markDispatchingOutcomeUnknown({
            jobId,
            attemptId,
            approvalToken,
            approvalEvidenceDigest: input.manifestDigest,
            occurredAtUtc: dispatchAtUtc,
            evidenceDigest: input.manifestDigest,
            audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: dispatchAtUtc },
        });
    };
    return { intentKey, sourceIdentityKey, targetIdentityKey, jobId, attemptId, markDispatching };
}
export function buildListingLifecycleAdminProgram(dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    const readWorkspace = dependencies.readWorkspace ?? readListingWorkspace;
    const draftDatabasePath = dependencies.draftDatabasePath
        ?? (() => process.env.LISTING_CONTROL_DATABASE_PATH);
    const openDraftStoreReadOnly = dependencies.openDraftStoreReadOnly
        ?? openListingControlStoreReadOnly;
    const openMigration = dependencies.openMigration ?? openMigrationStore;
    const createCreateAdapter = dependencies.createCreateAdapter ?? (() => createListingCreateDispatchAdapter({
        getAccessToken: createProductionDispatchTokenProvider(),
    }));
    const createTradingEndAdapter = dependencies.createTradingEndAdapter ?? (() => createTradingEndDispatchAdapter({
        getAccessToken: createProductionDispatchTokenProvider(),
    }));
    const createWithdrawAdapter = dependencies.createWithdrawAdapter ?? (() => createInventoryWithdrawDispatchAdapter({
        getAccessToken: createProductionDispatchTokenProvider(),
    }));
    const now = dependencies.now ?? (() => new Date());
    const uuid = dependencies.uuid ?? randomUUID;
    const targetDependencies = {
        readWorkspace, draftDatabasePath, openDraftStoreReadOnly,
    };
    const program = new Command();
    program
        .name('listing-lifecycle-admin')
        .description('Isolated one-action listing CREATE and listing END dispatch for exactly one target')
        .showHelpAfterError();
    const withCreateTargetOptions = (command) => command
        .requiredOption('--catalog-id <id>', 'Exact listings catalog row id')
        .requiredOption('--sku <sku>', 'Exact raw SKU of the one not-listed target')
        .requiredOption('--revision-digest <sha256>', 'Exact approved draft revision digest')
        .option('--description-template <version>', `Create only: opt in to the exact ${LISTING_DESCRIPTION_TEMPLATE_VERSION} description template`);
    const withEndTargetOptions = (command) => command
        .requiredOption('--catalog-id <id>', 'Exact listings catalog row id')
        .requiredOption('--sku <sku>', 'Exact raw SKU of the one active target')
        .requiredOption('--listing-id <id>', 'Exact eBay listing id of the one target')
        .requiredOption('--offer-id <id>', 'Exact eBay offer id of the one target, or the literal "none" for a Trading-model target')
        .requiredOption('--reason <reason>', 'Ending reason; only "not-available" is supported');
    program
        .command('establish-ownership')
        .description('Record the paused-genesis and product_pipeline ownership chain once for one '
        + 'lifecycle responsibility (listingCreate or listingEndRelist)')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
        .requiredOption('--evidence-digest <sha256>', 'Digest of the reviewed single-writer evidence')
        .requiredOption('--responsibility <responsibility>', 'Exactly listingCreate or listingEndRelist')
        .action((options) => {
        try {
            if (!LIFECYCLE_RESPONSIBILITIES.includes(options.responsibility)) {
                deny('LIFECYCLE_RESPONSIBILITY_INVALID');
            }
            const responsibility = options.responsibility;
            if (options.confirmScope !== deriveScopeKey(MIGRATION_SCOPE)) {
                deny('LIFECYCLE_SCOPE_CONFIRMATION_MISMATCH');
            }
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                let current = store.getCurrentOwnership(responsibility);
                if (current && current.owner === 'product_pipeline') {
                    io.stdout(JSON.stringify({
                        command: 'establish-ownership', status: 'already-established',
                        responsibility, version: current.version, externalWritesPerformed: 0,
                    }));
                    return;
                }
                if (!current) {
                    const genesisAt = clock();
                    store.recordOwnershipVersion({
                        responsibility,
                        version: 1,
                        owner: 'paused',
                        singleWriterVerified: true,
                        evidenceDigest: options.evidenceDigest,
                        effectiveAtUtc: genesisAt,
                        recordedAtUtc: genesisAt,
                        audit: {
                            eventId: `ownership:${responsibility}:v1:${uuid()}`,
                            occurredAtUtc: genesisAt,
                        },
                    });
                    current = store.getCurrentOwnership(responsibility);
                }
                if (!current || current.owner !== 'paused') {
                    throw new ListingLifecycleAdminError('LIFECYCLE_OWNERSHIP_CHAIN_INVALID');
                }
                const transferAt = clock();
                store.recordOwnershipVersion({
                    responsibility,
                    version: current.version + 1,
                    owner: 'product_pipeline',
                    singleWriterVerified: true,
                    evidenceDigest: options.evidenceDigest,
                    effectiveAtUtc: transferAt,
                    recordedAtUtc: transferAt,
                    audit: {
                        eventId: `ownership:${responsibility}:v${current.version + 1}:${uuid()}`,
                        occurredAtUtc: transferAt,
                    },
                });
                io.stdout(JSON.stringify({
                    command: 'establish-ownership', status: 'established',
                    responsibility, version: current.version + 1, externalWritesPerformed: 0,
                }));
            }
            finally {
                store.close();
            }
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'establish-ownership', status: 'denied', ...safeError(error),
            }));
            io.setExitCode(1);
        }
    });
    withCreateTargetOptions(program
        .command('preflight-create')
        .description('Derive and print the exact CREATE manifest without any store or provider write'))
        .action(async (options) => {
        try {
            const target = await deriveCreateTarget(targetDependencies, options);
            io.stdout(JSON.stringify({
                command: 'preflight-create',
                status: 'preview',
                ...createManifestSummary(target),
            }));
            io.setExitCode(2);
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'preflight-create', status: 'denied', ...safeError(error),
            }));
            io.setExitCode(1);
        }
    });
    withCreateTargetOptions(program
        .command('dispatch-create')
        .description('One-action exact-target CREATE dispatch of one approved draft revision to eBay '
        + '(inventory item PUT, offer POST, publish POST), with durable idempotent job state '
        + 'and immediate post-action reconciliation'))
        .requiredOption('--manifest-digest <sha256>', 'Exact manifest digest printed by preflight-create')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .action(async (options) => {
        try {
            const target = await deriveCreateTarget(targetDependencies, options);
            if (target.derived.manifestDigest !== options.manifestDigest) {
                deny('CREATE_MANIFEST_DIGEST_MISMATCH');
            }
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                const ceremony = reserveLifecycleJob({
                    store,
                    responsibility: 'listingCreate',
                    action: 'create_ebay_listing',
                    sourceIdentity: sourceVariantIdentity(target.basis.identity.shopifyVariantGid),
                    targetIdentity: createTargetIdentity(target.basis.identity.rawSku),
                    manifestDigest: target.derived.manifestDigest,
                    replayDeniedCode: 'CREATE_INTENT_ALREADY_RECORDED',
                    ownershipMissingCode: 'CREATE_OWNERSHIP_NOT_ESTABLISHED',
                    jobPrefix: 'listing-create',
                    clock,
                    uuid,
                });
                // Derive both provider payloads from the manifest alone before the
                // dispatch boundary; a payload failure stops the job while it is
                // still reserved.
                const payloads = buildListingCreatePayloads(target.derived.manifest);
                const adapter = createCreateAdapter();
                const sku = target.basis.identity.rawSku;
                ceremony.markDispatching();
                let dispatchFailed = false;
                let dispatchFailureStage = null;
                let dispatchFailureCode = null;
                let offerId = null;
                let listingId = null;
                let externalCommerceWritesAttempted = 0;
                try {
                    dispatchFailureStage = 'put_inventory_item';
                    externalCommerceWritesAttempted = 1;
                    await adapter.putInventoryItem(sku, payloads.inventoryItemPayload);
                    dispatchFailureStage = 'create_offer';
                    externalCommerceWritesAttempted = 2;
                    offerId = await adapter.createOffer(payloads.offerPayload);
                    dispatchFailureStage = 'publish_offer';
                    externalCommerceWritesAttempted = 3;
                    listingId = await adapter.publishOffer(offerId);
                    dispatchFailureStage = null;
                }
                catch (error) {
                    dispatchFailed = true;
                    dispatchFailureCode = error instanceof ListingCreateDispatchError
                        ? error.code
                        : 'CREATE_DISPATCH_WRITE_FAILED';
                }
                const requiredAtUtc = clock();
                store.requirePostDispatchReconciliation({
                    jobId: ceremony.jobId,
                    attemptId: ceremony.attemptId,
                    occurredAtUtc: requiredAtUtc,
                    evidenceDigest: target.derived.manifestDigest,
                    audit: {
                        eventId: `job:${ceremony.jobId}:reconciliation-required`,
                        occurredAtUtc: requiredAtUtc,
                    },
                });
                const reconciliation = await runLifecycleReconciliation({
                    store,
                    responsibility: 'listingCreate',
                    intentKey: ceremony.intentKey,
                    targetIdentityKey: ceremony.targetIdentityKey,
                    jobId: ceremony.jobId,
                    attemptId: ceremony.attemptId,
                    readWorkspace,
                    catalogId: options.catalogId,
                    clock,
                    uuid,
                    manifestDigest: target.derived.manifestDigest,
                    authorityEvidenceDigest: target.derived.manifest.baseEbayObservationDigest,
                    classify: (workspace) => classifyCreateOutcome({
                        workspace,
                        sku,
                        expectedListingId: listingId,
                        expectedDescriptionHtml: target.derived.manifest.proposed.description,
                    }),
                    // Absence may auto-confirm only when the provider reported the
                    // dispatch failed AND no offer artifact was ever created — an
                    // unpublished offer means something durable exists remotely.
                    resolveAbsent: dispatchFailed && offerId === null,
                });
                io.stdout(JSON.stringify({
                    command: 'dispatch-create',
                    status: reconciliation.resolution === 'resolved_existing'
                        ? 'dispatched-and-reconciled'
                        : reconciliation.resolution === 'confirmed_missing'
                            ? 'dispatch-failed-confirmed-missing'
                            : 'dispatched-unresolved',
                    jobId: ceremony.jobId,
                    attemptId: ceremony.attemptId,
                    intentKey: ceremony.intentKey,
                    manifestDigest: target.derived.manifestDigest,
                    ...(target.descriptionTemplate === null
                        ? {}
                        : { descriptionTemplate: target.descriptionTemplate }),
                    offerId,
                    listingId,
                    providerDispatchReported: !dispatchFailed,
                    ...(dispatchFailed ? { dispatchFailureStage, dispatchFailureCode } : {}),
                    effect: reconciliation.effect,
                    resolution: reconciliation.resolution,
                    unresolvedCode: reconciliation.unresolvedCode,
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
                command: 'dispatch-create', status: 'denied', ...safeError(error),
            }));
            io.setExitCode(1);
        }
    });
    withEndTargetOptions(program
        .command('preflight-end')
        .description('Derive and print the exact END manifest without any store or provider write'))
        .action(async (options) => {
        try {
            const target = await deriveEndTarget(targetDependencies, options);
            io.stdout(JSON.stringify({
                command: 'preflight-end',
                status: 'preview',
                ...endManifestSummary(target),
            }));
            io.setExitCode(2);
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'preflight-end', status: 'denied', ...safeError(error),
            }));
            io.setExitCode(1);
        }
    });
    withEndTargetOptions(program
        .command('dispatch-end')
        .description('One-action exact-target END dispatch for one active listing (Trading '
        + 'EndFixedPriceItem or Inventory offer withdraw), with durable idempotent job state '
        + 'and immediate post-action reconciliation'))
        .requiredOption('--manifest-digest <sha256>', 'Exact manifest digest printed by preflight-end')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .action(async (options) => {
        try {
            const target = await deriveEndTarget(targetDependencies, options);
            if (target.derived.manifestDigest !== options.manifestDigest) {
                deny('END_MANIFEST_DIGEST_MISMATCH');
            }
            const listingId = target.basis.identity.ebayListingId;
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                const ceremony = reserveLifecycleJob({
                    store,
                    responsibility: 'listingEndRelist',
                    action: 'end_or_relist_ebay_listing',
                    sourceIdentity: sourceVariantIdentity(target.basis.identity.shopifyVariantGid),
                    targetIdentity: endTargetIdentity(listingId),
                    manifestDigest: target.derived.manifestDigest,
                    replayDeniedCode: 'END_INTENT_ALREADY_RECORDED',
                    ownershipMissingCode: 'END_OWNERSHIP_NOT_ESTABLISHED',
                    jobPrefix: 'listing-end',
                    clock,
                    uuid,
                });
                ceremony.markDispatching();
                let dispatchFailed = false;
                const externalCommerceWritesAttempted = 1;
                try {
                    if (target.basis.identity.managementModel === 'trading_api') {
                        await createTradingEndAdapter().endFixedPriceItem({ listingId });
                    }
                    else {
                        await createWithdrawAdapter().withdrawOffer(target.basis.identity.ebayOfferId);
                    }
                }
                catch {
                    dispatchFailed = true;
                }
                const requiredAtUtc = clock();
                store.requirePostDispatchReconciliation({
                    jobId: ceremony.jobId,
                    attemptId: ceremony.attemptId,
                    occurredAtUtc: requiredAtUtc,
                    evidenceDigest: target.derived.manifestDigest,
                    audit: {
                        eventId: `job:${ceremony.jobId}:reconciliation-required`,
                        occurredAtUtc: requiredAtUtc,
                    },
                });
                const reconciliation = await runLifecycleReconciliation({
                    store,
                    responsibility: 'listingEndRelist',
                    intentKey: ceremony.intentKey,
                    targetIdentityKey: ceremony.targetIdentityKey,
                    jobId: ceremony.jobId,
                    attemptId: ceremony.attemptId,
                    readWorkspace,
                    catalogId: options.catalogId,
                    clock,
                    uuid,
                    manifestDigest: target.derived.manifestDigest,
                    authorityEvidenceDigest: target.basis.ebayDigest,
                    classify: (workspace) => classifyEndOutcome({
                        workspace, sku: options.sku, listingId,
                    }),
                    resolveAbsent: dispatchFailed,
                });
                io.stdout(JSON.stringify({
                    command: 'dispatch-end',
                    status: reconciliation.resolution === 'resolved_existing'
                        ? 'dispatched-and-reconciled'
                        : 'dispatched-unresolved',
                    jobId: ceremony.jobId,
                    attemptId: ceremony.attemptId,
                    intentKey: ceremony.intentKey,
                    manifestDigest: target.derived.manifestDigest,
                    listingId,
                    providerDispatchReported: !dispatchFailed,
                    effect: reconciliation.effect,
                    resolution: reconciliation.resolution,
                    unresolvedCode: reconciliation.unresolvedCode,
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
                command: 'dispatch-end', status: 'denied', ...safeError(error),
            }));
            io.setExitCode(1);
        }
    });
    program
        .command('reconcile')
        .description('Re-run post-dispatch verification for an outstanding reconciliation_required '
        + 'create or end job')
        .requiredOption('--action <action>', 'Exactly create or end')
        .requiredOption('--catalog-id <id>', 'Exact listings catalog row id')
        .requiredOption('--sku <sku>', 'Exact raw SKU of the one target')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .requiredOption('--job-id <id>', 'Exact job id printed by dispatch')
        .requiredOption('--attempt-id <id>', 'Exact attempt id printed by dispatch')
        .option('--revision-digest <sha256>', 'Create only: exact approved draft revision digest')
        .option('--description-template <version>', `Create only: opt in to the exact ${LISTING_DESCRIPTION_TEMPLATE_VERSION} description template`)
        .option('--listing-id <id>', 'End only: exact eBay listing id of the one target')
        .option('--manifest-digest <sha256>', 'End only: exact manifest digest printed by preflight-end')
        .option('--accept-absent', 'Explicitly accept a still-absent effect as the terminal confirmed_missing outcome. '
        + 'Never applies while a created offer artifact exists.')
        .action(async (options) => {
        const command = 'reconcile';
        try {
            if (options.action !== 'create' && options.action !== 'end') {
                deny('LIFECYCLE_ACTION_INVALID');
            }
            if (options.action === 'end' && options.descriptionTemplate !== undefined) {
                deny('LIFECYCLE_DESCRIPTION_TEMPLATE_NOT_ALLOWED');
            }
            if (options.action === 'create'
                && options.descriptionTemplate !== undefined
                && options.descriptionTemplate !== LISTING_DESCRIPTION_TEMPLATE_VERSION) {
                deny('CREATE_TEMPLATE_UNSUPPORTED');
            }
            const workspaceDto = await readWorkspace(options.catalogId);
            const shopify = workspaceDto.catalog.shopify;
            if (!shopify || shopify.sku !== options.sku) {
                deny(options.action === 'create'
                    ? 'CREATE_EXACT_TARGET_MISMATCH'
                    : 'END_EXACT_TARGET_MISMATCH');
            }
            const variantGid = shopify.variantId;
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = createMonotonicClock(now);
            try {
                const scopeKey = deriveScopeKey(MIGRATION_SCOPE);
                const sourceIdentityKey = deriveExternalIdentityKey(sourceVariantIdentity(variantGid));
                let responsibility;
                let intentKey;
                let targetIdentityKey;
                let manifestDigest;
                let authorityEvidenceDigest;
                let classify;
                let descriptionTemplate = null;
                if (options.action === 'create') {
                    if (typeof options.revisionDigest !== 'string') {
                        deny('CREATE_DRAFT_REVISION_MISMATCH');
                    }
                    const revision = loadLatestRevision(targetDependencies, variantGid, options.revisionDigest);
                    let derived = deriveListingCreateManifest(revision);
                    if (options.descriptionTemplate !== undefined) {
                        const templated = applyListingCreateDescriptionTemplate({
                            derived,
                            revision,
                            templateVersion: options.descriptionTemplate,
                        });
                        derived = { manifest: templated.manifest, manifestDigest: templated.manifestDigest };
                        descriptionTemplate = {
                            templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION,
                            applied: templated.descriptionTemplateApplied,
                        };
                    }
                    responsibility = 'listingCreate';
                    manifestDigest = derived.manifestDigest;
                    authorityEvidenceDigest = derived.manifest.baseEbayObservationDigest;
                    targetIdentityKey = deriveExternalIdentityKey(createTargetIdentity(options.sku));
                    intentKey = deriveIdempotencyKey({
                        scopeKey,
                        action: 'create_ebay_listing',
                        sourceIdentityKey,
                        targetIdentityKey,
                        desiredStateDigest: manifestDigest,
                    });
                    if (store.getIntent(intentKey) === null)
                        deny('CREATE_INTENT_NOT_FOUND');
                    classify = (workspace) => classifyCreateOutcome({
                        workspace,
                        sku: options.sku,
                        expectedListingId: null,
                        expectedDescriptionHtml: derived.manifest.proposed.description,
                    });
                }
                else {
                    if (typeof options.listingId !== 'string'
                        || typeof options.manifestDigest !== 'string'
                        || !/^sha256:[a-f0-9]{64}$/.test(options.manifestDigest)) {
                        deny('END_EXACT_TARGET_MISMATCH');
                    }
                    const listingId = options.listingId;
                    responsibility = 'listingEndRelist';
                    manifestDigest = options.manifestDigest;
                    authorityEvidenceDigest = manifestDigest;
                    targetIdentityKey = deriveExternalIdentityKey(endTargetIdentity(listingId));
                    intentKey = deriveIdempotencyKey({
                        scopeKey,
                        action: 'end_or_relist_ebay_listing',
                        sourceIdentityKey,
                        targetIdentityKey,
                        desiredStateDigest: manifestDigest,
                    });
                    if (store.getIntent(intentKey) === null)
                        deny('END_INTENT_NOT_FOUND');
                    classify = (workspace) => classifyEndOutcome({
                        workspace, sku: options.sku, listingId,
                    });
                }
                const reconciliation = await runLifecycleReconciliation({
                    store,
                    responsibility,
                    intentKey,
                    targetIdentityKey,
                    jobId: options.jobId,
                    attemptId: options.attemptId,
                    readWorkspace,
                    catalogId: options.catalogId,
                    clock,
                    uuid,
                    manifestDigest,
                    authorityEvidenceDigest,
                    classify,
                    resolveAbsent: options.acceptAbsent === true,
                });
                io.stdout(JSON.stringify({
                    command,
                    status: reconciliation.resolution === null ? 'unresolved' : 'reconciled',
                    action: options.action,
                    jobId: options.jobId,
                    attemptId: options.attemptId,
                    effect: reconciliation.effect,
                    resolution: reconciliation.resolution,
                    unresolvedCode: reconciliation.unresolvedCode,
                    offerId: reconciliation.outcome.observedOfferId,
                    listingId: reconciliation.outcome.observedListingId,
                    ...(descriptionTemplate === null ? {} : { descriptionTemplate }),
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
            io.stderr(JSON.stringify({ command, status: 'denied', ...safeError(error) }));
            io.setExitCode(1);
        }
    });
    return program;
}
