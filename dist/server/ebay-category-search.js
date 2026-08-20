/**
 * Read-only eBay Taxonomy category suggestion search for the listing editor.
 *
 * Bounded adapter in the same style as the other exact eBay readers: it can
 * reach exactly one host (`https://api.ebay.com`) on exactly two Taxonomy
 * resource paths, GET only, responses capped at 2MB with a 15s timeout and
 * `redirect: 'error'`. Both endpoints require only the `api_scope` OAuth
 * scope, which the existing transient read token already carries — the token
 * is minted through the existing provider machinery and is never persisted,
 * logged, or echoed. Errors are redacted to fixed codes; no token, URL,
 * query, or provider body ever escapes through an error.
 *
 * The default category tree id is fetched once and cached forever
 * in-process. Suggestion responses are cached per normalized query for one
 * hour in a bounded LRU (≤500 queries), and concurrent lookups for the same
 * normalized query coalesce into a single upstream call.
 */
import { getRuntimeEbayReadToken } from './live-listing-catalog-source.js';
const EBAY_API_ORIGIN = 'https://api.ebay.com';
const DEFAULT_TREE_PATH = '/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_QUERY_CHARACTERS = 2;
const MAX_QUERY_CHARACTERS = 100;
const MAX_SUGGESTIONS = 25;
const MAX_NAME_LENGTH = 256;
const MAX_ANCESTORS = 10;
const QUERY_CACHE_TTL_MS = 60 * 60_000;
const MAX_CACHED_QUERIES = 500;
export const EBAY_CATEGORY_SEARCH_FAILURE_CODES = Object.freeze([
    'INVALID_QUERY',
    'AUTHORITY_UNAVAILABLE',
    'REMOTE_READ_FAILED',
    'INVALID_RESPONSE',
]);
export class EbayCategorySearchError extends Error {
    code;
    constructor(code) {
        super('eBay category search is unavailable');
        this.name = 'EbayCategorySearchError';
        this.code = code;
    }
}
function fail(code) {
    throw new EbayCategorySearchError(code);
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/**
 * Trimmed 2–100 character query with no control, line-separator, or delete
 * characters. Anything else is an INVALID_QUERY (route: 400), never echoed.
 */
export function validateEbayCategoryQuery(value) {
    if (typeof value !== 'string')
        return fail('INVALID_QUERY');
    const query = value.trim();
    if (query.length < MIN_QUERY_CHARACTERS
        || query.length > MAX_QUERY_CHARACTERS
        || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(query))
        return fail('INVALID_QUERY');
    return query;
}
/** Conservative safe-string gate matching the listing-editor facet rules. */
function safeName(value) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_NAME_LENGTH
        || value.trim().length === 0
        || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value))
        return null;
    return value;
}
function safeCategoryId(value) {
    const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : value;
    return typeof text === 'string' && /^\d{1,32}$/u.test(text) ? text : null;
}
async function boundedTaxonomyGet(fetchImpl, path, accessToken) {
    if (!path.startsWith('/commerce/taxonomy/v1/'))
        return fail('REMOTE_READ_FAILED');
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
            },
            redirect: 'error',
            signal: controller.signal,
        });
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            return fail('REMOTE_READ_FAILED');
        }
        text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
            return fail('REMOTE_READ_FAILED');
        status = response.status;
    }
    catch (error) {
        if (error instanceof EbayCategorySearchError)
            throw error;
        return fail('REMOTE_READ_FAILED');
    }
    finally {
        clearTimeout(timeout);
    }
    if (status !== 200)
        return fail('REMOTE_READ_FAILED');
    try {
        const parsed = asRecord(JSON.parse(text));
        return parsed ?? fail('INVALID_RESPONSE');
    }
    catch (error) {
        if (error instanceof EbayCategorySearchError)
            throw error;
        return fail('INVALID_RESPONSE');
    }
}
/**
 * Map one raw suggestion entry to the DTO shape, or null when any part is
 * absent, malformed, or unsafe — entries are dropped, never escaped and
 * never allowed to fail the whole response. Ancestors arrive
 * most-specific-first; the rendered path is root-first.
 */
