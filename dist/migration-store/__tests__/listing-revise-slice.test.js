/**
 * Schema v2 — production listing-revise slice regressions.
 *
 * These tests prove that the narrowed production allowances admit exactly the
 * reviewed listingRevise lifecycle (paused genesis -> product_pipeline
 * ownership, one revise intent, one expiring exact-target approval, one job,
 * one dispatch attempt, one post-dispatch production-canary reconciliation
 * with a durable target observation, one resolution) and nothing else: every
 * other production writer intent, ownership transfer, watermark, and
 * reconciliation mode stays denied exactly as in schema v1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationStore, deriveScopeKey, inspectMigrationStoreReadOnly, MigrationStoreError, openMigrationStore, sha256Digest, upgradeMigrationStore, } from '../index.js';
import { initializeSchema } from '../schema.js';
const PRODUCTION_SCOPE = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'production',
    ebaySellerId: 'usedcameragear',
    ebayMarketplaceId: 'EBAY_US',
};
const temporaryDirectories = [];
const openStores = [];
afterEach(() => {
    for (const store of openStores.splice(0)) {
        try {
            store.close();
        }
        catch { /* already closed */ }
    }
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
function digest(label) {
    return sha256Digest(label);
}
function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-listing-revise-'));
    temporaryDirectories.push(directory);
    return directory;
}
function createProductionStore() {
    const store = createMigrationStore({
        databasePath: path.join(temporaryDirectory(), 'migration-state.sqlite'),
        scope: PRODUCTION_SCOPE,
        createdAtUtc: '2026-08-14T20:00:00.000Z',
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
function registerReviseIdentities(store) {
    const variant = store.registerIdentity({
        platform: 'shopify',
        kind: 'variant',
        bindingKey: 'variant:CAN3570-U119',
        storeDomain: PRODUCTION_SCOPE.shopifyStoreDomain,
        externalGid: 'gid://shopify/ProductVariant/55396000563491',
    }, { eventId: 'identity:shopify-variant', occurredAtUtc: '2026-08-14T20:00:01.000Z' });
    const listing = store.registerIdentity({
        platform: 'ebay',
        kind: 'listing',
        bindingKey: 'listing:147502608418',
        environment: PRODUCTION_SCOPE.ebayEnvironment,
        sellerId: PRODUCTION_SCOPE.ebaySellerId,
        marketplaceId: PRODUCTION_SCOPE.ebayMarketplaceId,
        externalId: '147502608418',
    }, { eventId: 'identity:ebay-listing', occurredAtUtc: '2026-08-14T20:00:02.000Z' });
    return { variant, listing };
}
function recordReviseOwnershipChain(store) {
    store.recordOwnershipVersion({
        responsibility: 'listingRevise',
        version: 1,
        owner: 'paused',
        singleWriterVerified: true,
        evidenceDigest: digest('listing-revise-quarantine-genesis'),
        effectiveAtUtc: '2026-08-14T20:00:03.000Z',
        recordedAtUtc: '2026-08-14T20:00:03.000Z',
        audit: { eventId: 'ownership:listing-revise:v1', occurredAtUtc: '2026-08-14T20:00:03.000Z' },
    });
    store.recordOwnershipVersion({
        responsibility: 'listingRevise',
        version: 2,
        owner: 'product_pipeline',
        singleWriterVerified: true,
        evidenceDigest: digest('listing-revise-single-writer-evidence'),
        effectiveAtUtc: '2026-08-14T20:00:04.000Z',
        recordedAtUtc: '2026-08-14T20:00:04.000Z',
        audit: { eventId: 'ownership:listing-revise:v2', occurredAtUtc: '2026-08-14T20:00:04.000Z' },
    });
}
describe('production listing-revise execution slice', () => {
    it('executes one approved revise dispatch through reconciliation and terminal resolution', () => {
        const store = createProductionStore();
        const { variant, listing } = registerReviseIdentities(store);
        recordReviseOwnershipChain(store);
        const manifestDigest = digest('revise-manifest:title-and-policy-change');
        const intentKey = store.createIdempotencyIntent({
            action: 'revise_ebay_listing',
            sourceIdentityKey: variant.identityKey,
            targetIdentityKey: listing.identityKey,
            desiredStateDigest: manifestDigest,
            createdAtUtc: '2026-08-14T20:00:05.000Z',
            audit: { eventId: 'intent:listing-revise', occurredAtUtc: '2026-08-14T20:00:05.000Z' },
        });
        const approvalToken = 'one-action-revise-approval-0001';
        const approvalEvidenceDigest = digest('one-action-revise-approval-evidence');
        store.issueActionApproval({
            approvalToken,
            intentKey,
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            ownershipVersion: 2,
            issuedAtUtc: '2026-08-14T20:00:06.000Z',
            expiresAtUtc: '2026-08-14T20:10:06.000Z',
            evidenceDigest: approvalEvidenceDigest,
            audit: { eventId: 'approval:listing-revise', occurredAtUtc: '2026-08-14T20:00:06.000Z' },
        });
        store.reserveExecutionJob({
            jobId: 'job:listing-revise',
            approvalToken,
            intentKey,
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            ownershipVersion: 2,
            approvalEvidenceDigest,
            reservedAtUtc: '2026-08-14T20:00:07.000Z',
            evidenceDigest: digest('reserved-revise-job'),
            audit: { eventId: 'job:listing-revise:reserved', occurredAtUtc: '2026-08-14T20:00:07.000Z' },
        });
        store.markDispatchingOutcomeUnknown({
            jobId: 'job:listing-revise',
            attemptId: 'attempt:listing-revise',
            approvalToken,
            approvalEvidenceDigest,
            occurredAtUtc: '2026-08-14T20:00:08.000Z',
            evidenceDigest: digest('revise-dispatch-boundary'),
            audit: { eventId: 'job:listing-revise:dispatching', occurredAtUtc: '2026-08-14T20:00:08.000Z' },
        });
        store.requirePostDispatchReconciliation({
            jobId: 'job:listing-revise',
            attemptId: 'attempt:listing-revise',
            occurredAtUtc: '2026-08-14T20:00:09.000Z',
            evidenceDigest: digest('revise-reconciliation-required'),
            audit: {
                eventId: 'job:listing-revise:reconciliation-required',
                occurredAtUtc: '2026-08-14T20:00:09.000Z',
            },
        });
        const resultDigest = digest('post-dispatch-target-comparison-result');
        store.recordReconciliationRun({
            runId: 'reconciliation:listing-revise',
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            mode: 'production_canary',
            status: 'passed',
            sourceSnapshotDigest: digest('approved-revise-manifest-snapshot'),
            targetSnapshotDigest: digest('post-dispatch-remote-snapshot'),
            resultDigest,
            authoritative: true,
            authorityEvidenceDigest: digest('exact-target-read-authority'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-14T20:00:10.000Z',
            completedAtUtc: '2026-08-14T20:00:11.000Z',
            exceptions: [],
            listingReviseObservation: {
                observationId: 'observation:listing-revise',
                intentKey,
                effect: 'revised_state_observed',
                observedDigest: digest('observed-revised-target-state'),
            },
            audit: { eventId: 'reconciliation:listing-revise', occurredAtUtc: '2026-08-14T20:00:11.000Z' },
        });
        store.resolveUnknownAttempt({
            jobId: 'job:listing-revise',
            attemptId: 'attempt:listing-revise',
            resolution: 'resolved_existing',
            reconciliationRunId: 'reconciliation:listing-revise',
            reconciliationResultDigest: resultDigest,
            reconciledAtUtc: '2026-08-14T20:00:12.000Z',
            audit: { eventId: 'resolution:listing-revise', occurredAtUtc: '2026-08-14T20:00:12.000Z' },
        });
        expect(store.getJobStatus('job:listing-revise')).toMatchObject({
            state: 'resolved_existing',
            attemptOutcome: 'outcome_unknown',
        });
        expect(store.getCounts()).toMatchObject({
            idempotency_intents: 1,
            action_approvals: 1,
            approval_consumptions: 1,
            execution_jobs: 1,
            intent_attempts: 1,
            attempt_resolutions: 1,
            reconciliation_runs: 1,
            listing_revise_observations: 1,
            order_links: 0,
            order_watermarks: 0,
        });
        expect(store.countExecutionRowsOutsideResponsibility('listingRevise')).toBe(0);
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
        // No automatic retry: the consumed single-use approval cannot dispatch again.
        expectMigrationError(() => store.markDispatchingOutcomeUnknown({
            jobId: 'job:listing-revise',
            attemptId: 'attempt:retry',
            approvalToken,
            approvalEvidenceDigest,
            occurredAtUtc: '2026-08-14T20:00:13.000Z',
            evidenceDigest: digest('automatic-retry-denied'),
            audit: { eventId: 'dispatch:retry-denied', occurredAtUtc: '2026-08-14T20:00:13.000Z' },
        }), 'CONFLICT');
        // The read-only projection accepts the slice-scoped production store.
        const projection = inspectMigrationStoreReadOnly({
            databasePath: store.databasePath,
            expectedScope: PRODUCTION_SCOPE,
        });
        expect(projection.status).toBe('verified');
        expect(projection.counts).toMatchObject({
            idempotencyIntents: 1,
            executionJobs: 1,
            listingReviseObservations: 1,
        });
        expect(projection.ownership.find((entry) => entry.responsibility === 'listingRevise'))
            .toMatchObject({ configured: true, owner: 'product_pipeline', version: 2 });
        expect(projection.readiness).toMatchObject({ canaryReady: false, cutoverReady: false });
    });
    it('keeps every non-enabled production writer surface denied under schema v3', () => {
        const store = createProductionStore();
        const { variant, listing } = registerReviseIdentities(store);
        // Mapping and feedback production intent actions stay denied.
        for (const action of ['update_mapping', 'sync_feedback']) {
            expectMigrationError(() => store.createIdempotencyIntent({
                action,
                sourceIdentityKey: variant.identityKey,
                targetIdentityKey: listing.identityKey,
                desiredStateDigest: digest(`denied:${action}`),
                createdAtUtc: '2026-08-14T20:00:05.000Z',
                audit: { eventId: `intent:denied:${action}`, occurredAtUtc: '2026-08-14T20:00:05.000Z' },
            }), 'OWNERSHIP_DENIED');
        }
        // Production ownership stays denied for mapping/feedback.
        for (const responsibility of ['mapping', 'feedback']) {
            expectMigrationError(() => store.recordOwnershipVersion({
                responsibility,
                version: 1,
                owner: 'marketplace_connect',
                singleWriterVerified: true,
                evidenceDigest: digest(`denied-${responsibility}-ownership`),
                effectiveAtUtc: '2026-08-14T20:00:06.000Z',
                recordedAtUtc: '2026-08-14T20:00:06.000Z',
                audit: {
                    eventId: `ownership:denied:${responsibility}`,
                    occurredAtUtc: '2026-08-14T20:00:06.000Z',
                },
            }), 'OWNERSHIP_DENIED');
        }
        // listingRevise can never record a Marketplace Connect owner: its
        // ownership was never verified for the incumbent.
        expectMigrationError(() => store.recordOwnershipVersion({
            responsibility: 'listingRevise',
            version: 1,
            owner: 'marketplace_connect',
            singleWriterVerified: true,
            evidenceDigest: digest('denied-marketplace-connect-listing-revise'),
            effectiveAtUtc: '2026-08-14T20:00:07.000Z',
            recordedAtUtc: '2026-08-14T20:00:07.000Z',
            audit: { eventId: 'ownership:denied:mc-revise', occurredAtUtc: '2026-08-14T20:00:07.000Z' },
        }), 'OWNERSHIP_DENIED');
        // A production watermark stays impossible without ProductPipeline
        // single-writer orderImport ownership.
        recordReviseOwnershipChain(store);
        expectMigrationError(() => store.establishOrderWatermark({
            boundaryExclusiveUtc: '2026-08-14T19:59:00.000Z',
            ownershipVersion: 1,
            ownershipEvidenceDigest: digest('denied-watermark-evidence'),
            acceptedEvidenceDigest: digest('denied-watermark-packet'),
            createdAtUtc: '2026-08-14T20:00:08.000Z',
            audit: { eventId: 'watermark:denied', occurredAtUtc: '2026-08-14T20:00:08.000Z' },
        }), 'OWNERSHIP_DENIED');
        // Production reconciliation stays shadow-or-exact-slice only.
        expectMigrationError(() => store.recordReconciliationRun({
            runId: 'reconciliation:denied-test-lane',
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            mode: 'test_lane',
            status: 'passed',
            sourceSnapshotDigest: digest('denied-source'),
            targetSnapshotDigest: digest('denied-target'),
            resultDigest: digest('denied-result'),
            authoritative: true,
            authorityEvidenceDigest: digest('denied-authority'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-14T20:00:09.000Z',
            completedAtUtc: '2026-08-14T20:00:10.000Z',
            exceptions: [],
            audit: { eventId: 'reconciliation:denied-test-lane', occurredAtUtc: '2026-08-14T20:00:10.000Z' },
        }), 'OWNERSHIP_DENIED');
        expectMigrationError(() => store.recordReconciliationRun({
            runId: 'reconciliation:denied-other-responsibility',
            responsibility: 'mapping',
            targetIdentityKey: listing.identityKey,
            mode: 'production_canary',
            status: 'passed',
            sourceSnapshotDigest: digest('denied-source-2'),
            targetSnapshotDigest: digest('denied-target-2'),
            resultDigest: digest('denied-result-2'),
            authoritative: true,
            authorityEvidenceDigest: digest('denied-authority-2'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-14T20:00:11.000Z',
            completedAtUtc: '2026-08-14T20:00:12.000Z',
            exceptions: [],
            audit: {
                eventId: 'reconciliation:denied-other-responsibility',
                occurredAtUtc: '2026-08-14T20:00:12.000Z',
            },
        }), 'OWNERSHIP_DENIED');
        expectMigrationError(() => store.recordReconciliationRun({
            runId: 'reconciliation:denied-canary-writes',
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            mode: 'production_canary',
            status: 'passed',
            sourceSnapshotDigest: digest('denied-source-3'),
            targetSnapshotDigest: digest('denied-target-3'),
            resultDigest: digest('denied-result-3'),
            authoritative: false,
            authorityEvidenceDigest: digest('denied-authority-3'),
            externalWritesObserved: 1,
            startedAtUtc: '2026-08-14T20:00:13.000Z',
            completedAtUtc: '2026-08-14T20:00:14.000Z',
            exceptions: [],
            audit: {
                eventId: 'reconciliation:denied-canary-writes',
                occurredAtUtc: '2026-08-14T20:00:14.000Z',
            },
        }), 'OWNERSHIP_DENIED');
    });
    it('rejects a resolution whose recorded observation does not match', () => {
        const store = createProductionStore();
        const { variant, listing } = registerReviseIdentities(store);
        recordReviseOwnershipChain(store);
        const intentKey = store.createIdempotencyIntent({
            action: 'revise_ebay_listing',
            sourceIdentityKey: variant.identityKey,
            targetIdentityKey: listing.identityKey,
            desiredStateDigest: digest('manifest:mismatch-case'),
            createdAtUtc: '2026-08-14T20:00:05.000Z',
            audit: { eventId: 'intent:mismatch', occurredAtUtc: '2026-08-14T20:00:05.000Z' },
        });
        const approvalToken = 'one-action-revise-approval-0002';
        const approvalEvidenceDigest = digest('mismatch-approval-evidence');
        store.issueActionApproval({
            approvalToken,
            intentKey,
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            ownershipVersion: 2,
            issuedAtUtc: '2026-08-14T20:00:06.000Z',
            expiresAtUtc: '2026-08-14T20:10:06.000Z',
            evidenceDigest: approvalEvidenceDigest,
            audit: { eventId: 'approval:mismatch', occurredAtUtc: '2026-08-14T20:00:06.000Z' },
        });
        store.reserveExecutionJob({
            jobId: 'job:mismatch',
            approvalToken,
            intentKey,
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            ownershipVersion: 2,
            approvalEvidenceDigest,
            reservedAtUtc: '2026-08-14T20:00:07.000Z',
            evidenceDigest: digest('reserved-mismatch-job'),
            audit: { eventId: 'job:mismatch:reserved', occurredAtUtc: '2026-08-14T20:00:07.000Z' },
        });
        store.markDispatchingOutcomeUnknown({
            jobId: 'job:mismatch',
            attemptId: 'attempt:mismatch',
            approvalToken,
            approvalEvidenceDigest,
            occurredAtUtc: '2026-08-14T20:00:08.000Z',
            evidenceDigest: digest('mismatch-dispatch'),
            audit: { eventId: 'job:mismatch:dispatching', occurredAtUtc: '2026-08-14T20:00:08.000Z' },
        });
        store.requirePostDispatchReconciliation({
            jobId: 'job:mismatch',
            attemptId: 'attempt:mismatch',
            occurredAtUtc: '2026-08-14T20:00:09.000Z',
            evidenceDigest: digest('mismatch-reconciliation-required'),
            audit: { eventId: 'job:mismatch:required', occurredAtUtc: '2026-08-14T20:00:09.000Z' },
        });
        const resultDigest = digest('mismatch-result');
        store.recordReconciliationRun({
            runId: 'reconciliation:mismatch',
            responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey,
            mode: 'production_canary',
            status: 'passed',
            sourceSnapshotDigest: digest('mismatch-source'),
            targetSnapshotDigest: digest('mismatch-target'),
            resultDigest,
            authoritative: true,
            authorityEvidenceDigest: digest('mismatch-authority'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-14T20:00:10.000Z',
            completedAtUtc: '2026-08-14T20:00:11.000Z',
            exceptions: [],
            listingReviseObservation: {
                observationId: 'observation:mismatch',
                intentKey,
                effect: 'revised_state_absent',
                observedDigest: digest('observed-unchanged-target'),
            },
            audit: { eventId: 'reconciliation:mismatch', occurredAtUtc: '2026-08-14T20:00:11.000Z' },
        });
        // The recorded observation says the revise effect is absent, so a
        // resolved_existing claim must fail; an order link is always invalid here.
        expectMigrationError(() => store.resolveUnknownAttempt({
            jobId: 'job:mismatch',
            attemptId: 'attempt:mismatch',
            resolution: 'resolved_existing',
            reconciliationRunId: 'reconciliation:mismatch',
            reconciliationResultDigest: resultDigest,
            reconciledAtUtc: '2026-08-14T20:00:12.000Z',
            audit: { eventId: 'resolution:mismatch-denied', occurredAtUtc: '2026-08-14T20:00:12.000Z' },
        }), 'CONFLICT');
        expectMigrationError(() => store.resolveUnknownAttempt({
            jobId: 'job:mismatch',
            attemptId: 'attempt:mismatch',
            resolution: 'confirmed_missing',
            reconciliationRunId: 'reconciliation:mismatch',
            reconciliationResultDigest: resultDigest,
            orderLinkId: 'link:invalid',
            shopifyOrderIdentityKey: digest('not-an-identity'),
            reconciledAtUtc: '2026-08-14T20:00:12.000Z',
            audit: { eventId: 'resolution:link-denied', occurredAtUtc: '2026-08-14T20:00:12.000Z' },
        }), 'INVALID_INPUT');
        store.resolveUnknownAttempt({
            jobId: 'job:mismatch',
            attemptId: 'attempt:mismatch',
            resolution: 'confirmed_missing',
            reconciliationRunId: 'reconciliation:mismatch',
            reconciliationResultDigest: resultDigest,
            reconciledAtUtc: '2026-08-14T20:00:13.000Z',
            audit: { eventId: 'resolution:confirmed-missing', occurredAtUtc: '2026-08-14T20:00:13.000Z' },
        });
        expect(store.getJobStatus('job:mismatch')).toMatchObject({ state: 'confirmed_missing' });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    });
});
describe('migration store schema upgrade', () => {
    function createVersionOneStoreFile(scope, createdAtUtc) {
        const databasePath = path.join(temporaryDirectory(), 'migration-state.sqlite');
        const database = new Database(databasePath);
        database.pragma('foreign_keys = ON');
        database.pragma('recursive_triggers = ON');
        database.pragma('journal_mode = DELETE');
        initializeSchema(database, createdAtUtc, 1);
        const scopeKey = deriveScopeKey(scope);
        const createdEpochMs = Date.parse(createdAtUtc);
        const establish = database.transaction(() => {
            database
                .prepare(`INSERT INTO integration_scope (
            singleton, scope_key, shopify_store_domain, ebay_environment,
            ebay_seller_id, ebay_marketplace_id, created_at_utc, created_epoch_ms
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`)
                .run(scopeKey, scope.shopifyStoreDomain, scope.ebayEnvironment, scope.ebaySellerId, scope.ebayMarketplaceId, createdAtUtc, createdEpochMs);
            const payloadDigest = sha256Digest({ scopeKey });
            const eventHash = sha256Digest({
                schemaVersion: 1,
                sequence: 1,
                scopeKey,
                eventId: `scope:${scopeKey}`,
                eventType: 'scope.established',
                occurredAtUtc: createdAtUtc,
                payloadDigest,
                previousHash: 'GENESIS',
            });
            database
                .prepare(`INSERT INTO audit_events (
            sequence, scope_key, event_id, event_type, occurred_at_utc,
            occurred_epoch_ms, payload_digest, previous_hash, event_hash
          ) VALUES (1, ?, ?, 'scope.established', ?, ?, ?, 'GENESIS', ?)`)
                .run(scopeKey, `scope:${scopeKey}`, createdAtUtc, createdEpochMs, payloadDigest, eventHash);
        });
        establish.immediate();
        database.close();
        fs.chmodSync(databasePath, 0o600);
        return databasePath;
    }
    it('upgrades a verified v1 store to the current version and leaves it fully operable', () => {
        const databasePath = createVersionOneStoreFile(PRODUCTION_SCOPE, '2026-08-14T19:00:00.000Z');
        // A v1 store fails every ordinary open until an operator upgrades it.
        expect(() => openMigrationStore({
            databasePath,
            expectedScope: PRODUCTION_SCOPE,
        })).toThrow(/does not match required version/);
        expect(upgradeMigrationStore({
            databasePath,
            expectedScope: PRODUCTION_SCOPE,
            appliedAtUtc: '2026-08-14T20:00:00.000Z',
        })).toEqual({ fromVersion: 1, toVersion: 5 });
        // Upgrading again is an explicit no-op.
        expect(upgradeMigrationStore({
            databasePath,
            expectedScope: PRODUCTION_SCOPE,
            appliedAtUtc: '2026-08-14T20:01:00.000Z',
        })).toEqual({ fromVersion: 5, toVersion: 5 });
        const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
        openStores.push(store);
        expect(store.getCounts()).toMatchObject({
            listing_revise_observations: 0,
            target_effect_observations: 0,
            audit_events: 1,
        });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true, recordCount: 1 });
    });
    it('refuses to upgrade a store whose recorded v1 history is tampered', () => {
        const databasePath = createVersionOneStoreFile(PRODUCTION_SCOPE, '2026-08-14T19:00:00.000Z');
        const database = new Database(databasePath);
        // In-band updates are already denied by trigger; simulate out-of-band
        // tampering by removing that protection first. Either the checksum
        // mismatch or the changed catalog digest must block the upgrade.
        database.exec('DROP TRIGGER schema_migrations_deny_update');
        database
            .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
            .run(`sha256:${'e'.repeat(64)}`);
        database.close();
        fs.chmodSync(databasePath, 0o600);
        expect(() => upgradeMigrationStore({
            databasePath,
            expectedScope: PRODUCTION_SCOPE,
            appliedAtUtc: '2026-08-14T20:00:00.000Z',
        })).toThrow(MigrationStoreError);
    });
});
