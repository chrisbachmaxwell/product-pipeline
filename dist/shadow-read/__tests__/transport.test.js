import { describe, expect, it, vi } from 'vitest';
import { validateBoundedOrderReadWindow } from '../order-window.js';
import { createFixtureReadTransport, } from '../transport.js';
import { validateEphemeralReadToken } from '../token.js';
import { FIXTURE_SECRET, NOW_UTC, SHOPIFY_SCOPE, ebayPolicy, shopifyPolicy, tokenFor, transportConfig, } from './fixtures.js';
const fixedClock = () => new Date(NOW_UTC);
function productRequest(overrides = {}) {
    return {
        source: 'shopify',
        method: 'GET',
        path: '/admin/api/2026-07/products.json',
        query: { limit: '2' },
        pageNumber: 1,
        requiredScopes: [SHOPIFY_SCOPE],
        token: tokenFor('shopify'),
        orderWindow: null,
        ...overrides,
    };
}
function readOrdersToken() {
    return validateEphemeralReadToken({
        provider: 'shopify',
        accessToken: FIXTURE_SECRET,
        issuedAtUtc: '2026-08-11T17:55:00.000Z',
        expiresAtUtc: '2026-08-11T18:45:00.000Z',
        scopes: ['read_orders'],
    }, shopifyPolicy(), NOW_UTC);
}
function readEbayOrdersToken() {
    return validateEphemeralReadToken({
        provider: 'ebay',
        accessToken: FIXTURE_SECRET,
        issuedAtUtc: '2026-08-11T17:55:00.000Z',
        expiresAtUtc: '2026-08-11T18:45:00.000Z',
        scopes: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'],
    }, ebayPolicy(), NOW_UTC);
}
function orderWindow() {
    return validateBoundedOrderReadWindow({
        creationDateStartUtc: '2026-08-10T18:00:00.000Z',
        creationDateEndUtc: NOW_UTC,
    }, NOW_UTC);
}
describe('fixture-only read transport', () => {
    it('has no default network path even when global fetch exists', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not run'));
        try {
            const transport = createFixtureReadTransport(transportConfig(), { clock: fixedClock });
            await expect(transport.request(productRequest())).rejects.toMatchObject({
                code: 'transport-unavailable',
            });
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(transport.auditEvents()).toEqual([
                expect.objectContaining({ outcome: 'attempted', method: 'GET' }),
                expect.objectContaining({ outcome: 'denied', errorCode: 'transport-unavailable' }),
            ]);
        }
        finally {
            fetchSpy.mockRestore();
        }
    });
    it('constructs only the exact configured HTTPS GET and exposes no body or token to fixtures', async () => {
        let dispatched;
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async (request) => {
                dispatched = request;
                return { status: 200, records: [{ id: 'product-1', sku: 'SAFE-SKU-1' }] };
            },
        });
        const result = await transport.request(productRequest());
        expect(dispatched).toMatchObject({
            method: 'GET',
            url: 'https://usedcameragear.myshopify.com/admin/api/2026-07/products.json?limit=2',
            headers: { Accept: 'application/json' },
            authority: { kind: 'validated-ephemeral-read-token', secretExposed: false },
            redirect: 'error',
        });
        expect(Object.prototype.hasOwnProperty.call(dispatched, 'body')).toBe(false);
        expect(JSON.stringify(dispatched)).not.toContain(FIXTURE_SECRET);
        expect(JSON.stringify(dispatched)).not.toContain('Authorization');
        expect(result).toMatchObject({
            recordCount: 1,
            provenance: {
                method: 'injected-fixture-read',
                attestation: 'not-runtime-observed',
                fixtureOnly: true,
                liveProof: false,
                productionParity: false,
            },
        });
        expect(result.datasetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
    it('records method, host, and path while omitting query cursors and authority values', async () => {
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => ({ status: 200, records: [] }),
        });
        await transport.request(productRequest({ query: { page_info: 'opaque-page-cursor' } }));
        const serialized = JSON.stringify(transport.auditEvents());
        expect(transport.auditEvents().at(-1)).toMatchObject({
            method: 'GET',
            host: 'usedcameragear.myshopify.com',
            path: '/admin/api/2026-07/products.json',
            outcome: 'succeeded',
        });
        expect(serialized).not.toContain('opaque-page-cursor');
        expect(serialized).not.toContain(FIXTURE_SECRET);
        expect(serialized).not.toContain('Authorization');
    });
    it('supports HEAD only with an empty fixture record set', async () => {
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => ({ status: 204, records: [] }),
        });
        await expect(transport.request(productRequest({ method: 'HEAD' }))).resolves.toMatchObject({
            status: 204,
            recordCount: 0,
        });
    });
    it('denies POST and unknown request fields before dispatch', async () => {
        const dispatcher = vi.fn(async () => ({ status: 200, records: [] }));
        const transport = createFixtureReadTransport(transportConfig(), { dispatcher, clock: fixedClock });
        await expect(transport.request(productRequest({ method: 'POST' }))).rejects.toMatchObject({
            code: 'method-denied',
        });
        await expect(transport.request({
            ...productRequest(),
            unreviewed: true,
        })).rejects.toMatchObject({ code: 'configuration-denied' });
        expect(dispatcher).not.toHaveBeenCalled();
    });
    it('denies host lookalikes, protocols, ports, and identity mismatches at configuration', () => {
        const base = transportConfig();
        for (const host of [
            'http://usedcameragear.myshopify.com',
            'usedcameragear.myshopify.com.attacker.test',
            'usedcameragear.myshopify.com:443',
        ]) {
            expect(() => createFixtureReadTransport(transportConfig({
                shopify: { ...base.shopify, host },
            }), {})).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
        }
        expect(() => createFixtureReadTransport(transportConfig({
            shopify: { ...base.shopify, storeDomain: 'other.myshopify.com' },
        }), {})).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
        expect(() => createFixtureReadTransport(transportConfig({
            ebay: { ...base.ebay, environment: 'production' },
        }), {})).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
    });
    it('denies off-allowlist, URL-bearing, and traversal paths', async () => {
        const dispatcher = vi.fn(async () => ({ status: 200, records: [] }));
        const transport = createFixtureReadTransport(transportConfig(), { dispatcher, clock: fixedClock });
        for (const path of [
            '/admin/api/2026-07/customers.json',
            '/admin/api/2026-07/products.json?limit=250',
            '/admin/api/../products.json',
            '/admin/api/%2e%2e/products.json',
            '//attacker.test/admin/api/2026-07/products.json',
        ]) {
            await expect(transport.request(productRequest({ path }))).rejects.toMatchObject({
                code: 'path-denied',
            });
        }
        expect(dispatcher).not.toHaveBeenCalled();
    });
    it('denies unknown, reserved, and credential-like query material', async () => {
        const base = transportConfig();
        expect(() => createFixtureReadTransport(transportConfig({
            shopify: { ...base.shopify, allowedQueryParameters: ['limit', 'access_token'] },
        }), {})).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
        expect(() => createFixtureReadTransport(transportConfig({
            shopify: { ...base.shopify, allowedQueryParameters: ['limit', 'created_at_min'] },
        }), {})).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
        const dispatcher = vi.fn(async () => ({ status: 200, records: [] }));
        const transport = createFixtureReadTransport(base, { dispatcher, clock: fixedClock });
        await expect(transport.request(productRequest({ query: { unknown: 'x' } }))).rejects.toMatchObject({
            code: 'query-denied',
        });
        await expect(transport.request(productRequest({ query: { limit: `Bearer ${FIXTURE_SECRET}` } }))).rejects.toMatchObject({
            code: 'query-denied',
        });
        await expect(transport.request(productRequest({ query: { limit: 'buyer@example.test' } }))).rejects.toMatchObject({
            code: 'query-denied',
        });
        expect(dispatcher).not.toHaveBeenCalled();
    });
    it('requires an opaque validated creationDate window for every Shopify order read', async () => {
        let dispatchedUrl = '';
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async (request) => {
                dispatchedUrl = request.url;
                return { status: 200, records: [] };
            },
        });
        const baseOrderRequest = productRequest({
            path: '/admin/api/2026-07/orders.json',
            query: { limit: '2' },
            requiredScopes: ['read_orders'],
            token: readOrdersToken(),
        });
        await expect(transport.request(baseOrderRequest)).rejects.toMatchObject({
            code: 'order-window-denied',
        });
        await expect(transport.request({
            ...baseOrderRequest,
            orderWindow: {
                ...orderWindow(),
            },
        })).rejects.toMatchObject({ code: 'order-window-denied' });
        await transport.request({ ...baseOrderRequest, orderWindow: orderWindow() });
        const url = new URL(dispatchedUrl);
        expect(url.searchParams.get('created_at_min')).toBe('2026-08-10T18:00:00.000Z');
        expect(url.searchParams.get('created_at_max')).toBe(NOW_UTC);
    });
    it('requires and injects the bounded creationdate filter for eBay fulfillment orders', async () => {
        let dispatchedUrl = '';
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async (request) => {
                dispatchedUrl = request.url;
                return { status: 200, records: [] };
            },
        });
        const request = productRequest({
            source: 'ebay',
            path: '/sell/fulfillment/v1/order',
            query: { limit: '2', offset: '0' },
            requiredScopes: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'],
            token: readEbayOrdersToken(),
            orderWindow: orderWindow(),
        });
        await transport.request(request);
        const url = new URL(dispatchedUrl);
        expect(url.origin).toBe('https://api.sandbox.ebay.com');
        expect(url.searchParams.get('filter')).toBe(`creationdate:[2026-08-10T18:00:00.000Z..${NOW_UTC}]`);
        expect(url.searchParams.get('limit')).toBe('2');
        expect(url.searchParams.get('offset')).toBe('0');
    });
    it('denies attaching an order window to a non-order read', async () => {
        const dispatcher = vi.fn(async () => ({ status: 200, records: [] }));
        const transport = createFixtureReadTransport(transportConfig(), { dispatcher, clock: fixedClock });
        await expect(transport.request(productRequest({ orderWindow: orderWindow() }))).rejects.toMatchObject({
            code: 'order-window-denied',
        });
        expect(dispatcher).not.toHaveBeenCalled();
    });
    it('fails closed on token provider/scope mismatch and page caps', async () => {
        const dispatcher = vi.fn(async () => ({ status: 200, records: [] }));
        const transport = createFixtureReadTransport(transportConfig(), { dispatcher, clock: fixedClock });
        await expect(transport.request(productRequest({ token: tokenFor('ebay') }))).rejects.toMatchObject({
            code: 'token-denied',
        });
        await expect(transport.request(productRequest({ pageNumber: 5 }))).rejects.toMatchObject({
            code: 'page-cap-exceeded',
        });
        expect(dispatcher).not.toHaveBeenCalled();
    });
    it('computes record and byte caps locally and deep-freezes the returned fixture', async () => {
        const mutable = [{ id: 'one', nested: { state: 'safe' } }];
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => ({ status: 200, records: mutable }),
        });
        const result = await transport.request(productRequest());
        mutable[0].nested.state = 'changed-after-return';
        expect(result.records[0].nested.state).toBe('safe');
        expect(Object.isFrozen(result.records)).toBe(true);
        expect(Object.isFrozen(result.records[0].nested)).toBe(true);
        const recordCap = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => ({
                status: 200,
                records: Array.from({ length: 11 }, (_, index) => ({ id: `id-${index}` })),
            }),
        });
        await expect(recordCap.request(productRequest())).rejects.toMatchObject({
            code: 'record-cap-exceeded',
        });
        const base = transportConfig();
        const byteCap = createFixtureReadTransport(transportConfig({
            limits: { ...base.limits, maxResponseBytes: 20 },
        }), {
            clock: fixedClock,
            dispatcher: async () => ({ status: 200, records: [{ id: 'x'.repeat(30) }] }),
        });
        await expect(byteCap.request(productRequest())).rejects.toMatchObject({
            code: 'response-byte-cap-exceeded',
        });
    });
    it('denies secret/PII fixture fields and values before returning them', async () => {
        for (const records of [
            [{ id: 'one', customerEmail: 'hidden@example.test' }],
            [{ id: 'one', harmless: `Bearer ${FIXTURE_SECRET}` }],
            [{ id: 'one', harmless: 'hidden@example.test' }],
        ]) {
            const transport = createFixtureReadTransport(transportConfig(), {
                clock: fixedClock,
                dispatcher: async () => ({ status: 200, records }),
            });
            await expect(transport.request(productRequest())).rejects.toMatchObject({
                code: 'fixture-payload-denied',
            });
            expect(JSON.stringify(transport.auditEvents())).not.toContain(FIXTURE_SECRET);
            expect(JSON.stringify(transport.auditEvents())).not.toContain('hidden@example.test');
        }
    });
    it('redacts dispatcher failures and non-success response payloads', async () => {
        const thrown = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => { throw new Error(`failed with ${FIXTURE_SECRET}`); },
        });
        await expect(thrown.request(productRequest())).rejects.toMatchObject({ code: 'upstream-failure' });
        expect(JSON.stringify(thrown.auditEvents())).not.toContain(FIXTURE_SECRET);
        const rejected = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => ({
                status: 302,
                records: [{ accessToken: FIXTURE_SECRET }],
            }),
        });
        try {
            await rejected.request(productRequest());
            throw new Error('Expected response denial');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'upstream-status-denied' });
            expect(JSON.stringify(error)).not.toContain(FIXTURE_SECRET);
            expect(String(error)).not.toContain(FIXTURE_SECRET);
        }
    });
    it('enforces the bounded timeout and aborts the injected fixture request', async () => {
        const base = transportConfig();
        let capturedSignal;
        const transport = createFixtureReadTransport(transportConfig({
            limits: { ...base.limits, timeoutMs: 5 },
        }), {
            clock: fixedClock,
            dispatcher: async (request) => {
                capturedSignal = request.signal;
                return new Promise(() => undefined);
            },
        });
        await expect(transport.request(productRequest())).rejects.toMatchObject({
            code: 'transport-timeout',
        });
        expect(capturedSignal?.aborted).toBe(true);
    });
    it('denies an unrecognized dispatcher response shape', async () => {
        const transport = createFixtureReadTransport(transportConfig(), {
            clock: fixedClock,
            dispatcher: async () => ({ status: 200, records: [], unreviewed: true }),
        });
        await expect(transport.request(productRequest())).rejects.toMatchObject({
            code: 'upstream-failure',
        });
    });
    it('keeps exact account identity and fixture-only proof limits in policy metadata', () => {
        const policy = createFixtureReadTransport(transportConfig()).policy;
        expect(policy).toEqual(expect.objectContaining({
            shopifyHost: 'usedcameragear.myshopify.com',
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            ebayHost: 'api.sandbox.ebay.com',
            ebayEnvironment: 'sandbox',
            ebaySellerAccount: 'usedcam-test',
            ebayMarketplaceId: 'EBAY_US',
            fixtureOnly: true,
            liveProof: false,
        }));
    });
});
