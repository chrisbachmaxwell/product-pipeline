/**
 * Read-only tripwire over eBay's daily Trading API budget — built the day
 * the budget ran out (2026-09-10, L58). The Developer Analytics `rate_limit`
 * resource reports every Trading call's daily count without consuming any
 * Trading quota itself, and the outage signature is unmistakable there:
 * `remaining: 0` on every call at once (the per-call limits read 5,000 each,
 * but the shared daily AGGREGATE is what empties).
 *
 * This module mints a client-credentials application token (base scope
 * only), reads the table at most once per check interval, and reports the
 * aggregate usage fraction plus the top consumers. It performs zero writes,
 * returns no credentials, and degrades to `{ available: false }` on any
 * failure — the tripwire must never become its own outage.
 */
import { loadEbayCredentials } from '../config/credentials.js';
import { warn } from '../utils/logger.js';
const SUCCESS_CACHE_MS = 30 * 60 * 1000;
const FAILURE_CACHE_MS = 5 * 60 * 1000;
export const EBAY_TRADING_QUOTA_WARNING_FRACTION = 0.6;
const AGGREGATE_LIMIT_FALLBACK = 5_000;
const UNAVAILABLE = Object.freeze({
    available: false,
    checkedAtUtc: null,
    aggregateCount: null,
    aggregateLimit: null,
    usedFraction: null,
    resetAtUtc: null,
    topCalls: Object.freeze([]),
    warning: false,
});
async function readQuota(fetchImpl, nowUtc) {
    const credentials = await loadEbayCredentials();
    const basic = Buffer.from(`${credentials.appId}:${credentials.certId}`).toString('base64');
    const tokenResponse = await fetchImpl('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            scope: 'https://api.ebay.com/oauth/api_scope',
        }),
    });
    if (!tokenResponse.ok)
        return UNAVAILABLE;
    const accessToken = (await tokenResponse.json()).access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0)
        return UNAVAILABLE;
    const response = await fetchImpl('https://api.ebay.com/developer/analytics/v1_beta/rate_limit/', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!response.ok)
        return UNAVAILABLE;
    const body = await response.json();
    let aggregateCount = 0;
    let aggregateLimit = AGGREGATE_LIMIT_FALLBACK;
    let resetAtUtc = null;
    const calls = [];
    for (const family of body.rateLimits ?? []) {
        if (family.apiName !== 'TradingAPI')
            continue;
        for (const resource of family.resources ?? []) {
            const rate = resource.rates?.[0];
            const count = typeof rate?.count === 'number' && rate.count >= 0 ? rate.count : 0;
            aggregateCount += count;
            // The shared daily aggregate equals the COMMON per-call limit (5,000
            // observed); a few calls (AddItem, RelistItem) carry larger separate
            // buckets, so the minimum is the aggregate, never the last seen.
            if (typeof rate?.limit === 'number' && rate.limit > 0) {
                aggregateLimit = Math.min(aggregateLimit, rate.limit);
            }
            if (typeof rate?.reset === 'string' && resetAtUtc === null)
                resetAtUtc = rate.reset;
            if (count > 0 && typeof resource.name === 'string') {
                calls.push({ name: resource.name, count });
            }
        }
    }
    if (calls.length === 0 && aggregateCount === 0 && resetAtUtc === null)
        return UNAVAILABLE;
    calls.sort((left, right) => right.count - left.count);
    const usedFraction = Math.min(1, aggregateCount / aggregateLimit);
    const warning = usedFraction >= EBAY_TRADING_QUOTA_WARNING_FRACTION;
    if (warning) {
        warn(`EBAY_TRADING_QUOTA_HIGH used=${aggregateCount}/${aggregateLimit} reset=${resetAtUtc ?? 'unknown'}`);
    }
    return Object.freeze({
        available: true,
        checkedAtUtc: nowUtc,
        aggregateCount,
        aggregateLimit,
        usedFraction,
        resetAtUtc,
        topCalls: Object.freeze(calls.slice(0, 5).map((entry) => Object.freeze(entry))),
        warning,
    });
}
export function createEbayTradingQuotaReader(dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const now = dependencies.now ?? Date.now;
    let cached = null;
    let flight = null;
    return async () => {
        if (cached && now() - cached.at < cached.ttlMs)
            return cached.value;
        if (flight)
            return flight;
        flight = (async () => {
            let value;
            try {
                value = await readQuota(fetchImpl, new Date(now()).toISOString());
            }
            catch {
                value = UNAVAILABLE;
            }
            cached = {
                at: now(),
                ttlMs: value.available ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS,
                value,
            };
            return value;
        })();
        try {
            return await flight;
        }
        finally {
            flight = null;
        }
    };
}
export const getEbayTradingQuota = createEbayTradingQuotaReader();
