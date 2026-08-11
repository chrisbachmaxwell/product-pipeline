import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationStore, MigrationStoreError, sha256Digest, } from '../index.js';
const SANDBOX_SCOPE = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'sandbox',
    ebaySellerId: 'usedcam-0',
    ebayMarketplaceId: 'EBAY_US',
};
const temporaryDirectories = [];
const openStores = [];
function digest(label) {
    return sha256Digest(label);
}
function createStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-state-machine-'));
    temporaryDirectories.push(directory);
    const store = createMigrationStore({
        databasePath: path.join(directory, 'migration-state.sqlite'),
        scope: SANDBOX_SCOPE,
        createdAtUtc: '2026-08-11T20:00:00.000Z',
    });
    openStores.push(store);
    return store;
}
function expectMigrationError(operation, code) {
    let caught;
    try {
        operation();
    }
    catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationStoreError);
    expect(caught.code).toBe(code);
}
function createReservedPostWatermarkOrder() {
    const store = createStore();
    const ebayOrder = store.registerIdentity({
        platform: 'ebay',
        kind: 'order',
        bindingKey: 'order:post-watermark',
        environment: SANDBOX_SCOPE.ebayEnvironment,
        sellerId: SANDBOX_SCOPE.ebaySellerId,
        marketplaceId: SANDBOX_SCOPE.ebayMarketplaceId,
        externalId: 'EBAY-ORDER-POST-WATERMARK',
    }, { eventId: 'identity:ebay-order', occurredAtUtc: '2026-08-11T20:00:01.000Z' });
    const incumbentEvidence = digest('accepted-marketplace-connect-owner');
    store.recordOwnershipVersion({
        responsibility: 'orderImport',
        version: 1,
        owner: 'marketplace_connect',
        singleWriterVerified: true,
        evidenceDigest: incumbentEvidence,
        effectiveAtUtc: '2026-08-11T20:00:01.000Z',
        recordedAtUtc: '2026-08-11T20:00:02.000Z',
        audit: { eventId: 'ownership:order-import:v1', occurredAtUtc: '2026-08-11T20:00:02.000Z' },
    });
    store.establishOrderWatermark({
        boundaryExclusiveUtc: '2026-08-11T19:59:59.000Z',
        ownershipVersion: 1,
        ownershipEvidenceDigest: incumbentEvidence,
        acceptedEvidenceDigest: digest('accepted-watermark-packet'),
        createdAtUtc: '2026-08-11T20:00:03.000Z',
        audit: { eventId: 'watermark:order-import', occurredAtUtc: '2026-08-11T20:00:03.000Z' },
    });
    store.recordOrderPage({
        pageId: 'page:post-watermark',
        cursorBefore: null,
        cursorAfter: 'cursor-after-post-watermark',
        observedAtUtc: '2026-08-11T20:01:00.000Z',
        snapshotDigest: digest('post-watermark-page'),
        orders: [{
                observationId: 'observation:post-watermark',
                ebayOrderIdentityKey: ebayOrder.identityKey,
                sourceCreationDateUtc: '2026-08-11T20:00:30.000Z',
            }],
        audit: { eventId: 'page:post-watermark', occurredAtUtc: '2026-08-11T20:01:00.000Z' },
    });
    const intentKey = store.createIdempotencyIntent({
        action: 'import_shopify_order',
        sourceIdentityKey: ebayOrder.identityKey,
        targetIdentityKey: null,
        desiredStateDigest: digest('normalized-shopify-order-payload'),
        createdAtUtc: '2026-08-11T20:01:01.000Z',
        audit: { eventId: 'intent:order-import', occurredAtUtc: '2026-08-11T20:01:01.000Z' },
    });
    store.recordOwnershipVersion({
        responsibility: 'orderImport',
        version: 2,
        owner: 'paused',
        singleWriterVerified: true,
        evidenceDigest: digest('zero-writer-pause'),
        effectiveAtUtc: '2026-08-11T20:01:02.000Z',
        recordedAtUtc: '2026-08-11T20:01:02.000Z',
        audit: { eventId: 'ownership:order-import:v2', occurredAtUtc: '2026-08-11T20:01:02.000Z' },
    });
    store.recordOwnershipVersion({
        responsibility: 'orderImport',
        version: 3,
        owner: 'product_pipeline',
        singleWriterVerified: true,
        evidenceDigest: digest('product-pipeline-single-writer'),
        effectiveAtUtc: '2026-08-11T20:01:03.000Z',
        recordedAtUtc: '2026-08-11T20:01:03.000Z',
        audit: { eventId: 'ownership:order-import:v3', occurredAtUtc: '2026-08-11T20:01:03.000Z' },
    });
    const approvalToken = 'single-action-approval-token-0001';
    const approvalEvidenceDigest = digest('single-action-approval-evidence');
    store.issueActionApproval({
        approvalToken,
        intentKey,
        responsibility: 'orderImport',
        targetIdentityKey: ebayOrder.identityKey,
        ownershipVersion: 3,
        issuedAtUtc: '2026-08-11T20:01:04.000Z',
        expiresAtUtc: '2026-08-11T20:11:04.000Z',
        evidenceDigest: approvalEvidenceDigest,
        audit: { eventId: 'approval:order-import', occurredAtUtc: '2026-08-11T20:01:04.000Z' },
    });
    store.reserveExecutionJob({
        jobId: 'job:order-import',
        approvalToken,
        intentKey,
        responsibility: 'orderImport',
        targetIdentityKey: ebayOrder.identityKey,
        ownershipVersion: 3,
        approvalEvidenceDigest,
        orderObservationId: 'observation:post-watermark',
        reservedAtUtc: '2026-08-11T20:01:05.000Z',
        evidenceDigest: digest('reserved-order-job'),
        audit: { eventId: 'job:order-import:reserved', occurredAtUtc: '2026-08-11T20:01:05.000Z' },
    });
    return { store, ebayOrder, intentKey, approvalToken, approvalEvidenceDigest };
}
afterEach(() => {
    for (const store of openStores.splice(0))
        store.close();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('migration-store order incident state machine', () => {
    it('permanently denies pre-watermark and equality-boundary order intents', () => {
        const store = createStore();
        const registerOrder = (suffix, occurredAtUtc) => store.registerIdentity({
            platform: 'ebay',
            kind: 'order',
            bindingKey: `order:${suffix}`,
            environment: SANDBOX_SCOPE.ebayEnvironment,
            sellerId: SANDBOX_SCOPE.ebaySellerId,
            marketplaceId: SANDBOX_SCOPE.ebayMarketplaceId,
            externalId: `EBAY-ORDER-${suffix.toUpperCase()}`,
        }, { eventId: `identity:${suffix}`, occurredAtUtc });
        const before = registerOrder('before', '2026-08-11T20:00:01.000Z');
        const equal = registerOrder('equal', '2026-08-11T20:00:02.000Z');
        const after = registerOrder('after', '2026-08-11T20:00:03.000Z');
        const incumbentEvidence = digest('incident-baseline');
        store.recordOwnershipVersion({
            responsibility: 'orderImport',
            version: 1,
            owner: 'marketplace_connect',
            singleWriterVerified: true,
            evidenceDigest: incumbentEvidence,
            effectiveAtUtc: '2026-08-11T20:00:03.000Z',
            recordedAtUtc: '2026-08-11T20:00:04.000Z',
            audit: { eventId: 'ownership:baseline', occurredAtUtc: '2026-08-11T20:00:04.000Z' },
        });
        store.establishOrderWatermark({
            boundaryExclusiveUtc: '2026-08-11T20:00:00.000Z',
            ownershipVersion: 1,
            ownershipEvidenceDigest: incumbentEvidence,
            acceptedEvidenceDigest: digest('accepted-incident-watermark'),
            createdAtUtc: '2026-08-11T20:00:05.000Z',
            audit: { eventId: 'watermark:incident', occurredAtUtc: '2026-08-11T20:00:05.000Z' },
        });
        store.recordOrderPage({
            pageId: 'page:watermark-boundary',
            cursorBefore: null,
            cursorAfter: 'cursor:watermark-boundary',
            observedAtUtc: '2026-08-11T20:00:06.000Z',
            snapshotDigest: digest('watermark-boundary-page'),
            orders: [
                {
                    observationId: 'observation:before',
                    ebayOrderIdentityKey: before.identityKey,
                    sourceCreationDateUtc: '2026-08-11T19:59:59.999Z',
                },
                {
                    observationId: 'observation:equal',
                    ebayOrderIdentityKey: equal.identityKey,
                    sourceCreationDateUtc: '2026-08-11T20:00:00.000Z',
                },
                {
                    observationId: 'observation:after',
                    ebayOrderIdentityKey: after.identityKey,
                    sourceCreationDateUtc: '2026-08-11T20:00:00.001Z',
                },
            ],
            audit: { eventId: 'page:watermark-boundary', occurredAtUtc: '2026-08-11T20:00:06.000Z' },
        });
        expect(store.isOrderEligible('2026-08-11T19:59:59.999Z')).toBe(false);
        expect(store.isOrderEligible('2026-08-11T20:00:00.000Z')).toBe(false);
        expect(store.isOrderEligible('2026-08-11T20:00:00.001Z')).toBe(true);
        for (const [identity, eventId] of [[before, 'before'], [equal, 'equal']]) {
            expectMigrationError(() => store.createIdempotencyIntent({
                action: 'import_shopify_order',
                sourceIdentityKey: identity.identityKey,
                targetIdentityKey: null,
                desiredStateDigest: digest(`payload:${eventId}`),
                createdAtUtc: '2026-08-11T20:00:07.000Z',
                audit: { eventId: `intent:${eventId}`, occurredAtUtc: '2026-08-11T20:00:07.000Z' },
            }), 'WATERMARK_REQUIRED');
        }
        store.createIdempotencyIntent({
            action: 'import_shopify_order',
            sourceIdentityKey: after.identityKey,
            targetIdentityKey: null,
            desiredStateDigest: digest('payload:after'),
            createdAtUtc: '2026-08-11T20:00:08.000Z',
            audit: { eventId: 'intent:after', occurredAtUtc: '2026-08-11T20:00:08.000Z' },
        });
        expectMigrationError(() => store.createIdempotencyIntent({
            action: 'import_shopify_order',
            sourceIdentityKey: after.identityKey,
            targetIdentityKey: null,
            desiredStateDigest: digest('different-payload-cannot-create-a-second-natural-intent'),
            createdAtUtc: '2026-08-11T20:00:09.000Z',
            audit: { eventId: 'intent:after:duplicate', occurredAtUtc: '2026-08-11T20:00:09.000Z' },
        }), 'CONFLICT');
        expect(store.getCounts().idempotency_intents).toBe(1);
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    });
    it('denies dispatch when an observed Shopify link appears after reservation', () => {
        const { store, intentKey, approvalToken, approvalEvidenceDigest } = createReservedPostWatermarkOrder();
        const ebayOrder = store.getIntent(intentKey);
        if (!ebayOrder)
            throw new Error('reserved order intent fixture was not created');
        const shopifyOrder = store.registerIdentity({
            platform: 'shopify',
            kind: 'order',
            bindingKey: 'order:already-imported',
            storeDomain: SANDBOX_SCOPE.shopifyStoreDomain,
            externalGid: 'gid://shopify/Order/9001',
        }, { eventId: 'identity:existing-shopify-order', occurredAtUtc: '2026-08-11T20:01:06.000Z' });
        store.linkObservedExistingOrder({
            linkId: 'link:incumbent-import',
            ebayOrderIdentityKey: ebayOrder.source_identity_key,
            shopifyOrderIdentityKey: shopifyOrder.identityKey,
            evidenceDigest: digest('incumbent-order-link'),
            linkedAtUtc: '2026-08-11T20:01:07.000Z',
            audit: { eventId: 'link:incumbent-import', occurredAtUtc: '2026-08-11T20:01:07.000Z' },
        });
        expectMigrationError(() => store.markDispatchingOutcomeUnknown({
            jobId: 'job:order-import',
            attemptId: 'attempt:must-not-exist',
            approvalToken,
            approvalEvidenceDigest,
            occurredAtUtc: '2026-08-11T20:01:08.000Z',
            evidenceDigest: digest('denied-dispatch'),
            audit: { eventId: 'dispatch:denied-existing-link', occurredAtUtc: '2026-08-11T20:01:08.000Z' },
        }), 'CONFLICT');
        expect(store.getJobStatus('job:order-import')).toMatchObject({
            state: 'reserved',
            attemptOutcome: null,
        });
        expect(store.getCounts()).toMatchObject({ execution_jobs: 1, intent_attempts: 0, order_links: 1 });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    });
    it('requires post-dispatch reconciliation before one terminal linked outcome', () => {
        const { store, ebayOrder, intentKey, approvalToken, approvalEvidenceDigest } = createReservedPostWatermarkOrder();
        expectMigrationError(() => store.requirePostDispatchReconciliation({
            jobId: 'job:order-import',
            attemptId: 'attempt:order-import',
            occurredAtUtc: '2026-08-11T20:01:05.500Z',
            evidenceDigest: digest('premature-reconciliation'),
            audit: { eventId: 'reconciliation:premature', occurredAtUtc: '2026-08-11T20:01:05.500Z' },
        }), 'NOT_FOUND');
        store.markDispatchingOutcomeUnknown({
            jobId: 'job:order-import',
            attemptId: 'attempt:order-import',
            approvalToken,
            approvalEvidenceDigest,
            occurredAtUtc: '2026-08-11T20:01:06.000Z',
            evidenceDigest: digest('dispatch-boundary'),
            audit: { eventId: 'job:order-import:dispatching', occurredAtUtc: '2026-08-11T20:01:06.000Z' },
        });
        const earlyResultDigest = digest('early-reconciliation-result');
        store.recordReconciliationRun({
            runId: 'reconciliation:too-early',
            responsibility: 'orderImport',
            targetIdentityKey: ebayOrder.identityKey,
            mode: 'test_lane',
            status: 'passed',
            sourceSnapshotDigest: digest('early-source-snapshot'),
            targetSnapshotDigest: digest('early-target-snapshot'),
            resultDigest: earlyResultDigest,
            authoritative: true,
            authorityEvidenceDigest: digest('early-authority'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-11T20:01:06.000Z',
            completedAtUtc: '2026-08-11T20:01:07.000Z',
            exceptions: [],
            audit: { eventId: 'reconciliation:too-early', occurredAtUtc: '2026-08-11T20:01:07.000Z' },
        });
        store.requirePostDispatchReconciliation({
            jobId: 'job:order-import',
            attemptId: 'attempt:order-import',
            occurredAtUtc: '2026-08-11T20:01:08.000Z',
            evidenceDigest: digest('reconciliation-required'),
            audit: { eventId: 'job:order-import:reconciliation-required', occurredAtUtc: '2026-08-11T20:01:08.000Z' },
        });
        const shopifyOrder = store.registerIdentity({
            platform: 'shopify',
            kind: 'order',
            bindingKey: 'order:created-by-product-pipeline',
            storeDomain: SANDBOX_SCOPE.shopifyStoreDomain,
            externalGid: 'gid://shopify/Order/9002',
        }, { eventId: 'identity:created-shopify-order', occurredAtUtc: '2026-08-11T20:01:09.000Z' });
        expectMigrationError(() => store.resolveUnknownAttempt({
            jobId: 'job:order-import',
            attemptId: 'attempt:order-import',
            resolution: 'resolved_existing',
            reconciliationRunId: 'reconciliation:too-early',
            reconciliationResultDigest: earlyResultDigest,
            shopifyOrderIdentityKey: shopifyOrder.identityKey,
            orderLinkId: 'link:must-not-exist',
            reconciledAtUtc: '2026-08-11T20:01:10.000Z',
            audit: { eventId: 'resolution:too-early', occurredAtUtc: '2026-08-11T20:01:10.000Z' },
        }), 'CONFLICT');
        const resultDigest = digest('authoritative-post-action-result');
        store.recordReconciliationRun({
            runId: 'reconciliation:authoritative',
            responsibility: 'orderImport',
            targetIdentityKey: ebayOrder.identityKey,
            mode: 'test_lane',
            status: 'passed',
            sourceSnapshotDigest: digest('authoritative-source-snapshot'),
            targetSnapshotDigest: digest('authoritative-target-snapshot'),
            resultDigest,
            authoritative: true,
            authorityEvidenceDigest: digest('authoritative-query-proof'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-11T20:01:09.000Z',
            completedAtUtc: '2026-08-11T20:01:11.000Z',
            exceptions: [],
            audit: { eventId: 'reconciliation:authoritative', occurredAtUtc: '2026-08-11T20:01:11.000Z' },
        });
        store.resolveUnknownAttempt({
            jobId: 'job:order-import',
            attemptId: 'attempt:order-import',
            resolution: 'resolved_existing',
            reconciliationRunId: 'reconciliation:authoritative',
            reconciliationResultDigest: resultDigest,
            shopifyOrderIdentityKey: shopifyOrder.identityKey,
            orderLinkId: 'link:product-pipeline-created',
            reconciledAtUtc: '2026-08-11T20:01:12.000Z',
            audit: { eventId: 'resolution:authoritative', occurredAtUtc: '2026-08-11T20:01:12.000Z' },
        });
        expectMigrationError(() => store.markDispatchingOutcomeUnknown({
            jobId: 'job:order-import',
            attemptId: 'attempt:automatic-retry',
            approvalToken,
            approvalEvidenceDigest,
            occurredAtUtc: '2026-08-11T20:01:13.000Z',
            evidenceDigest: digest('automatic-retry-denied'),
            audit: { eventId: 'dispatch:automatic-retry', occurredAtUtc: '2026-08-11T20:01:13.000Z' },
        }), 'CONFLICT');
        expectMigrationError(() => store.createIdempotencyIntent({
            action: 'import_shopify_order',
            sourceIdentityKey: ebayOrder.identityKey,
            targetIdentityKey: null,
            desiredStateDigest: digest('different-payload-must-not-change-natural-key'),
            createdAtUtc: '2026-08-11T20:01:13.000Z',
            audit: { eventId: 'intent:automatic-retry', occurredAtUtc: '2026-08-11T20:01:13.000Z' },
        }), 'WATERMARK_REQUIRED');
        expect(store.getIntent(intentKey)).not.toBeNull();
        expect(store.getJobStatus('job:order-import')).toMatchObject({
            state: 'resolved_existing',
            attemptOutcome: 'outcome_unknown',
        });
        expect(store.getCounts()).toMatchObject({
            idempotency_intents: 1,
            execution_jobs: 1,
            intent_attempts: 1,
            attempt_resolutions: 1,
            order_links: 1,
        });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    });
});
