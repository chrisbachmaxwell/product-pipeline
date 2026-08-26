import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { createMigrationStore, deriveExternalIdentityKey, deriveIdempotencyKey, deriveScopeKey, openMigrationStore, sha256Digest, MigrationStoreError, } from '../migration-store/index.js';
import { createSandboxAdapter, readCredentialPacket, sellerDigest, SandboxAdapterError, } from './adapter.js';
import { buildPayloads, readSandboxManifest, SandboxManifestError, validateTarget, } from './manifest.js';
const APPROVAL_TTL_MS = 10 * 60_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NUMERIC = /^[0-9]{1,20}$/;
const defaultIo = {
    stdout: (m) => process.stdout.write(`${m}\n`),
    stderr: (m) => process.stderr.write(`${m}\n`),
    setExitCode: (c) => {
        process.exitCode = c;
    },
};
class CanaryError extends Error {
    code;
    constructor(code) {
        super('Sandbox canary operation denied');
        this.code = code;
        this.name = 'CanaryError';
    }
}
const deny = (code) => {
    throw new CanaryError(code);
};
const safeError = (e) => ({
    code: e instanceof CanaryError ||
        e instanceof SandboxAdapterError ||
        e instanceof SandboxManifestError
        ? e.code
        : e instanceof MigrationStoreError
            ? `MIGRATION_STORE_${e.code}`
            : 'SANDBOX_CANARY_DENIED',
});
function target(options) {
    return validateTarget(options);
}
function scope(t, digest) {
    return {
        shopifyStoreDomain: t.storeDomain,
        ebayEnvironment: 'sandbox',
        ebaySellerId: digest,
        ebayMarketplaceId: 'EBAY_US',
    };
}
function clock(now) {
    let last = 0;
    return () => {
        const at = Math.max(now().getTime(), last);
        last = at;
        return new Date(at).toISOString();
    };
}
function sourceIdentity(t) {
    return {
        platform: 'shopify',
        kind: 'variant',
        bindingKey: `shopify-variant:${t.variantGid}`,
        storeDomain: t.storeDomain,
        externalGid: t.variantGid,
    };
}
function skuIdentity(t, s) {
    return {
        platform: 'ebay',
        kind: 'inventory_sku',
        bindingKey: `sandbox-inventory-sku:${t.sku}`,
        environment: 'sandbox',
        sellerId: s.ebaySellerId,
        marketplaceId: 'EBAY_US',
        externalId: t.sku,
    };
}
function listingIdentity(id, s) {
    return {
        platform: 'ebay',
        kind: 'listing',
        bindingKey: `sandbox-listing:${id}`,
        environment: 'sandbox',
        sellerId: s.ebaySellerId,
        marketplaceId: 'EBAY_US',
        externalId: id,
    };
}
function ensureIdentity(store, identity, at) {
    const key = deriveExternalIdentityKey(identity);
    if (!store.getIdentity(key))
        store.registerIdentity(identity, {
            eventId: `identity:${key.slice(7, 27)}`,
            occurredAtUtc: at,
        });
    return key;
}
function requireClean(snapshot) {
    if (snapshot.inventory || snapshot.offers.length || snapshot.tradingListings.length)
        deny('TARGET_NOT_ABSENT');
}
export function assertSandboxCreatedState(snapshot, offerId, listingId, manifest) {
    const payloads = buildPayloads(manifest);
    const expectedInventory = { sku: manifest.target.sku, ...payloads.inventory };
    const expectedOffer = {
        offerId,
        ...payloads.offer,
        status: 'PUBLISHED',
        listingId,
    };
    const l = manifest.listing;
    const expectedTrading = {
        itemId: listingId,
        sku: manifest.target.sku,
        title: l.title,
        description: l.description,
        quantity: l.quantity,
        categoryId: l.categoryId,
        price: l.price.value,
        currency: l.price.currency,
        listingStatus: 'Active',
    };
    if (!snapshot.inventory ||
        snapshot.offers.length !== 1 ||
        snapshot.tradingListings.length !== 1 ||
        sha256Digest(snapshot.inventory) !== sha256Digest(expectedInventory) ||
        sha256Digest(snapshot.offers[0]) !== sha256Digest(expectedOffer) ||
        sha256Digest(snapshot.tradingListings[0]) !== sha256Digest(expectedTrading))
        deny('CREATED_STATE_UNRESOLVED');
}
function requireCreated(snapshot, offerId, listingId, manifest) {
    assertSandboxCreatedState(snapshot, offerId, listingId, manifest);
}
function requireCleanupTarget(snapshot, offerId, listingId, manifest) {
    requireCreated(snapshot, offerId, listingId, manifest);
}
function requireCleaned(snapshot, listingId) {
    if (snapshot.inventory ||
        snapshot.offers.length !== 0 ||
        snapshot.tradingListings.length !== 1 ||
        snapshot.tradingListings[0]?.itemId !== listingId ||
        !['Completed', 'Ended'].includes(snapshot.tradingListings[0]?.listingStatus ?? ''))
        deny('CLEANUP_STATE_UNRESOLVED');
}
export function discoverSandboxRecovery(snapshot, manifest) {
    const payloads = buildPayloads(manifest);
    const inventoryExact = !!snapshot.inventory && sha256Digest(snapshot.inventory) === sha256Digest({ sku: manifest.target.sku, ...payloads.inventory });
    const ended = snapshot.tradingListings.length === 1 && ['Completed', 'Ended'].includes(snapshot.tradingListings[0]?.listingStatus ?? '');
    if (!snapshot.inventory && snapshot.offers.length === 0)
        return { stage: snapshot.tradingListings.length === 0 ? 'absent' : ended ? 'cleaned' : 'drift', offerId: null, listingId: ended ? snapshot.tradingListings[0].itemId : null };
    if (!inventoryExact || snapshot.offers.length > 1 || snapshot.tradingListings.length > 1)
        return { stage: 'drift', offerId: null, listingId: null };
    if (snapshot.offers.length === 0)
        return { stage: ended ? 'inventory_only_ended' : snapshot.tradingListings.length === 0 ? 'inventory_only' : 'drift', offerId: null, listingId: ended ? snapshot.tradingListings[0].itemId : null };
    const offer = snapshot.offers[0];
    const expected = { offerId: offer.offerId, ...payloads.offer, status: offer.status, listingId: offer.listingId };
    if (sha256Digest(offer) !== sha256Digest(expected))
        return { stage: 'drift', offerId: null, listingId: null };
    if (offer.status === 'UNPUBLISHED' && offer.listingId === null)
        return { stage: ended ? 'offer_unpublished_ended' : snapshot.tradingListings.length === 0 ? 'offer_unpublished' : 'drift', offerId: offer.offerId, listingId: ended ? snapshot.tradingListings[0].itemId : null };
    if (offer.status === 'PUBLISHED' && offer.listingId) {
        try {
            assertSandboxCreatedState(snapshot, offer.offerId, offer.listingId, manifest);
            return { stage: 'created', offerId: offer.offerId, listingId: offer.listingId };
        }
        catch {
            return { stage: 'drift', offerId: null, listingId: null };
        }
    }
    return { stage: 'drift', offerId: null, listingId: null };
}
const discoverRecovery = discoverSandboxRecovery;
function createActionDigest(t, manifestDigest) {
    return sha256Digest({
        schemaVersion: 1,
        action: 'sandbox_create',
        target: {
            storeDomain: t.storeDomain,
            productGid: t.productGid,
            variantGid: t.variantGid,
            sku: t.sku,
            shopifyEvidenceDigest: t.shopifyEvidenceDigest,
        },
        manifestDigest,
    });
}
function createOneShotDigest(t) {
    return sha256Digest({
        schemaVersion: 1,
        lane: 'sandbox-listing-canary',
        action: 'create_once',
        storeDomain: t.storeDomain,
        variantGid: t.variantGid,
        sku: t.sku,
    });
}
function createIntentKey(t, s) {
    return deriveIdempotencyKey({
        scopeKey: deriveScopeKey(s),
        action: 'create_ebay_listing',
        sourceIdentityKey: deriveExternalIdentityKey(sourceIdentity(t)),
        targetIdentityKey: deriveExternalIdentityKey(skuIdentity(t, s)),
        desiredStateDigest: createOneShotDigest(t),
    });
}
function recoverySource(o, t, s, listingId) {
    if (!SAFE.test(o.sourceJobId) || !SAFE.test(o.sourceAttemptId) || !DIGEST.test(o.sourceIntentKey) || !['listingCreate', 'listingEndRelist'].includes(o.sourceResponsibility))
        deny('RECOVERY_SOURCE_INVALID');
    const responsibility = o.sourceResponsibility;
    if (responsibility === 'listingEndRelist' && !listingId)
        deny('RECOVERY_SOURCE_INVALID');
    return { responsibility, ceremony: { intentKey: o.sourceIntentKey, targetIdentityKey: responsibility === 'listingCreate' ? deriveExternalIdentityKey(skuIdentity(t, s)) : deriveExternalIdentityKey(listingIdentity(listingId, s)), jobId: o.sourceJobId, attemptId: o.sourceAttemptId, markDispatching: () => deny('RECOVERY_SOURCE_WRITE_DENIED') } };
}
function recoveryDigest(t, manifestDigest, o, d) { return sha256Digest({ schemaVersion: 1, action: 'sandbox_recovery_cleanup', target: { storeDomain: t.storeDomain, variantGid: t.variantGid, sku: t.sku }, manifestDigest, source: { responsibility: o.sourceResponsibility, jobId: o.sourceJobId, attemptId: o.sourceAttemptId, intentKey: o.sourceIntentKey }, residue: d }); }
function establishOwnership(store, responsibility, evidence, next, uuid) {
    let current = store.getCurrentOwnership(responsibility);
    if (!current) {
        const at = next();
        store.recordOwnershipVersion({
            responsibility,
            version: 1,
            owner: 'paused',
            singleWriterVerified: true,
            evidenceDigest: evidence,
            effectiveAtUtc: at,
            recordedAtUtc: at,
            audit: {
                eventId: `sandbox:${responsibility}:paused:${uuid()}`,
                occurredAtUtc: at,
            },
        });
        current = store.getCurrentOwnership(responsibility);
    }
    if (!current || current.owner !== 'paused')
        return deny('OWNERSHIP_CHAIN_INVALID');
    const paused = current;
    const at = next();
    store.recordOwnershipVersion({
        responsibility,
        version: paused.version + 1,
        owner: 'product_pipeline',
        singleWriterVerified: true,
        evidenceDigest: evidence,
        effectiveAtUtc: at,
        recordedAtUtc: at,
        audit: {
            eventId: `sandbox:${responsibility}:owner:${uuid()}`,
            occurredAtUtc: at,
        },
    });
}
function approve(input) {
    const own = input.store.getCurrentOwnership(input.responsibility);
    if (!own || own.owner !== 'product_pipeline' || !own.singleWriterVerified)
        return deny('OWNERSHIP_NOT_ESTABLISHED');
    const ownership = own;
    const sourceKey = ensureIdentity(input.store, sourceIdentity(input.t), input.next());
    const targetKey = ensureIdentity(input.store, input.targetIdentity, input.next());
    const desiredStateDigest = input.intentDesiredDigest ?? input.manifestDigest;
    const intentKey = deriveIdempotencyKey({
        scopeKey: deriveScopeKey(input.s),
        action: input.action,
        sourceIdentityKey: sourceKey,
        targetIdentityKey: targetKey,
        desiredStateDigest,
    });
    const existing = input.store.getIntent(intentKey);
    if (existing) {
        if (existing.action !== input.action ||
            existing.responsibility !== input.responsibility ||
            existing.source_identity_key !== sourceKey ||
            existing.target_identity_key !== targetKey ||
            existing.approval_target_identity_key !== targetKey ||
            existing.desired_state_digest !== desiredStateDigest)
            deny('INTENT_BINDING_INVALID');
    }
    else {
        const created = input.next();
        input.store.createIdempotencyIntent({
            action: input.action,
            sourceIdentityKey: sourceKey,
            targetIdentityKey: targetKey,
            desiredStateDigest,
            createdAtUtc: created,
            audit: {
                eventId: `intent:${intentKey.slice(7, 27)}`,
                occurredAtUtc: created,
            },
        });
    }
    const issued = input.next();
    if (existing) {
        const state = input.store.getIntentApprovalState(intentKey);
        if (state.jobCount !== 0)
            deny('INTENT_ALREADY_CONSUMED');
        if (state.latestExpiresEpochMs !== null && Date.parse(issued) < state.latestExpiresEpochMs)
            deny('APPROVAL_STILL_ACTIVE');
    }
    const approvalToken = `sandbox-approval:${input.uuid()}`;
    const expiresAtUtc = new Date(Date.parse(issued) + APPROVAL_TTL_MS).toISOString();
    const approvalDigest = input.store.issueActionApproval({
        approvalToken,
        intentKey,
        responsibility: input.responsibility,
        targetIdentityKey: targetKey,
        ownershipVersion: ownership.version,
        issuedAtUtc: issued,
        expiresAtUtc,
        evidenceDigest: input.manifestDigest,
        audit: { eventId: `approval:${input.uuid()}`, occurredAtUtc: issued },
    });
    return {
        intentKey,
        targetIdentityKey: targetKey,
        approvalToken,
        approvalDigest,
        expiresAtUtc,
    };
}
function reserve(input) {
    if (sha256Digest(input.approvalToken) !== input.approvalDigest)
        deny('APPROVAL_DIGEST_MISMATCH');
    const ownership = input.store.getCurrentOwnership(input.responsibility);
    if (!ownership || ownership.owner !== 'product_pipeline' || !ownership.singleWriterVerified)
        return deny('OWNERSHIP_NOT_ESTABLISHED');
    const jobId = `sandbox-job:${input.uuid()}`;
    const attemptId = `sandbox-attempt:${input.uuid()}`;
    const reserved = input.next();
    input.store.reserveExecutionJob({
        jobId,
        approvalToken: input.approvalToken,
        intentKey: input.intentKey,
        responsibility: input.responsibility,
        targetIdentityKey: input.targetIdentityKey,
        ownershipVersion: ownership.version,
        approvalEvidenceDigest: input.evidenceDigest,
        reservedAtUtc: reserved,
        evidenceDigest: input.evidenceDigest,
        audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reserved },
    });
    return {
        intentKey: input.intentKey,
        targetIdentityKey: input.targetIdentityKey,
        jobId,
        attemptId,
        markDispatching: () => {
            const at = input.next();
            input.store.markDispatchingOutcomeUnknown({
                jobId,
                attemptId,
                approvalToken: input.approvalToken,
                approvalEvidenceDigest: input.evidenceDigest,
                occurredAtUtc: at,
                evidenceDigest: input.evidenceDigest,
                audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: at },
            });
        },
    };
}
function requireReconcile(store, c, digest, next) {
    const at = next();
    store.requirePostDispatchReconciliation({
        jobId: c.jobId,
        attemptId: c.attemptId,
        occurredAtUtc: at,
        evidenceDigest: digest,
        audit: {
            eventId: `job:${c.jobId}:reconciliation-required`,
            occurredAtUtc: at,
        },
    });
}
function assertOutstanding(store, c, responsibility) {
    const job = store.getJobStatus(c.jobId);
    const attempt = store.getAttemptStatus(c.jobId, c.attemptId);
    if (!job ||
        !attempt ||
        job.intentKey !== c.intentKey ||
        attempt.intentKey !== c.intentKey ||
        job.targetIdentityKey !== c.targetIdentityKey ||
        job.responsibility !== responsibility ||
        job.state !== 'reconciliation_required' ||
        attempt.resolution !== null)
        deny('RECONCILIATION_BINDING_INVALID');
}
function resolve(store, c, responsibility, digest, observed, next, uuid) {
    assertOutstanding(store, c, responsibility);
    const at = next();
    const runId = `sandbox-run:${uuid()}`;
    store.recordReconciliationRun({
        runId,
        responsibility,
        targetIdentityKey: c.targetIdentityKey,
        mode: 'test_lane',
        status: 'passed',
        sourceSnapshotDigest: digest,
        targetSnapshotDigest: observed,
        resultDigest: observed,
        authoritative: true,
        authorityEvidenceDigest: digest,
        externalWritesObserved: 0,
        startedAtUtc: at,
        completedAtUtc: at,
        exceptions: [],
        targetEffectObservation: {
            observationId: `sandbox-observation:${uuid()}`,
            intentKey: c.intentKey,
            responsibility,
            effect: 'effect_observed',
            observedDigest: observed,
        },
        audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: at },
    });
    const done = next();
    store.resolveUnknownAttempt({
        jobId: c.jobId,
        attemptId: c.attemptId,
        resolution: 'resolved_existing',
        reconciliationRunId: runId,
        reconciliationResultDigest: observed,
        reconciledAtUtc: done,
        audit: { eventId: `resolution:${runId}`, occurredAtUtc: done },
    });
    return runId;
}
async function authority(deps, current) {
    const packet = await readCredentialPacket(deps.stdin ?? process.stdin, current);
    const adapter = createSandboxAdapter({
        token: packet.accessToken,
        expectedSellerId: packet.sellerId,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
    });
    await adapter.verifyIdentity();
    return { adapter, sellerHash: sellerDigest(packet.sellerId) };
}
export function buildSandboxListingCanaryProgram(deps = {}) {
    const io = deps.io ?? defaultIo;
    const now = deps.now ?? (() => new Date());
    const uuid = deps.uuid ?? randomUUID;
    const program = new Command()
        .name('sandbox-listing-canary-admin')
        .description('Isolated operator-gated eBay Sandbox listing canary; credentials are bounded stdin only')
        .showHelpAfterError();
    const targetOptions = (c) => c
        .requiredOption('--store-domain <domain>')
        .requiredOption('--product-gid <gid>')
        .requiredOption('--variant-gid <gid>')
        .requiredOption('--sku <sku>')
        .requiredOption('--shopify-evidence-digest <sha256>')
        .requiredOption('--manifest-file <absolute-path>');
    const run = (name, fn, preview = false) => (o) => fn(o)
        .then((r) => {
        io.stdout(JSON.stringify({
            command: name,
            ...r,
            externalProductionWrites: 0,
        }));
        if (preview)
            io.setExitCode(2);
        else if (r.status === 'dispatched-unresolved')
            io.setExitCode(1);
    })
        .catch((e) => {
        io.stderr(JSON.stringify({
            command: name,
            status: 'denied',
            ...safeError(e),
        }));
        io.setExitCode(1);
    });
    targetOptions(program
        .command('init-store')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--evidence-digest <sha256>')).action(run('init-store', async (o) => {
        const t = target(o);
        const { digest } = readSandboxManifest(o.manifestFile, t);
        if (!DIGEST.test(o.evidenceDigest))
            deny('EVIDENCE_DIGEST_INVALID');
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const next = clock(now);
        const store = createMigrationStore({
            databasePath: o.state,
            scope: s,
            createdAtUtc: next(),
        });
        try {
            establishOwnership(store, 'listingCreate', o.evidenceDigest, next, uuid);
            establishOwnership(store, 'listingEndRelist', o.evidenceDigest, next, uuid);
        }
        finally {
            store.close();
        }
        return {
            status: 'initialized',
            scopeKey: deriveScopeKey(s),
            manifestDigest: digest,
            stateRetained: true,
            providerWritesPerformed: 0,
        };
    }));
    targetOptions(program.command('preflight')).action(run('preflight', async (o) => {
        const t = target(o);
        const { manifest, digest } = readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        await a.adapter.validatePrerequisites(manifest);
        const snap = await a.adapter.snapshot(t.sku);
        requireClean(snap);
        return {
            status: 'prerequisites-partial',
            action: 'create',
            manifestDigest: digest,
            actionDigest: createActionDigest(t, digest),
            target: {
                productGid: t.productGid,
                variantGid: t.variantGid,
                sku: t.sku,
            },
            state: 'absent',
            providerWritesPerformed: 0,
        };
    }, true));
    targetOptions(program
        .command('approve-create')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--manifest-digest <sha256>')
        .requiredOption('--action-digest <sha256>')).action(run('approve-create', async (o) => {
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        if (parsed.digest !== o.manifestDigest)
            deny('MANIFEST_DIGEST_MISMATCH');
        const actionDigest = createActionDigest(t, parsed.digest);
        if (actionDigest !== o.actionDigest)
            deny('ACTION_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        await a.adapter.validatePrerequisites(parsed.manifest);
        requireClean(await a.adapter.snapshot(t.sku));
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        const next = clock(now);
        try {
            const approved = approve({
                store,
                s,
                t,
                action: 'create_ebay_listing',
                responsibility: 'listingCreate',
                targetIdentity: skuIdentity(t, s),
                manifestDigest: actionDigest,
                intentDesiredDigest: createOneShotDigest(t),
                next,
                uuid,
            });
            return {
                status: 'approved',
                action: 'create',
                manifestDigest: parsed.digest,
                actionDigest,
                ...approved,
                providerWritesPerformed: 0,
            };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program
        .command('dispatch-create')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--manifest-digest <sha256>')
        .requiredOption('--action-digest <sha256>')
        .requiredOption('--approval-token <token>')
        .requiredOption('--approval-digest <sha256>')
        .requiredOption('--intent-key <sha256>')).action(run('dispatch-create', async (o) => {
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        if (parsed.digest !== o.manifestDigest)
            deny('MANIFEST_DIGEST_MISMATCH');
        const actionDigest = createActionDigest(t, parsed.digest);
        if (actionDigest !== o.actionDigest)
            deny('ACTION_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        await a.adapter.validatePrerequisites(parsed.manifest);
        const before = await a.adapter.snapshot(t.sku);
        requireClean(before);
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        const next = clock(now);
        let c = null;
        let attempted = 0;
        let offerId = null;
        let listingId = null;
        try {
            if (!DIGEST.test(o.approvalDigest) || !DIGEST.test(o.intentKey))
                deny('APPROVAL_INVALID');
            const targetIdentityKey = deriveExternalIdentityKey(skuIdentity(t, s));
            c = reserve({
                store,
                responsibility: 'listingCreate',
                intentKey: o.intentKey,
                targetIdentityKey,
                approvalToken: o.approvalToken,
                approvalDigest: o.approvalDigest,
                evidenceDigest: actionDigest,
                next,
                uuid,
            });
            const payloads = buildPayloads(parsed.manifest);
            c.markDispatching();
            let dispatchError = null;
            try {
                attempted = 1;
                await a.adapter.putInventory(t.sku, payloads.inventory);
                attempted = 2;
                offerId = await a.adapter.createOffer(payloads.offer);
                attempted = 3;
                listingId = await a.adapter.publish(offerId);
            }
            catch (e) {
                dispatchError = safeError(e).code;
            }
            finally {
                requireReconcile(store, c, actionDigest, next);
            }
            let after = null;
            try {
                after = await a.adapter.snapshot(t.sku);
            }
            catch (e) {
                dispatchError = safeError(e).code;
            }
            if (!offerId || !listingId || !after)
                return {
                    status: 'dispatched-unresolved',
                    code: dispatchError ?? 'CREATE_OUTCOME_UNKNOWN',
                    jobId: c.jobId,
                    attemptId: c.attemptId,
                    intentKey: c.intentKey,
                    manifestDigest: parsed.digest,
                    offerId,
                    listingId,
                    providerWritesAttempted: attempted,
                };
            try {
                requireCreated(after, offerId, listingId, parsed.manifest);
            }
            catch (e) {
                return {
                    status: 'dispatched-unresolved',
                    code: safeError(e).code,
                    jobId: c.jobId,
                    attemptId: c.attemptId,
                    intentKey: c.intentKey,
                    manifestDigest: parsed.digest,
                    offerId,
                    listingId,
                    providerWritesAttempted: attempted,
                };
            }
            const observed = sha256Digest({
                sku: t.sku,
                offerId,
                listingId,
                state: 'published',
                actionDigest,
            });
            const runId = resolve(store, c, 'listingCreate', actionDigest, observed, next, uuid);
            return {
                status: 'dispatched-and-reconciled',
                jobId: c.jobId,
                attemptId: c.attemptId,
                intentKey: c.intentKey,
                manifestDigest: parsed.digest,
                offerId,
                listingId,
                reconciliationRunId: runId,
                providerWritesAttempted: attempted,
            };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program
        .command('reconcile-create')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--manifest-digest <sha256>')
        .requiredOption('--action-digest <sha256>')
        .requiredOption('--offer-id <id>')
        .requiredOption('--listing-id <id>')
        .requiredOption('--job-id <id>')
        .requiredOption('--attempt-id <id>')
        .requiredOption('--intent-key <sha256>')).action(run('reconcile-create', async (o) => {
        if (!SAFE.test(o.offerId) ||
            !NUMERIC.test(o.listingId) ||
            !SAFE.test(o.jobId) ||
            !SAFE.test(o.attemptId) ||
            !DIGEST.test(o.intentKey))
            deny('TARGET_INVALID');
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        if (parsed.digest !== o.manifestDigest)
            deny('MANIFEST_DIGEST_MISMATCH');
        const actionDigest = createActionDigest(t, parsed.digest);
        if (actionDigest !== o.actionDigest)
            deny('ACTION_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        const next = clock(now);
        try {
            const c = {
                intentKey: o.intentKey,
                targetIdentityKey: deriveExternalIdentityKey(skuIdentity(t, s)),
                jobId: o.jobId,
                attemptId: o.attemptId,
                markDispatching: () => deny('RECONCILE_WRITE_DENIED'),
            };
            assertOutstanding(store, c, 'listingCreate');
            requireCreated(await a.adapter.snapshot(t.sku), o.offerId, o.listingId, parsed.manifest);
            const observed = sha256Digest({
                sku: t.sku,
                offerId: o.offerId,
                listingId: o.listingId,
                state: 'published',
                actionDigest,
            });
            const runId = resolve(store, c, 'listingCreate', actionDigest, observed, next, uuid);
            return {
                status: 'reconciled',
                reconciliationRunId: runId,
                providerWritesPerformed: 0,
            };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program.command('recover-create')
        .requiredOption('--state <absolute-path>').requiredOption('--manifest-digest <sha256>')
        .requiredOption('--action-digest <sha256>').requiredOption('--job-id <id>')
        .requiredOption('--attempt-id <id>').requiredOption('--intent-key <sha256>')).action(run('recover-create', async (o) => {
        if (!SAFE.test(o.jobId) || !SAFE.test(o.attemptId) || !DIGEST.test(o.intentKey))
            deny('TARGET_INVALID');
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        if (parsed.digest !== o.manifestDigest)
            deny('MANIFEST_DIGEST_MISMATCH');
        const actionDigest = createActionDigest(t, parsed.digest);
        if (actionDigest !== o.actionDigest)
            deny('ACTION_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({ databasePath: o.state, expectedScope: s });
        const next = clock(now);
        try {
            const c = { intentKey: o.intentKey, targetIdentityKey: deriveExternalIdentityKey(skuIdentity(t, s)), jobId: o.jobId, attemptId: o.attemptId, markDispatching: () => deny('RECOVERY_WRITE_DENIED') };
            assertOutstanding(store, c, 'listingCreate');
            const discovered = discoverRecovery(await a.adapter.snapshot(t.sku), parsed.manifest);
            if (discovered.stage === 'drift' || discovered.stage === 'cleaned')
                deny('CREATE_RECOVERY_AMBIGUOUS');
            if (discovered.stage === 'created' && discovered.offerId && discovered.listingId) {
                const observed = sha256Digest({ sku: t.sku, offerId: discovered.offerId, listingId: discovered.listingId, state: 'published', actionDigest });
                const runId = resolve(store, c, 'listingCreate', actionDigest, observed, next, uuid);
                return { status: 'reconciled', ...discovered, reconciliationRunId: runId, providerWritesPerformed: 0 };
            }
            return { status: 'recovery-required', ...discovered, jobId: o.jobId, attemptId: o.attemptId, intentKey: o.intentKey, providerWritesPerformed: 0 };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program
        .command('preflight-cleanup')
        .requiredOption('--offer-id <id>')
        .requiredOption('--listing-id <id>')).action(run('preflight-cleanup', async (o) => {
        if (!SAFE.test(o.offerId) || !NUMERIC.test(o.listingId))
            deny('TARGET_INVALID');
        const t = target(o);
        const { manifest, digest } = readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        requireCleanupTarget(await a.adapter.snapshot(t.sku), o.offerId, o.listingId, manifest);
        const cleanupDigest = sha256Digest({
            schemaVersion: 1,
            action: 'sandbox_cleanup',
            manifestDigest: digest,
            sku: t.sku,
            offerId: o.offerId,
            listingId: o.listingId,
        });
        return { status: 'ready', cleanupDigest, providerWritesPerformed: 0 };
    }, true));
    targetOptions(program
        .command('approve-cleanup')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--offer-id <id>')
        .requiredOption('--listing-id <id>')
        .requiredOption('--cleanup-digest <sha256>')).action(run('approve-cleanup', async (o) => {
        if (!SAFE.test(o.offerId) || !NUMERIC.test(o.listingId))
            deny('TARGET_INVALID');
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        const expected = sha256Digest({
            schemaVersion: 1,
            action: 'sandbox_cleanup',
            manifestDigest: parsed.digest,
            sku: t.sku,
            offerId: o.offerId,
            listingId: o.listingId,
        });
        if (expected !== o.cleanupDigest)
            deny('CLEANUP_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        requireCleanupTarget(await a.adapter.snapshot(t.sku), o.offerId, o.listingId, parsed.manifest);
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        const next = clock(now);
        try {
            const createObservedDigest = sha256Digest({
                sku: t.sku,
                offerId: o.offerId,
                listingId: o.listingId,
                state: 'published',
                actionDigest: createActionDigest(t, parsed.digest),
            });
            if (!store.hasResolvedExistingEffect(createIntentKey(t, s), 'listingCreate', createObservedDigest))
                deny('CREATE_PROVENANCE_REQUIRED');
            const approved = approve({
                store,
                s,
                t,
                action: 'end_or_relist_ebay_listing',
                responsibility: 'listingEndRelist',
                targetIdentity: listingIdentity(o.listingId, s),
                manifestDigest: expected,
                next,
                uuid,
            });
            return {
                status: 'approved',
                action: 'cleanup',
                cleanupDigest: expected,
                ...approved,
                providerWritesPerformed: 0,
            };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program
        .command('dispatch-cleanup')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--offer-id <id>')
        .requiredOption('--listing-id <id>')
        .requiredOption('--cleanup-digest <sha256>')
        .requiredOption('--approval-token <token>')
        .requiredOption('--approval-digest <sha256>')
        .requiredOption('--intent-key <sha256>')).action(run('dispatch-cleanup', async (o) => {
        if (!SAFE.test(o.offerId) || !NUMERIC.test(o.listingId))
            deny('TARGET_INVALID');
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        const expected = sha256Digest({
            schemaVersion: 1,
            action: 'sandbox_cleanup',
            manifestDigest: parsed.digest,
            sku: t.sku,
            offerId: o.offerId,
            listingId: o.listingId,
        });
        if (expected !== o.cleanupDigest)
            deny('CLEANUP_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        requireCleanupTarget(await a.adapter.snapshot(t.sku), o.offerId, o.listingId, parsed.manifest);
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        const next = clock(now);
        let attempted = 0;
        try {
            if (!DIGEST.test(o.approvalDigest) || !DIGEST.test(o.intentKey))
                deny('APPROVAL_INVALID');
            const c = reserve({
                store,
                responsibility: 'listingEndRelist',
                intentKey: o.intentKey,
                targetIdentityKey: deriveExternalIdentityKey(listingIdentity(o.listingId, s)),
                approvalToken: o.approvalToken,
                approvalDigest: o.approvalDigest,
                evidenceDigest: expected,
                next,
                uuid,
            });
            c.markDispatching();
            let dispatchError = null;
            try {
                attempted = 1;
                await a.adapter.withdraw(o.offerId);
                attempted = 2;
                await a.adapter.deleteOffer(o.offerId);
                attempted = 3;
                await a.adapter.deleteInventory(t.sku);
            }
            catch (e) {
                dispatchError = safeError(e).code;
            }
            finally {
                requireReconcile(store, c, expected, next);
            }
            let after = null;
            try {
                after = await a.adapter.snapshot(t.sku);
            }
            catch (e) {
                dispatchError = safeError(e).code;
            }
            if (!after)
                return {
                    status: 'dispatched-unresolved',
                    code: dispatchError ?? 'CLEANUP_OUTCOME_UNKNOWN',
                    jobId: c.jobId,
                    attemptId: c.attemptId,
                    intentKey: c.intentKey,
                    providerWritesAttempted: attempted,
                };
            try {
                requireCleaned(after, o.listingId);
            }
            catch (e) {
                return {
                    status: 'dispatched-unresolved',
                    code: safeError(e).code,
                    jobId: c.jobId,
                    attemptId: c.attemptId,
                    intentKey: c.intentKey,
                    providerWritesAttempted: attempted,
                };
            }
            const observed = sha256Digest({
                sku: t.sku,
                listingId: o.listingId,
                state: 'ended',
            });
            const runId = resolve(store, c, 'listingEndRelist', expected, observed, next, uuid);
            return {
                status: 'cleaned-and-reconciled',
                jobId: c.jobId,
                attemptId: c.attemptId,
                intentKey: c.intentKey,
                reconciliationRunId: runId,
                providerWritesAttempted: attempted,
            };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program
        .command('reconcile-cleanup')
        .requiredOption('--state <absolute-path>')
        .requiredOption('--offer-id <id>')
        .requiredOption('--listing-id <id>')
        .requiredOption('--cleanup-digest <sha256>')
        .requiredOption('--job-id <id>')
        .requiredOption('--attempt-id <id>')
        .requiredOption('--intent-key <sha256>')).action(run('reconcile-cleanup', async (o) => {
        if (!SAFE.test(o.offerId) ||
            !NUMERIC.test(o.listingId) ||
            !SAFE.test(o.jobId) ||
            !SAFE.test(o.attemptId) ||
            !DIGEST.test(o.intentKey))
            deny('TARGET_INVALID');
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        const expected = sha256Digest({
            schemaVersion: 1,
            action: 'sandbox_cleanup',
            manifestDigest: parsed.digest,
            sku: t.sku,
            offerId: o.offerId,
            listingId: o.listingId,
        });
        if (expected !== o.cleanupDigest)
            deny('CLEANUP_DIGEST_MISMATCH');
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        const next = clock(now);
        try {
            const c = {
                intentKey: o.intentKey,
                targetIdentityKey: deriveExternalIdentityKey(listingIdentity(o.listingId, s)),
                jobId: o.jobId,
                attemptId: o.attemptId,
                markDispatching: () => deny('RECONCILE_WRITE_DENIED'),
            };
            assertOutstanding(store, c, 'listingEndRelist');
            requireCleaned(await a.adapter.snapshot(t.sku), o.listingId);
            const observed = sha256Digest({
                sku: t.sku,
                listingId: o.listingId,
                state: 'ended',
            });
            const runId = resolve(store, c, 'listingEndRelist', expected, observed, next, uuid);
            return {
                status: 'reconciled',
                reconciliationRunId: runId,
                providerWritesPerformed: 0,
            };
        }
        finally {
            store.close();
        }
    }));
    const recoverySourceOptions = (c) => c.requiredOption('--source-responsibility <responsibility>').requiredOption('--source-job-id <id>').requiredOption('--source-attempt-id <id>').requiredOption('--source-intent-key <sha256>');
    recoverySourceOptions(targetOptions(program.command('preflight-recovery-cleanup').requiredOption('--state <absolute-path>'))).action(run('preflight-recovery-cleanup', async (o) => {
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({ databasePath: o.state, expectedScope: s });
        try {
            const d = discoverRecovery(await a.adapter.snapshot(t.sku), parsed.manifest);
            if (['drift', 'absent', 'cleaned'].includes(d.stage))
                deny('RECOVERY_RESIDUE_NOT_EXACT');
            const source = recoverySource(o, t, s, d.listingId);
            assertOutstanding(store, source.ceremony, source.responsibility);
            return { status: 'ready', stage: d.stage, offerId: d.offerId, listingId: d.listingId, recoveryDigest: recoveryDigest(t, parsed.digest, o, d), providerWritesPerformed: 0 };
        }
        finally {
            store.close();
        }
    }, true));
    recoverySourceOptions(targetOptions(program.command('approve-recovery-cleanup').requiredOption('--state <absolute-path>').requiredOption('--recovery-digest <sha256>'))).action(run('approve-recovery-cleanup', async (o) => {
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({ databasePath: o.state, expectedScope: s });
        const next = clock(now);
        try {
            const d = discoverRecovery(await a.adapter.snapshot(t.sku), parsed.manifest);
            const expected = recoveryDigest(t, parsed.digest, o, d);
            if (expected !== o.recoveryDigest || ['drift', 'absent', 'cleaned'].includes(d.stage))
                deny('RECOVERY_DIGEST_MISMATCH');
            const source = recoverySource(o, t, s, d.listingId);
            assertOutstanding(store, source.ceremony, source.responsibility);
            const approved = approve({ store, s, t, action: 'end_or_relist_ebay_listing', responsibility: 'listingEndRelist', targetIdentity: d.listingId ? listingIdentity(d.listingId, s) : skuIdentity(t, s), manifestDigest: expected, intentDesiredDigest: expected, next, uuid });
            return { status: 'approved', stage: d.stage, offerId: d.offerId, listingId: d.listingId, recoveryDigest: expected, ...approved, providerWritesPerformed: 0 };
        }
        finally {
            store.close();
        }
    }));
    recoverySourceOptions(targetOptions(program.command('dispatch-recovery-cleanup').requiredOption('--state <absolute-path>').requiredOption('--recovery-digest <sha256>').requiredOption('--approval-token <token>').requiredOption('--approval-digest <sha256>').requiredOption('--intent-key <sha256>'))).action(run('dispatch-recovery-cleanup', async (o) => {
        const t = target(o);
        const parsed = readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({ databasePath: o.state, expectedScope: s });
        const next = clock(now);
        let attempted = 0;
        try {
            const d = discoverRecovery(await a.adapter.snapshot(t.sku), parsed.manifest);
            const expected = recoveryDigest(t, parsed.digest, o, d);
            if (expected !== o.recoveryDigest || ['drift', 'absent', 'cleaned'].includes(d.stage))
                deny('RECOVERY_DIGEST_MISMATCH');
            const source = recoverySource(o, t, s, d.listingId);
            assertOutstanding(store, source.ceremony, source.responsibility);
            const targetKey = deriveExternalIdentityKey(d.listingId ? listingIdentity(d.listingId, s) : skuIdentity(t, s));
            const c = reserve({ store, responsibility: 'listingEndRelist', intentKey: o.intentKey, targetIdentityKey: targetKey, approvalToken: o.approvalToken, approvalDigest: o.approvalDigest, evidenceDigest: expected, next, uuid });
            c.markDispatching();
            let dispatchError = null;
            try {
                if (d.stage === 'created' && d.offerId) {
                    attempted++;
                    await a.adapter.withdraw(d.offerId);
                }
                if (d.offerId) {
                    attempted++;
                    await a.adapter.deleteOffer(d.offerId);
                }
                attempted++;
                await a.adapter.deleteInventory(t.sku);
            }
            catch (e) {
                dispatchError = safeError(e).code;
            }
            finally {
                requireReconcile(store, c, expected, next);
            }
            let after = null;
            try {
                after = await a.adapter.snapshot(t.sku);
            }
            catch (e) {
                dispatchError = safeError(e).code;
            }
            if (after) {
                try {
                    d.listingId ? requireCleaned(after, d.listingId) : requireClean(after);
                    const observed = sha256Digest({ sku: t.sku, listingId: d.listingId, state: d.listingId ? 'ended' : 'absent' });
                    const runId = resolve(store, c, 'listingEndRelist', expected, observed, next, uuid);
                    return { status: 'cleaned-and-reconciled', jobId: c.jobId, attemptId: c.attemptId, intentKey: c.intentKey, reconciliationRunId: runId, providerWritesAttempted: attempted };
                }
                catch (e) {
                    dispatchError = safeError(e).code;
                }
            }
            return { status: 'dispatched-unresolved', code: dispatchError ?? 'RECOVERY_CLEANUP_OUTCOME_UNKNOWN', jobId: c.jobId, attemptId: c.attemptId, intentKey: c.intentKey, providerWritesAttempted: attempted };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program.command('reconcile-recovery-cleanup').requiredOption('--state <absolute-path>').requiredOption('--recovery-digest <sha256>').requiredOption('--listing-id <id-or-none>').requiredOption('--job-id <id>').requiredOption('--attempt-id <id>').requiredOption('--intent-key <sha256>')).action(run('reconcile-recovery-cleanup', async (o) => {
        if (!DIGEST.test(o.recoveryDigest) || !DIGEST.test(o.intentKey) || !SAFE.test(o.jobId) || !SAFE.test(o.attemptId) || (o.listingId !== 'none' && !NUMERIC.test(o.listingId)))
            deny('TARGET_INVALID');
        const t = target(o);
        readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({ databasePath: o.state, expectedScope: s });
        const next = clock(now);
        const listingId = o.listingId === 'none' ? null : o.listingId;
        try {
            const c = { intentKey: o.intentKey, targetIdentityKey: deriveExternalIdentityKey(listingId ? listingIdentity(listingId, s) : skuIdentity(t, s)), jobId: o.jobId, attemptId: o.attemptId, markDispatching: () => deny('RECONCILE_WRITE_DENIED') };
            assertOutstanding(store, c, 'listingEndRelist');
            const snapshot = await a.adapter.snapshot(t.sku);
            listingId ? requireCleaned(snapshot, listingId) : requireClean(snapshot);
            const observed = sha256Digest({ sku: t.sku, listingId, state: listingId ? 'ended' : 'absent' });
            const runId = resolve(store, c, 'listingEndRelist', o.recoveryDigest, observed, next, uuid);
            return { status: 'reconciled', reconciliationRunId: runId, providerWritesPerformed: 0 };
        }
        finally {
            store.close();
        }
    }));
    targetOptions(program.command('verify-state').requiredOption('--state <absolute-path>')).action(run('verify-state', async (o) => {
        const t = target(o);
        readSandboxManifest(o.manifestFile, t);
        const a = await authority(deps, now());
        const s = scope(t, a.sellerHash);
        const store = openMigrationStore({
            databasePath: o.state,
            expectedScope: s,
        });
        try {
            const audit = store.verifyAuditChain();
            if (!audit.valid)
                deny('AUDIT_INVALID');
            return {
                status: 'verified',
                scopeKey: deriveScopeKey(s),
                audit,
                providerWritesPerformed: 0,
            };
        }
        finally {
            store.close();
        }
    }));
    return program;
}
