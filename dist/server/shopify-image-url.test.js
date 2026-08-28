import { describe, expect, it } from 'vitest';
import { safeShopifyImageUrl } from './live-listing-catalog-source.js';
/**
 * Regression cover for the image-URL rule that blocked every create.
 *
 * The rule required an empty query string. Shopify serves every CDN asset
 * with a `?v=<epoch>` cache-buster, so the catalog resolved `primaryImageUrl:
 * null` for the entire store (Production: 0 of 156 image-bearing rows), and
 * `preflight-create` denied `CREATE_REQUIRED_FIELD_MISSING: images` for every
 * possible listing.
 */
const REAL = 'https://cdn.shopify.com/s/files/1/0862/5451/8563/files/'
    + 'canonspeedlitetransmitterst-e2_809-001-JPEG-1.jpg';
describe('safeShopifyImageUrl', () => {
    it('accepts the exact URL shape Shopify actually serves', () => {
        // Captured verbatim from Production for SKU STE2-U809.
        const actual = `${REAL}?v=1787071340`;
        expect(safeShopifyImageUrl(actual)).toBe(actual);
    });
    it('preserves the version parameter rather than stripping it', () => {
        const resolved = safeShopifyImageUrl(`${REAL}?v=1787071340`);
        expect(resolved).toContain('?v=1787071340');
    });
    it('still accepts a URL with no query at all', () => {
        expect(safeShopifyImageUrl(REAL)).toBe(REAL);
    });
    it('rejects a foreign host', () => {
        expect(safeShopifyImageUrl('https://evil.example.com/x.jpg?v=1')).toBeNull();
        // A look-alike host must not pass on suffix similarity.
        expect(safeShopifyImageUrl('https://cdn.shopify.com.evil.example/x.jpg')).toBeNull();
    });
    it('rejects a non-https scheme', () => {
        expect(safeShopifyImageUrl(`http://cdn.shopify.com/x.jpg?v=1`)).toBeNull();
    });
    it('rejects any parameter other than a numeric v', () => {
        expect(safeShopifyImageUrl(`${REAL}?v=abc`)).toBeNull();
        expect(safeShopifyImageUrl(`${REAL}?width=100`)).toBeNull();
        expect(safeShopifyImageUrl(`${REAL}?v=1&width=100`)).toBeNull();
        expect(safeShopifyImageUrl(`${REAL}?vv=1`)).toBeNull();
        expect(safeShopifyImageUrl(`${REAL}?v=`)).toBeNull();
    });
    it('rejects a fragment', () => {
        expect(safeShopifyImageUrl(`${REAL}?v=1787071340#frag`)).toBeNull();
        expect(safeShopifyImageUrl(`${REAL}#frag`)).toBeNull();
    });
    it('rejects absent, empty, and unparseable values', () => {
        expect(safeShopifyImageUrl(null)).toBeNull();
        expect(safeShopifyImageUrl(undefined)).toBeNull();
        expect(safeShopifyImageUrl('')).toBeNull();
        expect(safeShopifyImageUrl('not a url')).toBeNull();
    });
});
