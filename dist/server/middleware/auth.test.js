import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_RATE_LIMIT_TESTING, createApiKeyAuth, verifyShopifySessionToken, } from './auth.js';
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
const verifiedPrincipal = {
    kind: 'shopify_session',
    actorId: 'shopify-user:operator-1',
    subject: 'operator-1',
    shopifyStoreDomain: 'usedcameragear.myshopify.com',
};
function sessionJwt(overrides = {}, secret = 'test-shopify-secret') {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: 'https://usedcameragear.myshopify.com/admin',
        dest: 'https://usedcameragear.myshopify.com',
        aud: '2db0555e4848a8264383dc0edfcfb8fe',
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
        .createHmac('sha256', secret)
        .update(unsigned)
        .digest('base64url');
    return `${unsigned}.${signature}`;
}
afterEach(() => {
    API_RATE_LIMIT_TESTING.reset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
describe('API authentication boundary', () => {
    it('does not trust a forged same-origin Referer or Origin', async () => {
        const verifySession = vi.fn(async () => null);
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
            sessionTokenVerifier: async () => null,
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
            sessionTokenVerifier: async () => null,
            testMode: () => false,
        });
        const { res } = response();
        const next = vi.fn();
        await middleware(request({ 'x-api-key': 'operator-secret' }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });
    it('cryptographically verifies the exact Shopify app, store, and token lifetime', async () => {
        vi.stubEnv('SHOPIFY_CLIENT_ID', '2db0555e4848a8264383dc0edfcfb8fe');
        vi.stubEnv('SHOPIFY_CLIENT_SECRET', 'test-shopify-secret');
        await expect(verifyShopifySessionToken(sessionJwt())).resolves.toEqual(verifiedPrincipal);
        await expect(verifyShopifySessionToken(sessionJwt({ dest: 'https://other-store.myshopify.com' }))).resolves.toBeNull();
        await expect(verifyShopifySessionToken(sessionJwt({ aud: 'other-shopify-client' }))).resolves.toBeNull();
        await expect(verifyShopifySessionToken(sessionJwt({ exp: Math.floor(Date.now() / 1000) - 30 }))).resolves.toBeNull();
        await expect(verifyShopifySessionToken(sessionJwt({ sub: '' }))).resolves.toBeNull();
    });
    it('accepts current and time-bounded previous signatures during rotation', async () => {
        vi.stubEnv('SHOPIFY_CLIENT_ID', '2db0555e4848a8264383dc0edfcfb8fe');
        vi.stubEnv('SHOPIFY_CLIENT_SECRET', 'new-test-shopify-secret');
        vi.stubEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET', 'old-test-shopify-secret');
        vi.stubEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC', new Date(Date.now() + 30 * 60 * 1_000).toISOString());
        await expect(verifyShopifySessionToken(sessionJwt({}, 'new-test-shopify-secret')))
            .resolves.toEqual(verifiedPrincipal);
        await expect(verifyShopifySessionToken(sessionJwt({}, 'old-test-shopify-secret')))
            .resolves.toEqual(verifiedPrincipal);
    });
    it.each([
        { previous: 'new-test-shopify-secret', expiryOffset: 30 * 60 * 1_000 },
        { previous: 'old-test-shopify-secret', expiryOffset: 65 * 60 * 1_000 },
        { previous: 'unsafe previous secret', expiryOffset: 30 * 60 * 1_000 },
    ])('fails closed on unsafe previous-secret configuration %#', async ({ previous, expiryOffset }) => {
        vi.stubEnv('SHOPIFY_CLIENT_ID', '2db0555e4848a8264383dc0edfcfb8fe');
        vi.stubEnv('SHOPIFY_CLIENT_SECRET', 'new-test-shopify-secret');
        vi.stubEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET', previous);
        vi.stubEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC', new Date(Date.now() + expiryOffset).toISOString());
        await expect(verifyShopifySessionToken(sessionJwt({}, 'new-test-shopify-secret')))
            .resolves.toBeNull();
    });
    it('stops accepting the previous JWT at cutoff without disrupting the primary', async () => {
        vi.stubEnv('SHOPIFY_CLIENT_ID', '2db0555e4848a8264383dc0edfcfb8fe');
        vi.stubEnv('SHOPIFY_CLIENT_SECRET', 'new-test-shopify-secret');
        vi.stubEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET', 'old-test-shopify-secret');
        vi.stubEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC', new Date().toISOString());
        await expect(verifyShopifySessionToken(sessionJwt({}, 'new-test-shopify-secret')))
            .resolves.toEqual(verifiedPrincipal);
        await expect(verifyShopifySessionToken(sessionJwt({}, 'old-test-shopify-secret')))
            .resolves.toBeNull();
    });
    it('rejects noncanonical segments and malformed numeric lifetime claims', async () => {
        vi.stubEnv('SHOPIFY_CLIENT_ID', '2db0555e4848a8264383dc0edfcfb8fe');
        vi.stubEnv('SHOPIFY_CLIENT_SECRET', 'test-shopify-secret');
        const canonical = sessionJwt();
        const [header, payload, signature] = canonical.split('.');
        await expect(verifyShopifySessionToken(`${header}.${payload}.${signature}=`))
            .resolves.toBeNull();
        await expect(verifyShopifySessionToken(sessionJwt({ nbf: 'not-numeric' })))
            .resolves.toBeNull();
        const now = Math.floor(Date.now() / 1_000);
        await expect(verifyShopifySessionToken(sessionJwt({ iat: now - 600, exp: now + 60 })))
            .resolves.toBeNull();
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
        await createApiKeyAuth({ sessionTokenVerifier: async () => null })(request(), res, next);
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
    it('attaches only the verified Shopify session principal', async () => {
        const req = request({ authorization: 'Bearer signed-session' });
        const { res } = response();
        const next = vi.fn();
        await createApiKeyAuth({
            production: () => true,
            testMode: () => false,
            sessionTokenVerifier: async () => verifiedPrincipal,
        })(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(req.apiPrincipal).toEqual(verifiedPrincipal);
    });
    it('bounds and deterministically prunes global IP rate buckets', () => {
        for (let index = 0; index < API_RATE_LIMIT_TESTING.maximumBuckets; index += 1) {
            expect(API_RATE_LIMIT_TESTING.touch(`198.51.100.${index}`, 1_000)).toBe(true);
        }
        expect(API_RATE_LIMIT_TESTING.size()).toBe(API_RATE_LIMIT_TESTING.maximumBuckets);
        expect(API_RATE_LIMIT_TESTING.touch('203.0.113.1', 1_000)).toBe(false);
        expect(API_RATE_LIMIT_TESTING.touch('203.0.113.1', 61_000)).toBe(true);
        expect(API_RATE_LIMIT_TESTING.size()).toBe(1);
    });
});
