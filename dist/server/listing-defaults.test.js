import { describe, expect, it } from 'vitest';
import { categoryQueryFromTitle, conditionFromTags, createListingDefaultsReader, } from './listing-defaults.js';
describe('condition from the store condition tag', () => {
    it('maps every grade on the store chart to its eBay condition id', () => {
        expect(conditionFromTags(['condition-like-new-minus'])?.id).toBe('2750');
        expect(conditionFromTags(['condition-like-new'])?.id).toBe('2750');
        expect(conditionFromTags(['condition-excellent-plus'])?.id).toBe('3000');
        expect(conditionFromTags(['lens', 'condition-excellent'])?.id).toBe('3000');
        expect(conditionFromTags(['condition-excellent-minus'])?.id).toBe('4000');
        expect(conditionFromTags(['condition-good'])?.id).toBe('5000');
        expect(conditionFromTags(['condition-poor'])?.id).toBe('6000');
        expect(conditionFromTags(['condition-ugly'])?.id).toBe('7000');
    });
    it('carries the store chart language as the condition description', () => {
        const excellent = conditionFromTags(['condition-excellent']);
        expect(excellent?.description).toContain('normal signs of use');
        expect(excellent?.description).toContain('75–90%');
        const poor = conditionFromTags(['condition-poor']);
        expect(poor?.description).toContain('still fully operational');
    });
    it('returns null with no tag, an unknown grade, or no tags at all', () => {
        expect(conditionFromTags(['lens', 'canon'])).toBeNull();
        expect(conditionFromTags(['condition-mystery'])).toBeNull();
        expect(conditionFromTags(undefined)).toBeNull();
    });
});
describe('category query derivation', () => {
    it('strips store decorations before asking eBay', () => {
        expect(categoryQueryFromTitle('Canon Angle Finder C (#002) *USED*'))
            .toBe('Canon Angle Finder C');
        expect(categoryQueryFromTitle('Aputure 2-Bay V-Mount Battery *OPEN BOX*'))
            .toBe('Aputure 2-Bay V-Mount Battery');
    });
});
describe('assembled defaults', () => {
    const snapshot = { rows: [] };
    const observations = [];
    it('combines tag condition, most-used policies, and the top category suggestion', async () => {
        const read = createListingDefaultsReader({
            getSnapshot: async () => snapshot,
            getSweepObservations: () => observations,
            searchCategories: async () => ({
                categories: [{ id: '30059', name: 'Viewfinders', usedByStore: false }],
            }),
        });
        const defaults = await read({
            title: 'Canon Angle Finder C (#002) *USED*',
            productTags: ['condition-excellent'],
        });
        expect(defaults.conditionId).toBe('3000');
        expect(defaults.conditionDescription).toContain('75–90%');
        expect(defaults.categoryId).toBe('30059');
        expect(defaults.categoryName).toBe('Viewfinders');
    });
    it('caches category suggestions per cleaned title', async () => {
        let calls = 0;
        const read = createListingDefaultsReader({
            getSnapshot: async () => snapshot,
            getSweepObservations: () => observations,
            searchCategories: async () => {
                calls += 1;
                return { categories: [{ id: '99', name: 'X', usedByStore: false }] };
            },
        });
        await read({ title: 'Unique Cached Lens (#900) *USED*', productTags: [] });
        await read({ title: 'Unique Cached Lens (#901) *USED*', productTags: [] });
        // Different (#) suffixes clean to the same query — one eBay call.
        expect(calls).toBe(1);
    });
    it('degrades to nulls when every source fails', async () => {
        const read = createListingDefaultsReader({
            getSnapshot: async () => { throw new Error('down'); },
            getSweepObservations: () => { throw new Error('down'); },
            searchCategories: async () => { throw new Error('down'); },
        });
        const defaults = await read({ title: 'Something Broken', productTags: undefined });
        expect(defaults).toMatchObject({
            conditionId: null, categoryId: null, fulfillmentPolicyId: null,
        });
    });
});
