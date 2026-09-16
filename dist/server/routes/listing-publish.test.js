import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import { listingDraftJsonParser, listingDraftJsonErrorHandler } from './listing-drafts.js';
import { createListingPublishRouter } from './listing-publish.js';
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55484011184419';
const REVISION = `sha256:${'b'.repeat(64)}`;
const MANIFEST = `sha256:${'c'.repeat(64)}`;
const PREFLIGHT = ['dist/listing-lifecycle-admin/index.js', 'preflight-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}'];
const DISPATCH = ['dist/listing-lifecycle-admin/index.js', 'dispatch-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--manifest-digest', '{manifestDigest}', '--migration-store', '/data/x'];
const RECONCILE = ['dist/listing-lifecycle-admin/index.js', 'reconcile', '--action', 'create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--migration-store', '/data/x', '--job-id', '{jobId}', '--attempt-id', '{attemptId}'];
const RECOVER = ['dist/listing-lifecycle-admin/index.js', 'recover-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--job-id', '{jobId}',
    '--attempt-id', '{attemptId}', '--intent-key', '{intentKey}',
    '--evidence-digest', '{evidenceDigest}', '--offer-id', '{offerId}'];
const RECOVER_RECONCILE = ['dist/listing-lifecycle-admin/index.js', 'recover-reconcile',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--job-id', '{jobId}',
    '--attempt-id', '{attemptId}', '--intent-key', '{intentKey}',
    '--evidence-digest', '{evidenceDigest}', '--offer-id', '{offerId}',
    '--recovery-job-id', '{recoveryJobId}', '--recovery-attempt-id', '{recoveryAttemptId}'];
const UNRESOLVED_CREATE = {
    jobId: 'listing-create-job:11111111-1111-1111-1111-111111111111',
    attemptId: 'listing-create-attempt:22222222-2222-2222-2222-222222222222',
    intentKey: `sha256:${'d'.repeat(64)}`,
    evidenceDigest: `sha256:${'e'.repeat(64)}`,
};
const servers = [];
afterEach(() => { for (const server of servers.splice(0))
    server.close(); });
