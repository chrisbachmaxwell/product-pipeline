import { describe, expect, it } from 'vitest';
import { brandFromVendor, createShopifyProductContentReader, mpnFromSku, normalizedGtin, ShopifyProductContentError, SHOPIFY_PRODUCT_CONTENT_TESTING, } from './shopify-product-content.js';
const PRODUCT_GID = 'gid://shopify/Product/10333721723171';
const VARIANT_GID = 'gid://shopify/ProductVariant/55484011151651';
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
        const content = await read(PRODUCT_GID, VARIANT_GID);
        expect(content.descriptionHtml).toBe('<p>A compact wireless flash controller.</p>');
        expect(content.imageUrls).toEqual([
            `${CDN}/a.jpg?v=1787071340`,
            `${CDN}/b.jpg?v=1787071339`,
        ]);
    });
    it('posts exactly one request to the pinned Shopify admin endpoint', async () => {
        const { read, calls } = createReader();
        await read(PRODUCT_GID, VARIANT_GID);
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
        const content = await read(PRODUCT_GID, VARIANT_GID);
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
        const content = await read(PRODUCT_GID, VARIANT_GID);
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
        await expect(read(PRODUCT_GID, VARIANT_GID)).rejects.toBeInstanceOf(ShopifyProductContentError);
    });
    it('rejects a malformed product gid without contacting Shopify', async () => {
        const { read, calls } = createReader();
        await expect(read('not-a-gid', VARIANT_GID)).rejects.toBeInstanceOf(ShopifyProductContentError);
        await expect(read('gid://shopify/ProductVariant/123', VARIANT_GID)).rejects
            .toBeInstanceOf(ShopifyProductContentError);
        expect(calls).toHaveLength(0);
    });
    it('fails closed on GraphQL errors, a missing product, and a non-200', async () => {
        await expect(createReader({ body: { errors: [{ message: 'boom' }] } }).read(PRODUCT_GID, VARIANT_GID))
            .rejects.toBeInstanceOf(ShopifyProductContentError);
        await expect(createReader({ body: { data: { product: null } } }).read(PRODUCT_GID, VARIANT_GID))
            .rejects.toBeInstanceOf(ShopifyProductContentError);
        await expect(createReader({ status: 401 }).read(PRODUCT_GID, VARIANT_GID))
            .rejects.toBeInstanceOf(ShopifyProductContentError);
    });
    it('never leaks the token through a failure', async () => {
        const { read } = createReader({ tokenThrows: true });
        try {
            await read(PRODUCT_GID, VARIANT_GID);
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
    it('sources brand, mpn and upc from the product and its exact variant', async () => {
        const { read } = createReader({
            body: {
                data: {
                    product: {
                        id: PRODUCT_GID,
                        vendor: 'Sony',
                        descriptionHtml: '<p>x</p>',
                        media: { nodes: [] },
                    },
                    productVariant: {
                        id: VARIANT_GID,
                        sku: 'ILCE7M3/B-U406',
                        barcode: '27242910768',
                    },
                },
            },
        });
        const content = await read(PRODUCT_GID, VARIANT_GID);
        expect(content.brand).toBe('Sony');
        expect(content.mpn).toBe('ILCE7M3/B');
        // 11 digits zero-padded to a 12-digit UPC-A so eBay sees one product.
        expect(content.upc).toBe('027242910768');
    });
    it('drops identifiers when the variant does not match the one requested', async () => {
        const { read } = createReader({
            body: {
                data: {
                    product: {
                        id: PRODUCT_GID, vendor: 'Canon', descriptionHtml: null, media: { nodes: [] },
                    },
                    productVariant: {
                        id: 'gid://shopify/ProductVariant/999', sku: 'X-U1', barcode: '012345678905',
                    },
                },
            },
        });
        const content = await read(PRODUCT_GID, VARIANT_GID);
        // Brand is product-level so it survives; variant-derived fields do not.
        expect(content.brand).toBe('Canon');
        expect(content.mpn).toBeNull();
        expect(content.upc).toBeNull();
    });
    it('rejects a malformed variant gid without contacting Shopify', async () => {
        const { read, calls } = createReader();
        await expect(read(PRODUCT_GID, 'not-a-variant')).rejects
            .toBeInstanceOf(ShopifyProductContentError);
        expect(calls).toHaveLength(0);
    });
});
describe('shopify field mappings', () => {
    it('strips only the per-unit suffix from a SKU', () => {
        // Real SKUs from the live catalog.
        expect(mpnFromSku('ILCE7M3/B-U406')).toBe('ILCE7M3/B');
        expect(mpnFromSku('2882A001-U002')).toBe('2882A001');
        expect(mpnFromSku('MT-24EX-U167')).toBe('MT-24EX');
        expect(mpnFromSku('STE2-U809')).toBe('STE2');
        // Condition tags are NOT unit numbers and are left intact rather than
        // guessed at — a slightly long MPN beats an invented one.
        expect(mpnFromSku('APD0170A3B-OB')).toBe('APD0170A3B-OB');
        expect(mpnFromSku('AP30126A20-DISP')).toBe('AP30126A20-DISP');
        expect(mpnFromSku(null)).toBeNull();
        expect(mpnFromSku('  ')).toBeNull();
    });
    it('normalizes barcodes to a 12 or 13 digit GTIN', () => {
        // The catalog stores this same product both ways.
        expect(normalizedGtin('27242910768')).toBe('027242910768');
        expect(normalizedGtin('027242910768')).toBe('027242910768');
        expect(normalizedGtin('0123456789012')).toBe('0123456789012');
        expect(normalizedGtin('012-345-678905')).toBe('012345678905');
        expect(normalizedGtin('12345')).toBeNull();
        expect(normalizedGtin('not-a-barcode')).toBeNull();
        expect(normalizedGtin(null)).toBeNull();
    });
    it('refuses the store name as a brand', () => {
        expect(brandFromVendor('Canon', 'usedcameragear')).toBe('Canon');
        expect(brandFromVendor('Leica', 'usedcameragear')).toBe('Leica');
        // The exact miss found on the ST-E2 product, plus casing/spacing variants.
        expect(brandFromVendor('usedcameragear', 'usedcameragear')).toBeNull();
        expect(brandFromVendor('Used Camera Gear', 'usedcameragear')).toBeNull();
        expect(brandFromVendor('  ', 'usedcameragear')).toBeNull();
        expect(brandFromVendor(null, 'usedcameragear')).toBeNull();
    });
});
