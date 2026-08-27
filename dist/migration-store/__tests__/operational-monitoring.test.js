import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationStore, sha256Digest } from '../index.js';
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
describe('aggregate-only operational monitoring', () => {
    it('counts the previous completed UTC day without exposing row identifiers', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-monitoring-'));
        roots.push(root);
        const scope = {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayEnvironment: 'sandbox',
            ebaySellerId: 'fixture-seller',
            ebayMarketplaceId: 'EBAY_US',
        };
        const store = createMigrationStore({
            databasePath: path.join(root, 'state.sqlite'),
            scope,
            createdAtUtc: '2026-08-25T00:00:00.000Z',
        });
        const target = store.registerIdentity({
            platform: 'ebay', kind: 'listing', bindingKey: 'fixture-listing',
            environment: 'sandbox', sellerId: scope.ebaySellerId,
            marketplaceId: scope.ebayMarketplaceId, externalId: 'fixture-listing-id',
        }, { eventId: 'identity:monitoring-target', occurredAtUtc: '2026-08-25T00:00:01.000Z' });
        store.recordReconciliationRun({
            runId: 'reconciliation:monitoring-failed',
            responsibility: 'reconciliation',
            targetIdentityKey: target.identityKey,
            mode: 'shadow',
            status: 'failed',
            sourceSnapshotDigest: sha256Digest('source'),
            targetSnapshotDigest: sha256Digest('target'),
            resultDigest: sha256Digest('result'),
            authoritative: false,
            authorityEvidenceDigest: sha256Digest('authority'),
            externalWritesObserved: 0,
            startedAtUtc: '2026-08-26T11:59:00.000Z',
            completedAtUtc: '2026-08-26T12:00:00.000Z',
            exceptions: [{
                    exceptionId: 'exception:monitoring-critical',
                    code: 'FIXTURE_READ_FAILED',
                    severity: 'critical',
                    detailsDigest: sha256Digest('redacted detail'),
                }],
            audit: {
                eventId: 'reconciliation:monitoring-failed',
                occurredAtUtc: '2026-08-26T12:00:00.000Z',
            },
        });
        const result = store.getOperationalMonitoring('2026-08-27T15:30:00.000Z');
        expect(result).toEqual({
            currentJobs: {
                reserved: 0, dispatching: 0, reconciliationRequired: 0,
                resolvedExisting: 0, confirmedMissing: 0, resolvedResidueRemoved: 0,
            },
            previousUtcDay: {
                dateUtc: '2026-08-26',
                windowStartUtc: '2026-08-26T00:00:00.000Z',
                windowEndUtc: '2026-08-27T00:00:00.000Z',
                writes: { performed: 0, succeeded: 0, failed: 0, unresolved: 0 },
                reconciliations: { passed: 0, blocked: 0, failed: 1 },
                exceptions: { info: 0, warning: 0, critical: 1 },
            },
        });
        expect(JSON.stringify(result)).not.toMatch(/fixture-listing|FIXTURE_READ_FAILED|sha256:/);
        store.close();
    });
    it('keeps one immutable attempt cohort coherent when resolution crosses midnight', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-monitoring-midnight-'));
        roots.push(root);
        const scope = {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayEnvironment: 'production',
            ebaySellerId: 'usedcameragear',
            ebayMarketplaceId: 'EBAY_US',
        };
        const store = createMigrationStore({
            databasePath: path.join(root, 'state.sqlite'), scope,
            createdAtUtc: '2026-08-26T23:58:00.000Z',
        });
        const variant = store.registerIdentity({
            platform: 'shopify', kind: 'variant', bindingKey: 'variant:midnight-fixture',
            storeDomain: scope.shopifyStoreDomain,
            externalGid: 'gid://shopify/ProductVariant/55555555555555',
        }, { eventId: 'identity:midnight-variant', occurredAtUtc: '2026-08-26T23:58:01.000Z' });
        const listing = store.registerIdentity({
            platform: 'ebay', kind: 'listing', bindingKey: 'listing:midnight-fixture',
            environment: 'production', sellerId: scope.ebaySellerId,
            marketplaceId: scope.ebayMarketplaceId, externalId: '155555555555',
        }, { eventId: 'identity:midnight-listing', occurredAtUtc: '2026-08-26T23:58:02.000Z' });
        store.recordOwnershipVersion({
            responsibility: 'listingRevise', version: 1, owner: 'paused',
            singleWriterVerified: true, evidenceDigest: sha256Digest('midnight-paused'),
            effectiveAtUtc: '2026-08-26T23:58:03.000Z', recordedAtUtc: '2026-08-26T23:58:03.000Z',
            audit: { eventId: 'ownership:midnight:v1', occurredAtUtc: '2026-08-26T23:58:03.000Z' },
        });
        store.recordOwnershipVersion({
            responsibility: 'listingRevise', version: 2, owner: 'product_pipeline',
            singleWriterVerified: true, evidenceDigest: sha256Digest('midnight-owned'),
            effectiveAtUtc: '2026-08-26T23:58:04.000Z', recordedAtUtc: '2026-08-26T23:58:04.000Z',
            audit: { eventId: 'ownership:midnight:v2', occurredAtUtc: '2026-08-26T23:58:04.000Z' },
        });
        const desiredStateDigest = sha256Digest('midnight-desired');
        const intentKey = store.createIdempotencyIntent({
            action: 'revise_ebay_listing', sourceIdentityKey: variant.identityKey,
            targetIdentityKey: listing.identityKey, desiredStateDigest,
            createdAtUtc: '2026-08-26T23:58:05.000Z',
            audit: { eventId: 'intent:midnight', occurredAtUtc: '2026-08-26T23:58:05.000Z' },
        });
        const approvalToken = 'midnight-one-action-approval';
        const approvalEvidenceDigest = sha256Digest('midnight-approval');
        store.issueActionApproval({
            approvalToken, intentKey, responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey, ownershipVersion: 2,
            issuedAtUtc: '2026-08-26T23:58:06.000Z', expiresAtUtc: '2026-08-27T00:08:06.000Z',
            evidenceDigest: approvalEvidenceDigest,
            audit: { eventId: 'approval:midnight', occurredAtUtc: '2026-08-26T23:58:06.000Z' },
        });
        store.reserveExecutionJob({
            jobId: 'job:midnight', approvalToken, intentKey, responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey, ownershipVersion: 2, approvalEvidenceDigest,
            reservedAtUtc: '2026-08-26T23:58:07.000Z', evidenceDigest: sha256Digest('midnight-reserved'),
            audit: { eventId: 'job:midnight:reserved', occurredAtUtc: '2026-08-26T23:58:07.000Z' },
        });
        store.markDispatchingOutcomeUnknown({
            jobId: 'job:midnight', attemptId: 'attempt:midnight', approvalToken,
            approvalEvidenceDigest, occurredAtUtc: '2026-08-26T23:59:50.000Z',
            evidenceDigest: sha256Digest('midnight-dispatch'),
            audit: { eventId: 'job:midnight:dispatch', occurredAtUtc: '2026-08-26T23:59:50.000Z' },
        });
        store.requirePostDispatchReconciliation({
            jobId: 'job:midnight', attemptId: 'attempt:midnight',
            occurredAtUtc: '2026-08-26T23:59:51.000Z',
            evidenceDigest: sha256Digest('midnight-reconciliation-required'),
            audit: { eventId: 'job:midnight:required', occurredAtUtc: '2026-08-26T23:59:51.000Z' },
        });
        const resultDigest = sha256Digest('midnight-result');
        store.recordReconciliationRun({
            runId: 'reconciliation:midnight', responsibility: 'listingRevise',
            targetIdentityKey: listing.identityKey, mode: 'production_canary', status: 'passed',
            sourceSnapshotDigest: sha256Digest('midnight-source'),
            targetSnapshotDigest: sha256Digest('midnight-target'), resultDigest,
            authoritative: true, authorityEvidenceDigest: sha256Digest('midnight-authority'),
            externalWritesObserved: 0, startedAtUtc: '2026-08-27T00:00:00.000Z',
            completedAtUtc: '2026-08-27T00:00:01.000Z', exceptions: [],
            listingReviseObservation: {
                observationId: 'observation:midnight', intentKey,
                effect: 'revised_state_observed', observedDigest: sha256Digest('midnight-observed'),
            },
            audit: { eventId: 'reconciliation:midnight', occurredAtUtc: '2026-08-27T00:00:01.000Z' },
        });
        store.resolveUnknownAttempt({
            jobId: 'job:midnight', attemptId: 'attempt:midnight', resolution: 'resolved_existing',
            reconciliationRunId: 'reconciliation:midnight', reconciliationResultDigest: resultDigest,
            reconciledAtUtc: '2026-08-27T00:00:02.000Z',
            audit: { eventId: 'resolution:midnight', occurredAtUtc: '2026-08-27T00:00:02.000Z' },
        });
        const first = store.getOperationalMonitoring('2026-08-27T12:00:00.000Z');
        const repeated = store.getOperationalMonitoring('2026-08-27T23:59:59.000Z');
        expect(first.previousUtcDay.writes).toEqual({
            performed: 1, succeeded: 0, failed: 0, unresolved: 1,
        });
        expect(first.previousUtcDay.writes).toEqual(repeated.previousUtcDay.writes);
        expect(first.currentJobs.resolvedExisting).toBe(1);
        expect(store.getOperationalMonitoring('2026-08-28T12:00:00.000Z').previousUtcDay)
            .toMatchObject({
            writes: { performed: 0, succeeded: 0, failed: 0, unresolved: 0 },
            reconciliations: { passed: 1, blocked: 0, failed: 0 },
        });
        store.close();
    });
});
