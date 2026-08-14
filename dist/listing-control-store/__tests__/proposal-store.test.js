import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LISTING_AI_PROPOSABLE_FIELDS, LISTING_FIELD_NAMES, } from '../types.js';
import { LISTING_CONTROL_STORE_CAPABILITIES, ListingControlStoreError, deriveListingBaseDigests, deriveListingProposalEvidenceDigest, deriveListingSemanticDigests, initializeListingControlStore, openListingControlStore, openListingControlStoreReadOnly, sha256Digest, upgradeListingControlStoreV2ToV3, } from '../store.js';
import { LISTING_CONTROL_APPLICATION_ID, LISTING_CONTROL_MIGRATIONS, } from '../schema.js';
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
const scope = {
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'production',
    ebaySellerId: 'usedcameragear',
    ebayMarketplaceId: 'EBAY_US',
};
const identity = {
    shopifyProductGid: 'gid://shopify/Product/1001',
    shopifyVariantGid: 'gid://shopify/ProductVariant/2001',
    rawSku: 'CAN3570-U119',
    ebaySellerId: 'usedcameragear',
    ebayMarketplaceId: 'EBAY_US',
    managementModel: 'inventory_api',
    ebayInventorySku: 'CAN3570-U119',
    ebayOfferId: '234942877011',
    ebayListingId: '147502608418',
};
const editableValues = {
    title: 'Canon 35-70mm Lens',
    category: '3323',
    condition: '3000',
    condition_description: 'Used; inspected and photographed.',
    description: 'Exact inspected used-camera listing description.',
    images: '["https://cdn.example.test/canon.jpg"]',
    fulfillment_policy: 'fulfillment-1',
    payment_policy: 'payment-1',
    return_policy: 'return-1',
    merchant_location: 'pictureline-salt-lake',
};
function temporaryPath() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-store-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    return path.join(root, 'listing-control.sqlite');
}
function revisionFields() {
    return LISTING_FIELD_NAMES.map((field) => {
        const value = editableValues[field] ?? null;
        return {
            field,
            sourceValue: value,
            sourceDigest: sha256Digest({ state: value === null ? 'missing' : 'value', value }),
            defaultValue: null,
            defaultDigest: sha256Digest({ state: 'not_set', value: null }),
            overrideValue: null,
            overrideDigest: sha256Digest({ state: 'not_set', value: null }),
            proposedValue: value,
            proposedDigest: sha256Digest({ state: value === null ? 'omitted' : 'value', value }),
            proposedSource: value === null ? 'omit' : 'source',
            observedValue: null,
            observedDigest: sha256Digest({ state: 'unavailable', value: null }),
        };
    });
}
const observedAt = {
    source: '2026-08-14T15:59:55.000Z',
    ebay: '2026-08-14T15:59:56.000Z',
};
function baseDigests() {
    return deriveListingBaseDigests({
        scope,
        identity,
        baseSourceObservedAtUtc: observedAt.source,
        baseEbayObservedAtUtc: observedAt.ebay,
        fields: revisionFields(),
    });
}
function semanticDigests(fields = revisionFields()) {
    return deriveListingSemanticDigests({ scope, identity, fields });
}
const evidence = [
    {
        source: 'policy',
        field: 'listing',
        valueDigest: sha256Digest('policy-evidence'),
        summary: 'Current approved listing policy.',
    },
    ...LISTING_AI_PROPOSABLE_FIELDS.map((field) => ({
        source: 'shopify',
        field,
        valueDigest: sha256Digest({ state: 'value', value: editableValues[field] }),
        summary: `Verified Shopify ${field} candidate.`,
    })),
];
function job(overrides = {}) {
    const bases = semanticDigests();
    return {
        jobId: 'proposal-job-1',
        identity,
        baseRevisionDigest: null,
        baseSourceDigest: bases.source,
        baseEbayObservationDigest: bases.ebay,
        triggerDigest: sha256Digest('catalog-trigger-1'),
        catalogId: 'catalog-2026-08-14',
        evidence,
        evidenceDigest: deriveListingProposalEvidenceDigest(evidence),
        policyVersion: 'listing-policy-v1',
        policyDigest: sha256Digest('listing-policy-v1-content'),
        promptVersion: 'listing-prompt-v1',
        promptDigest: sha256Digest('listing-prompt-v1-content'),
        schemaVersion: 'listing-proposal-v1',
        schemaDigest: sha256Digest('listing-proposal-v1-schema'),
        agentVersion: 'listing-agent-v1',
        provider: 'fixture',
        requestedModel: 'deterministic-fixture-v1',
        modelDigest: sha256Digest('deterministic-fixture-v1-config'),
        requestedBy: 'operator-chris',
        createdAtUtc: '2026-08-14T16:00:00.000Z',
        eventId: 'proposal-queued-1',
        ...overrides,
    };
}
function decisions() {
    return LISTING_AI_PROPOSABLE_FIELDS.map((field) => {
        const value = editableValues[field];
        return {
            field,
            proposedValue: value,
            proposedDigest: sha256Digest({ state: 'value', value }),
            proposedSource: 'source',
            confidence: 'high',
            reasonCode: 'shopify_authoritative',
            warningCode: null,
            evidence: [{
                    source: 'shopify', field,
                    digest: sha256Digest({ state: 'value', value }),
                }],
        };
    });
}
function approvalRevision() {
    const bases = baseDigests();
    return {
        revisionId: 'approved-revision-1',
        identity,
        baseSourceDigest: bases.source,
        baseSourceObservedAtUtc: observedAt.source,
        baseEbayObservationDigest: bases.ebay,
        baseEbayObservedAtUtc: observedAt.ebay,
        fields: revisionFields(),
        actor: 'operator-chris',
        state: 'reviewed',
        createdAtUtc: '2026-08-14T16:00:03.000Z',
        expectedPreviousRevisionDigest: null,
        expectedLatestBaseSourceDigest: null,
        expectedLatestBaseEbayObservationDigest: null,
        auditEventId: 'approved-revision-created-1',
    };
}
function initialized() {
    const databasePath = temporaryPath();
    const store = initializeListingControlStore({
        databasePath,
        scope,
        createdAtUtc: '2026-08-14T15:59:50.000Z',
    });
    return { databasePath, store };
}
function ready(store) {
    const queued = store.createProposalJob(job());
    const generating = store.markProposalGenerating({
        jobId: queued.job.jobId,
        expectedPreviousEventDigest: store.getProposalJob(queued.job.jobId).latestEvent.eventDigest,
        actor: 'listing-agent-v1',
        occurredAtUtc: '2026-08-14T16:00:01.000Z',
        eventId: 'proposal-generating-1',
    });
    const completed = store.completeProposal({
        jobId: queued.job.jobId,
        resultId: 'proposal-result-1',
        outcome: 'ready',
        expectedPreviousEventDigest: generating.eventDigest,
        parsedOutputDigest: sha256Digest('canonical-parsed-output'),
        fieldDecisions: decisions(),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        failureCode: null,
        actor: 'listing-agent-v1',
        occurredAtUtc: '2026-08-14T16:00:02.000Z',
        eventId: 'proposal-ready-1',
    });
    return { queued, generating, completed };
}
function expectCode(operation, code) {
    try {
        operation();
        throw new Error(`Expected ${code}`);
    }
    catch (error) {
        expect(error).toBeInstanceOf(ListingControlStoreError);
        expect(error.code).toBe(code);
    }
}
describe('listing AI proposal store', () => {
    it('binds fresh T2 observations while CAS approval targets the stored T1 revision base', () => {
        const { store } = initialized();
        const t1Source = '2026-08-14T15:59:51.000Z';
        const t1Ebay = '2026-08-14T15:59:52.000Z';
        const t1Bases = deriveListingBaseDigests({
            scope, identity, baseSourceObservedAtUtc: t1Source,
            baseEbayObservedAtUtc: t1Ebay, fields: revisionFields(),
        });
        const old = store.createRevision({
            ...approvalRevision(),
            revisionId: 't1-revision',
            state: 'draft',
            baseSourceDigest: t1Bases.source,
            baseSourceObservedAtUtc: t1Source,
            baseEbayObservationDigest: t1Bases.ebay,
            baseEbayObservedAtUtc: t1Ebay,
            createdAtUtc: '2026-08-14T15:59:53.000Z',
            auditEventId: 't1-revision-created',
        });
        const queued = store.createProposalJob(job({ baseRevisionDigest: old.revisionDigest }));
        const generating = store.markProposalGenerating({
            jobId: queued.job.jobId,
            expectedPreviousEventDigest: store.getProposalJob(queued.job.jobId).latestEvent.eventDigest,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-1',
        });
        const completed = store.completeProposal({
            jobId: queued.job.jobId, resultId: 'proposal-result-1', outcome: 'ready',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('fresh-t2-output'), fieldDecisions: decisions(),
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'proposal-ready-1',
        });
        const t3Source = '2026-08-14T16:00:02.100Z';
        const t3Ebay = '2026-08-14T16:00:02.200Z';
        const t3Bases = deriveListingBaseDigests({
            scope, identity, baseSourceObservedAtUtc: t3Source,
            baseEbayObservedAtUtc: t3Ebay, fields: revisionFields(),
        });
        const approved = store.approveProposal({
            jobId: queued.job.jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: {
                ...approvalRevision(),
                baseSourceDigest: t3Bases.source,
                baseSourceObservedAtUtc: t3Source,
                baseEbayObservationDigest: t3Bases.ebay,
                baseEbayObservedAtUtc: t3Ebay,
                expectedPreviousRevisionDigest: old.revisionDigest,
                expectedLatestBaseSourceDigest: old.baseSourceDigest,
                expectedLatestBaseEbayObservationDigest: old.baseEbayObservationDigest,
            },
            actor: 'operator-chris', occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-1',
        });
        expect(approved.revision.previousRevisionDigest).toBe(old.revisionDigest);
        expect(approved.revision.baseSourceDigest).toBe(t3Bases.source);
        expect(approved.revision.baseSourceDigest).not.toBe(baseDigests().source);
        expect(approved.revision.baseSourceDigest).not.toBe(old.baseSourceDigest);
        store.close();
    });
    it('rejects approval when a source fact changes between proposal and approval', () => {
        const { store } = initialized();
        const { completed } = ready(store);
        const changedPrice = JSON.stringify({ amount: '99.00', currency: 'USD' });
        const changedFields = revisionFields().map((field) => field.field === 'price' ? {
            ...field,
            sourceValue: changedPrice,
            sourceDigest: sha256Digest({ state: 'value', value: changedPrice }),
        } : field);
        const t3Source = '2026-08-14T16:00:02.100Z';
        const t3Ebay = '2026-08-14T16:00:02.200Z';
        const changedBases = deriveListingBaseDigests({
            scope, identity, baseSourceObservedAtUtc: t3Source,
            baseEbayObservedAtUtc: t3Ebay, fields: changedFields,
        });
        expectCode(() => store.approveProposal({
            jobId: job().jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: {
                ...approvalRevision(),
                baseSourceDigest: changedBases.source,
                baseSourceObservedAtUtc: t3Source,
                baseEbayObservationDigest: changedBases.ebay,
                baseEbayObservedAtUtc: t3Ebay,
                fields: changedFields,
            },
            actor: 'operator-chris', occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-changed-facts',
        }), 'STALE_BASE');
        expect(store.getProposalJob(job().jobId)?.latestEvent.eventType).toBe('ready');
        store.close();
    });
    it('rejects approval when an observed eBay fact changes between proposal and approval', () => {
        const { store } = initialized();
        const { completed } = ready(store);
        const changedObserved = JSON.stringify({ amount: '98.00', currency: 'USD' });
        const changedFields = revisionFields().map((field) => field.field === 'price' ? {
            ...field,
            observedValue: changedObserved,
            observedDigest: sha256Digest({ state: 'value', value: changedObserved }),
        } : field);
        const t3Source = '2026-08-14T16:00:02.100Z';
        const t3Ebay = '2026-08-14T16:00:02.200Z';
        const changedBases = deriveListingBaseDigests({
            scope, identity, baseSourceObservedAtUtc: t3Source,
            baseEbayObservedAtUtc: t3Ebay, fields: changedFields,
        });
        expectCode(() => store.approveProposal({
            jobId: job().jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: {
                ...approvalRevision(),
                baseSourceDigest: changedBases.source,
                baseSourceObservedAtUtc: t3Source,
                baseEbayObservationDigest: changedBases.ebay,
                baseEbayObservedAtUtc: t3Ebay,
                fields: changedFields,
            },
            actor: 'operator-chris', occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-changed-observation',
        }), 'STALE_BASE');
        expect(store.getProposalJob(job().jobId)?.latestEvent.eventType).toBe('ready');
        store.close();
    });
    it('fails approval when another local revision consumes the T1 revision base', () => {
        const { store } = initialized();
        const old = store.createRevision({
            ...approvalRevision(), revisionId: 'old-revision', state: 'draft',
            createdAtUtc: '2026-08-14T15:59:57.000Z', auditEventId: 'old-revision-created',
        });
        const queued = store.createProposalJob(job({ baseRevisionDigest: old.revisionDigest }));
        const generating = store.markProposalGenerating({
            jobId: queued.job.jobId,
            expectedPreviousEventDigest: store.getProposalJob(queued.job.jobId).latestEvent.eventDigest,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-1',
        });
        const completed = store.completeProposal({
            jobId: queued.job.jobId, resultId: 'proposal-result-1', outcome: 'ready',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('race-output'), fieldDecisions: decisions(),
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'proposal-ready-1',
        });
        store.createRevision({
            ...approvalRevision(), revisionId: 'competing-revision', state: 'draft',
            createdAtUtc: '2026-08-14T16:00:02.500Z', auditEventId: 'competing-created',
            expectedPreviousRevisionDigest: old.revisionDigest,
            expectedLatestBaseSourceDigest: old.baseSourceDigest,
            expectedLatestBaseEbayObservationDigest: old.baseEbayObservationDigest,
        });
        expectCode(() => store.approveProposal({
            jobId: queued.job.jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: {
                ...approvalRevision(), expectedPreviousRevisionDigest: old.revisionDigest,
                expectedLatestBaseSourceDigest: old.baseSourceDigest,
                expectedLatestBaseEbayObservationDigest: old.baseEbayObservationDigest,
            },
            actor: 'operator-chris', occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-1',
        }), 'STALE_BASE');
        expect(store.getProposalJob(queued.job.jobId)?.latestEvent.eventType).toBe('ready');
        store.close();
    });
    it('runs first proposal through atomic local approval without provider capability', () => {
        const { store } = initialized();
        const { completed } = ready(store);
        expect(store.getLatestRevision(identity.shopifyVariantGid)).toBeNull();
        const approved = store.approveProposal({
            jobId: job().jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: approvalRevision(),
            actor: 'operator-chris',
            occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-1',
        });
        expect(approved.revision.state).toBe('reviewed');
        expect(store.getProposalJob(job().jobId)?.latestEvent).toMatchObject({
            eventType: 'approved', reviewedRevisionDigest: approved.revision.revisionDigest,
        });
        expect(store.getLatestProposal(identity.shopifyVariantGid)?.result?.usage)
            .toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        expect(store.getLatestProposalForCatalog(identity.shopifyVariantGid, 'catalog-2026-08-14')?.job.jobId).toBe(job().jobId);
        expect(store.getLatestProposalForCatalog(identity.shopifyVariantGid, 'catalog-not-present')).toBeNull();
        expect(store.countProposalJobsForSubjectSince(identity.shopifyVariantGid, '2026-08-14T15:00:00.000Z')).toBe(1);
        expect(store.countProposalJobsForScopeSince('2026-08-14T15:00:00.000Z')).toBe(1);
        expect(store.capabilities).toEqual(expect.objectContaining({
            ...LISTING_CONTROL_STORE_CAPABILITIES,
            providerWriteSupported: false,
            publishAuthorizationSupported: false,
            localContentApprovalSupported: true,
        }));
        expect(store.verifyAudit()).toMatchObject({ valid: true, recordCount: 6 });
        expect(() => store.verifyIntegrity()).not.toThrow();
        store.close();
    });
    it('never approves a needs_human result even with a syntactically valid revision', () => {
        const { databasePath, store } = initialized();
        const queued = store.createProposalJob(job());
        const generating = store.markProposalGenerating({
            jobId: queued.job.jobId,
            expectedPreviousEventDigest: store.getProposalJob(queued.job.jobId).latestEvent.eventDigest,
            actor: 'listing-agent-v1',
            occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-1',
        });
        const completed = store.completeProposal({
            jobId: queued.job.jobId,
            resultId: 'proposal-needs-human-result',
            outcome: 'needs_human',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('canonical-needs-human-output'),
            fieldDecisions: decisions().map((decision, index) => index === 0
                ? { ...decision, confidence: 'low', warningCode: 'policy_exception' }
                : decision),
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            failureCode: null,
            actor: 'listing-agent-v1',
            occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'proposal-needs-human-1',
        });
        expectCode(() => store.approveProposal({
            jobId: queued.job.jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: approvalRevision(),
            actor: 'operator-chris',
            occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-illegal-approval-1',
        }), 'STALE_BASE');
        expect(store.getLatestRevision(identity.shopifyVariantGid)).toBeNull();
        expect(store.getProposalJob(queued.job.jobId)?.latestEvent.eventType).toBe('needs_human');
        expect(() => store.verifyIntegrity()).not.toThrow();
        store.close();
        const raw = new Database(databasePath);
        const persisted = raw.prepare(`SELECT job.scope_key, job.subject_key, event.event_digest
       FROM listing_proposal_jobs job
       JOIN listing_proposal_events event ON event.job_id = job.job_id
       WHERE job.job_id = ? ORDER BY event.sequence DESC LIMIT 1`).get(queued.job.jobId);
        const approvalBindingTrigger = raw.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'trigger'
       AND name = 'listing_proposal_events_approved_revision'`).get();
        raw.exec('DROP TRIGGER listing_proposal_events_approved_revision');
        expect(() => raw.prepare(`INSERT INTO listing_proposal_events (
        event_id, job_id, sequence, scope_key, subject_key, event_type, event_digest,
        previous_event_digest, actor, occurred_at_utc, occurred_epoch_ms, result_digest,
        reviewed_revision_digest, review_reason_code, payload_digest
      ) VALUES (?, ?, 4, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`).run('direct-illegal-approval', queued.job.jobId, persisted.scope_key, persisted.subject_key, sha256Digest('direct-illegal-approval-event'), persisted.event_digest, 'operator-chris', '2026-08-14T16:00:03.000Z', Date.parse('2026-08-14T16:00:03.000Z'), completed.result.resultDigest, sha256Digest('nonexistent-reviewed-revision'), sha256Digest('direct-illegal-approval-payload'))).toThrow(/proposal event chain mismatch/);
        raw.exec(approvalBindingTrigger.sql);
        raw.close();
        const reopened = openListingControlStoreReadOnly({ databasePath, expectedScope: scope });
        expect(reopened.getProposalJob(queued.job.jobId)?.latestEvent.eventType).toBe('needs_human');
        reopened.close();
    });
    it('rejects a ready event with a low-confidence decision at the SQL boundary', () => {
        const { databasePath, store } = initialized();
        const queued = store.createProposalJob(job());
        store.markProposalGenerating({
            jobId: queued.job.jobId,
            expectedPreviousEventDigest: store.getProposalJob(queued.job.jobId).latestEvent.eventDigest,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-1',
        });
        store.close();
        const raw = new Database(databasePath);
        const persisted = raw.prepare(`SELECT job.scope_key, job.subject_key, event.event_digest
       FROM listing_proposal_jobs job
       JOIN listing_proposal_events event ON event.job_id = job.job_id
       WHERE job.job_id = ? ORDER BY event.sequence DESC LIMIT 1`).get(queued.job.jobId);
        const resultDigest = sha256Digest('direct-ready-low-result');
        raw.exec('BEGIN IMMEDIATE');
        raw.prepare(`INSERT INTO listing_proposal_results (
        result_id, result_digest, job_id, scope_key, subject_key, outcome,
        parsed_output_digest, failure_code, input_tokens, output_tokens, total_tokens,
        actor, completed_at_utc, completed_epoch_ms
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?, NULL, 1, 1, 2, ?, ?, ?)`).run('direct-ready-low-result', resultDigest, queued.job.jobId, persisted.scope_key, persisted.subject_key, sha256Digest('direct-ready-low-output'), 'listing-agent-v1', '2026-08-14T16:00:02.000Z', Date.parse('2026-08-14T16:00:02.000Z'));
        raw.prepare(`INSERT INTO listing_proposal_field_decisions (
        result_id, scope_key, subject_key, field_name, proposed_value, proposed_digest,
        proposed_source, confidence, reason_code, warning_code, evidence_json, evidence_digest
      ) VALUES (?, ?, ?, 'title', 'unsafe', ?, 'source', 'low',
        'conflicting_sources', 'low_confidence', '[]', ?)`).run('direct-ready-low-result', persisted.scope_key, persisted.subject_key, sha256Digest('unsafe'), sha256Digest('empty-evidence'));
        expect(() => raw.prepare(`INSERT INTO listing_proposal_events (
        event_id, job_id, sequence, scope_key, subject_key, event_type, event_digest,
        previous_event_digest, actor, occurred_at_utc, occurred_epoch_ms, result_digest,
        reviewed_revision_digest, review_reason_code, payload_digest
      ) VALUES (?, ?, 3, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`).run('direct-ready-low-event', queued.job.jobId, persisted.scope_key, persisted.subject_key, sha256Digest('direct-ready-low-event'), persisted.event_digest, 'listing-agent-v1', '2026-08-14T16:00:02.000Z', Date.parse('2026-08-14T16:00:02.000Z'), resultDigest, resultDigest)).toThrow(/proposal confidence outcome mismatch/);
        raw.exec('ROLLBACK');
        raw.close();
        const reopened = openListingControlStoreReadOnly({ databasePath, expectedScope: scope });
        expect(reopened.getProposalJob(queued.job.jobId)?.latestEvent.eventType).toBe('generating');
        reopened.close();
    });
    it('deduplicates an exact trigger and rejects transition replay and stale review CAS', () => {
        const { store } = initialized();
        const first = store.createProposalJob(job());
        const duplicate = store.createProposalJob(job({
            jobId: 'ignored-deduplicated-job',
            eventId: 'ignored-deduplicated-event',
            requestedBy: 'another-operator',
            createdAtUtc: '2026-08-14T16:00:00.500Z',
        }));
        expect(duplicate).toEqual({ job: first.job, deduplicated: true });
        const queuedEvent = store.getProposalJob(first.job.jobId).latestEvent;
        const generating = store.markProposalGenerating({
            jobId: first.job.jobId,
            expectedPreviousEventDigest: queuedEvent.eventDigest,
            actor: 'listing-agent-v1',
            occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-1',
        });
        expectCode(() => store.markProposalGenerating({
            jobId: first.job.jobId,
            expectedPreviousEventDigest: queuedEvent.eventDigest,
            actor: 'listing-agent-v1',
            occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-replay',
        }), 'STALE_BASE');
        expect(generating.eventType).toBe('generating');
        store.close();
    });
    it('allows exactly one independent writer to approve the latest result', () => {
        const { databasePath, store: firstWriter } = initialized();
        const { completed } = ready(firstWriter);
        const secondWriter = openListingControlStore({ databasePath, expectedScope: scope });
        const approved = firstWriter.approveProposal({
            jobId: job().jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: approvalRevision(),
            actor: 'operator-chris',
            occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-1',
        });
        expect(approved.event.eventType).toBe('approved');
        expectCode(() => secondWriter.approveProposal({
            jobId: job().jobId,
            resultDigest: completed.result.resultDigest,
            expectedPreviousEventDigest: completed.event.eventDigest,
            revision: { ...approvalRevision(), revisionId: 'racing-revision',
                auditEventId: 'racing-revision-created' },
            actor: 'operator-two',
            occurredAtUtc: '2026-08-14T16:00:03.000Z',
            eventId: 'proposal-approved-racing',
        }), 'STALE_BASE');
        secondWriter.close();
        firstWriter.close();
    });
    it('rejects protected-field model decisions, credential material, and bad usage', () => {
        const { databasePath, store } = initialized();
        const queued = store.createProposalJob(job());
        const generating = store.markProposalGenerating({
            jobId: queued.job.jobId,
            expectedPreviousEventDigest: store.getProposalJob(queued.job.jobId).latestEvent.eventDigest,
            actor: 'listing-agent-v1',
            occurredAtUtc: '2026-08-14T16:00:01.000Z',
            eventId: 'proposal-generating-1',
        });
        const protectedField = [...decisions(), {
                ...decisions()[0], field: 'price',
            }];
        expectCode(() => store.completeProposal({
            jobId: queued.job.jobId, resultId: 'bad-result', outcome: 'ready',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('bad'), fieldDecisions: protectedField,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'bad-ready-event',
        }), 'INVALID_INPUT');
        const inventedOverride = decisions().map((decision, index) => index === 0 ? {
            ...decision, proposedSource: 'override',
        } : decision);
        expectCode(() => store.completeProposal({
            jobId: queued.job.jobId, resultId: 'invented-override', outcome: 'ready',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('invented-override'),
            fieldDecisions: inventedOverride,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'invented-override-event',
        }), 'INVALID_INPUT');
        const lowConfidence = decisions().map((decision, index) => index === 0
            ? { ...decision, confidence: 'low', warningCode: 'low_confidence' }
            : decision);
        expectCode(() => store.completeProposal({
            jobId: queued.job.jobId, resultId: 'ready-with-low', outcome: 'ready',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('ready-with-low'), fieldDecisions: lowConfidence,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'ready-with-low-event',
        }), 'INVALID_INPUT');
        expectCode(() => store.completeProposal({
            jobId: queued.job.jobId, resultId: 'needs-human-without-low', outcome: 'needs_human',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('needs-human-without-low'), fieldDecisions: decisions(),
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'needs-human-without-low-event',
        }), 'INVALID_INPUT');
        expectCode(() => store.createProposalJob(job({
            jobId: 'credential-job',
            triggerDigest: sha256Digest('credential-trigger'),
            requestedModel: 'access_token=sk-live-PROHIBITED-MATERIAL',
            eventId: 'credential-event',
        })), 'INVALID_INPUT');
        expectCode(() => store.completeProposal({
            jobId: queued.job.jobId, resultId: 'bad-usage', outcome: 'ready',
            expectedPreviousEventDigest: generating.eventDigest,
            parsedOutputDigest: sha256Digest('bad-usage'), fieldDecisions: decisions(),
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 99 }, failureCode: null,
            actor: 'listing-agent-v1', occurredAtUtc: '2026-08-14T16:00:02.000Z',
            eventId: 'bad-usage-event',
        }), 'INVALID_INPUT');
        store.close();
        expect(fs.readFileSync(databasePath).includes(Buffer.from('sk-live-PROHIBITED', 'utf8')))
            .toBe(false);
    });
    it('detects proposal tampering after append-only triggers are restored', () => {
        const { databasePath, store } = initialized();
        ready(store);
        store.close();
        const raw = new Database(databasePath);
        expect(() => raw.prepare("UPDATE listing_proposal_results SET actor = 'tampered' WHERE result_id = 'proposal-result-1'").run()).toThrow(/append-only/);
        const trigger = raw.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'listing_proposal_results_deny_update'").get();
        raw.exec('DROP TRIGGER listing_proposal_results_deny_update');
        raw.prepare("UPDATE listing_proposal_results SET actor = 'tampered' WHERE result_id = 'proposal-result-1'").run();
        raw.exec(trigger.sql);
        raw.close();
        expectCode(() => openListingControlStoreReadOnly({ databasePath, expectedScope: scope }), 'SCHEMA_MISMATCH');
    });
});
function canonicalV2() {
    const sourcePath = temporaryPath();
    const source = initializeListingControlStore({
        databasePath: sourcePath, scope, createdAtUtc: '2026-08-14T15:59:50.000Z',
    });
    const draft = approvalRevision();
    const revision = source.createRevision({
        ...draft, state: 'draft', revisionId: 'legacy-v2-revision',
        auditEventId: 'legacy-v2-revision-created',
    });
    const auditHead = source.verifyAudit().headHash;
    source.close();
    const databasePath = temporaryPath();
    const database = new Database(databasePath);
    try {
        fs.chmodSync(databasePath, 0o600);
        database.pragma('foreign_keys = ON');
        database.pragma('recursive_triggers = ON');
        for (const migration of LISTING_CONTROL_MIGRATIONS.slice(0, 2)) {
            database.exec(migration.sql);
            database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)').run(migration.version, migration.name, migration.checksum, '2026-08-14T15:59:50.000Z');
            database.pragma(`user_version = ${migration.version}`);
        }
        database.pragma(`application_id = ${LISTING_CONTROL_APPLICATION_ID}`);
        database.exec(`ATTACH DATABASE ${JSON.stringify(sourcePath)} AS source`);
        for (const table of ['control_scope', 'listing_subjects', 'listing_revisions',
            'ebay_artifact_bindings', 'shopify_sku_bindings', 'listing_revision_fields']) {
            database.exec(`INSERT INTO ${table} SELECT * FROM source.${table}`);
        }
        database.exec(`INSERT INTO audit_events (
      sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
      subject_key, revision_digest, payload_digest, previous_hash, event_hash
    ) SELECT sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
      subject_key, revision_digest, payload_digest, previous_hash, event_hash
      FROM source.audit_events`);
        database.exec('DETACH DATABASE source');
    }
    finally {
        database.close();
    }
    return { databasePath, auditHead, revisionDigest: revision.revisionDigest };
}
describe('listing proposal V3 migration', () => {
    it('explicitly preserves canonical V2 revisions and audit bytes semantically', () => {
        const before = canonicalV2();
        expect(() => openListingControlStore({ databasePath: before.databasePath,
            expectedScope: scope })).toThrow();
        const upgraded = upgradeListingControlStoreV2ToV3({
            databasePath: before.databasePath,
            expectedScope: scope,
            appliedAtUtc: '2026-08-14T16:10:00.000Z',
        });
        expect(upgraded.getRevision('legacy-v2-revision')?.revisionDigest).toBe(before.revisionDigest);
        expect(upgraded.verifyAudit()).toMatchObject({
            valid: true, recordCount: 2, headHash: before.auditHead,
        });
        upgraded.close();
    });
    it('fails atomically on a noncanonical V2 checksum and changes no bytes', () => {
        const before = canonicalV2();
        const raw = new Database(before.databasePath);
        raw.exec('DROP TRIGGER schema_migrations_deny_update');
        raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
            .run(`sha256:${'0'.repeat(64)}`);
        raw.close();
        const rejected = fs.readFileSync(before.databasePath);
        expect(() => upgradeListingControlStoreV2ToV3({
            databasePath: before.databasePath,
            expectedScope: scope,
            appliedAtUtc: '2026-08-14T16:10:00.000Z',
        })).toThrow();
        expect(fs.readFileSync(before.databasePath)).toEqual(rejected);
        const check = new Database(before.databasePath, { readonly: true });
        expect(check.pragma('user_version', { simple: true })).toBe(2);
        check.close();
    });
});
