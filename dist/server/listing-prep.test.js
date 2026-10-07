import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAutofillMemo } from './listing-autofill.js';
import { getListingPrepStatus, resetListingPrepState, runListingPrep } from './listing-prep.js';
const SOURCE = `sha256:${'d'.repeat(64)}`;
const EBAY = `sha256:${'e'.repeat(64)}`;
function dto(title) {
    const field = (shopify) => ({ shopify, draft: null });
    return {
        revision: null,
        base: { sourceDigest: SOURCE, ebayDigest: EBAY },
        sections: {
            listing: {
                title: field(title), category: field('3323'), condition: field('3000'),
                conditionDescription: field(null),
            },
            content: {
                description: field(null), images: field(null),
                itemSpecifics: field(JSON.stringify({ Brand: ['Canon'] })),
            },
            delivery: {
                fulfillmentPolicyId: field(null), paymentPolicyId: field(null),
                returnPolicyId: field(null), merchantLocation: field(null),
            },
        },
    };
}
const rows = [
    { id: 'a', readyToList: true, shopify: { sku: 'LENS-1', title: 'Canon EF 50mm f/1.8' } },
    { id: 'b', readyToList: true, shopify: { sku: 'ODD-1', title: 'Mystery accessory' } },
    { id: 'c', readyToList: true, readyToListGaps: ['condition'], shopify: { sku: 'NOCOND', title: 'Thing' } },
    { id: 'd', readyToList: false, shopify: { sku: 'LISTED', title: 'Already on eBay' } },
    { id: 'e', readyToList: true, shopify: { sku: 'PIPELINE-TEST-1', title: 'Test' } },
];
function dependencies(overrides = {}) {
    const saved = [];
    return {
        saved,
        deps: {
            getSnapshot: async () => ({ rows }),
            draftService: {
                get: async (id) => dto(id === 'a' ? 'Canon EF 50mm f/1.8' : 'Mystery accessory'),
                save: async (request) => {
                    saved.push(request.catalogId);
                    return { revision: { revisionDigest: `sha256:${'f'.repeat(64)}` } };
                },
            },
            getCategoryAspects: async () => ({
                available: true,
                aspects: [{ name: 'Mount', required: true, mode: 'FREE_TEXT', values: [] }],
            }),
            createProposer: async () => async (input) => input.title.includes('EF') ? [{ name: 'Mount', value: 'Canon EF' }] : [],
            publishBusy: overrides.publishBusy ?? (() => false),
            sleep: async () => undefined,
            now: () => '2026-10-06T12:00:00.000Z',
        },
    };
}
beforeEach(() => { resetListingPrepState(); resetAutofillMemo(); });
afterEach(() => { resetListingPrepState(); });
describe('runListingPrep', () => {
    it('prepares every not-yet-listed product and lists what still needs a person', async () => {
        const harness = dependencies();
        expect(await runListingPrep(harness.deps)).toBe(true);
        expect(harness.saved).toEqual(['a']);
        const status = getListingPrepStatus();
        expect(status.aiArmed).toBe(true);
        expect(status.items.map((item) => [item.sku, item.state, item.filled, item.missing])).toEqual([
            ['NOCOND', 'needs_input', [], ['Condition']],
            ['ODD-1', 'needs_input', [], ['Mount']],
            ['LENS-1', 'ready', ['Mount'], []],
        ]);
    });
    it('stands aside while a publish run owns the drafts', async () => {
        const harness = dependencies({ publishBusy: () => true });
        expect(await runListingPrep(harness.deps)).toBe(false);
        expect(harness.saved).toEqual([]);
    });
    it('drops items that left the ready queue', async () => {
        const harness = dependencies();
        await runListingPrep(harness.deps);
        await runListingPrep({ ...harness.deps, getSnapshot: async () => ({ rows: [rows[0]] }) });
        expect(getListingPrepStatus().items.map((item) => item.sku)).toEqual(['LENS-1']);
    });
});