function toSuggestion(raw) {
    const entry = asRecord(raw);
    if (entry === null)
        return null;
    const category = asRecord(entry.category);
    if (category === null)
        return null;
    const id = safeCategoryId(category.categoryId);
    const name = safeName(category.categoryName);
    if (id === null || name === null)
        return null;
    const rawAncestors = entry.categoryTreeNodeAncestors;
    const ancestors = rawAncestors === undefined || rawAncestors === null
        ? []
        : Array.isArray(rawAncestors) ? rawAncestors : null;
    if (ancestors === null || ancestors.length > MAX_ANCESTORS)
        return null;
    const ancestorNames = [];
    for (const rawAncestor of ancestors) {
        const ancestorName = safeName(asRecord(rawAncestor)?.categoryName);
        if (ancestorName === null)
            return null;
        ancestorNames.push(ancestorName);
    }
    const rawLeaf = entry.leafCategoryTreeNode;
    if (rawLeaf !== undefined && rawLeaf !== null && typeof rawLeaf !== 'boolean')
        return null;
    return Object.freeze({
        id,
        name,
        path: [...ancestorNames.reverse(), name].join(' > '),
        leaf: typeof rawLeaf === 'boolean' ? rawLeaf : true,
    });
}
function toSearchDto(body) {
    const rawSuggestions = body.categorySuggestions;
    const suggestions = rawSuggestions === undefined || rawSuggestions === null
        ? []
        : Array.isArray(rawSuggestions) ? rawSuggestions : fail('INVALID_RESPONSE');
    const categories = [];
    for (const raw of suggestions) {
        if (categories.length >= MAX_SUGGESTIONS)
            break;
        const suggestion = toSuggestion(raw);
        if (suggestion !== null)
            categories.push(suggestion);
    }
    return Object.freeze({ categories: Object.freeze(categories) });
}
export function createEbayCategorySearch(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const now = dependencies.now ?? Date.now;
    let cachedTreeId = null;
    let treeIdFlight = null;
    /** Insertion-ordered LRU: re-inserted on hit, oldest evicted at capacity. */
    const queryCache = new Map();
    const inFlight = new Map();
    async function accessToken() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            return fail('AUTHORITY_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            return fail('AUTHORITY_UNAVAILABLE');
        }
        return token;
    }
    async function defaultTreeId() {
        if (cachedTreeId !== null)
            return cachedTreeId;
        if (treeIdFlight)
            return treeIdFlight;
        treeIdFlight = (async () => {
            const body = await boundedTaxonomyGet(fetchImpl, DEFAULT_TREE_PATH, await accessToken());
            const treeId = safeCategoryId(body.categoryTreeId);
            if (treeId === null)
                return fail('INVALID_RESPONSE');
            cachedTreeId = treeId;
            return treeId;
        })();
        try {
            return await treeIdFlight;
        }
        finally {
            treeIdFlight = null;
        }
    }
    return async (rawQuery) => {
        const query = validateEbayCategoryQuery(rawQuery);
        const cacheKey = query.toLocaleLowerCase('en-US');
        const cached = queryCache.get(cacheKey);
        if (cached !== undefined && cached.expiresAt > now()) {
            queryCache.delete(cacheKey);
            queryCache.set(cacheKey, cached);
            return cached.dto;
        }
        const flight = inFlight.get(cacheKey);
        if (flight !== undefined)
            return flight;
        const lookup = (async () => {
            const treeId = await defaultTreeId();
            const body = await boundedTaxonomyGet(fetchImpl, `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query)}`, await accessToken());
            const dto = toSearchDto(body);
            queryCache.delete(cacheKey);
            queryCache.set(cacheKey, { dto, expiresAt: now() + QUERY_CACHE_TTL_MS });
            while (queryCache.size > MAX_CACHED_QUERIES) {
                const oldest = queryCache.keys().next();
                if (oldest.done)
                    break;
                queryCache.delete(oldest.value);
            }
            return dto;
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
/**
 * Production instance backed by the existing transient eBay read token
 * (already minted with `api_scope`; no new scope is requested).
 */
export const searchEbayCategories = createEbayCategorySearch({
    getAccessToken: getRuntimeEbayReadToken,
});
export const EBAY_CATEGORY_SEARCH_TESTING = Object.freeze({
    MIN_QUERY_CHARACTERS,
    MAX_QUERY_CHARACTERS,
    MAX_SUGGESTIONS,
    MAX_ANCESTORS,
    MAX_CACHED_QUERIES,
    QUERY_CACHE_TTL_MS,
    MAX_RESPONSE_BYTES,
    REQUEST_TIMEOUT_MS,
});
