/**
 * Contract tests for GET /api/listing-description-preview: exact DTO shape,
 * 404 for unknown rows, one generic 503 for every other failure, and no leak
 * of internal error detail. The draft read is injected; no store, network,
 * or provider access occurs.
 */
import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { buildListingDescriptionPreviewInput, createShadowApiRouter, SHADOW_API_GET_PATHS, } from './shadow-api.js';
import { ListingDraftServiceError, } from '../listing-draft-service.js';
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000563491';
function field(input = {}) {
    return { shopify: null, ebay: null, draft: null, editable: true, ...input };
}
function draftDto(overrides = {}) {
    return {
        schemaVersion: 1,
        mode: 'local_draft_only',
        catalogId: CATALOG_ID,
        identity: {
            shopifyProductGid: 'gid://shopify/Product/10310708035875',
            shopifyVariantGid: 'gid://shopify/ProductVariant/55396000563491',
            rawSku: 'CAN3570-U119',
            ebaySellerId: 'usedcameragear',
            ebayMarketplaceId: 'EBAY_US',
            managementModel: 'inventory_api',
            ebayInventorySku: 'CAN3570-U119',
            ebayOfferId: '234942877011',
            ebayListingId: '147502608418',
        },
        base: {
            catalogObservedAtUtc: '2026-08-14T21:59:00.000Z',
            detailObservedAtUtc: '2026-08-14T22:00:01.000Z',
            sourceDigest: `sha256:${'a'.repeat(64)}`,
            ebayDigest: `sha256:${'b'.repeat(64)}`,
        },
        revision: null,
        sections: {
            listing: {
                title: field({
                    shopify: 'Shopify Title',
                    ebay: 'Canon 35-70mm f/3.5-4.5 FD Zoom (#119) *USED*',
                    draft: overrides.titleDraft ?? null,
                }),
                category: field({ ebay: '3323' }),
                condition: field({ ebay: '3000', draft: overrides.conditionDraft ?? null }),
                conditionDescription: field({
                    ebay: 'Excellent condition.',
                    draft: overrides.conditionNoteDraft ?? null,
                }),
                price: field({ editable: false }),
                quantity: field({ editable: false }),
            },
            content: {
                description: field({
                    ebay: overrides.descriptionObserved !== undefined
                        ? overrides.descriptionObserved
                        : 'Observed plain text with <angle> & ampersand.',
                    draft: overrides.descriptionDraft ?? null,
                }),
                images: field({
                    ebay: overrides.imagesObserved !== undefined
                        ? overrides.imagesObserved
                        : JSON.stringify(['https://i.ebayimg.com/images/g/abc/s-l1600.jpg']),
                }),
                itemSpecifics: field({ editable: false }),
                identifiers: field({ editable: false }),
            },
            delivery: {
                fulfillmentPolicyId: field({ ebay: '111' }),
                paymentPolicyId: field({ ebay: '222' }),
                returnPolicyId: field({ ebay: '333' }),
                merchantLocation: field({ ebay: 'warehouse-1' }),
            },
        },
        capabilities: { saveDraft: false, previewChanges: true, apply: false, publish: false },
        externalWritesPerformed: 0,
    };
}
async function requestPreview(router, pathname = `/api/listing-description-preview?id=${encodeURIComponent(CATALOG_ID)}`) {
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
            throw new Error('no test server address');
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
function router(getListingDraft) {
    return createShadowApiRouter({
        getSnapshot: async () => { throw new Error('snapshot must not be read'); },
        getListingDraft,
    });
}
describe('GET /api/listing-description-preview', () => {
    it('is registered on the shadow GET allowlist', () => {
        expect(SHADOW_API_GET_PATHS).toContain('/api/listing-description-preview');
    });
    it('renders the branded template for the exact requested row', async () => {
        const requested = [];
        const response = await requestPreview(router(async (id) => {
            requested.push(id);
            return draftDto();
        }));
        expect(requested).toEqual([CATALOG_ID]);
        expect(response.status).toBe(200);
        expect(Object.keys(response.body).sort()).toEqual(['html', 'templateVersion']);
        expect(response.body.templateVersion).toBe('ucg-branded-v1');
        const html = response.body.html;
        expect(html.startsWith('<!-- template:ucg-branded-v1 -->')).toBe(true);
        expect(html).toContain('Canon 35-70mm f/3.5-4.5 FD Zoom (#119) *USED*');
        expect(html).toContain('<span class="ucg-condition">Used</span>');
        expect(html).toContain('SKU: CAN3570-U119');
        // The observed plain-text description is escaped into one paragraph.
        expect(html).toContain('<p>Observed plain text with &lt;angle&gt; &amp; ampersand.</p>');
        expect(html).toContain('https://i.ebayimg.com/images/g/abc/s-l1600.jpg');
        expect(html).not.toMatch(/<script|<iframe|<object|<embed|<form|<link|javascript:/i);
    });
    it('prefers saved draft overrides for title, condition, note, and description', async () => {
        const response = await requestPreview(router(async () => draftDto({
            titleDraft: 'Operator Title',
            descriptionDraft: '<p>Draft description with <b>markup</b>.</p>',
            conditionDraft: '1500',
            conditionNoteDraft: 'Open box, never mounted.',
        })));
        expect(response.status).toBe(200);
        const html = response.body.html;
        expect(html).toContain('<h1 class="ucg-title">Operator Title</h1>');
        expect(html).toContain('<p>Draft description with <b>markup</b>.</p>');
        expect(html).toContain('<span class="ucg-condition">New other (open box)</span>');
        expect(html).toContain('Open box, never mounted.');
    });
    it('returns 404 for an unknown row without detail leakage', async () => {
        const response = await requestPreview(router(async () => {
            throw new ListingDraftServiceError('LISTING_DRAFT_NOT_FOUND');
        }));
        expect(response).toEqual({ status: 404, body: { error: 'Listing was not found' } });
    });
    it('maps every other failure to one generic 503 without internals', async () => {
        const secretError = await requestPreview(router(async () => {
            throw new Error('Bearer super-secret-token upstream detail');
        }));
        expect(secretError).toEqual({
            status: 503,
            body: { error: 'Description preview is unavailable' },
        });
        expect(JSON.stringify(secretError)).not.toMatch(/super-secret-token|Bearer|upstream/);
        const unavailable = await requestPreview(router(async () => {
            throw new ListingDraftServiceError('LISTING_DRAFT_UNAVAILABLE');
        }));
        expect(unavailable).toEqual({
            status: 503,
            body: { error: 'Description preview is unavailable' },
        });
        // A DTO that renders to invalid template input (http image) also fails
        // closed with the same generic 503.
        const badImage = await requestPreview(router(async () => draftDto({
            imagesObserved: JSON.stringify(['http://insecure.example.com/a.jpg']),
        })));
        expect(badImage).toEqual({
            status: 503,
            body: { error: 'Description preview is unavailable' },
        });
    });
    it('builds the exact deterministic template input from the draft DTO', () => {
        expect(buildListingDescriptionPreviewInput(draftDto())).toEqual({
            templateVersion: 'ucg-branded-v1',
            title: 'Canon 35-70mm f/3.5-4.5 FD Zoom (#119) *USED*',
            bodyHtml: '<p>Observed plain text with &lt;angle&gt; &amp; ampersand.</p>',
            conditionId: '3000',
            conditionNote: 'Excellent condition.',
            imageUrls: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'],
            sku: 'CAN3570-U119',
        });
        expect(buildListingDescriptionPreviewInput(draftDto({
            descriptionObserved: null,
            imagesObserved: null,
        }))).toMatchObject({ bodyHtml: '', imageUrls: [] });
    });
});
