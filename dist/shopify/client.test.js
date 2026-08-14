import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from './production-identity.js';
import { requestShopifyClientCredentialsToken, SHOPIFY_CLIENT_CREDENTIALS_TOKEN_LIMITS, } from './client.js';
const PRIMARY_SECRET = 'new-production-client-secret';
const ACCESS_TOKEN = 'shopify-client-credentials-access-token';
function credentials(overrides = {}) {
    return {
        clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
        clientSecret: PRIMARY_SECRET,
        storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
        ...overrides,
    };
}
function json(value, init = {}) {
    return new Response(JSON.stringify(value), {
        status: 200,
        ...init,
        headers: { 'Content-Type': 'application/json', ...init.headers },
    });
}
describe('bounded primary-only Shopify client-credentials request', () => {
    it('uses the exact fixed host and primary secret with bounded redirect/abort controls', async () => {
        const fetchImpl = vi.fn(async (_url, _init) => json({ access_token: ACCESS_TOKEN }));
        await expect(requestShopifyClientCredentialsToken({
            fetchImpl: fetchImpl,
            loadCredentials: async () => credentials(),
        })).resolves.toBe(ACCESS_TOKEN);
        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://usedcameragear.myshopify.com/admin/oauth/access_token');
        expect(init.redirect).toBe('error');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(init.body))).toEqual({
            client_id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
            client_secret: PRIMARY_SECRET,
            grant_type: 'client_credentials',
        });
        expect(String(init.body)).not.toContain('SHOPIFY_PREVIOUS_CLIENT_SECRET');
    });
    it('returns one fixed redacted failure for a provider error body', async () => {
        const leaked = `${PRIMARY_SECRET}-provider-body`;
        const failure = await requestShopifyClientCredentialsToken({
            fetchImpl: vi.fn(async () => new Response(leaked, { status: 401 })),
            loadCredentials: async () => credentials(),
        }).catch((error) => error);
        expect(failure).toMatchObject({
            code: 'shopify-token-denied',
            message: 'Shopify client credentials token request failed',
        });
        expect(String(failure)).not.toContain(leaked);
        expect(String(failure)).not.toContain(PRIMARY_SECRET);
    });
    it('fails closed on timeout/transport errors without exposing the underlying message', async () => {
        const failure = await requestShopifyClientCredentialsToken({
            fetchImpl: vi.fn(async (_url, init) => {
                expect(init?.signal?.aborted).toBe(true);
                throw new Error(`${PRIMARY_SECRET}-transport-detail`);
            }),
            loadCredentials: async () => credentials(),
            scheduleTimeout: (callback) => {
                callback();
                return {};
            },
            clearScheduledTimeout: vi.fn(),
        }).catch((error) => error);
        expect(failure).toMatchObject({ code: 'shopify-token-denied' });
        expect(String(failure)).not.toContain(PRIMARY_SECRET);
    });
    it('rejects oversized, non-JSON, and malformed token responses', async () => {
        const cases = [
            new Response('{}', {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(SHOPIFY_CLIENT_CREDENTIALS_TOKEN_LIMITS.responseMaxBytes + 1),
                },
            }),
            new Response('{"access_token":"hidden"}', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            }),
            json({ access_token: 'short' }),
        ];
        for (const response of cases) {
            await expect(requestShopifyClientCredentialsToken({
                fetchImpl: vi.fn(async () => response),
                loadCredentials: async () => credentials(),
            })).rejects.toMatchObject({ code: 'shopify-token-denied' });
        }
    });
    it('rejects any non-production identity before network dispatch', async () => {
        for (const loaded of [
            credentials({ storeDomain: 'other.myshopify.com' }),
            credentials({ clientId: 'wrong-client-id' }),
            credentials({ clientSecret: 'unsafe secret value' }),
        ]) {
            const fetchImpl = vi.fn();
            await expect(requestShopifyClientCredentialsToken({
                fetchImpl: fetchImpl,
                loadCredentials: async () => loaded,
            })).rejects.toMatchObject({ code: 'shopify-token-denied' });
            expect(fetchImpl).not.toHaveBeenCalled();
        }
    });
});
