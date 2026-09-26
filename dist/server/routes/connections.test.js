/** L79: in-app AI connection — live-verified before storage, never echoed. */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import { listingDraftJsonParser, listingDraftJsonErrorHandler } from './listing-drafts.js';
import { createConnectionsRouter } from './connections.js';
const KEY = `sk-ant-${'a'.repeat(40)}`;
const servers = [];
afterEach(() => { for (const server of servers.splice(0))
    server.close(); });
async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', () => resolve()));
    return `http://127.0.0.1:${server.address().port}`;
}
function harness(options) {
    let stored = null;
    const app = express();
    app.use((req, _res, next) => {
        req.apiPrincipal =
            options.kind === 'shopify_session'
                ? { kind: 'shopify_session', actorId: 'shopify-user:1', subject: '1',
                    shopifyStoreDomain: 'usedcameragear.myshopify.com' }
                : { kind: options.kind, actorId: 'x', subject: null, shopifyStoreDomain: null };
        next();
    });
    app.use('/api', writerQuarantineMiddleware);
    app.post('/api/connections/anthropic', listingDraftJsonParser);
    app.use(listingDraftJsonErrorHandler);
    app.use(createConnectionsRouter({
        validate: async () => options.verdict ?? 'valid',
        store: (key) => { stored = key; return true; },
        remove: () => { stored = null; return true; },
        status: () => ({
            connected: options.envManaged === true || stored !== null,
            source: options.envManaged === true ? 'env' : stored !== null ? 'stored' : null,
        }),
    }));
    return { app, getStored: () => stored };
}
async function call(app, method, path, body) {
    const base = await listen(app);
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}
describe('connections route', () => {
    it('verifies live, stores, reports connected — and never echoes the key', async () => {
        const h = harness({ kind: 'shopify_session' });
        const response = await call(h.app, 'POST', '/api/connections/anthropic', { apiKey: KEY });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ anthropic: { connected: true, source: 'stored' } });
        expect(JSON.stringify(response.body)).not.toContain(KEY);
        expect(h.getStored()).toBe(KEY);
    });
    it('rejects a provider-refused key without storing anything', async () => {
        const h = harness({ kind: 'shopify_session', verdict: 'unauthorized' });
        const response = await call(h.app, 'POST', '/api/connections/anthropic', { apiKey: KEY });
        expect(response.status).toBe(422);
        expect(h.getStored()).toBeNull();
    });
    it('rejects malformed keys before any provider call', async () => {
        const h = harness({ kind: 'shopify_session' });
        const response = await call(h.app, 'POST', '/api/connections/anthropic', { apiKey: 'sk-live-notours' });
        expect(response.status).toBe(400);
    });
    it('disconnect removes a stored key but refuses to unmanage an env key', async () => {
        const stored = harness({ kind: 'shopify_session' });
        await call(stored.app, 'POST', '/api/connections/anthropic', { apiKey: KEY });
        const removed = await call(stored.app, 'DELETE', '/api/connections/anthropic');
        expect(removed.status).toBe(200);
        expect(stored.getStored()).toBeNull();
        const env = harness({ kind: 'shopify_session', envManaged: true });
        expect((await call(env.app, 'DELETE', '/api/connections/anthropic')).status).toBe(409);
    });
    it('requires the exact Shopify session on every method', async () => {
        const h = harness({ kind: 'operator_api_key' });
        expect((await call(h.app, 'GET', '/api/connections')).status).toBe(403);
        expect((await call(h.app, 'POST', '/api/connections/anthropic', { apiKey: KEY })).status).toBe(403);
        expect((await call(h.app, 'DELETE', '/api/connections/anthropic')).status).toBe(403);
        expect(h.getStored()).toBeNull();
    });
});
