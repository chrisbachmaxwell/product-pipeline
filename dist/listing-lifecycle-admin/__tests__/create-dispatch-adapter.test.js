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
    it('classifies a known Inventory PUT HTTP rejection as definite no effect', async () => {
        const dispatch = adapter(async () => new Response('VERY_SECRET provider body', {
            status: 400,
        }));
        await expectFailure(dispatch.putInventoryItem(SKU, payload), 'definite_no_effect');
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
        await expectFailure(dispatch.putInventoryItem(SKU, payload), 'outcome_unknown');
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
