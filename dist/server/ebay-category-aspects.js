/**
 * Read-only category item-specifics metadata from eBay's Taxonomy API
 * (`getItemAspectsForCategory`), for the listing editor and the draft
 * defaults. Born from the 2026-09-11 publish battle: eBay requires six
 * aspects for lenses and reveals the gaps one refusal at a time — the
 * editor must show the full list up front instead.
 *
 * Application token (client-credentials, base scope) like the quota
 * monitor; responses are projected to a small bounded DTO and cached per
 * category for a day. Failures degrade to `available: false` — the editor
 * falls back to free-form rows exactly as before.
 */
import { loadEbayCredentials } from '../config/credentials.js';
const CATEGORY_ID = /^[1-9][0-9]{0,9}$/;
const SUCCESS_CACHE_MS = 24 * 60 * 60 * 1000;
const FAILURE_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHED_CATEGORIES = 200;
const MAX_ASPECTS = 40;
const MAX_VALUES_PER_ASPECT = 30;
const MAX_TEXT = 80;
function unavailable(categoryId) {
    return Object.freeze({ available: false, categoryId, aspects: Object.freeze([]) });
}
async function applicationToken(fetchImpl) {
    const credentials = await loadEbayCredentials();
    const basic = Buffer.from(`${credentials.appId}:${credentials.certId}`).toString('base64');
    const response = await fetchImpl('https://api.ebay.com/identity/v1/oauth2/token', {
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
    if (!response.ok)
        return null;
    const token = (await response.json()).access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
}
function boundedText(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_TEXT)
        return null;
    return trimmed;
}
async function fetchAspects(fetchImpl, categoryId) {
    const token = await applicationToken(fetchImpl);
    if (token === null)
        return unavailable(categoryId);
    const response = await fetchImpl('https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category'
        + `?category_id=${encodeURIComponent(categoryId)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok)
        return unavailable(categoryId);
    const body = await response.json();
    if (!Array.isArray(body.aspects))
        return unavailable(categoryId);
    const aspects = [];
    // Required aspects first, in eBay's order; then recommended.
    const ordered = [...body.aspects].sort((left, right) => Number(right.aspectConstraint?.aspectRequired === true)
        - Number(left.aspectConstraint?.aspectRequired === true));
    for (const raw of ordered) {
        if (aspects.length >= MAX_ASPECTS)
            break;
        const name = boundedText(raw.localizedAspectName);
        if (name === null)
            continue;
        const values = [];
        for (const value of raw.aspectValues ?? []) {
            if (values.length >= MAX_VALUES_PER_ASPECT)
                break;
            const text = boundedText(value.localizedValue);
            if (text !== null && !values.includes(text))
                values.push(text);
        }
        aspects.push(Object.freeze({
            name,
            required: raw.aspectConstraint?.aspectRequired === true,
            mode: raw.aspectConstraint?.aspectMode === 'SELECTION_ONLY' ? 'SELECTION_ONLY' : 'FREE_TEXT',
            values: Object.freeze(values),
        }));
    }
    return Object.freeze({ available: true, categoryId, aspects: Object.freeze(aspects) });
}
export function createEbayCategoryAspectsReader(dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const now = dependencies.now ?? Date.now;
    const cache = new Map();
    const flights = new Map();
    return async (categoryId) => {
        if (!CATEGORY_ID.test(categoryId))
            return unavailable(String(categoryId).slice(0, 10));
        const hit = cache.get(categoryId);
        if (hit && now() - hit.at < hit.ttlMs)
            return hit.value;
        const inFlight = flights.get(categoryId);
        if (inFlight)
            return inFlight;
        const flight = (async () => {
            let value;
            try {
                value = await fetchAspects(fetchImpl, categoryId);
            }
            catch {
                value = unavailable(categoryId);
            }
            if (cache.size >= MAX_CACHED_CATEGORIES)
                cache.clear();
            cache.set(categoryId, {
                at: now(),
                ttlMs: value.available ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS,
                value,
            });
            return value;
        })();
        flights.set(categoryId, flight);
        try {
            return await flight;
        }
        finally {
            flights.delete(categoryId);
        }
    };
}
export const getEbayCategoryAspects = createEbayCategoryAspectsReader();
