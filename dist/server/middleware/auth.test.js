import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiKeyAuth, verifyShopifySessionToken, } from './auth.js';
function request(headers = {}, query = {}) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        headers: normalized,
        query,
        get(name) {
            return normalized[name.toLowerCase()];
        },
    };
}
function response() {
    const json = vi.fn();
    const res = { json };
    const status = vi.fn(() => res);
    Object.assign(res, { status });
    return { res, status, json };
}
function sessionJwt(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: 'https://usedcameragear.myshopify.com/admin',
        dest: 'https://usedcameragear.myshopify.com',
        aud: 'test-shopify-client',
        sub: 'operator-1',
        exp: now + 60,
        nbf: now - 1,
        iat: now - 1,
        jti: 'test-jti',
        sid: 'test-sid',
        ...overrides,
    })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = crypto
        .createHmac('sha256', 'test-shopify-secret')
        .update(unsigned)
        .digest('base64url');
    return `${unsigned}.${signature}`;
}
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
describe('API authentication boundary', () => {
    it('does not trust a forged same-origin Referer or Origin', async () => {
        const verifySession = vi.fn(async () => false);
        const middleware = createApiKeyAuth({
            apiKey: () => 'operator-secret',
            operatorApiKeyEnabled: () => true,
            production: () => true,
            sessionTokenVerifier: verifySession,
            testMode: () => false,
        });
        const { res, status, json } = response();
        const next = vi.fn();
        await middleware(request({
            host: 'ebay-sync-app-production.up.railway.app',
            referer: 'https://ebay-sync-app-production.up.railway.app/',
            origin: 'https://ebay-sync-app-production.up.railway.app',
        }), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(verifySession).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_AUTH_REQUIRED' }));
    });
    it('rejects query-string keys and production X-API-Key access', async () => {
        const middleware = createApiKeyAuth({
            apiKey: () => 'operator-secret',
            operatorApiKeyEnabled: () => true,
            production: () => true,
            sessionTokenVerifier: async () => false,
            testMode: () => false,
        });
        for (const req of [
            request({}, { api_key: 'operator-secret' }),
            request({ 'x-api-key': 'operator-secret' }),
        ]) {
            const { res, status } = response();
            const next = vi.fn();
            await middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(status).toHaveBeenCalledWith(401);
        }
    });
    it('allows an operator key only in explicitly opted-in nonproduction', async () => {
        const middleware = createApiKeyAuth({
            apiKey: () => 'operator-secret',
            operatorApiKeyEnabled: () => true,
            production: () => false,
            sessionTokenVerifier: async () => false,
            testMode: () => false,
        });
        const { res } = response();
        const next = vi.fn();
        await middleware(request({ 'x-api-key': 'operator-secret' }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });
    it('cryptographically verifies the exact Shopify app, store, and token lifetime', async () => {
        vi.stubEnv('SHOPIFY_CLIENT_ID', 'test-shopify-client');
        vi.stubEnv('SHOPIFY_CLIENT_SECRET', 'test-shopify-secret');
        await expect(verifyShopifySessionToken(sessionJwt())).resolves.toBe(true);
        await expect(verifyShopifySessionToken(sessionJwt({ dest: 'https://other-store.myshopify.com' }))).resolves.toBe(false);
        await expect(verifyShopifySessionToken(sessionJwt({ aud: 'other-shopify-client' }))).resolves.toBe(false);
        await expect(verifyShopifySessionToken(sessionJwt({ exp: Math.floor(Date.now() / 1000) - 30 }))).resolves.toBe(false);
    });
    it('never enables TEST_MODE authentication bypass in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('TEST_MODE', 'true');
        vi.stubEnv('API_KEY', 'operator-secret');
        vi.stubEnv('ALLOW_OPERATOR_API_KEY', 'true');
        const { res, status } = response();
        const next = vi.fn();
        await createApiKeyAuth()(request({ 'x-api-key': 'operator-secret' }), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
    });
    it('fails closed when NODE_ENV is unset even if TEST_MODE is requested', async () => {
        vi.stubEnv('NODE_ENV', '');
        vi.stubEnv('TEST_MODE', 'true');
        const { res, status } = response();
        const next = vi.fn();
        await createApiKeyAuth({ sessionTokenVerifier: async () => false })(request(), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
    });
    it('keeps the authentication bypass limited to explicit nonproduction TEST_MODE', async () => {
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('TEST_MODE', 'true');
        const { res } = response();
        const next = vi.fn();
        await createApiKeyAuth()(request(), res, next);
        expect(next).toHaveBeenCalledOnce();
    });
});
