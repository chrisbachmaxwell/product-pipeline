import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../config/credentials.js', () => ({
    loadShopifyCredentials: async () => ({ storeDomain: 'test.myshopify.com' }),
}));
import { findExistingShopifyOrder } from '../orders.js';
function mockFetchSequence(responses) {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
        const body = responses[Math.min(call, responses.length - 1)];
        call++;
        return {
            ok: true,
            json: async () => body,
        };
    }));
}
describe('findExistingShopifyOrder — Method 3 (note/tag scan)', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });
    it('does NOT flag an unrelated ebay-sourced order as a duplicate', async () => {
        // Regression: a bare source_name === 'ebay' check used to match ANY
        // recent eBay-sourced order, falsely flagging every new import.
        mockFetchSequence([
            { orders: [] }, // tag search
            { orders: [] }, // source_identifier search
            {
                orders: [
                    { id: 1, name: '#1001', source_name: 'ebay', note: 'eBay Order: 99-99999-88888' },
                ],
            },
        ]);
        const result = await findExistingShopifyOrder('token', '11-22222-33333');
        expect(result).toBeNull();
    });
    it('matches when the eBay order ID appears in the note', async () => {
        mockFetchSequence([
            { orders: [] },
            { orders: [] },
            {
                orders: [
                    { id: 2, name: '#1002', source_name: '12345', note: 'eBay Order: 11-22222-33333' },
                ],
            },
        ]);
        const result = await findExistingShopifyOrder('token', '11-22222-33333');
        expect(result).toEqual({ id: 2, name: '#1002' });
    });
    it('matches when the eBay order ID appears in the tags', async () => {
        mockFetchSequence([
            { orders: [] },
            { orders: [] },
            {
                orders: [
                    { id: 3, name: '#1003', tags: 'eBay, eBay-11-22222-33333', note: '' },
                ],
            },
        ]);
        const result = await findExistingShopifyOrder('token', '11-22222-33333');
        expect(result).toEqual({ id: 3, name: '#1003' });
    });
});
