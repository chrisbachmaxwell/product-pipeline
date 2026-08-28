/**
 * Bounded per-product Shopify content reader for the listing draft editor.
 *
 * The bulk catalog sweep captures identity, price and stock for ~2,100
 * variants on a refresh timer. Description HTML and media belong to the
 * PRODUCT and are only needed when one draft is open, so pulling them into
 * that sweep would add megabytes to every refresh for data almost none of it
 * uses. This reads them for exactly one product, on demand.
 *
 * Same shape as the other exact readers: one host, one GraphQL document, GET
 * semantics (a POST is required by the GraphQL endpoint, but the document is
 * a fixed query and can mutate nothing), a response cap, a timeout, and
 * `redirect: 'error'`. Failures redact to a single fixed code — no token,
 * URL, query, or provider body escapes.
 */
import { safeShopifyImageUrl } from './live-listing-catalog-source.js';
const SHOPIFY_ADMIN_ORIGIN = 'https://usedcameragear.myshopify.com';
const SHOPIFY_ADMIN_PATH = '/admin/api/2023-10/graphql.json';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** The create manifest rejects more than 24 images; ask for no more. */
const MAX_IMAGES = 24;
const MAX_DESCRIPTION_CHARACTERS = 500_000;
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d{1,32}$/u;
const PRODUCT_CONTENT_QUERY = `query ListingDraftProductContent($id: ID!) {
  product(id: $id) {
    id
    descriptionHtml
    media(first: ${MAX_IMAGES}) {
      nodes {
        ... on MediaImage { image { url } }
      }
    }
  }
}`;
export class ShopifyProductContentError extends Error {
    constructor() {
        super('Shopify product content is unavailable');
        this.name = 'ShopifyProductContentError';
    }
}
function fail() {
    throw new ShopifyProductContentError();
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
export function createShopifyProductContentReader(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    return async (productGid) => {
        if (typeof productGid !== 'string' || !PRODUCT_GID_PATTERN.test(productGid))
            fail();
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            fail();
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096)
            fail();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let status = 0;
        let text = '';
        try {
            const response = await fetchImpl(`${SHOPIFY_ADMIN_ORIGIN}${SHOPIFY_ADMIN_PATH}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': token,
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    query: PRODUCT_CONTENT_QUERY,
                    variables: { id: productGid },
                }),
                redirect: 'error',
                signal: controller.signal,
            });
            const declared = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
                fail();
            text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
                fail();
            status = response.status;
        }
        catch (error) {
            if (error instanceof ShopifyProductContentError)
                throw error;
            fail();
        }
        finally {
            clearTimeout(timeout);
        }
        if (status !== 200)
            fail();
        let body;
        try {
            body = asRecord(JSON.parse(text));
        }
        catch {
            return fail();
        }
        if (body === null || body.errors !== undefined)
            fail();
        const product = asRecord(asRecord(body.data)?.product);
        if (product === null)
            fail();
        // The response must be the product that was asked for, never a redirect
        // or a substituted id.
        if (product.id !== productGid)
            fail();
        const rawDescription = product.descriptionHtml;
        const descriptionHtml = typeof rawDescription === 'string'
            && rawDescription.length > 0
            && rawDescription.length <= MAX_DESCRIPTION_CHARACTERS
            ? rawDescription
            : null;
        const nodes = asRecord(product.media)?.nodes;
        const imageUrls = [];
        if (Array.isArray(nodes)) {
            for (const node of nodes) {
                if (imageUrls.length >= MAX_IMAGES)
                    break;
                // Non-image media (video, 3D) has no `image` and is simply skipped.
                const url = safeShopifyImageUrl(asRecord(asRecord(node)?.image)?.url);
                if (url !== null && !imageUrls.includes(url))
                    imageUrls.push(url);
            }
        }
        return Object.freeze({
            descriptionHtml,
            imageUrls: Object.freeze(imageUrls),
        });
    };
}
export const SHOPIFY_PRODUCT_CONTENT_TESTING = Object.freeze({
    MAX_IMAGES,
    MAX_RESPONSE_BYTES,
    REQUEST_TIMEOUT_MS,
    MAX_DESCRIPTION_CHARACTERS,
    SHOPIFY_ADMIN_ORIGIN,
    SHOPIFY_ADMIN_PATH,
});
