/**
 * Schema v5 — listing-create recovery-cleanup slice regressions (Brain L34).
 *
 * Version 5 widens exactly one production capability: a
 * `recover_create_ebay_listing` intent structurally bound to an outstanding
 * unresolved create job, plus the truthful `resolved_residue_removed` /
 * `effect_residue_removed` terminal pairing for listingCreate. Everything
 * else must keep denying exactly as v4 did, and the rebuilt tables must stay
 * append-only and tamper-evident.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationStore, deriveScopeKey, openMigrationStore, sha256Digest, upgradeMigrationStore, } from '../index.js';
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
function temporaryStorePath() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-v5-recovery-'));
    temporaryDirectories.push(directory);
    return path.join(directory, 'migration-state.sqlite');
}
let tick = 0;
function at(offsetMinutes) {
    return new Date(Date.parse('2026-08-27T18:00:00.000Z') + offsetMinutes * 60_000).toISOString();
}
/** One production store holding one unresolved (reconciliation_required) create job. */
function seedUnresolvedCreate() {
    tick = 0;
    const databasePath = temporaryStorePath();
    const store = createMigrationStore({
        databasePath,
        scope: PRODUCTION_SCOPE,
        createdAtUtc: at(0),
    });
    openStores.push(store);
    const variant = store.registerIdentity({
        platform: 'shopify',
        kind: 'variant',
        bindingKey: 'variant:55396000700009',
        storeDomain: PRODUCTION_SCOPE.shopifyStoreDomain,
        externalGid: 'gid://shopify/ProductVariant/55396000700009',
    }, { eventId: 'identity:variant', occurredAtUtc: at(1) });
    const sku = store.registerIdentity({
        platform: 'ebay',
        kind: 'inventory_sku',
        bindingKey: 'ebay-inventory-sku:CAN2470-U400',
        environment: PRODUCTION_SCOPE.ebayEnvironment,
        sellerId: PRODUCTION_SCOPE.ebaySellerId,
        marketplaceId: PRODUCTION_SCOPE.ebayMarketplaceId,
        externalId: 'CAN2470-U400',
    }, { eventId: 'identity:sku', occurredAtUtc: at(2) });
    for (const ownership of [
        { version: 1, owner: 'paused', atUtc: at(3) },
        { version: 2, owner: 'product_pipeline', atUtc: at(4) },
    ]) {
        store.recordOwnershipVersion({
            responsibility: 'listingCreate',
            version: ownership.version,
            owner: ownership.owner,
            singleWriterVerified: true,
            evidenceDigest: digest(`listing-create-owner-v${ownership.version}`),
            effectiveAtUtc: ownership.atUtc,
            recordedAtUtc: ownership.atUtc,
            audit: { eventId: `ownership:listingCreate:v${ownership.version}`, occurredAtUtc: ownership.atUtc },
        });
    }
    const createManifestDigest = digest('create-manifest-draft-5');
    const createIntentKey = store.createIdempotencyIntent({
        action: 'create_ebay_listing',
        sourceIdentityKey: variant.identityKey,
        targetIdentityKey: sku.identityKey,
        desiredStateDigest: createManifestDigest,
        createdAtUtc: at(5),
        audit: { eventId: 'intent:create', occurredAtUtc: at(5) },
    });
    store.issueActionApproval({
        approvalToken: 'create-ceremony-approval-token-001',
        intentKey: createIntentKey,
        responsibility: 'listingCreate',
        targetIdentityKey: sku.identityKey,
        ownershipVersion: 2,
        issuedAtUtc: at(6),
        expiresAtUtc: at(16),
        evidenceDigest: createManifestDigest,
        audit: { eventId: 'approval:create', occurredAtUtc: at(6) },
    });
    store.reserveExecutionJob({
        jobId: 'job:create-unpublished',
        approvalToken: 'create-ceremony-approval-token-001',
        intentKey: createIntentKey,
        responsibility: 'listingCreate',
        targetIdentityKey: sku.identityKey,
        ownershipVersion: 2,
        approvalEvidenceDigest: createManifestDigest,
        reservedAtUtc: at(7),
        evidenceDigest: createManifestDigest,
        audit: { eventId: 'job:create:reserved', occurredAtUtc: at(7) },
    });
    store.markDispatchingOutcomeUnknown({
        jobId: 'job:create-unpublished',
        attemptId: 'attempt:create-unpublished',
        approvalToken: 'create-ceremony-approval-token-001',
        approvalEvidenceDigest: createManifestDigest,
        occurredAtUtc: at(8),
        evidenceDigest: createManifestDigest,
        audit: { eventId: 'job:create:dispatching', occurredAtUtc: at(8) },
    });
    store.requirePostDispatchReconciliation({
        jobId: 'job:create-unpublished',
        attemptId: 'attempt:create-unpublished',
        occurredAtUtc: at(9),
        evidenceDigest: createManifestDigest,
        audit: { eventId: 'job:create:reconciliation-required', occurredAtUtc: at(9) },
    });
    return {
        store,
        databasePath,
        variantIdentityKey: variant.identityKey,
        skuIdentityKey: sku.identityKey,
        createIntentKey,
        createManifestDigest,
    };
}
/** Reserve and dispatch the recovery ceremony job for a seeded store. */
function seedRecoveryCeremony(seeded) {
    const recoveryDigest = digest('recovery-manifest-001');
    const recoveryIntentKey = seeded.store.createIdempotencyIntent({
        action: 'recover_create_ebay_listing',
        sourceIdentityKey: seeded.variantIdentityKey,
        targetIdentityKey: seeded.skuIdentityKey,
        desiredStateDigest: recoveryDigest,
        createdAtUtc: at(20),
        audit: { eventId: 'intent:recover', occurredAtUtc: at(20) },
    });
    seeded.store.issueActionApproval({
        approvalToken: 'recover-ceremony-approval-token-001',
        intentKey: recoveryIntentKey,
        responsibility: 'listingCreate',
        targetIdentityKey: seeded.skuIdentityKey,
        ownershipVersion: 2,
        issuedAtUtc: at(21),
        expiresAtUtc: at(31),
        evidenceDigest: recoveryDigest,
        audit: { eventId: 'approval:recover', occurredAtUtc: at(21) },
    });
    seeded.store.reserveExecutionJob({
        jobId: 'job:recover',
        approvalToken: 'recover-ceremony-approval-token-001',
        intentKey: recoveryIntentKey,
        responsibility: 'listingCreate',
        targetIdentityKey: seeded.skuIdentityKey,
        ownershipVersion: 2,
        approvalEvidenceDigest: recoveryDigest,
        reservedAtUtc: at(22),
        evidenceDigest: recoveryDigest,
        audit: { eventId: 'job:recover:reserved', occurredAtUtc: at(22) },
    });
    seeded.store.markDispatchingOutcomeUnknown({
        jobId: 'job:recover',
        attemptId: 'attempt:recover',
        approvalToken: 'recover-ceremony-approval-token-001',
        approvalEvidenceDigest: recoveryDigest,
        occurredAtUtc: at(23),
        evidenceDigest: recoveryDigest,
        audit: { eventId: 'job:recover:dispatching', occurredAtUtc: at(23) },
    });
    seeded.store.requirePostDispatchReconciliation({
        jobId: 'job:recover',
        attemptId: 'attempt:recover',
        occurredAtUtc: at(24),
        evidenceDigest: recoveryDigest,
        audit: { eventId: 'job:recover:reconciliation-required', occurredAtUtc: at(24) },
    });
    return { recoveryIntentKey, recoveryDigest };
}
function recordRemovalRun(seeded, input) {
    const resultDigest = digest(`result:${input.runId}`);
    seeded.store.recordReconciliationRun({
        runId: input.runId,
        responsibility: 'listingCreate',
        targetIdentityKey: seeded.skuIdentityKey,
        mode: 'production_canary',
        status: 'passed',
        sourceSnapshotDigest: digest(`source:${input.runId}`),
        targetSnapshotDigest: digest(`target:${input.runId}`),
        resultDigest,
        authoritative: true,
        authorityEvidenceDigest: digest(`authority:${input.runId}`),
        externalWritesObserved: 0,
        startedAtUtc: input.startedAtUtc,
        completedAtUtc: input.completedAtUtc,
        exceptions: [],
        targetEffectObservation: {
            observationId: `observation:${input.runId}`,
            intentKey: input.intentKey,
            responsibility: 'listingCreate',
            effect: input.effect ?? 'effect_residue_removed',
            observedDigest: digest(`observed:${input.runId}`),
        },
        audit: { eventId: `reconciliation:${input.runId}`, occurredAtUtc: input.completedAtUtc },
    });
    return resultDigest;
}
describe('schema v5 listing-create recovery slice', () => {
    it('admits a production recovery intent only against an unresolved create job on the exact target', () => {
        const seeded = seedUnresolvedCreate();
        // A target no unresolved create job ever touched can never gain a
        // recovery intent — TS guard and SQL trigger agree.
        const foreignSku = seeded.store.registerIdentity({
            platform: 'ebay',
            kind: 'inventory_sku',
            bindingKey: 'ebay-inventory-sku:OTHER-SKU-1',
            environment: PRODUCTION_SCOPE.ebayEnvironment,
            sellerId: PRODUCTION_SCOPE.ebaySellerId,
            marketplaceId: PRODUCTION_SCOPE.ebayMarketplaceId,
            externalId: 'OTHER-SKU-1',
        }, { eventId: 'identity:foreign-sku', occurredAtUtc: at(10) });
        expect(() => seeded.store.createIdempotencyIntent({
            action: 'recover_create_ebay_listing',
            sourceIdentityKey: seeded.variantIdentityKey,
            targetIdentityKey: foreignSku.identityKey,
            desiredStateDigest: digest('speculative-recovery'),
            createdAtUtc: at(11),
            audit: { eventId: 'intent:speculative-recovery', occurredAtUtc: at(11) },
        })).toThrow(/unresolved create job/);
        const raw = new Database(seeded.databasePath);
        try {
            raw.pragma('foreign_keys = ON');
            raw.pragma('recursive_triggers = ON');
            const intentKey = digest('raw-speculative-recovery-intent');
            expect(() => raw.prepare(`INSERT INTO idempotency_intents (
          intent_key, scope_key, responsibility, action, source_identity_key,
          target_identity_key, approval_target_identity_key, desired_state_digest,
          created_at_utc, created_epoch_ms
        ) VALUES (?, ?, 'listingCreate', 'recover_create_ebay_listing', ?, ?, ?, ?, ?, ?)`).run(intentKey, deriveScopeKey(PRODUCTION_SCOPE), seeded.variantIdentityKey, foreignSku.identityKey, foreignSku.identityKey, digest('raw-speculative-recovery'), at(12), Date.parse(at(12)))).toThrow(/recovery intent requires an unresolved create job on the exact target/);
            // Every other new production action stays denied by the same trigger.
            expect(() => raw.prepare(`INSERT INTO idempotency_intents (
          intent_key, scope_key, responsibility, action, source_identity_key,
          target_identity_key, approval_target_identity_key, desired_state_digest,
          created_at_utc, created_epoch_ms
        ) VALUES (?, ?, 'mapping', 'update_mapping', ?, ?, ?, ?, ?, ?)`).run(digest('raw-mapping-intent'), deriveScopeKey(PRODUCTION_SCOPE), seeded.variantIdentityKey, seeded.skuIdentityKey, seeded.skuIdentityKey, digest('raw-mapping-manifest'), at(13), Date.parse(at(13)))).toThrow(/production writer intents are disabled/);
        }
        finally {
            raw.close();
        }
        expect(() => seeded.store.createIdempotencyIntent({
            action: 'update_mapping',
            sourceIdentityKey: seeded.variantIdentityKey,
            targetIdentityKey: seeded.skuIdentityKey,
            desiredStateDigest: digest('mapping-manifest'),
            createdAtUtc: at(14),
            audit: { eventId: 'intent:mapping', occurredAtUtc: at(14) },
        })).toThrow(/Production writer intents are disabled/);
        // With the unresolved create job on the exact target, the recovery
        // intent is admitted.
        const { recoveryIntentKey } = seedRecoveryCeremony(seeded);
        expect(recoveryIntentKey).toMatch(/^sha256:/);
    });
    it('resolves removed residue truthfully — and only with the exact paired observation', () => {
        const seeded = seedUnresolvedCreate();
        const { recoveryIntentKey } = seedRecoveryCeremony(seeded);
        // A removed-residue claim cannot ride on an effect_absent observation.
        const absentRun = recordRemovalRun(seeded, {
            runId: 'run:recover-absent',
            intentKey: recoveryIntentKey,
            effect: 'effect_absent',
            startedAtUtc: at(25),
            completedAtUtc: at(26),
        });
        expect(() => seeded.store.resolveUnknownAttempt({
            jobId: 'job:recover',
            attemptId: 'attempt:recover',
            resolution: 'resolved_residue_removed',
            reconciliationRunId: 'run:recover-absent',
            reconciliationResultDigest: absentRun,
            reconciledAtUtc: at(27),
            audit: { eventId: 'resolution:recover-absent', occurredAtUtc: at(27) },
        })).toThrow(/exact recorded target effect observation/);
        // And an effect_residue_removed observation cannot be claimed as
        // resolved_existing.
        const removedRun = recordRemovalRun(seeded, {
            runId: 'run:recover-removed',
            intentKey: recoveryIntentKey,
            startedAtUtc: at(28),
            completedAtUtc: at(29),
        });
        expect(() => seeded.store.resolveUnknownAttempt({
            jobId: 'job:recover',
            attemptId: 'attempt:recover',
            resolution: 'resolved_existing',
            reconciliationRunId: 'run:recover-removed',
            reconciliationResultDigest: removedRun,
            reconciledAtUtc: at(30),
            audit: { eventId: 'resolution:recover-wrong', occurredAtUtc: at(30) },
        })).toThrow(/exact recorded target effect observation/);
        // The truthful pairing resolves the recovery job terminally.
        seeded.store.resolveUnknownAttempt({
            jobId: 'job:recover',
            attemptId: 'attempt:recover',
            resolution: 'resolved_residue_removed',
            reconciliationRunId: 'run:recover-removed',
            reconciliationResultDigest: removedRun,
            reconciledAtUtc: at(31),
            audit: { eventId: 'resolution:recover', occurredAtUtc: at(31) },
        });
        expect(seeded.store.getJobStatus('job:recover')).toMatchObject({
            state: 'resolved_residue_removed',
        });
        // The ORIGINAL create job then resolves through its own run bound to the
        // create intent — removed-residue semantics, not a fabricated
        // confirmed_missing.
        const sourceRun = recordRemovalRun(seeded, {
            runId: 'run:source-removed',
            intentKey: seeded.createIntentKey,
            startedAtUtc: at(32),
            completedAtUtc: at(33),
        });
        seeded.store.resolveUnknownAttempt({
            jobId: 'job:create-unpublished',
            attemptId: 'attempt:create-unpublished',
            resolution: 'resolved_residue_removed',
            reconciliationRunId: 'run:source-removed',
            reconciliationResultDigest: sourceRun,
            reconciledAtUtc: at(34),
            audit: { eventId: 'resolution:source', occurredAtUtc: at(34) },
        });
        expect(seeded.store.getJobStatus('job:create-unpublished')).toMatchObject({
            state: 'resolved_residue_removed',
        });
        expect(seeded.store.getAttemptStatus('job:create-unpublished', 'attempt:create-unpublished'))
            .toMatchObject({ resolution: 'resolved_residue_removed' });
        expect(seeded.store.verifyAuditChain()).toMatchObject({ valid: true });
        const monitoring = seeded.store.getOperationalMonitoring(at(60));
        expect(monitoring.currentJobs).toMatchObject({
            reconciliationRequired: 0,
            resolvedResidueRemoved: 2,
        });
    });
    it('restricts the removed-residue effect to listingCreate everywhere', () => {
        const seeded = seedUnresolvedCreate();
        seedRecoveryCeremony(seeded);
        expect(() => seeded.store.recordReconciliationRun({
            runId: 'run:price-residue',
            responsibility: 'price',
            targetIdentityKey: seeded.skuIdentityKey,
            mode: 'production_canary',
            status: 'passed',
            sourceSnapshotDigest: digest('price-source'),
            targetSnapshotDigest: digest('price-target'),
            resultDigest: digest('price-result'),
            authoritative: true,
            authorityEvidenceDigest: digest('price-authority'),
            externalWritesObserved: 0,
            startedAtUtc: at(25),
            completedAtUtc: at(26),
            exceptions: [],
            targetEffectObservation: {
                observationId: 'observation:price-residue',
                intentKey: seeded.createIntentKey,
                responsibility: 'price',
                effect: 'effect_residue_removed',
                observedDigest: digest('price-observed'),
            },
            audit: { eventId: 'reconciliation:price-residue', occurredAtUtc: at(26) },
        })).toThrow(/listingCreate/);
        const raw = new Database(seeded.databasePath);
        try {
            raw.pragma('foreign_keys = ON');
            raw.pragma('recursive_triggers = ON');
            // The rebuilt table's CHECK denies a non-listingCreate residue effect
            // even from raw SQL.
            expect(() => raw.prepare(`INSERT INTO target_effect_observations (
          observation_id, run_id, intent_key, target_identity_key,
          responsibility, effect, observed_digest, created_at_utc, created_epoch_ms
        ) VALUES ('observation:raw-price-residue', 'run:raw-price', ?, ?,
          'price', 'effect_residue_removed', ?, ?, ?)`).run(seeded.createIntentKey, seeded.skuIdentityKey, digest('raw-price-observed'), at(27), Date.parse(at(27)))).toThrow(/CHECK|listingCreate|binding/);
            // A terminal job event without its exact attempt resolution stays
            // impossible for the new state, exactly as for the old ones.
            expect(() => raw.prepare(`INSERT INTO job_events (
          job_event_id, job_id, sequence, from_state, to_state,
          evidence_digest, occurred_at_utc, occurred_epoch_ms
        ) VALUES ('job:recover:forged', 'job:recover', 4, 'reconciliation_required',
          'resolved_residue_removed', ?, ?, ?)`).run(digest('forged'), at(28), Date.parse(at(28))))
                .toThrow(/terminal job event requires exact attempt resolution/);
            // And the transition matrix admits the new state only from
            // reconciliation_required.
            expect(() => raw.prepare(`INSERT INTO job_events (
          job_event_id, job_id, sequence, from_state, to_state,
          evidence_digest, occurred_at_utc, occurred_epoch_ms
        ) VALUES ('job:recover:forged2', 'job:recover', 4, 'dispatching',
          'resolved_residue_removed', ?, ?, ?)`).run(digest('forged2'), at(28), Date.parse(at(28))))
                .toThrow(/invalid job state transition|terminal job event/);
        }
        finally {
            raw.close();
        }
    });
    it('keeps the rebuilt tables append-only and replay-denied after the v5 rebuild', () => {
        const seeded = seedUnresolvedCreate();
        const { recoveryIntentKey } = seedRecoveryCeremony(seeded);
        const removedRun = recordRemovalRun(seeded, {
            runId: 'run:recover-removed',
            intentKey: recoveryIntentKey,
            startedAtUtc: at(25),
            completedAtUtc: at(26),
        });
        seeded.store.resolveUnknownAttempt({
            jobId: 'job:recover',
            attemptId: 'attempt:recover',
            resolution: 'resolved_residue_removed',
            reconciliationRunId: 'run:recover-removed',
            reconciliationResultDigest: removedRun,
            reconciledAtUtc: at(27),
            audit: { eventId: 'resolution:recover', occurredAtUtc: at(27) },
        });
        const raw = new Database(seeded.databasePath);
        try {
            raw.pragma('foreign_keys = ON');
            raw.pragma('recursive_triggers = ON');
            for (const [table, mutation] of [
                ['idempotency_intents', `UPDATE idempotency_intents SET desired_state_digest = '${digest('tampered')}'`],
                ['idempotency_intents', 'DELETE FROM idempotency_intents'],
                ['job_events', "UPDATE job_events SET to_state = 'resolved_existing'"],
                ['job_events', 'DELETE FROM job_events'],
                ['attempt_resolutions', "UPDATE attempt_resolutions SET resolution = 'resolved_existing'"],
                ['attempt_resolutions', 'DELETE FROM attempt_resolutions'],
                ['target_effect_observations', "UPDATE target_effect_observations SET effect = 'effect_observed'"],
                ['target_effect_observations', 'DELETE FROM target_effect_observations'],
            ]) {
                expect(() => raw.prepare(mutation).run(), mutation).toThrow(new RegExp(`${table} is append-only`));
            }
            expect(() => raw.prepare('INSERT INTO idempotency_intents SELECT * FROM idempotency_intents').run()).toThrow(/replay or replacement denied/);
            // Replaying a resolution is denied — by the replay trigger or the
            // authoritative-reconciliation gate, whichever fires first.
            expect(() => raw.prepare('INSERT INTO attempt_resolutions SELECT * FROM attempt_resolutions').run()).toThrow(/replay or replacement denied|authoritative target reconciliation/);
        }
        finally {
            raw.close();
        }
    });
    it('upgrades a verified v4 store to v5 explicitly and leaves it operable', () => {
        const databasePath = temporaryStorePath();
        const database = new Database(databasePath);
        database.pragma('foreign_keys = ON');
        database.pragma('recursive_triggers = ON');
        database.pragma('journal_mode = DELETE');
        initializeSchema(database, '2026-08-27T16:00:00.000Z', 4);
        const scopeKey = deriveScopeKey(PRODUCTION_SCOPE);
        const genesisPayload = sha256Digest({ scopeKey });
        const genesisHash = sha256Digest({
            schemaVersion: 1,
            sequence: 1,
            scopeKey,
            eventId: `scope:${scopeKey}`,
            eventType: 'scope.established',
            occurredAtUtc: '2026-08-27T16:00:00.000Z',
            payloadDigest: genesisPayload,
            previousHash: 'GENESIS',
        });
        const populate = database.transaction(() => {
            database.prepare(`INSERT INTO integration_scope (
          singleton, scope_key, shopify_store_domain, ebay_environment,
          ebay_seller_id, ebay_marketplace_id, created_at_utc, created_epoch_ms
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`).run(scopeKey, PRODUCTION_SCOPE.shopifyStoreDomain, PRODUCTION_SCOPE.ebayEnvironment, PRODUCTION_SCOPE.ebaySellerId, PRODUCTION_SCOPE.ebayMarketplaceId, '2026-08-27T16:00:00.000Z', Date.parse('2026-08-27T16:00:00.000Z'));
            database.prepare(`INSERT INTO audit_events (
          sequence, scope_key, event_id, event_type, occurred_at_utc,
          occurred_epoch_ms, payload_digest, previous_hash, event_hash
        ) VALUES (1, ?, ?, 'scope.established', ?, ?, ?, 'GENESIS', ?)`).run(scopeKey, `scope:${scopeKey}`, '2026-08-27T16:00:00.000Z', Date.parse('2026-08-27T16:00:00.000Z'), genesisPayload, genesisHash);
        });
        populate.immediate();
        database.close();
        fs.chmodSync(databasePath, 0o600);
        // An ordinary open of the v4 store fails closed until the explicit
        // operator upgrade runs.
        expect(() => openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE }))
            .toThrow(/schema version 4 does not match required version 5/);
        expect(upgradeMigrationStore({
            databasePath,
            expectedScope: PRODUCTION_SCOPE,
            appliedAtUtc: '2026-08-27T17:00:00.000Z',
        })).toEqual({ fromVersion: 4, toVersion: 5 });
        const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
        openStores.push(store);
        expect(store.verifyAuditChain()).toMatchObject({ valid: true, recordCount: 1 });
        expect(store.getCounts()).toMatchObject({
            idempotency_intents: 0,
            execution_jobs: 0,
            attempt_resolutions: 0,
            target_effect_observations: 0,
        });
    });
});
