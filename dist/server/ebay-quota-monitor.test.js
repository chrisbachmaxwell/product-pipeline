import { describe, expect, it, vi } from 'vitest';
import { createEbayTradingQuotaReader } from './ebay-quota-monitor.js';
vi.mock('../config/credentials.js', () => ({
    loadEbayCredentials: async () => ({ appId: 'app', certId: 'cert' }),
}));
function analyticsBody(resources) {
    return {
        rateLimits: [{
                apiContext: 'TradingAPI',
                apiName: 'TradingAPI',
                resources: resources.map((resource) => ({
                    name: resource.name,
                    rates: [{
                            count: resource.count,
                            limit: resource.limit ?? 5000,
                            remaining: 0,
                            reset: '2026-09-11T07:00:00.000Z',
                            timeWindow: 86400,
                        }],
                })),
            }],
    };
}
function fetchStub(body) {
    return (async (url) => {
        if (String(url).includes('/identity/')) {
            return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 });
        }
        return new Response(JSON.stringify(body), { status: 200 });
    });
}
describe('eBay Trading quota tripwire', () => {
    it('aggregates Trading counts, ranks top consumers, and warns at 60%', async () => {
        const read = createEbayTradingQuotaReader({
            fetchImpl: fetchStub(analyticsBody([
                { name: 'GetUser', count: 2810 },
                { name: 'GetItem', count: 1670 },
                { name: 'GetMyeBaySelling', count: 830 },
                { name: 'AddItem', count: 0, limit: 100000 },
            ])),
            now: () => 1_000,
        });
        const quota = await read();
        expect(quota.available).toBe(true);
        expect(quota.aggregateCount).toBe(5310);
        expect(quota.warning).toBe(true);
        expect(quota.usedFraction).toBe(1);
        expect(quota.topCalls[0]).toEqual({ name: 'GetUser', count: 2810 });
        expect(quota.resetAtUtc).toBe('2026-09-11T07:00:00.000Z');
    });
    it('stays quiet under the warning threshold', async () => {
        const read = createEbayTradingQuotaReader({
            fetchImpl: fetchStub(analyticsBody([{ name: 'GetMyeBaySelling', count: 400 }])),
            now: () => 1_000,
        });
        const quota = await read();
        expect(quota.warning).toBe(false);
        expect(quota.usedFraction).toBeCloseTo(400 / 5000, 5);
    });
    it('caches successes and degrades to available:false on failure, never throwing', async () => {
        let calls = 0;
        const read = createEbayTradingQuotaReader({
            fetchImpl: (async () => {
                calls += 1;
                throw new Error('network down');
            }),
            now: () => 1_000,
        });
        const first = await read();
        const second = await read();
        expect(first).toMatchObject({ available: false, warning: false });
        expect(second).toMatchObject({ available: false });
        expect(calls).toBe(1);
    });
});
