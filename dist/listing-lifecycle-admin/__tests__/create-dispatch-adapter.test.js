import { describe, expect, it } from 'vitest';
import { createListingCreateDispatchAdapter, ListingCreateDispatchError, } from '../create-dispatch-adapter.js';
const SKU = 'PIPELINE-TEST-20260826';
const payload = { product: { title: 'Pipeline test' } };
async function expectFailure(action, outcomeClass) {
    try {
        await action;
        throw new Error('expected dispatch failure');
    }
    catch (error) {
        expect(error).toBeInstanceOf(ListingCreateDispatchError);
        const dispatchError = error;
        expect(dispatchError).toMatchObject({
            code: expect.stringMatching(/^CREATE_DISPATCH_/),
            outcomeClass,
            message: 'Listing create dispatch adapter failed',
        });
        expect(JSON.stringify(dispatchError)).not.toContain('VERY_SECRET');
        return dispatchError;
    }
}
function adapter(fetchImpl) {
    return createListingCreateDispatchAdapter({
        fetchImpl,
        getAccessToken: async () => 'test-token-not-logged',
    });
}
describe('listing-create dispatch outcome classification', () => {
    it('uses eBay\'s exact hyphenated language headers', async () => {
        let acceptLanguage = null;
        let contentLanguage = null;
        let hasUnderscoreHeader = true;
        const dispatch = adapter(async (_url, init) => {
            const headers = new Headers(init?.headers);
            acceptLanguage = headers.get('Accept-Language');
            contentLanguage = headers.get('Content-Language');
            hasUnderscoreHeader = headers.has('Accept_Language');
            return new Response(null, { status: 204 });
        });
        await dispatch.putInventoryItem(SKU, payload);
        expect(acceptLanguage).toBe('en-US');
        expect(contentLanguage).toBe('en-US');
        expect(hasUnderscoreHeader).toBe(false);
    });
    it('classifies a known Inventory PUT HTTP rejection as definite no effect', async () => {
        const dispatch = adapter(async () => new Response(JSON.stringify({
            errors: [
                {
                    errorId: 25002,
                    domain: 'API_INVENTORY',
                    category: 'REQUEST',
                    message: 'VERY_SECRET provider message',
                    parameters: [{ name: 'sku', value: 'VERY_SECRET parameter' }],
                },
                { errorId: 1001, message: 'VERY_SECRET token detail' },
                { errorId: 25002, message: 'duplicate id is canonicalized' },
            ],
        }), {
            status: 400,
        }));
        const error = await expectFailure(dispatch.putInventoryItem(SKU, payload), 'definite_no_effect');
        expect(error.httpDiagnostic).toEqual({
            statusFamily: 'http_4xx',
            statusCode: 400,
            ebayErrorIds: [1001, 25002],
        });
        expect(JSON.stringify(error)).not.toContain('provider message');
        expect(JSON.stringify(error)).not.toContain('parameter');
        expect(JSON.stringify(error)).not.toContain('token detail');
    });
    it.each([
        ['non-JSON', 'VERY_SECRET non-json'],
        ['empty errors', '{"errors":[]}'],
        ['non-numeric errorId', '{"errors":[{"errorId":"25002"}]}'],
        ['zero errorId', '{"errors":[{"errorId":0}]}'],
        ['out-of-range errorId', '{"errors":[{"errorId":2147483648}]}'],
        ['too many errors', JSON.stringify({
                errors: Array.from({ length: 21 }, (_, index) => ({ errorId: index + 1 })),
            })],
    ])('omits eBay error IDs when a rejection has %s', async (_name, body) => {
        const dispatch = adapter(async () => new Response(body, { status: 422 }));
        const error = await expectFailure(dispatch.putInventoryItem(SKU, payload), 'definite_no_effect');
        expect(error.httpDiagnostic).toEqual({
            statusFamily: 'http_4xx',
            statusCode: 422,
            ebayErrorIds: null,
        });
        expect(JSON.stringify(error)).not.toContain('VERY_SECRET');
    });
    it('keeps a known create-offer rejection outcome unknown while exposing safe diagnostics', async () => {
        const dispatch = adapter(async () => new Response('{"errors":[{"errorId":25710,"message":"VERY_SECRET"}]}', { status: 503 }));
        const error = await expectFailure(dispatch.createOffer(payload), 'outcome_unknown');
        expect(error.httpDiagnostic).toEqual({
            statusFamily: 'http_5xx',
            statusCode: 503,
            ebayErrorIds: [25710],
        });
        expect(JSON.stringify(error)).not.toContain('VERY_SECRET');
    });
    it('keeps an Inventory PUT 5xx outcome unknown even with valid safe diagnostics', async () => {
        const dispatch = adapter(async () => new Response('{"errors":[{"errorId":25001,"message":"VERY_SECRET"}]}', { status: 503 }));
        const error = await expectFailure(dispatch.putInventoryItem(SKU, payload), 'outcome_unknown');
        expect(error.httpDiagnostic).toEqual({
            statusFamily: 'http_5xx',
            statusCode: 503,
            ebayErrorIds: [25001],
        });
        expect(JSON.stringify(error)).not.toContain('VERY_SECRET');
    });
    it('reports only the first five sorted unique IDs from a bounded provider array', async () => {
        const dispatch = adapter(async () => new Response(JSON.stringify({
            errors: [9, 2, 7, 1, 6, 3, 2].map((errorId) => ({ errorId })),
        }), { status: 400 }));
        const error = await expectFailure(dispatch.putInventoryItem(SKU, payload), 'definite_no_effect');
        expect(error.httpDiagnostic?.ebayErrorIds).toEqual([1, 2, 3, 6, 7]);
    });
    it.each([
        ['network failure', async () => { throw new Error('VERY_SECRET network'); }],
        ['abort/timeout', async () => { throw new DOMException('VERY_SECRET abort', 'AbortError'); }],
        ['response read failure', async () => ({
                status: 200,
                headers: new Headers(),
                text: async () => { throw new Error('VERY_SECRET read'); },
            })],
        ['oversized response', async () => new Response('', {
                status: 200,
                headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
            })],
    ])('classifies %s after a PUT attempt as outcome unknown', async (_name, fetchImpl) => {
        const dispatch = adapter(fetchImpl);
        const error = await expectFailure(dispatch.putInventoryItem(SKU, payload), 'outcome_unknown');
        expect(error.httpDiagnostic).toBeNull();
    });
    it('classifies an ambiguous successful create-offer response as outcome unknown', async () => {
        const dispatch = adapter(async () => new Response('{"unexpected":"VERY_SECRET"}', {
            status: 201,
            headers: { 'content-type': 'application/json' },
        }));
        await expectFailure(dispatch.createOffer(payload), 'outcome_unknown');
    });
    it('classifies a local target denial before fetch as definite no effect', async () => {
        let fetchCalls = 0;
        const dispatch = adapter(async () => {
            fetchCalls += 1;
            return new Response('', { status: 204 });
        });
        await expectFailure(dispatch.putInventoryItem('bad/sku', payload), 'definite_no_effect');
        expect(fetchCalls).toBe(0);
    });
});
