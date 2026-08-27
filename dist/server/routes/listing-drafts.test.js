import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import { ListingDraftServiceError } from '../listing-draft-service.js';
import { LISTING_DRAFT_ROUTE_TESTING, createListingDraftRouter, listingDraftJsonErrorHandler, listingDraftJsonParser, } from './listing-drafts.js';
const servers = [];
afterEach(async () => {
    LISTING_DRAFT_ROUTE_TESTING.resetWriteRates();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
});
async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', () => resolve()));
    return `http://127.0.0.1:${server.address().port}`;
}
const digest = `sha256:${'a'.repeat(64)}`;
const requestBody = {
    schemaVersion: 1, action: 'save_local_draft', catalogId: 'row-1',
    expectedRevisionDigest: null, base: { sourceDigest: digest, ebayDigest: digest },
    draft: { title: 'New title', category: null, condition: null, conditionDescription: null,
        description: null, images: null, itemSpecifics: null,
        fulfillmentPolicyId: null, paymentPolicyId: null,
        returnPolicyId: null, merchantLocation: null },
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
    app.post('/api/listing-draft', listingDraftJsonParser);
    app.use(listingDraftJsonErrorHandler);
    app.use(createListingDraftRouter(service));
    return app;
}
describe('local listing draft route boundary', () => {
    it('allows only an exact verified Shopify session principal and derives actor server-side', async () => {
        const service = { get: vi.fn(), save: vi.fn(async () => ({ schemaVersion: 1 })) };
        const base = await listen(harness('shopify_session', service));
        const response = await fetch(`${base}/api/listing-draft`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        expect(response.status).toBe(201);
        expect(service.save).toHaveBeenCalledWith(expect.objectContaining({ catalogId: 'row-1' }), 'shopify-user:123');
        const blockedService = { get: vi.fn(), save: vi.fn() };
        const blockedBase = await listen(harness('operator_api_key', blockedService));
        const blocked = await fetch(`${blockedBase}/api/listing-draft`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        expect(blocked.status).toBe(403);
        expect(blockedService.save).not.toHaveBeenCalled();
    });
    it.each([
        '/api/listing-draft/', '/api/Listing-draft', '/api/listing-draft?write=true',
        '/api/listing-draft%2f', '/api/listing-drafts',
    ])('keeps noncanonical sibling %s quarantined', async (pathname) => {
        const service = { get: vi.fn(), save: vi.fn() };
        const base = await listen(harness('shopify_session', service));
        const response = await fetch(`${base}${pathname}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        expect(response.status).toBe(423);
        expect(service.save).not.toHaveBeenCalled();
    });
    it('returns fixed generic stale/unavailable errors without raw details', async () => {
        const service = { get: vi.fn(), save: vi.fn(async () => {
                throw new ListingDraftServiceError('LISTING_DRAFT_STALE');
            }) };
        const base = await listen(harness('shopify_session', service));
        const response = await fetch(`${base}/api/listing-draft`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        expect(response.status).toBe(409);
        const body = await response.text();
        expect(body).toContain('LISTING_DRAFT_STALE');
        expect(body).not.toMatch(/stack|sqlite|path|token/i);
    });
    it('bounds attempted writes by hashed principal without retaining the raw subject key', () => {
        for (let index = 0; index < 20; index += 1) {
            expect(LISTING_DRAFT_ROUTE_TESTING.allowDraftAttempt('private-subject', 1_000)).toBe(true);
        }
        expect(LISTING_DRAFT_ROUTE_TESTING.allowDraftAttempt('private-subject', 1_000)).toBe(false);
        expect(LISTING_DRAFT_ROUTE_TESTING.allowDraftAttempt('another-subject', 1_000)).toBe(true);
    });
    it('bounds distinct draft-subject buckets and prunes them after the window', () => {
        LISTING_DRAFT_ROUTE_TESTING.resetWriteRates();
        for (let index = 0; index < LISTING_DRAFT_ROUTE_TESTING.maximumBuckets; index += 1) {
            expect(LISTING_DRAFT_ROUTE_TESTING.allowDraftAttempt(`subject-${index}`, 1_000)).toBe(true);
        }
        expect(LISTING_DRAFT_ROUTE_TESTING.rateBucketCount())
            .toBe(LISTING_DRAFT_ROUTE_TESTING.maximumBuckets);
        expect(LISTING_DRAFT_ROUTE_TESTING.allowDraftAttempt('overflow', 1_000)).toBe(false);
        expect(LISTING_DRAFT_ROUTE_TESTING.allowDraftAttempt('overflow', 601_000)).toBe(true);
        expect(LISTING_DRAFT_ROUTE_TESTING.rateBucketCount()).toBe(1);
    });
    it('authenticates before parsing and sanitizes authenticated parser failures', async () => {
        const service = { get: vi.fn(), save: vi.fn() };
        const app = express();
        app.use('/api', (req, res, next) => {
            if (req.get('Authorization') !== 'Bearer verified') {
                res.status(401).json({ error: 'Unauthorized', code: 'API_AUTH_REQUIRED' });
                return;
            }
            req.apiPrincipal = principal('shopify_session');
            next();
        });
        app.use('/api', writerQuarantineMiddleware);
        app.post('/api/listing-draft', listingDraftJsonParser);
        app.use(listingDraftJsonErrorHandler);
        app.use(createListingDraftRouter(service));
        const base = await listen(app);
        const unauthenticated = await fetch(`${base}/api/listing-draft`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
        });
        expect(unauthenticated.status).toBe(401);
        const malformed = await fetch(`${base}/api/listing-draft`, {
            method: 'POST', headers: { authorization: 'Bearer verified',
                'content-type': 'application/json' }, body: '{broken',
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({ error: 'Local listing draft request is invalid',
            code: 'LISTING_DRAFT_INVALID' });
        const oversized = await fetch(`${base}/api/listing-draft`, {
            method: 'POST', headers: { authorization: 'Bearer verified',
                'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(70_000) }),
        });
        expect(oversized.status).toBe(413);
        expect(service.save).not.toHaveBeenCalled();
    });
});
