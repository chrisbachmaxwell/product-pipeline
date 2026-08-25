import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { deriveExternalIdentityKey, deriveIdempotencyKey, deriveScopeKey, openMigrationStore, MigrationStoreError, sha256Digest, } from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import { compareFulfillmentEffect, deriveFulfillmentManifest, FulfillmentManifestError, } from './manifest.js';
import { createProductionShopifyFulfillmentReader, ShopifyFulfillmentReadError, } from './shopify-fulfillment-reader.js';
import { createProductionEbayFulfillmentAdapter, EbayFulfillmentAdapterError, } from './ebay-fulfillment-adapter.js';
const APPROVAL_TTL_MS = 10 * 60_000;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const MIGRATION_SCOPE = Object.freeze({
    shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
    ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
    ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
    ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});
const defaultIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
    setExitCode: (code) => { process.exitCode = code; },
};
class FulfillmentTrackingAdminError extends Error {
    code;
    constructor(code) {
        super('Fulfillment tracking operation denied');
        this.code = code;
        this.name = 'FulfillmentTrackingAdminError';
    }
}
const deny = (code) => {
    throw new FulfillmentTrackingAdminError(code);
};
function safeErrorCode(error) {
    if (error instanceof FulfillmentTrackingAdminError)
        return error.code;
    if (error instanceof FulfillmentManifestError)
        return error.code;
    if (error instanceof ShopifyFulfillmentReadError)
        return error.code;
    if (error instanceof EbayFulfillmentAdapterError)
        return error.code;
    if (error instanceof MigrationStoreError)
        return `MIGRATION_STORE_${error.code}`;
    return 'FULFILLMENT_TRACKING_DENIED';
}
function digest(value, code) {
    const candidate = RAW_SHA256.test(value) ? `sha256:${value}` : value;
    if (!/^sha256:[a-f0-9]{64}$/.test(candidate))
        deny(code);
    return candidate;
}
function clockFrom(now) {
    let last = 0;
    return () => {
        last = Math.max(last, now().getTime());
        return new Date(last).toISOString();
    };
}
function ensureIdentity(store, input, occurredAtUtc) {
    const key = deriveExternalIdentityKey(input);
    if (store.getIdentity(key) === null) {
        store.registerIdentity(input, {
            eventId: `identity:${key.slice(7, 27)}`,
            occurredAtUtc,
        });
    }
    return key;
}
function identityInputs(shopifyOrderGid, ebayOrderId) {
    return {
        source: {
            platform: 'shopify',
            kind: 'order',
            bindingKey: `shopify-order:${shopifyOrderGid}`,
            storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
            externalGid: shopifyOrderGid,
        },
        target: {
            platform: 'ebay',
            kind: 'order',
            bindingKey: `ebay-order:${ebayOrderId}`,
            environment: MIGRATION_SCOPE.ebayEnvironment,
            sellerId: MIGRATION_SCOPE.ebaySellerId,
            marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
            externalId: ebayOrderId,
        },
    };
}
async function deriveTarget(shopify, ebay, options, allowAlreadyRecorded = false) {
    const [shopifyOrder, ebayOrder] = await Promise.all([
        shopify.getOrder(options.shopifyOrderGid),
        ebay.getOrder(options.ebayOrderId),
    ]);
    return deriveFulfillmentManifest({
        shopify: shopifyOrder,
        ebay: ebayOrder,
        expectedShopifyOrderGid: options.shopifyOrderGid,
        expectedShopifyFulfillmentGid: options.shopifyFulfillmentGid,
        expectedEbayOrderId: options.ebayOrderId,
        allowAlreadyRecorded,
    });
}
async function reconcile(input) {
    const startedAtUtc = input.clock();
    const ebayOrder = await input.ebay.getOrder(input.target.ebayOrderId);
    const effect = compareFulfillmentEffect({
        expectedManifestDigest: input.expectedManifestDigest,
        shopifyOrderGid: input.target.shopifyOrderGid,
        ebayOrderId: input.target.ebayOrderId,
        shopifyFulfillmentGid: input.shopifyFulfillmentGid,
        ebay: ebayOrder,
    });
    const completedAtUtc = input.clock();
    const runId = `fulfillment-run:${input.uuid()}`;
    const targetSnapshotDigest = sha256Digest({
        ebayOrderId: input.target.ebayOrderId,
        effect,
        fulfillmentCount: ebayOrder.shippingFulfillments.length,
    });
    const resultDigest = sha256Digest({
        schemaVersion: 1,
        manifestDigest: input.expectedManifestDigest,
        effect,
        targetSnapshotDigest,
    });
    const resolvable = effect === 'effect_observed' || input.acceptAbsent;
    input.store.recordReconciliationRun({
        runId,
        responsibility: 'fulfillment',
        targetIdentityKey: input.targetIdentityKey,
        mode: 'production_canary',
        status: 'passed',
        sourceSnapshotDigest: input.expectedManifestDigest,
        targetSnapshotDigest,
        resultDigest,
        authoritative: resolvable,
        authorityEvidenceDigest: input.expectedManifestDigest,
        externalWritesObserved: 0,
        startedAtUtc,
        completedAtUtc,
        exceptions: resolvable ? [] : [{
                exceptionId: `fulfillment-exception:${input.uuid()}`,
                code: 'FULFILLMENT_EFFECT_NOT_YET_OBSERVED',
                severity: 'critical',
                subjectIdentityKey: input.targetIdentityKey,
                detailsDigest: resultDigest,
            }],
        targetEffectObservation: {
            observationId: `fulfillment-observation:${input.uuid()}`,
            intentKey: input.intentKey,
            responsibility: 'fulfillment',
            effect,
            observedDigest: targetSnapshotDigest,
        },
        audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: completedAtUtc },
    });
    if (!resolvable)
        return { effect, resolution: null, runId };
    const resolution = effect === 'effect_observed' ? 'resolved_existing' : 'confirmed_missing';
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
    return { effect, resolution, runId };
}
export function buildFulfillmentTrackingAdminProgram(dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    const openMigration = dependencies.openMigration ?? openMigrationStore;
    const shopify = dependencies.shopifyReader ?? createProductionShopifyFulfillmentReader();
    const ebay = dependencies.ebayAdapter ?? createProductionEbayFulfillmentAdapter();
    const now = dependencies.now ?? (() => new Date());
    const uuid = dependencies.uuid ?? randomUUID;
    const program = new Command()
        .name('fulfillment-tracking-admin')
        .description('Isolated one-action full-order Shopify fulfillment to eBay tracking ceremony')
        .showHelpAfterError();
    const withTarget = (command) => command
        .requiredOption('--shopify-order-gid <gid>', 'Exact Shopify order GID')
        .requiredOption('--shopify-fulfillment-gid <gid>', 'Exact Shopify fulfillment GID')
        .requiredOption('--ebay-order-id <id>', 'Exact eBay order ID');
    program.command('establish-ownership')
        .description('Record MC incumbent -> paused -> ProductPipeline fulfillment ownership')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key')
        .requiredOption('--baseline-evidence <sha256>', 'Digest of MC fulfillment baseline evidence')
        .requiredOption('--mc-disabled-evidence <sha256>', 'Digest proving Marketplace Connect fulfillment behavior is off')
        .action((options) => {
        try {
            if (options.confirmScope !== deriveScopeKey(MIGRATION_SCOPE)) {
                deny('FULFILLMENT_SCOPE_CONFIRMATION_MISMATCH');
            }
            const baselineEvidence = digest(options.baselineEvidence, 'FULFILLMENT_EVIDENCE_INVALID');
            const disabledEvidence = digest(options.mcDisabledEvidence, 'FULFILLMENT_EVIDENCE_INVALID');
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = clockFrom(now);
            try {
                let current = store.getCurrentOwnership('fulfillment');
                if (current?.owner === 'product_pipeline') {
                    io.stdout(JSON.stringify({
                        command: 'establish-ownership',
                        status: 'already-established',
                        version: current.version,
                        externalWritesPerformed: 0,
                    }));
                    return;
                }
                if (!current) {
                    const at = clock();
                    store.recordOwnershipVersion({
                        responsibility: 'fulfillment',
                        version: 1,
                        owner: 'marketplace_connect',
                        singleWriterVerified: true,
                        evidenceDigest: baselineEvidence,
                        effectiveAtUtc: at,
                        recordedAtUtc: at,
                        audit: { eventId: `ownership:fulfillment:v1:${uuid()}`, occurredAtUtc: at },
                    });
                    current = store.getCurrentOwnership('fulfillment');
                }
                if (current?.owner === 'marketplace_connect') {
                    const at = clock();
                    store.recordOwnershipVersion({
                        responsibility: 'fulfillment',
                        version: current.version + 1,
                        owner: 'paused',
                        singleWriterVerified: true,
                        evidenceDigest: disabledEvidence,
                        effectiveAtUtc: at,
                        recordedAtUtc: at,
                        audit: {
                            eventId: `ownership:fulfillment:v${current.version + 1}:${uuid()}`,
                            occurredAtUtc: at,
                        },
                    });
                    current = store.getCurrentOwnership('fulfillment');
                }
                if (!current || current.owner !== 'paused')
                    deny('FULFILLMENT_OWNERSHIP_CHAIN_INVALID');
                const pausedOwnership = current;
                const at = clock();
                store.recordOwnershipVersion({
                    responsibility: 'fulfillment',
                    version: pausedOwnership.version + 1,
                    owner: 'product_pipeline',
                    singleWriterVerified: true,
                    evidenceDigest: disabledEvidence,
                    effectiveAtUtc: at,
                    recordedAtUtc: at,
                    audit: {
                        eventId: `ownership:fulfillment:v${pausedOwnership.version + 1}:${uuid()}`,
                        occurredAtUtc: at,
                    },
                });
                io.stdout(JSON.stringify({
                    command: 'establish-ownership',
                    status: 'established',
                    version: pausedOwnership.version + 1,
                    externalWritesPerformed: 0,
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
    withTarget(program.command('preflight')
        .description('Read both orders and print a redacted deterministic full-order manifest preview'))
        .action(async (options) => {
        try {
            const derived = await deriveTarget(shopify, ebay, options);
            io.stdout(JSON.stringify({
                command: 'preflight',
                status: 'preview',
                manifestDigest: derived.manifestDigest,
                shopifyOrderGid: derived.manifest.shopifyOrderGid,
                ebayOrderId: derived.manifest.ebayOrderId,
                shopifyFulfillmentGid: derived.manifest.shopifyFulfillmentGid,
                shippedDate: derived.manifest.shippedDate,
                shippingCarrierCode: derived.manifest.shippingCarrierCode,
                trackingPresent: true,
                lineItemCount: derived.manifest.lineItems.length,
                externalWritesPerformed: 0,
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
    withTarget(program.command('dispatch')
        .description('One-action exact-order dispatch with durable approval and reconciliation'))
        .requiredOption('--manifest-digest <sha256>', 'Exact digest printed by preflight')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .action(async (options) => {
        try {
            const expectedDigest = digest(options.manifestDigest, 'FULFILLMENT_MANIFEST_DIGEST_INVALID');
            const derived = await deriveTarget(shopify, ebay, options);
            if (derived.manifestDigest !== expectedDigest) {
                deny('FULFILLMENT_MANIFEST_DIGEST_MISMATCH');
            }
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = clockFrom(now);
            try {
                const ownership = store.getCurrentOwnership('fulfillment');
                if (!ownership || ownership.owner !== 'product_pipeline'
                    || !ownership.singleWriterVerified) {
                    deny('FULFILLMENT_OWNERSHIP_NOT_ESTABLISHED');
                }
                const activeOwnership = ownership;
                const identities = identityInputs(options.shopifyOrderGid, options.ebayOrderId);
                const sourceIdentityKey = ensureIdentity(store, identities.source, clock());
                const targetIdentityKey = ensureIdentity(store, identities.target, clock());
                if (!store.hasExactOrderLink({
                    shopifyOrderIdentityKey: sourceIdentityKey,
                    ebayOrderIdentityKey: targetIdentityKey,
                })) {
                    deny('FULFILLMENT_ORDER_LINK_REQUIRED');
                }
                const intentKey = deriveIdempotencyKey({
                    scopeKey: deriveScopeKey(MIGRATION_SCOPE),
                    action: 'sync_fulfillment',
                    sourceIdentityKey,
                    targetIdentityKey,
                    desiredStateDigest: expectedDigest,
                });
                if (store.getIntent(intentKey) !== null)
                    deny('FULFILLMENT_INTENT_ALREADY_RECORDED');
                const createdAtUtc = clock();
                store.createIdempotencyIntent({
                    action: 'sync_fulfillment',
                    sourceIdentityKey,
                    targetIdentityKey,
                    desiredStateDigest: expectedDigest,
                    createdAtUtc,
                    audit: { eventId: `intent:${intentKey.slice(7, 27)}`, occurredAtUtc: createdAtUtc },
                });
                const approvalToken = `fulfillment-approval:${uuid()}`;
                const issuedAtUtc = clock();
                const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + APPROVAL_TTL_MS).toISOString();
                store.issueActionApproval({
                    approvalToken,
                    intentKey,
                    responsibility: 'fulfillment',
                    targetIdentityKey,
                    ownershipVersion: activeOwnership.version,
                    issuedAtUtc,
                    expiresAtUtc,
                    evidenceDigest: expectedDigest,
                    audit: { eventId: `approval:${uuid()}`, occurredAtUtc: issuedAtUtc },
                });
                // Deterministic IDs make an outcome-unknown dispatch discoverable
                // from the exact order pair and approved manifest even if the
                // process exits before it can print them.
                const intentSuffix = intentKey.slice(7, 47);
                const jobId = `fulfillment-job:${intentSuffix}`;
                const attemptId = `fulfillment-attempt:${intentSuffix}`;
                const reservedAtUtc = clock();
                store.reserveExecutionJob({
                    jobId,
                    approvalToken,
                    intentKey,
                    responsibility: 'fulfillment',
                    targetIdentityKey,
                    ownershipVersion: activeOwnership.version,
                    approvalEvidenceDigest: expectedDigest,
                    reservedAtUtc,
                    evidenceDigest: expectedDigest,
                    audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reservedAtUtc },
                });
                const dispatchAtUtc = clock();
                store.markDispatchingOutcomeUnknown({
                    jobId,
                    attemptId,
                    approvalToken,
                    approvalEvidenceDigest: expectedDigest,
                    occurredAtUtc: dispatchAtUtc,
                    evidenceDigest: expectedDigest,
                    audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: dispatchAtUtc },
                });
                let providerDispatchReported = true;
                try {
                    await ebay.createShippingFulfillment(derived.manifest);
                }
                catch {
                    providerDispatchReported = false;
                }
                const requiredAtUtc = clock();
                store.requirePostDispatchReconciliation({
                    jobId,
                    attemptId,
                    occurredAtUtc: requiredAtUtc,
                    evidenceDigest: expectedDigest,
                    audit: {
                        eventId: `job:${jobId}:reconciliation-required`,
                        occurredAtUtc: requiredAtUtc,
                    },
                });
                const result = await reconcile({
                    store,
                    ebay,
                    target: options,
                    shopifyFulfillmentGid: derived.manifest.shopifyFulfillmentGid,
                    expectedManifestDigest: expectedDigest,
                    intentKey,
                    targetIdentityKey,
                    jobId,
                    attemptId,
                    acceptAbsent: false,
                    clock,
                    uuid,
                });
                io.stdout(JSON.stringify({
                    command: 'dispatch',
                    status: result.resolution === 'resolved_existing'
                        ? 'dispatched-and-reconciled'
                        : 'dispatched-unresolved',
                    jobId,
                    attemptId,
                    intentKey,
                    manifestDigest: expectedDigest,
                    providerDispatchReported,
                    effect: result.effect,
                    resolution: result.resolution,
                    reconciliationRunId: result.runId,
                    externalCommerceWritesAttempted: 1,
                }));
                if (result.resolution !== 'resolved_existing')
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
    withTarget(program.command('reconcile')
        .description('Re-read eBay for one outstanding job; never writes to either provider')
        .requiredOption('--manifest-digest <sha256>', 'Exact digest printed by preflight')
        .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
        .option('--accept-absent', 'Explicitly terminalize a still-absent effect as confirmed_missing'))
        .action(async (options) => {
        try {
            const expectedDigest = digest(options.manifestDigest, 'FULFILLMENT_MANIFEST_DIGEST_INVALID');
            const identities = identityInputs(options.shopifyOrderGid, options.ebayOrderId);
            const sourceIdentityKey = deriveExternalIdentityKey(identities.source);
            const targetIdentityKey = deriveExternalIdentityKey(identities.target);
            const intentKey = deriveIdempotencyKey({
                scopeKey: deriveScopeKey(MIGRATION_SCOPE),
                action: 'sync_fulfillment',
                sourceIdentityKey,
                targetIdentityKey,
                desiredStateDigest: expectedDigest,
            });
            const store = openMigration({
                databasePath: options.migrationStore,
                expectedScope: MIGRATION_SCOPE,
            });
            const clock = clockFrom(now);
            try {
                if (store.getIntent(intentKey) === null)
                    deny('FULFILLMENT_INTENT_NOT_FOUND');
                const intentSuffix = intentKey.slice(7, 47);
                const jobId = `fulfillment-job:${intentSuffix}`;
                const attemptId = `fulfillment-attempt:${intentSuffix}`;
                const job = store.getJobStatus(jobId);
                if (!job || job.intentKey !== intentKey || job.responsibility !== 'fulfillment') {
                    deny('FULFILLMENT_JOB_MISMATCH');
                }
                const activeJob = job;
                if (activeJob.state === 'dispatching') {
                    const requiredAtUtc = clock();
                    store.requirePostDispatchReconciliation({
                        jobId,
                        attemptId,
                        occurredAtUtc: requiredAtUtc,
                        evidenceDigest: expectedDigest,
                        audit: {
                            eventId: `job:${jobId}:reconciliation-required`,
                            occurredAtUtc: requiredAtUtc,
                        },
                    });
                }
                else if (activeJob.state !== 'reconciliation_required') {
                    deny('FULFILLMENT_JOB_NOT_RECONCILABLE');
                }
                const result = await reconcile({
                    store,
                    ebay,
                    target: options,
                    shopifyFulfillmentGid: options.shopifyFulfillmentGid,
                    expectedManifestDigest: expectedDigest,
                    intentKey,
                    targetIdentityKey,
                    jobId,
                    attemptId,
                    acceptAbsent: options.acceptAbsent === true,
                    clock,
                    uuid,
                });
                io.stdout(JSON.stringify({
                    command: 'reconcile',
                    status: result.resolution === null ? 'unresolved' : 'reconciled',
                    jobId,
                    attemptId,
                    effect: result.effect,
                    resolution: result.resolution,
                    reconciliationRunId: result.runId,
                    externalWritesPerformed: 0,
                }));
                if (result.resolution === null)
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
