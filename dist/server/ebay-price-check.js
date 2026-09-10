/**
 * On-demand price intelligence: bounded, read-only eBay Browse API comps for
 * one catalog listing title.
 *
 * Same adapter discipline as the other exact eBay readers
 * (`ebay-category-search.ts`, `live-listing-catalog-source.ts`): exactly one
 * host (`https://api.ebay.com`), GET only, responses capped at 2MB with a 15s
 * timeout and `redirect: 'error'`. Errors are redacted to fixed codes — no
 * token, URL, query, or provider body ever escapes through an error, and the
 * token is never logged or persisted.
 *
 * The Browse API accepts an APPLICATION access token, so the default token
 * provider mirrors `createTransientEbayTokenProvider` but exchanges the same
 * runtime app credentials (`loadEbayCredentials`) via the
 * `client_credentials` grant with only the base `api_scope`. No user token,
 * no refresh token, no new scope.
 *
 * Results are cached in-process per normalized query+condition for one hour
 * in a bounded LRU (max 200 entries); concurrent identical lookups coalesce
 * into a single upstream call. Zero writes, ever.
 */
import { loadEbayCredentials } from '../config/credentials.js';
const EBAY_API_ORIGIN = 'https://api.ebay.com';
const EBAY_OAUTH_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_SEARCH_PATH = '/buy/browse/v1/item_summary/search';
const EBAY_MARKETPLACE_ID = 'EBAY_US';
const EBAY_APPLICATION_TOKEN_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_LIMIT = 20;
const MAX_COMPS = 10;
const MAX_QUERY_CHARACTERS = 80;
const MIN_QUERY_CHARACTERS = 3;
const MAX_COMP_TITLE_CHARACTERS = 120;
const MAX_COMP_CONDITION_CHARACTERS = 40;
const CACHE_TTL_MS = 60 * 60_000;
const MAX_CACHED_QUERIES = 200;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60_000;
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;
export const PRICE_CHECK_FAILURE_CODES = Object.freeze([
    'PRICE_CHECK_AUTH_UNAVAILABLE',
    'PRICE_CHECK_READ_FAILED',
    'PRICE_CHECK_NO_RESULTS',
]);
export class PriceCheckError extends Error {
    code;
    constructor(code) {
        super('Price check is unavailable');
        this.name = 'PriceCheckError';
        this.code = code;
    }
}
function fail(code) {
    throw new PriceCheckError(code);
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/**
 * Derive the comp search query from one store listing title: store-inventory
 * suffixes like `(#12345)` and asterisk-wrapped condition banners like
 * `*USED*` / `*OPEN BOX*` are stripped, unsafe characters and extra
 * whitespace are collapsed, and the remainder (the brand/model tokens) is
 * capped at a whole-word boundary.
 */
export function derivePriceCheckQuery(title) {
    const stripped = title
        .replace(/\(#\s*\d{1,12}\s*\)/gu, ' ')
        .replace(/\*[^*\n]{1,40}\*/gu, ' ')
        .replace(UNSAFE_CHARACTERS, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (stripped.length <= MAX_QUERY_CHARACTERS)
        return stripped;
    const cut = stripped.slice(0, MAX_QUERY_CHARACTERS + 1);
    const boundary = cut.lastIndexOf(' ');
    return (boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, MAX_QUERY_CHARACTERS)).trim();
}
/**
 * Map an optional operator/store condition hint onto the fixed Browse filter
 * allowlist. Anything unrecognized falls back to USED — the store sells used
 * gear, and an unexpected hint must never widen the request shape.
 */
export function derivePriceCheckCondition(hint) {
    if (typeof hint !== 'string')
        return 'USED';
    const normalized = hint.trim().toLocaleLowerCase('en-US');
    return normalized === 'new' || normalized === 'brand new' ? 'NEW' : 'USED';
}
function safeCompText(value, maximum) {
    if (typeof value !== 'string')
        return null;
    const clean = value
        .replace(UNSAFE_CHARACTERS, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (clean.length === 0)
        return null;
    return clean.length > maximum ? clean.slice(0, maximum).trim() : clean;
}
function toComp(raw) {
    const entry = asRecord(raw);
    if (entry === null)
        return null;
    const title = safeCompText(entry.title, MAX_COMP_TITLE_CHARACTERS);
    const price = asRecord(entry.price);
    if (title === null || price === null)
        return null;
    const value = typeof price.value === 'string' ? Number(price.value) : price.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        return null;
    }
    const currency = typeof price.currency === 'string' && /^[A-Z]{3}$/u.test(price.currency)
        ? price.currency
        : null;
    if (currency === null)
        return null;
    const condition = safeCompText(entry.condition, MAX_COMP_CONDITION_CHARACTERS);
    return Object.freeze({
        title,
        price: Object.freeze({ value: Math.round(value * 100) / 100, currency }),
        condition,
    });
}
/** Median of the sample, rounded to cents; even counts average the middle pair. */
export function medianPrice(values) {
    if (values.length === 0)
        return fail('PRICE_CHECK_NO_RESULTS');
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    return Math.round(median * 100) / 100;
}
function toResult(query, conditionFilter, body) {
    const rawSummaries = body.itemSummaries;
    const summaries = rawSummaries === undefined || rawSummaries === null
        ? []
        : Array.isArray(rawSummaries) ? rawSummaries : fail('PRICE_CHECK_READ_FAILED');
    const comps = [];
    for (const raw of summaries) {
        if (comps.length >= SEARCH_LIMIT)
            break;
        const comp = toComp(raw);
        if (comp !== null)
            comps.push(comp);
    }
    if (comps.length === 0)
        return fail('PRICE_CHECK_NO_RESULTS');
    // Comps are compared in one currency: keep the modal currency's sample.
    const currencyCounts = new Map();
    for (const comp of comps) {
        currencyCounts.set(comp.price.currency, (currencyCounts.get(comp.price.currency) ?? 0) + 1);
    }
    let currency = comps[0].price.currency;
    let best = 0;
    for (const [candidate, count] of currencyCounts) {
        if (count > best) {
            best = count;
            currency = candidate;
        }
    }
    const sample = comps.filter((comp) => comp.price.currency === currency);
    return Object.freeze({
        query,
        conditionFilter,
        median: medianPrice(sample.map((comp) => comp.price.value)),
        currency,
        sampleSize: sample.length,
        comps: Object.freeze(sample.slice(0, MAX_COMPS)),
    });
}
async function boundedBrowseGet(fetchImpl, path, accessToken) {
    if (!path.startsWith(EBAY_BROWSE_SEARCH_PATH))
        return fail('PRICE_CHECK_READ_FAILED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let status = 0;
    let text = '';
    try {
        const response = await fetchImpl(`${EBAY_API_ORIGIN}${path}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'Accept-Language': 'en-US',
                'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE_ID,
            },
            redirect: 'error',
            signal: controller.signal,
        });
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            return fail('PRICE_CHECK_READ_FAILED');
        }
        text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
            return fail('PRICE_CHECK_READ_FAILED');
        status = response.status;
    }
    catch (error) {
        if (error instanceof PriceCheckError)
            throw error;
        return fail('PRICE_CHECK_READ_FAILED');
    }
    finally {
        clearTimeout(timeout);
    }
    if (status !== 200)
        return fail('PRICE_CHECK_READ_FAILED');
    try {
        const parsed = asRecord(JSON.parse(text));
        return parsed ?? fail('PRICE_CHECK_READ_FAILED');
    }
    catch (error) {
        if (error instanceof PriceCheckError)
            throw error;
        return fail('PRICE_CHECK_READ_FAILED');
    }
}
/**
 * Application-token provider for Browse reads: `client_credentials` exchange
 * of the same runtime app credentials the user-token path uses, base
 * `api_scope` only, cached in-process until shortly before expiry. The token
 * never leaves this module except in the Authorization header and is never
 * logged or persisted.
 */
export function createApplicationEbayTokenProvider(dependencies = {}) {
    const loadCredentials = dependencies.loadCredentials ?? loadEbayCredentials;
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const now = dependencies.now ?? Date.now;
    let cached = null;
    let flight = null;
    return async () => {
        if (cached && cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS > now())
            return cached.token;
        if (flight)
            return flight;
        flight = (async () => {
            const credentials = await loadCredentials();
            const appId = credentials.appId;
            const certId = credentials.certId;
            if (!appId || !certId)
                return fail('PRICE_CHECK_AUTH_UNAVAILABLE');
            const basic = Buffer.from(`${appId}:${certId}`).toString('base64');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            let body = null;
            try {
                const response = await fetchImpl(EBAY_OAUTH_TOKEN_URL, {
                    method: 'POST',
                    headers: {
                        Authorization: `Basic ${basic}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        grant_type: 'client_credentials',
                        scope: EBAY_APPLICATION_TOKEN_SCOPE,
                    }),
                    redirect: 'error',
                    signal: controller.signal,
                });
                const text = await response.text();
                if (!response.ok || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                    return fail('PRICE_CHECK_AUTH_UNAVAILABLE');
                }
                body = asRecord(JSON.parse(text));
            }
            catch (error) {
                if (error instanceof PriceCheckError)
                    throw error;
                return fail('PRICE_CHECK_AUTH_UNAVAILABLE');
            }
            finally {
                clearTimeout(timeout);
            }
            const accessToken = body?.access_token;
            const expiresIn = body?.expires_in;
            if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 4_096
                || typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 300) {
                return fail('PRICE_CHECK_AUTH_UNAVAILABLE');
            }
            cached = { token: accessToken, expiresAt: now() + expiresIn * 1_000 };
            return accessToken;
        })();
        try {
            return await flight;
        }
        finally {
            flight = null;
        }
    };
}
export function createPriceCheck(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const now = dependencies.now ?? Date.now;
    /** Insertion-ordered LRU: re-inserted on hit, oldest evicted at capacity. */
    const cache = new Map();
    const inFlight = new Map();
    async function accessToken() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            return fail('PRICE_CHECK_AUTH_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            return fail('PRICE_CHECK_AUTH_UNAVAILABLE');
        }
        return token;
    }
    return async (title, conditionHint) => {
        if (typeof title !== 'string')
            return fail('PRICE_CHECK_NO_RESULTS');
        const query = derivePriceCheckQuery(title);
        if (query.length < MIN_QUERY_CHARACTERS)
            return fail('PRICE_CHECK_NO_RESULTS');
        const condition = derivePriceCheckCondition(conditionHint);
        const cacheKey = `${condition} ${query.toLocaleLowerCase('en-US')}`;
        const cached = cache.get(cacheKey);
        if (cached !== undefined && cached.expiresAt > now()) {
            cache.delete(cacheKey);
            cache.set(cacheKey, cached);
            return cached.result;
        }
        const flight = inFlight.get(cacheKey);
        if (flight !== undefined)
            return flight;
        const lookup = (async () => {
            const search = new URLSearchParams({
                q: query,
                limit: String(SEARCH_LIMIT),
                filter: `conditions:{${condition}}`,
            });
            const body = await boundedBrowseGet(fetchImpl, `${EBAY_BROWSE_SEARCH_PATH}?${search.toString()}`, await accessToken());
            const result = toResult(query, condition, body);
            cache.delete(cacheKey);
            cache.set(cacheKey, { result, expiresAt: now() + CACHE_TTL_MS });
            while (cache.size > MAX_CACHED_QUERIES) {
                const oldest = cache.keys().next();
                if (oldest.done)
                    break;
                cache.delete(oldest.value);
            }
            return result;
        })();
        inFlight.set(cacheKey, lookup);
        try {
            return await lookup;
        }
        finally {
            inFlight.delete(cacheKey);
        }
    };
}
/** Production instance: application token from the same runtime credentials. */
export const checkListingPrice = createPriceCheck({
    getAccessToken: createApplicationEbayTokenProvider(),
});
export const EBAY_PRICE_CHECK_TESTING = Object.freeze({
    MAX_RESPONSE_BYTES,
    REQUEST_TIMEOUT_MS,
    SEARCH_LIMIT,
    MAX_COMPS,
    MAX_QUERY_CHARACTERS,
    MAX_COMP_TITLE_CHARACTERS,
    MAX_COMP_CONDITION_CHARACTERS,
    CACHE_TTL_MS,
    MAX_CACHED_QUERIES,
});