async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', () => resolve()));
    return `http://127.0.0.1:${server.address().port}`;
}
async function post(app, path, body) {
    const base = await listen(app);
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}
function principal(kind) {
    return kind === 'shopify_session'
        ? { kind, actorId: 'shopify-user:123', subject: '123',
            shopifyStoreDomain: 'usedcameragear.myshopify.com' }
        : { kind, actorId: kind, subject: null, shopifyStoreDomain: null };
}
function harness(options) {
    const calls = [];
    const app = express();
    app.use((req, _res, next) => {
        req.apiPrincipal = principal(options.kind);
        next();
    });
    app.use('/api', writerQuarantineMiddleware);
    app.post('/api/listing-publish', listingDraftJsonParser);
    app.post('/api/listing-recovery', listingDraftJsonParser);
    app.use(listingDraftJsonErrorHandler);
    app.use(createListingPublishRouter({
        preflightArgv: options.armed === false ? null : PREFLIGHT,
        dispatchArgv: options.armed === false ? null : DISPATCH,
        reconcileArgv: options.armed === false ? null : RECONCILE,
        recoverArgv: options.armed === false ? null : RECOVER,
        recoverReconcileArgv: options.armed === false ? null : RECOVER_RECONCILE,
        refreshCatalog: async () => undefined,
        lookupUnresolvedCreate: () => options.unresolvedCreate ?? null,
        latestRevisionDigest: () => options.revisionDigest ?? REVISION,
        runStep: async (argv) => {
            calls.push([...argv]);
            if (argv[1] === 'preflight-create')
                return { json: options.preflightJson ?? null };
            if (argv[1] === 'reconcile')
                return { json: options.reconcileJson ?? null };
            if (argv[1] === 'recover-create')
                return { json: options.recoverJson ?? null };
            if (argv[1] === 'recover-reconcile')
                return { json: options.recoverReconcileJson ?? null };
            return { json: options.dispatchJson ?? null };
        },
    }));
    return { app, calls };
}
const validBody = { catalogId: CATALOG_ID, sku: '2882A001-U002', revisionDigest: REVISION };
describe('listing publish route', () => {
    it('publishes: preflight digest flows into dispatch, argv fully substituted', async () => {
        const h = harness({
            kind: 'shopify_session',
            preflightJson: { status: 'preview', manifestDigest: MANIFEST },
            dispatchJson: { status: 'created-and-reconciled', listingId: '147000000001', offerId: '9-1' },
        });
        const response = await post(h.app, '/api/listing-publish', validBody);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'created-and-reconciled', listingId: '147000000001' });
        expect(h.calls).toHaveLength(2);
        expect(h.calls[0]).toContain(CATALOG_ID);
        expect(h.calls[1]).toContain(MANIFEST);
        expect(h.calls[1].join(' ')).not.toContain('{');
    });
    it('refuses without an exact Shopify session — the click IS the approval', async () => {
        for (const kind of ['operator_api_key', 'test_mode']) {
            const h = harness({ kind });
            const response = await post(h.app, '/api/listing-publish', validBody);
            expect(response.status).toBe(403);
            expect(h.calls).toHaveLength(0);
        }
    });
    it('refuses when the operator has not armed the publish argv', async () => {
        const h = harness({ kind: 'shopify_session', armed: false });
        const response = await post(h.app, '/api/listing-publish', validBody);
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('PUBLISH_NOT_ARMED');
    });
    it('rejects identifiers that fail the strict grammars before any spawn', async () => {
        const h = harness({ kind: 'shopify_session' });
        for (const body of [
            { ...validBody, catalogId: 'row-1; rm -rf /' },
            { ...validBody, revisionDigest: 'sha256:short' },
            { ...validBody, sku: 'bad sku with space ' },
            {},
        ]) {
            const response = await post(h.app, '/api/listing-publish', body);
            expect(response.status).toBe(400);
        }
        expect(h.calls).toHaveLength(0);
    });
    it('surfaces a preflight refusal with its ceremony code and never dispatches', async () => {
        const h = harness({
            kind: 'shopify_session',
            preflightJson: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING' },
        });
        const response = await post(h.app, '/api/listing-publish', validBody);
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ code: 'CREATE_REQUIRED_FIELD_MISSING', stage: 'preflight' });
        expect(h.calls).toHaveLength(1);
    });
    it('recovery retry: ledger lookup feeds the chain, offer id comes from reconcile', async () => {
        const h = harness({
            kind: 'shopify_session',
            unresolvedCreate: UNRESOLVED_CREATE,
            reconcileJson: { status: 'unresolved', unresolvedCode: 'CREATE_OFFER_UNPUBLISHED', offerId: '267000000011' },
            recoverJson: {
                status: 'recovery-unresolved',
                recoveryJobId: 'listing-create-recovery-job:33333333-3333-3333-3333-333333333333',
                recoveryAttemptId: 'listing-create-recovery-attempt:44444444-4444-4444-4444-444444444444',
            },
            recoverReconcileJson: { status: 'recovered-and-reconciled' },
        });
        const response = await post(h.app, '/api/listing-recovery', { catalogId: CATALOG_ID, sku: '2882A001-U002' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'removed' });
        expect(h.calls.map((call) => call[1]))
            .toEqual(['reconcile', 'recover-create', 'recover-reconcile']);
        expect(h.calls[1]).toContain('267000000011');
        expect(h.calls[2].join(' ')).not.toContain('{');
    });
    it('recovery retry: nothing unresolved in the ledger is a 404, no ceremony spawns', async () => {
        const h = harness({ kind: 'shopify_session', unresolvedCreate: null });
        const response = await post(h.app, '/api/listing-recovery', { catalogId: CATALOG_ID, sku: '2882A001-U002' });
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('RECOVERY_NOTHING_UNRESOLVED');
        expect(h.calls).toHaveLength(0);
    });
    it('recovery retry: a non-residue reconcile outcome stops the chain before any delete', async () => {
        const h = harness({
            kind: 'shopify_session',
            unresolvedCreate: UNRESOLVED_CREATE,
            reconcileJson: { status: 'reconciled', resolution: 'resolved_existing' },
        });
        const response = await post(h.app, '/api/listing-recovery', { catalogId: CATALOG_ID, sku: '2882A001-U002' });
        expect(response.status).toBe(502);
        expect(response.body).toMatchObject({ status: 'skipped', code: 'RECOVERY_UNRESOLVED' });
        expect(h.calls.map((call) => call[1])).toEqual(['reconcile']);
    });
    it('recovery retry requires the same session bar as publishing', async () => {
        const h = harness({ kind: 'operator_api_key', unresolvedCreate: UNRESOLVED_CREATE });
        const response = await post(h.app, '/api/listing-recovery', { catalogId: CATALOG_ID, sku: '2882A001-U002' });
        expect(response.status).toBe(403);
        expect(h.calls).toHaveLength(0);
    });
    it('other POST /api routes stay quarantined', async () => {
        const h = harness({ kind: 'shopify_session' });
        const response = await post(h.app, '/api/sync/trigger', {});
        expect(response.status).toBe(423);
    });
});
