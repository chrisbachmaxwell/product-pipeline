import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import { ListingProposalServiceError } from '../listing-proposal-service.js';
import { LISTING_PROPOSAL_ROUTE_TESTING, createListingProposalRouter, listingProposalJsonErrorHandler, listingProposalJsonParser, } from './listing-proposals.js';
const servers = [];
afterEach(async () => {
    LISTING_PROPOSAL_ROUTE_TESTING.resetRates();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
});
async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}
const digest = `sha256:${'a'.repeat(64)}`;
const generateBody = {
    schemaVersion: 1,
    action: 'generate_local_proposal',
    catalogId: 'row-1',
    expectedRevisionDigest: null,
    base: { sourceDigest: digest, ebayDigest: digest, policyDigest: digest },
};
const approveBody = {
    schemaVersion: 1,
    action: 'approve_local_proposal',
    catalogId: 'row-1',
    proposalId: 'listing-proposal:1',
    proposalDigest: digest,
    expectedEventDigest: digest,
    base: { sourceDigest: digest, ebayDigest: digest, policyDigest: digest },
};
function principal(kind) {
    return kind === 'shopify_session'
        ? { kind, actorId: 'shopify-user:123', subject: '123',
            shopifyStoreDomain: 'usedcameragear.myshopify.com' }
        : { kind, actorId: kind, subject: null, shopifyStoreDomain: null };
}
function harness(kind, service) {
    const app = express();
    app.use((req, _res, next) => {
        req.apiPrincipal = principal(kind);
        next();
    });
    app.use('/api', writerQuarantineMiddleware);
    app.post('/api/listing-proposal', listingProposalJsonParser);
    app.use(listingProposalJsonErrorHandler);
    app.use(createListingProposalRouter(service));
    return app;
}
describe('local AI listing proposal route boundary', () => {
    it('dispatches generation and approval only for an exact Shopify principal', async () => {
        const service = {
            get: vi.fn(),
            generate: vi.fn(async () => ({ schemaVersion: 1 })),
            approve: vi.fn(async () => ({ schemaVersion: 1 })),
        };
        const base = await listen(harness('shopify_session', service));
        const generated = await fetch(`${base}/api/listing-proposal`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(generateBody),
        });
        expect(generated.status).toBe(201);
        expect(service.generate).toHaveBeenCalledWith(expect.objectContaining({ action: 'generate_local_proposal' }), 'shopify-user:123');
        const approved = await fetch(`${base}/api/listing-proposal`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(approveBody),
        });
        expect(approved.status).toBe(201);
        expect(service.approve).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve_local_proposal' }), 'shopify-user:123');
        const blockedService = { get: vi.fn(), generate: vi.fn(), approve: vi.fn() };
        const blockedBase = await listen(harness('operator_api_key', blockedService));
        const blocked = await fetch(`${blockedBase}/api/listing-proposal`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(generateBody),
        });
        expect(blocked.status).toBe(403);
        expect(blockedService.generate).not.toHaveBeenCalled();
    });
    it('passes verified local-review authority to GET without granting it to bypass principals', async () => {
        const verified = { get: vi.fn(async () => ({ schemaVersion: 1 })),
            generate: vi.fn(), approve: vi.fn() };
        const verifiedBase = await listen(harness('shopify_session', verified));
        expect((await fetch(`${verifiedBase}/api/listing-proposal?id=row-1`)).status).toBe(200);
        expect(verified.get).toHaveBeenCalledWith('row-1', true);
        const bypass = { get: vi.fn(async () => ({ schemaVersion: 1 })),
            generate: vi.fn(), approve: vi.fn() };
        const bypassBase = await listen(harness('test_mode', bypass));
        expect((await fetch(`${bypassBase}/api/listing-proposal?id=row-1`)).status).toBe(200);
        expect(bypass.get).toHaveBeenCalledWith('row-1', false);
    });
    it.each([
        '/api/listing-proposal/', '/api/Listing-proposal', '/api/listing-proposal?write=true',
        '/api/listing-proposal%2f', '/api/listing-proposals',
    ])('keeps noncanonical sibling %s quarantined', async (pathname) => {
        const service = { get: vi.fn(), generate: vi.fn(), approve: vi.fn() };
        const base = await listen(harness('shopify_session', service));
        const response = await fetch(`${base}${pathname}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        expect(response.status).toBe(423);
        expect(service.generate).not.toHaveBeenCalled();
        expect(service.approve).not.toHaveBeenCalled();
    });
    it('returns generic CAS errors without raw details', async () => {
        const service = { get: vi.fn(), approve: vi.fn(), generate: vi.fn(async () => {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
            }) };
        const base = await listen(harness('shopify_session', service));
        const response = await fetch(`${base}/api/listing-proposal`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(generateBody),
        });
        expect(response.status).toBe(409);
        const body = await response.text();
        expect(body).toContain('LISTING_PROPOSAL_STALE');
        expect(body).not.toMatch(/stack|sqlite|path|token|secret/i);
    });
    it('bounds and prunes hashed principal buckets', () => {
        for (let index = 0; index < 30; index += 1) {
            expect(LISTING_PROPOSAL_ROUTE_TESTING.allowProposalAttempt('private-subject', 1_000))
                .toBe(true);
        }
        expect(LISTING_PROPOSAL_ROUTE_TESTING.allowProposalAttempt('private-subject', 1_000))
            .toBe(false);
        LISTING_PROPOSAL_ROUTE_TESTING.resetRates();
        for (let index = 0; index < LISTING_PROPOSAL_ROUTE_TESTING.maximumBuckets; index += 1) {
            expect(LISTING_PROPOSAL_ROUTE_TESTING.allowProposalAttempt(`subject-${index}`, 1_000))
                .toBe(true);
        }
        expect(LISTING_PROPOSAL_ROUTE_TESTING.allowProposalAttempt('overflow', 1_000)).toBe(false);
        expect(LISTING_PROPOSAL_ROUTE_TESTING.allowProposalAttempt('overflow', 601_000)).toBe(true);
        expect(LISTING_PROPOSAL_ROUTE_TESTING.rateBucketCount()).toBe(1);
    });
    it('sanitizes malformed and oversized authenticated bodies', async () => {
        const service = { get: vi.fn(), generate: vi.fn(), approve: vi.fn() };
        const base = await listen(harness('shopify_session', service));
        const malformed = await fetch(`${base}/api/listing-proposal`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({
            error: 'Listing proposal request is invalid', code: 'LISTING_PROPOSAL_INVALID',
        });
        const oversized = await fetch(`${base}/api/listing-proposal`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'x'.repeat(70_000) }),
        });
        expect(oversized.status).toBe(413);
        expect(service.generate).not.toHaveBeenCalled();
    });
});
