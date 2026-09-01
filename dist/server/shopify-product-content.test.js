import { describe, expect, it } from 'vitest';
import { createShopifyProductContentReader, ShopifyProductContentError, SHOPIFY_PRODUCT_CONTENT_TESTING, } from './shopify-product-content.js';
const PRODUCT_GID = 'gid://shopify/Product/10333721723171';
const CDN = 'https://cdn.shopify.com/s/files/1/0862/5451/8563/files';
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function mediaNodes(urls) {
    return urls.map((url) => ({ image: { url } }));
}
function createReader(overrides = {}) {
    const calls = overrides.calls ?? [];
    const fetchImpl = (async (input, init) => {
        calls.push({ url: typeof input === 'string' ? input : input.toString(), init: init ?? {} });
        return jsonResponse(overrides.body ?? {
            data: {
                product: {
                    id: PRODUCT_GID,
                    descriptionHtml: '<p>A compact wireless flash controller.</p>',
                    media: { nodes: mediaNodes([`${CDN}/a.jpg?v=1787071340`, `${CDN}/b.jpg?v=1787071339`]) },
                },
            },
        }, overrides.status ?? 200);
    });
    return {
        calls,
        read: createShopifyProductContentReader({
            getAccessToken: async () => {
                if (overrides.tokenThrows)
                    throw new Error('no token');
                return overrides.token ?? 'shpat-test-token';
            },
            fetchImpl,
        }),
    };
}
describe('shopify product content reader', () => {
    it('returns the description and image urls for one product', async () => {
        const { read } = createReader();
        const content = await read(PRODUCT_GID);
        expect(content.descriptionHtml).toBe('<p>A compact wireless flash controller.</p>');
        expect(content.imageUrls).toEqual([
            `${CDN}/a.jpg?v=1787071340`,
            `${CDN}/b.jpg?v=1787071339`,
        ]);
    });
    it('posts exactly one request to the pinned Shopify admin endpoint', async () => {
        const { read, calls } = createReader();
        await read(PRODUCT_GID);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(SHOPIFY_PRODUCT_CONTENT_TESTING.SHOPIFY_ADMIN_ORIGIN
            + SHOPIFY_PRODUCT_CONTENT_TESTING.SHOPIFY_ADMIN_PATH);
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.redirect).toBe('error');
    });
    it('skips non-image media and urls that are not Shopify CDN images', async () => {
        const { read } = createReader({
            body: {
                data: {
                    product: {
                        id: PRODUCT_GID,
                        descriptionHtml: '<p>x</p>',
                        media: {
                            nodes: [
                                {},
                                { image: { url: `${CDN}/good.jpg?v=1` } },
                                { image: { url: 'https://evil.example.com/x.jpg' } },
                                { image: { url: `${CDN}/sized.jpg?width=100` } },
                                null,
                            ],
                        },
                    },
                },
            },
        });
        const content = await read(PRODUCT_GID);
        expect(content.imageUrls).toEqual([`${CDN}/good.jpg?v=1`]);
    });
    it('deduplicates repeated urls and caps at the manifest image limit', async () => {
        const many = Array.from({ length: 40 }, (_, index) => `${CDN}/img${index}.jpg?v=1`);
        const { read } = createReader({
            body: {
                data: {
                    product: {
                        id: PRODUCT_GID,
                        descriptionHtml: null,
                        media: { nodes: mediaNodes([`${CDN}/dupe.jpg?v=1`, `${CDN}/dupe.jpg?v=1`, ...many]) },
                    },
                },
            },
        });
        const content = await read(PRODUCT_GID);
        expect(content.imageUrls.length).toBe(SHOPIFY_PRODUCT_CONTENT_TESTING.MAX_IMAGES);
        expect(new Set(content.imageUrls).size).toBe(content.imageUrls.length);
        expect(content.descriptionHtml).toBeNull();
    });
    it('refuses a response for a different product than the one requested', async () => {
        const { read } = createReader({
            body: {
                data: {
                    product: {
                        id: 'gid://shopify/Product/99999999',
                        descriptionHtml: '<p>x</p>',
                        media: { nodes: [] },
                    },
                },
            },
        });
        await expect(read(PRODUCT_GID)).rejects.toBeInstanceOf(ShopifyProductContentError);
    });
    it('rejects a malformed product gid without contacting Shopify', async () => {
        const { read, calls } = createReader();
        await expect(read('not-a-gid')).rejects.toBeInstanceOf(ShopifyProductContentError);
        await expect(read('gid://shopify/ProductVariant/123')).rejects
            .toBeInstanceOf(ShopifyProductContentError);
        expect(calls).toHaveLength(0);
    });
    it('fails closed on GraphQL errors, a missing product, and a non-200', async () => {
        await expect(createReader({ body: { errors: [{ message: 'boom' }] } }).read(PRODUCT_GID))
            .rejects.toBeInstanceOf(ShopifyProductContentError);
        await expect(createReader({ body: { data: { product: null } } }).read(PRODUCT_GID))
            .rejects.toBeInstanceOf(ShopifyProductContentError);
        await expect(createReader({ status: 401 }).read(PRODUCT_GID))
            .rejects.toBeInstanceOf(ShopifyProductContentError);
    });
    it('never leaks the token through a failure', async () => {
        const { read } = createReader({ tokenThrows: true });
        try {
            await read(PRODUCT_GID);
            throw new Error('expected a denial');
        }
        catch (error) {
            expect(error).toBeInstanceOf(ShopifyProductContentError);
            expect(String(error.message)).not.toMatch(/shpat|token/i);
        }
    });
    it('asks for no more images than the create manifest accepts', () => {
        // parseImageList in the create manifest denies a list longer than 24.
        expect(SHOPIFY_PRODUCT_CONTENT_TESTING.MAX_IMAGES).toBe(24);
    });
});
