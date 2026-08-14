import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveListingProposalEvidenceDigest, initializeListingControlStore, openListingControlStore, openListingControlStoreReadOnly, sha256Digest, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import { LISTING_PROPOSAL_AGENT_METADATA } from './listing-proposal-agent.js';
import { LISTING_PROPOSAL_FIELDS, buildListingProposalEvidence, resolveListingProposalOutput, } from './listing-proposal-contract.js';
import { LISTING_PROPOSAL_POLICY_DIGEST, LISTING_PROPOSAL_SERVICE_TESTING, ListingProposalServiceError, createListingProposalService, parseListingProposalRequest, } from './listing-proposal-service.js';
const digest = `sha256:${'a'.repeat(64)}`;
const sourceDigest = `sha256:${'b'.repeat(64)}`;
const ebayDigest = `sha256:${'c'.repeat(64)}`;
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function temporaryStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-proposal-service-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const databasePath = path.join(root, 'listing-control.sqlite');
    initializeListingControlStore({
        databasePath,
        scope: LISTING_DRAFT_SCOPE,
        createdAtUtc: '2026-08-14T17:59:59.000Z',
    }).close();
    return databasePath;
}
function field(shopify, ebay, draft = null, editable = true) {
    return { shopify, ebay, draft, editable };
}
function draftDto() {
    const candidate = {
        schemaVersion: 1,
        mode: 'local_draft_only',
        catalogId: 'shopify-variant:gid://shopify/ProductVariant/55396000563491',
        identity: {
            shopifyProductGid: 'gid://shopify/Product/10310708035875',
            shopifyVariantGid: 'gid://shopify/ProductVariant/55396000563491',
            rawSku: 'CAN3570-U119',
            ebaySellerId: 'usedcameragear',
            ebayMarketplaceId: 'EBAY_US',
            managementModel: 'inventory_api',
            ebayInventorySku: 'CAN3570-U119',
            ebayOfferId: '234942877011',
            ebayListingId: '147502608418',
        },
        base: {
            catalogObservedAtUtc: '2026-08-14T18:00:00.000Z',
            detailObservedAtUtc: '2026-08-14T18:00:01.000Z',
            sourceDigest,
            ebayDigest,
        },
        revision: null,
        sections: {
            listing: {
                title: field('Shopify Canon Lens', 'eBay Canon Lens'),
                category: field(null, '3323'),
                condition: field(null, '3000'),
                conditionDescription: field(null, 'Used and inspected.'),
                price: field('{"amount":"39.95","currency":"USD"}', '{"amount":"39.95","currency":"USD"}', null, false),
                quantity: field('1', '1', null, false),
            },
            content: {
                description: field(null, 'Clean used lens.'),
                images: field(null, '["https://i.ebayimg.com/images/g/a/s-l1600.jpg"]'),
                itemSpecifics: field(null, '{"Brand":["Canon"]}', null, false),
                identifiers: field(null, '{"brand":"Canon"}', null, false),
            },
            delivery: {
                fulfillmentPolicyId: field(null, '111'),
                paymentPolicyId: field(null, '222'),
                returnPolicyId: field(null, '333'),
                merchantLocation: field(null, 'warehouse-1'),
            },
        },
        capabilities: { saveDraft: true, previewChanges: true, apply: false, publish: false },
        externalWritesPerformed: 0,
    };
    const semantic = LISTING_PROPOSAL_SERVICE_TESTING.semanticDigests(candidate);
    return {
        ...candidate,
        base: { ...candidate.base, sourceDigest: semantic.source, ebayDigest: semantic.ebay },
    };
}
function modelOutput() {
    return {
        schemaVersion: 1,
        fields: LISTING_PROPOSAL_FIELDS.map((fieldName) => fieldName === 'title'
            ? { field: fieldName, choice: 'use_shopify',
                reasonCode: 'use_verified_shopify', riskCodes: [] }
            : { field: fieldName, choice: 'keep_ebay',
                reasonCode: 'keep_verified_ebay', riskCodes: [] }),
    };
}
function seedInFlightProposal(databasePath, dto, state) {
    const store = openListingControlStore({
        databasePath,
        expectedScope: LISTING_DRAFT_SCOPE,
    });
    const evidence = LISTING_PROPOSAL_SERVICE_TESTING.semanticEvidence(dto);
    const jobId = `listing-proposal:abandoned-${state}`;
    try {
        store.createProposalJob({
            jobId,
            identity: dto.identity,
            baseRevisionDigest: null,
            baseSourceDigest: dto.base.sourceDigest,
            baseEbayObservationDigest: dto.base.ebayDigest,
            triggerDigest: sha256Digest({ state, type: 'abandoned-test-trigger' }),
            catalogId: dto.catalogId,
            evidence,
            evidenceDigest: deriveListingProposalEvidenceDigest(evidence),
            policyVersion: LISTING_PROPOSAL_AGENT_METADATA.policyVersion,
            policyDigest: LISTING_PROPOSAL_POLICY_DIGEST,
            promptVersion: LISTING_PROPOSAL_AGENT_METADATA.promptVersion,
            promptDigest: LISTING_PROPOSAL_AGENT_METADATA.promptDigest,
            schemaVersion: LISTING_PROPOSAL_AGENT_METADATA.schemaVersion,
            schemaDigest: LISTING_PROPOSAL_AGENT_METADATA.schemaDigest,
            agentVersion: LISTING_PROPOSAL_AGENT_METADATA.agentVersion,
            provider: 'fixture',
            requestedModel: 'gpt-5.6-terra',
            modelDigest: LISTING_PROPOSAL_AGENT_METADATA.modelDigest,
            requestedBy: 'shopify-user:123',
            createdAtUtc: '2026-08-14T18:00:02.000Z',
            eventId: `listing-proposal-event:abandoned-${state}:queued`,
        });
        if (state === 'generating') {
            const queued = store.getProposalJob(jobId);
            if (!queued)
                throw new Error('Seeded proposal job is missing');
            store.markProposalGenerating({
                jobId,
                expectedPreviousEventDigest: queued.latestEvent.eventDigest,
                actor: `ai-agent:${LISTING_PROPOSAL_AGENT_METADATA.agentVersion}`,
                occurredAtUtc: '2026-08-14T18:00:03.000Z',
                eventId: 'listing-proposal-event:abandoned-generating:generating',
            });
        }
    }
    finally {
        store.close();
    }
    return jobId;
}
describe('listing proposal browser contract', () => {
    it('accepts only the exact generate and local-approval requests', () => {
        expect(parseListingProposalRequest({
            schemaVersion: 1,
            action: 'generate_local_proposal',
            catalogId: 'shopify-variant:gid://shopify/ProductVariant/123',
            expectedRevisionDigest: null,
            base: { sourceDigest: digest, ebayDigest: digest, policyDigest: digest },
        })).toEqual(expect.objectContaining({ action: 'generate_local_proposal' }));
        expect(parseListingProposalRequest({
            schemaVersion: 1,
            action: 'approve_local_proposal',
            catalogId: 'shopify-variant:gid://shopify/ProductVariant/123',
            proposalId: 'listing-proposal:123',
            proposalDigest: digest,
            expectedEventDigest: digest,
            base: { sourceDigest: digest, ebayDigest: digest, policyDigest: digest },
        })).toEqual(expect.objectContaining({ action: 'approve_local_proposal' }));
    });
    it.each([
        { action: 'publish', expectedRevisionDigest: null },
        { action: 'generate_local_proposal', expectedRevisionDigest: null, actor: 'admin' },
        { action: 'generate_local_proposal', expectedRevisionDigest: null,
            base: { sourceDigest: digest, ebayDigest: digest, policyDigest: digest, model: 'override' } },
    ])('rejects authority and unknown fields', (extra) => {
        expect(() => parseListingProposalRequest({
            schemaVersion: 1,
            catalogId: 'row-1',
            base: { sourceDigest: digest, ebayDigest: digest, policyDigest: digest },
            ...extra,
        })).toThrowError(new ListingProposalServiceError('LISTING_PROPOSAL_INVALID'));
    });
    it('rejects credential-shaped material before service work', () => {
        expect(() => parseListingProposalRequest({
            schemaVersion: 1,
            action: 'generate_local_proposal',
            catalogId: 'row-1',
            expectedRevisionDigest: null,
            base: { sourceDigest: digest, ebayDigest: digest,
                policyDigest: `api_key=${'x'.repeat(64)}` },
        })).toThrowError(new ListingProposalServiceError('LISTING_PROPOSAL_INVALID'));
    });
    it('automatically prepares a verified-value proposal and atomically records local approval', async () => {
        const databasePath = temporaryStore();
        const dto = draftDto();
        let currentDto = dto;
        const agent = {
            readiness: vi.fn(() => ({ ready: true, code: 'ready',
                model: 'gpt-5.6-terra' })),
            generate: vi.fn(async (current) => ({
                decision: resolveListingProposalOutput(modelOutput(), buildListingProposalEvidence(current), current),
                generator: {
                    provider: 'openai',
                    requestedModel: 'gpt-5.6-terra',
                    responseModel: 'gpt-5.6-terra',
                    store: false,
                    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                    modelOutputDigest: digest,
                },
            })),
        };
        let tick = 0;
        const service = createListingProposalService({
            databasePath: () => databasePath,
            draftService: { get: vi.fn(async () => currentDto), save: vi.fn() },
            agent,
            provider: 'fixture',
            writerInstanceReady: () => true,
            now: () => new Date(`2026-08-14T18:00:0${2 + tick++}.000Z`),
            uuid: (() => { let value = 0; return () => `fixture-${++value}`; })(),
        });
        const empty = await service.get(dto.catalogId, true);
        expect(empty).toMatchObject({ state: 'not_prepared', proposal: null,
            capabilities: { generate: true, apply: false, publish: false },
            aiRequestsPerformed: 0, externalCommerceWritesPerformed: 0 });
        const generated = await service.generate({
            schemaVersion: 1,
            action: 'generate_local_proposal',
            catalogId: dto.catalogId,
            expectedRevisionDigest: null,
            base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest,
                policyDigest: LISTING_PROPOSAL_POLICY_DIGEST },
        }, 'shopify-user:123');
        expect(agent.generate).toHaveBeenCalledTimes(1);
        expect(generated).toMatchObject({
            state: 'ready',
            aiRequestsPerformed: 1,
            externalCommerceWritesPerformed: 0,
            capabilities: { approveLocal: true, apply: false, publish: false },
            proposal: { summary: { changedFieldCount: 1, blockedFieldCount: 0 } },
        });
        expect(generated.proposal?.fields.find(({ key }) => key === 'title')).toMatchObject({
            currentShopify: 'Shopify Canon Lens', currentEbay: 'eBay Canon Lens',
            proposed: 'Shopify Canon Lens', decision: 'change', source: 'shopify',
        });
        expect(generated.proposal?.fields.find(({ key }) => key === 'price')).toMatchObject({
            editable: false, decision: 'observe_only', reasonCode: 'marketplace_connect_owned',
        });
        currentDto = {
            ...dto,
            base: {
                ...dto.base,
                catalogObservedAtUtc: '2026-08-14T18:00:03.000Z',
                detailObservedAtUtc: '2026-08-14T18:00:03.000Z',
            },
        };
        const approved = await service.approve({
            schemaVersion: 1,
            action: 'approve_local_proposal',
            catalogId: dto.catalogId,
            proposalId: generated.proposal.id,
            proposalDigest: generated.proposal.digest,
            expectedEventDigest: generated.eventDigest,
            base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest,
                policyDigest: LISTING_PROPOSAL_POLICY_DIGEST },
        }, 'shopify-user:123');
        expect(approved).toMatchObject({
            state: 'approved_local',
            externalCommerceWritesPerformed: 0,
            capabilities: { apply: false, publish: false },
            proposal: { review: { status: 'approved_local' } },
        });
        const store = openListingControlStoreReadOnly({
            databasePath,
            expectedScope: LISTING_DRAFT_SCOPE,
        });
        try {
            const revision = store.getLatestRevision(dto.identity.shopifyVariantGid);
            expect(revision).toMatchObject({ state: 'reviewed', actor: 'shopify-user:123' });
            expect(revision?.fields.find(({ field }) => field === 'title')).toMatchObject({
                proposedValue: 'Shopify Canon Lens', proposedSource: 'source',
            });
            expect(() => store.verifyIntegrity()).not.toThrow();
            expect(store.verifyAudit()).toMatchObject({ valid: true });
        }
        finally {
            store.close();
        }
    });
    it('rejects stale semantic facts before any AI request', async () => {
        const dto = draftDto();
        const agent = { readiness: vi.fn(() => ({ ready: true, code: 'ready',
                model: 'gpt-5.6-terra' })), generate: vi.fn() };
        const service = createListingProposalService({
            databasePath: () => temporaryStore(),
            draftService: { get: vi.fn(async () => dto), save: vi.fn() },
            agent: agent,
            provider: 'fixture',
            writerInstanceReady: () => true,
        });
        await expect(service.generate({
            schemaVersion: 1,
            action: 'generate_local_proposal',
            catalogId: dto.catalogId,
            expectedRevisionDigest: null,
            base: { sourceDigest: digest, ebayDigest,
                policyDigest: LISTING_PROPOSAL_POLICY_DIGEST },
        }, 'shopify-user:123')).rejects.toMatchObject({ code: 'LISTING_PROPOSAL_STALE' });
        expect(agent.generate).not.toHaveBeenCalled();
    });
    it.each(['queued', 'generating'])('projects an abandoned %s job as failed and durably recovers it before a manual retry', async (state) => {
        const databasePath = temporaryStore();
        const dto = draftDto();
        const abandonedJobId = seedInFlightProposal(databasePath, dto, state);
        const agent = {
            readiness: vi.fn(() => ({ ready: true, code: 'ready',
                model: 'gpt-5.6-terra' })),
            generate: vi.fn(async (current) => ({
                decision: resolveListingProposalOutput(modelOutput(), buildListingProposalEvidence(current), current),
                generator: {
                    provider: 'openai',
                    requestedModel: 'gpt-5.6-terra',
                    responseModel: 'gpt-5.6-terra',
                    store: false,
                    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                    modelOutputDigest: digest,
                },
            })),
        };
        const service = createListingProposalService({
            databasePath: () => databasePath,
            draftService: { get: vi.fn(async () => dto), save: vi.fn() },
            agent,
            provider: 'fixture',
            writerInstanceReady: () => true,
            now: () => new Date('2026-08-14T18:06:00.000Z'),
            uuid: (() => { let value = 0; return () => `recovery-${state}-${++value}`; })(),
        });
        const abandoned = await service.get(dto.catalogId, true);
        expect(abandoned).toMatchObject({ state: 'failed', proposal: null,
            capabilities: { generate: true }, aiRequestsPerformed: 0 });
        let store = openListingControlStoreReadOnly({
            databasePath,
            expectedScope: LISTING_DRAFT_SCOPE,
        });
        try {
            expect(store.getProposalJob(abandonedJobId)).toMatchObject({
                result: null,
                latestEvent: { eventType: state },
            });
        }
        finally {
            store.close();
        }
        const generated = await service.generate({
            schemaVersion: 1,
            action: 'generate_local_proposal',
            catalogId: dto.catalogId,
            expectedRevisionDigest: null,
            base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest,
                policyDigest: LISTING_PROPOSAL_POLICY_DIGEST },
        }, 'shopify-user:123');
        expect(generated).toMatchObject({ state: 'ready', aiRequestsPerformed: 1 });
        expect(agent.generate).toHaveBeenCalledTimes(1);
        store = openListingControlStoreReadOnly({
            databasePath,
            expectedScope: LISTING_DRAFT_SCOPE,
        });
        try {
            expect(store.getProposalJob(abandonedJobId)).toMatchObject({
                result: { outcome: 'failed', failureCode: 'internal_error' },
                latestEvent: { eventType: 'failed' },
            });
            expect(store.getLatestProposalForCatalog(dto.identity.shopifyVariantGid, dto.catalogId)).toMatchObject({
                job: { jobId: generated.proposal?.id },
                result: { outcome: 'ready' },
                latestEvent: { eventType: 'ready' },
            });
            expect(() => store.verifyIntegrity()).not.toThrow();
            expect(store.verifyAudit()).toMatchObject({ valid: true });
        }
        finally {
            store.close();
        }
    });
});
