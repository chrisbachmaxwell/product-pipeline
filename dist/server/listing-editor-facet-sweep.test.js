import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createEditorFacetSweep, EDITOR_FACET_SWEEP_TESTING, } from './listing-editor-facet-sweep.js';
import { buildListingEditorMetadata } from './listing-editor-metadata.js';
import { createShadowApiRouter } from './routes/shadow-api.js';
function snapshotWith(input) {
    return {
        observedAtUtc: new Date().toISOString(),
        rows: input.rows ?? [],
        ...(input.editorFacets === undefined ? {} : { editorFacets: input.editorFacets }),
    };
}
function activeRow(rowId, listingId, lifecycleStatus = 'active') {
    return { id: rowId, lifecycleStatus, ebay: { sku: `SKU-${rowId}`, listingId } };
}
function workspaceDto(listingId, facets = {}) {
    return {
        ebayDetail: {
            identity: { listingId },
            actual: {
                category: {
                    primary: { id: facets.categoryId ?? null, name: facets.categoryName ?? null },
                },
                policies: {
                    fulfillmentPolicyId: facets.fulfillmentPolicyId ?? null,
                    paymentPolicyId: facets.paymentPolicyId ?? null,
                    returnPolicyId: facets.returnPolicyId ?? null,
                },
            },
            management: {
                offer: { merchantLocationKey: facets.merchantLocationKey ?? null },
            },
        },
    };
}
function facetObservation(listingId, overrides = {}) {
    return {
        listingId,
        categoryId: null,
        categoryName: null,
        fulfillmentPolicyId: null,
        paymentPolicyId: null,
        returnPolicyId: null,
        merchantLocationKey: null,
        ...overrides,
    };
}
async function requestJson(router, pathname) {
    const app = express();
    app.use(router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Test server address unavailable');
        return await new Promise((resolve, reject) => {
            const request = http.get({ hostname: '127.0.0.1', port: address.port, path: pathname }, (response) => {
                let raw = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { raw += chunk; });
                response.on('end', () => {
                    try {
                        resolve({
                            status: response.statusCode ?? 0,
                            body: JSON.parse(raw),
                        });
                    }
                    catch (error) {
                        reject(error);
                    }
                });
            });
            request.on('error', reject);
        });
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (!error || error.code === 'ERR_SERVER_NOT_RUNNING')
                    resolve();
                else
                    reject(error);
            });
        });
    }
}
describe('listing editor used-facet enrichment sweep', () => {
    it('never blocks the caller: returns nothing pre-sweep, aggregates after settling', async () => {
        const readIds = [];
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => snapshotWith({
                rows: [activeRow('row-1', '100'), activeRow('row-2', '200')],
            }),
            readListingDetail: async (rowId) => {
                readIds.push(rowId);
                return workspaceDto(rowId === 'row-1' ? '100' : '200', {
                    categoryId: '30088',
                    categoryName: 'Battery Grips',
                    fulfillmentPolicyId: '297085892011',
                    merchantLocationKey: 'warehouse-1',
                });
            },
        });
        expect(sweep.getObservations()).toEqual([]);
        await sweep.settle();
        expect(readIds.sort()).toEqual(['row-1', 'row-2']);
        const observations = sweep.getObservations();
        expect(observations).toHaveLength(2);
        expect(observations.map((observation) => observation.listingId).sort())
            .toEqual(['100', '200']);
        expect(observations[0]).toMatchObject({
            categoryId: '30088',
            categoryName: 'Battery Grips',
            fulfillmentPolicyId: '297085892011',
            paymentPolicyId: null,
            returnPolicyId: null,
            merchantLocationKey: 'warehouse-1',
        });
    });
    it('sweeps only active rows bound to a listing, deduplicated, capped at 150', async () => {
        const rows = [
            ...Array.from({ length: 160 }, (_value, index) => activeRow(`row-${index}`, `listing-${index}`)),
            activeRow('row-dup', 'listing-0'),
            activeRow('row-attention', 'listing-x', 'attention'),
            { id: 'row-unlisted', lifecycleStatus: 'active', ebay: { listingId: null } },
            'not-a-record',
        ];
        const identities = EDITOR_FACET_SWEEP_TESTING.collectSweepIdentities(snapshotWith({ rows }));
        expect(EDITOR_FACET_SWEEP_TESTING.MAX_SWEEP_LISTINGS).toBe(150);
        expect(identities).toHaveLength(150);
        expect(identities[0]).toBe('row-0');
        expect(identities[149]).toBe('row-149');
        expect(identities).not.toContain('row-dup');
        expect(identities).not.toContain('row-attention');
        expect(identities).not.toContain('row-unlisted');
    });
    it('keeps at most three detail reads in flight and reads at most 150 listings', async () => {
        let active = 0;
        let maxActive = 0;
        let reads = 0;
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => snapshotWith({
                rows: Array.from({ length: 160 }, (_value, index) => activeRow(`row-${index}`, `listing-${index}`)),
            }),
            readListingDetail: async (rowId) => {
                reads += 1;
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 1));
                active -= 1;
                return workspaceDto(rowId.replace('row-', 'listing-'), { categoryId: '30088' });
            },
        });
        sweep.getObservations();
        await sweep.settle();
        expect(reads).toBe(150);
        expect(EDITOR_FACET_SWEEP_TESTING.SWEEP_CONCURRENCY).toBe(3);
        expect(maxActive).toBe(3);
        expect(sweep.getObservations()).toHaveLength(150);
    });
    it('skips per-listing failures and unusable details without failing the sweep', async () => {
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => snapshotWith({
                rows: [
                    activeRow('row-ok', '100'),
                    activeRow('row-throws', '200'),
                    activeRow('row-no-detail', '300'),
                    activeRow('row-no-facets', '400'),
                ],
            }),
            readListingDetail: async (rowId) => {
                if (rowId === 'row-throws')
                    throw new Error('Bearer secret detail failure');
                if (rowId === 'row-no-detail')
                    return { ebayDetail: null };
                if (rowId === 'row-no-facets')
                    return workspaceDto('400');
                return workspaceDto('100', { categoryId: '30088', categoryName: 'Battery Grips' });
            },
        });
        sweep.getObservations();
        await sweep.settle();
        const observations = sweep.getObservations();
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({ listingId: '100', categoryId: '30088' });
    });
    it('runs at most one sweep at a time', async () => {
        let snapshotReads = 0;
        let release = null;
        const gate = new Promise((resolve) => { release = resolve; });
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => {
                snapshotReads += 1;
                return snapshotWith({ rows: [activeRow('row-1', '100')] });
            },
            readListingDetail: async () => {
                await gate;
                return workspaceDto('100', { categoryId: '30088' });
            },
        });
        sweep.getObservations();
        sweep.getObservations();
        sweep.getObservations();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(snapshotReads).toBe(1);
        release();
        await sweep.settle();
        expect(sweep.getObservations()).toHaveLength(1);
        expect(snapshotReads).toBe(1);
    });
    it('caches the aggregate for six hours, then refreshes in the background', async () => {
        let epoch = 1_000_000;
        let sweeps = 0;
        let categoryName = 'First Name';
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => {
                sweeps += 1;
                return snapshotWith({ rows: [activeRow('row-1', '100')] });
            },
            readListingDetail: async () => workspaceDto('100', { categoryId: '30088', categoryName }),
            now: () => epoch,
        });
        sweep.getObservations();
        await sweep.settle();
        expect(sweeps).toBe(1);
        // Within the TTL the cached aggregate is reused with no new sweep.
        epoch += EDITOR_FACET_SWEEP_TESTING.SWEEP_TTL_MS - 1;
        expect(sweep.getObservations()[0]).toMatchObject({ categoryName: 'First Name' });
        await sweep.settle();
        expect(sweeps).toBe(1);
        // Past the TTL the stale aggregate is still served while one background
        // refresh runs; the next read sees the refreshed data.
        epoch += 2;
        categoryName = 'Second Name';
        expect(sweep.getObservations()[0]).toMatchObject({ categoryName: 'First Name' });
        await sweep.settle();
        expect(sweeps).toBe(2);
        expect(sweep.getObservations()[0]).toMatchObject({ categoryName: 'Second Name' });
    });
    it('does not cache a failed snapshot read, so the next request retries', async () => {
        let snapshotReads = 0;
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => {
                snapshotReads += 1;
                if (snapshotReads === 1)
                    throw new Error('snapshot unavailable');
                return snapshotWith({ rows: [activeRow('row-1', '100')] });
            },
            readListingDetail: async () => workspaceDto('100', { categoryId: '30088' }),
        });
        sweep.getObservations();
        await sweep.settle();
        expect(sweep.getObservations()).toEqual([]);
        await sweep.settle();
        expect(snapshotReads).toBe(2);
        expect(sweep.getObservations()).toHaveLength(1);
    });
    it('merges sweep names over nameless snapshot facet entries without double-counting', () => {
        const snapshot = snapshotWith({
            editorFacets: [
                facetObservation('100', { categoryId: '30088', fulfillmentPolicyId: '297085892011' }),
                facetObservation('200', { categoryId: '11724', categoryName: 'Film Cameras' }),
            ],
        });
        const metadata = buildListingEditorMetadata(snapshot, [
            // Same listing as the nameless snapshot entry: contributes the name,
            // fills the missing location, and is counted once.
            facetObservation('100', {
                categoryId: '30088',
                categoryName: 'Battery Grips',
                merchantLocationKey: 'warehouse-1',
            }),
            // Sweep-only listing.
            facetObservation('300', { categoryId: '30088', categoryName: 'Battery Grips' }),
        ]);
        expect(metadata.categories).toEqual([
            { id: '30088', name: 'Battery Grips', usageCount: 2 },
            { id: '11724', name: 'Film Cameras', usageCount: 1 },
        ]);
        expect(metadata.policies.fulfillment).toEqual([
            { id: '297085892011', usageCount: 1 },
        ]);
        expect(metadata.merchantLocations).toEqual([{ id: 'warehouse-1', usageCount: 1 }]);
    });
    it('lets sweep data win over a conflicting snapshot category for the same listing', () => {
        const snapshot = snapshotWith({
            editorFacets: [
                facetObservation('100', { categoryId: '99999', categoryName: 'Stale Name' }),
            ],
        });
        const metadata = buildListingEditorMetadata(snapshot, [
            facetObservation('100', { categoryId: '30088', categoryName: 'Battery Grips' }),
        ]);
        expect(metadata.categories).toEqual([
            { id: '30088', name: 'Battery Grips', usageCount: 1 },
        ]);
    });
    it('drops malformed sweep observations without failing the request', () => {
        const metadata = buildListingEditorMetadata(snapshotWith({}), [
            'not-a-record',
            facetObservation('bad\u0000listing', { categoryId: 'x'.repeat(257) }),
            facetObservation('100', {
                categoryId: 42,
                categoryName: 7,
                fulfillmentPolicyId: 'x'.repeat(257),
                merchantLocationKey: '   ',
            }),
            facetObservation('200', { categoryId: '30088', categoryName: 'Battery Grips' }),
        ]);
        expect(metadata.categories).toEqual([
            { id: '30088', name: 'Battery Grips', usageCount: 1 },
        ]);
        expect(metadata.policies).toEqual({ fulfillment: [], payment: [], return: [] });
        expect(metadata.merchantLocations).toEqual([]);
    });
    it('serves pre-sweep metadata immediately, then sweep-enriched names, via the route', async () => {
        const snapshot = snapshotWith({
            rows: [activeRow('row-1', '147502608418')],
            editorFacets: [
                facetObservation('147502608418', {
                    categoryId: '30088',
                    fulfillmentPolicyId: '297085892011',
                }),
            ],
        });
        const sweep = createEditorFacetSweep({
            getSnapshot: async () => snapshot,
            readListingDetail: async () => workspaceDto('147502608418', {
                categoryId: '30088',
                categoryName: 'Battery Grips',
                fulfillmentPolicyId: '297085892011',
                merchantLocationKey: 'warehouse-1',
            }),
        });
        const router = createShadowApiRouter({
            getSnapshot: async () => snapshot,
            facetSweep: sweep,
        });
        // The first request never waits for the sweep it just started.
        const before = await requestJson(router, '/api/listing-editor-metadata');
        expect(before.status).toBe(200);
        expect(before.body.categories).toEqual([
            { id: '30088', name: null, usageCount: 1 },
        ]);
        expect(before.body.merchantLocations).toEqual([]);
        await sweep.settle();
        const after = await requestJson(router, '/api/listing-editor-metadata');
        expect(after.status).toBe(200);
        expect(after.body.categories).toEqual([
            { id: '30088', name: 'Battery Grips', usageCount: 1 },
        ]);
        expect(after.body.policies.fulfillment).toEqual([
            { id: '297085892011', usageCount: 1 },
        ]);
        expect(after.body.merchantLocations).toEqual([{ id: 'warehouse-1', usageCount: 1 }]);
    });
});
