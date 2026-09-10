import { describe, expect, it } from 'vitest';
import { createPriceCheck, derivePriceCheckCondition, derivePriceCheckQuery, EBAY_PRICE_CHECK_TESTING, medianPrice, PriceCheckError, } from './ebay-price-check.js';
const SEARCH_URL_PREFIX = 'https://api.ebay.com/buy/browse/v1/item_summary/search?';
function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}
/** Realistic Browse item_summary/search body shape (trimmed to what eBay sends). */
function browseBody() {
    const item = (title, value, condition = 'Used') => ({
        itemId: 'v1|110000000001|0',
        title,
        leafCategoryIds: ['31388'],
        condition,
        conditionId: '3000',
        price: { value, currency: 'USD' },
        itemHref: 'https://api.ebay.com/buy/browse/v1/item/v1%7C110000000001%7C0',
        seller: { username: 'someoneelse', feedbackPercentage: '99.6', feedbackScore: 2140 },
        itemWebUrl: 'https://www.ebay.com/itm/110000000001',
    });
    return {
        href: 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=canon&limit=20',
        total: 4,
        limit: 20,
        offset: 0,
        itemSummaries: [
            item('Canon EOS R5 Mirrorless Camera Body', '2450.00'),
            item('Canon EOS R5 Body Only w/ Battery', '2299.99'),
            item('Canon EOS R5 45MP Full Frame', '2600.00'),
            item('Canon EOS R5 Camera Body - Excellent', '2500.00'),
        ],
    };
}
function createCheck(overrides = {}) {
    const calls = overrides.calls ?? [];
    const fetchImpl = (async (input, init) => {
        const url = String(input);
        const headers = { ...(init?.headers ?? {}) };
        calls.push({ url, headers });
        if (overrides.rawText !== undefined) {
            return new Response(overrides.rawText, { status: overrides.status ?? 200 });
        }
        return jsonResponse(overrides.body ?? browseBody(), overrides.status ?? 200, overrides.headers);
    });
    return {
        calls,
        check: createPriceCheck({
            getAccessToken: overrides.token ?? (async () => 'app-token-1'),
            fetchImpl,
            now: overrides.now,
        }),
    };
}
async function failureCode(operation) {
    try {
        await operation;
    }
    catch (error) {
        expect(error).toBeInstanceOf(PriceCheckError);
        return error.code;
    }
    throw new Error('expected the price check to fail');
}
describe('derivePriceCheckQuery', () => {
    it('strips store suffixes like (#123), *USED*, and *OPEN BOX*', () => {
        expect(derivePriceCheckQuery('Canon EOS R5 Camera Body *USED* (#12345)'))
            .toBe('Canon EOS R5 Camera Body');
        expect(derivePriceCheckQuery('Sony FE 24-70mm f/2.8 GM II *OPEN BOX* (# 998 )'))
            .toBe('Sony FE 24-70mm f/2.8 GM II');
        expect(derivePriceCheckQuery('*MINT* Nikon Z8 Body')).toBe('Nikon Z8 Body');
    });
    it('collapses whitespace and keeps a plain title unchanged', () => {
        expect(derivePriceCheckQuery('  Fuji   X-T5   Silver ')).toBe('Fuji X-T5 Silver');
    });
    it('caps the query length at a word boundary', () => {
        const long = `Canon EOS R5 ${'Accessory '.repeat(30)}Kit`;
        const query = derivePriceCheckQuery(long);
        expect(query.length).toBeLessThanOrEqual(EBAY_PRICE_CHECK_TESTING.MAX_QUERY_CHARACTERS);
        expect(query.endsWith('Accessory')).toBe(true);
    });
    it('replaces control characters instead of forwarding them', () => {
        expect(derivePriceCheckQuery('Canon\u0000EOS\u001FR5')).toBe('Canon EOS R5');
    });
});
describe('derivePriceCheckCondition', () => {
    it('defaults to USED and only allowlists NEW', () => {
        expect(derivePriceCheckCondition(undefined)).toBe('USED');
        expect(derivePriceCheckCondition('open box')).toBe('USED');
        expect(derivePriceCheckCondition('New')).toBe('NEW');
        expect(derivePriceCheckCondition('conditions:{NEW},category_ids:625')).toBe('USED');
    });
});
describe('medianPrice', () => {
    it('takes the middle value for odd samples', () => {
        expect(medianPrice([3, 1, 2])).toBe(2);
    });
    it('averages the middle pair for even samples, rounded to cents', () => {
        expect(medianPrice([100, 300, 200, 400])).toBe(250);
        expect(medianPrice([1, 2])).toBe(1.5);
        expect(medianPrice([1, 1.005])).toBe(1);
    });
});
describe('createPriceCheck', () => {
    it('performs one bounded Browse GET and projects a redacted comp summary', async () => {
        const { check, calls } = createCheck();
        const result = await check('Canon EOS R5 Camera Body *USED* (#12345)');
        expect(calls).toHaveLength(1);
        const call = calls[0];
        expect(call.url.startsWith(SEARCH_URL_PREFIX)).toBe(true);
        const search = new URL(call.url).searchParams;
        expect(search.get('q')).toBe('Canon EOS R5 Camera Body');
        expect(search.get('limit')).toBe('20');
        expect(search.get('filter')).toBe('conditions:{USED}');
        expect(call.headers.Authorization).toBe('Bearer app-token-1');
        expect(call.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
        expect(result.query).toBe('Canon EOS R5 Camera Body');
        expect(result.conditionFilter).toBe('USED');
        expect(result.currency).toBe('USD');
        expect(result.sampleSize).toBe(4);
        // Sorted sample: 2299.99, 2450, 2500, 2600 → median (2450 + 2500) / 2.
        expect(result.median).toBe(2475);
        expect(result.comps).toHaveLength(4);
        expect(result.comps[0]).toEqual({
            title: 'Canon EOS R5 Mirrorless Camera Body',
            price: { value: 2450, currency: 'USD' },
            condition: 'Used',
        });
    });
    it('passes the NEW condition hint through the fixed filter allowlist', async () => {
        const { check, calls } = createCheck();
        await check('Canon EOS R5 Body', 'new');
        expect(new URL(calls[0].url).searchParams.get('filter')).toBe('conditions:{NEW}');
    });
    it('caps comp fields, drops malformed items, and keeps at most 10 comps', async () => {
        const good = (index) => ({
            title: `Canon EOS R5 Body number ${index} ${'very long descriptor '.repeat(12)}end`,
            condition: `An extremely wordy condition description that keeps going ${index}`,
            price: { value: `${1000 + index}.00`, currency: 'USD' },
        });
        const body = {
            itemSummaries: [
                ...Array.from({ length: 15 }, (_, index) => good(index)),
                { title: 'No price at all' },
                { title: 'Negative', price: { value: '-5', currency: 'USD' } },
                { title: 'Bad currency', price: { value: '5', currency: 'usd!' } },
                'not-an-object',
            ],
        };
        const { check } = createCheck({ body });
        const result = await check('Canon EOS R5 Body');
        expect(result.sampleSize).toBe(15);
        expect(result.comps).toHaveLength(EBAY_PRICE_CHECK_TESTING.MAX_COMPS);
        for (const comp of result.comps) {
            expect(comp.title.length)
                .toBeLessThanOrEqual(EBAY_PRICE_CHECK_TESTING.MAX_COMP_TITLE_CHARACTERS);
            expect((comp.condition ?? '').length)
                .toBeLessThanOrEqual(EBAY_PRICE_CHECK_TESTING.MAX_COMP_CONDITION_CHARACTERS);
        }
        expect(result.median).toBe(1007);
    });
    it('computes the median over the modal currency only', async () => {
        const body = {
            itemSummaries: [
                { title: 'USD one', price: { value: '100.00', currency: 'USD' } },
                { title: 'USD two', price: { value: '300.00', currency: 'USD' } },
                { title: 'CAD outlier', price: { value: '9999.00', currency: 'CAD' } },
            ],
        };
        const { check } = createCheck({ body });
        const result = await check('Canon EOS R5 Body');
        expect(result.currency).toBe('USD');
        expect(result.sampleSize).toBe(2);
        expect(result.median).toBe(200);
        expect(result.comps.every((comp) => comp.price.currency === 'USD')).toBe(true);
    });
    it('serves the second identical lookup from cache with exactly one fetch', async () => {
        const { check, calls } = createCheck();
        const first = await check('Canon EOS R5 Camera Body *USED* (#12345)');
        const second = await check('  canon eos r5 CAMERA body (#999) *OPEN BOX*  ');
        expect(calls).toHaveLength(1);
        expect(second).toBe(first);
    });
    it('expires the cache after the TTL', async () => {
        let clock = 1_000;
        const { check, calls } = createCheck({ now: () => clock });
        await check('Canon EOS R5 Body');
        clock += EBAY_PRICE_CHECK_TESTING.CACHE_TTL_MS + 1;
        await check('Canon EOS R5 Body');
        expect(calls).toHaveLength(2);
    });
    it('redacts a failing token provider to PRICE_CHECK_AUTH_UNAVAILABLE', async () => {
        const { check, calls } = createCheck({
            token: async () => {
                throw new Error('secret credential detail');
            },
        });
        const code = await failureCode(check('Canon EOS R5 Body'));
        expect(code).toBe('PRICE_CHECK_AUTH_UNAVAILABLE');
        expect(calls).toHaveLength(0);
    });
    it('redacts a non-200 provider response to PRICE_CHECK_READ_FAILED', async () => {
        const { check } = createCheck({ body: { error: 'upstream detail' }, status: 429 });
        expect(await failureCode(check('Canon EOS R5 Body'))).toBe('PRICE_CHECK_READ_FAILED');
    });
    it('redacts an unparseable body to PRICE_CHECK_READ_FAILED', async () => {
        const { check } = createCheck({ rawText: 'not json at all' });
        expect(await failureCode(check('Canon EOS R5 Body'))).toBe('PRICE_CHECK_READ_FAILED');
    });
    it('rejects an oversized declared response as PRICE_CHECK_READ_FAILED', async () => {
        const { check } = createCheck({
            headers: {
                'Content-Length': String(EBAY_PRICE_CHECK_TESTING.MAX_RESPONSE_BYTES + 1),
            },
        });
        expect(await failureCode(check('Canon EOS R5 Body'))).toBe('PRICE_CHECK_READ_FAILED');
    });
    it('maps an empty result set to PRICE_CHECK_NO_RESULTS', async () => {
        const { check } = createCheck({ body: { total: 0, itemSummaries: [] } });
        expect(await failureCode(check('Canon EOS R5 Body'))).toBe('PRICE_CHECK_NO_RESULTS');
    });
    it('treats an unusably short derived query as PRICE_CHECK_NO_RESULTS without fetching', async () => {
        const { check, calls } = createCheck();
        expect(await failureCode(check('*USED* (#12345)'))).toBe('PRICE_CHECK_NO_RESULTS');
        expect(calls).toHaveLength(0);
    });
    it('does not cache failures', async () => {
        const { check, calls } = createCheck({ body: { itemSummaries: [] } });
        await failureCode(check('Canon EOS R5 Body'));
        await failureCode(check('Canon EOS R5 Body'));
        expect(calls).toHaveLength(2);
    });
});
