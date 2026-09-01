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
/** Guards against listing the store itself as a product's Brand. */
const STORE_NAME = 'usedcameragear';
const SHOPIFY_ADMIN_PATH = '/admin/api/2023-10/graphql.json';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** The create manifest rejects more than 24 images; ask for no more. */
const MAX_IMAGES = 24;
const MAX_DESCRIPTION_CHARACTERS = 500_000;
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d{1,32}$/u;

const PRODUCT_CONTENT_QUERY = `query ListingDraftProductContent($id: ID!, $variantId: ID!) {
  product(id: $id) {
    id
    vendor
    descriptionHtml
    media(first: ${MAX_IMAGES}) {
      nodes {
        ... on MediaImage { image { url } }
      }
    }
  }
  productVariant(id: $variantId) {
    id
    sku
    barcode
  }
}`;

const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/\d{1,32}$/u;
/** Unit tag this store appends to the manufacturer part number: `-U` + serial. */
const UNIT_TAG = '-U';

/**
 * Manufacturer part number, derived by removing this store's unit tag.
 *
 * The store's convention, per the operator: the SKU is the manufacturer part
 * number, then `-U`, then the last three of that unit's serial number.
 * Everything from `-U` onward — including the `-U` itself — is the unit tag,
 * not the part number.
 *
 * An earlier version required digits after `-U`. That was wrong on real data:
 * serials contain letters and units can carry an extra tag, so
 * `SEL24F14GM-U84M-new` and `16443058-U` (2 of 174 live SKUs) were left whole.
 * The split is therefore on the LAST `-U`, which keeps a part number that
 * legitimately contains `-U` earlier in the string intact.
 *
 * Other trailing tags with no `-U` (`-OB` open box, `-DISP` display) are
 * condition markers whose relationship to the part number is not established,
 * so they are left alone: a slightly long MPN is harmless, an invented one is
 * not. MPN is an optional free-text aspect on eBay.
 */
export function mpnFromSku(sku: string | null | undefined): string | null {
  if (typeof sku !== 'string') return null;
  const trimmed = sku.trim();
  if (trimmed === '' || trimmed.length > 128) return null;
  const cut = trimmed.toLocaleUpperCase('en-US').lastIndexOf(UNIT_TAG);
  const stripped = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  return stripped === '' ? null : stripped;
}

/**
 * Normalized GTIN from the Shopify barcode field, or null when it is absent
 * or not a recognizable UPC/EAN.
 *
 * The live catalog stores the same product's UPC inconsistently — A7 III
 * units carry both `027242910768` and `27242910768`. eBay treats those as
 * different products, so an 11-digit value is zero-padded to a 12-digit
 * UPC-A. Only 12-digit (UPC-A) and 13-digit (EAN-13) results are accepted.
 */
export function normalizedGtin(barcode: string | null | undefined): string | null {
  if (typeof barcode !== 'string') return null;
  const digits = barcode.trim().replace(/[\s-]/gu, '');
  if (!/^\d+$/u.test(digits)) return null;
  const padded = digits.length === 11 ? `0${digits}` : digits;
  return padded.length === 12 || padded.length === 13 ? padded : null;
}

/**
 * Brand from the Shopify vendor field, or null when it cannot be trusted.
 *
 * Verified populated across the catalog (Canon, Leica, Fujifilm, Sony,
 * Aputure, Hasselblad, Tamron, DJI). The guard exists because at least one
 * product carried the STORE name in `vendor` instead of a real brand, and
 * listing "usedcameragear" as the Brand is worse than leaving it for the
 * operator: this returns null so the field stays visibly empty.
 */
export function brandFromVendor(
  vendor: string | null | undefined,
  storeName: string,
): string | null {
  if (typeof vendor !== 'string') return null;
  const trimmed = vendor.trim();
  if (trimmed === '' || trimmed.length > 65) return null;
  const folded = trimmed.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
  const foldedStore = storeName.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
  if (folded === '' || folded === foldedStore) return null;
  return trimmed;
}

export class ShopifyProductContentError extends Error {
  constructor() {
    super('Shopify product content is unavailable');
    this.name = 'ShopifyProductContentError';
  }
}

export type ShopifyProductContent = Readonly<{
  /** Raw Shopify description HTML, or null when the product has none. */
  descriptionHtml: string | null;
  /** Product media, in Shopify order, already host- and shape-validated. */
  imageUrls: readonly string[];
  /** Shopify `vendor`, when it is a trustworthy brand. eBay aspect "Brand". */
  brand: string | null;
  /** SKU minus the unit suffix. eBay aspect "MPN". */
  mpn: string | null;
  /** Normalized 12/13-digit GTIN from the variant barcode. */
  upc: string | null;
}>;

type FetchLike = typeof fetch;

function fail(): never {
  throw new ShopifyProductContentError();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createShopifyProductContentReader(dependencies: Readonly<{
  getAccessToken: () => Promise<string>;
  fetchImpl?: FetchLike;
}>) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  return async (
    productGid: string,
    variantGid: string,
  ): Promise<ShopifyProductContent> => {
    if (typeof productGid !== 'string' || !PRODUCT_GID_PATTERN.test(productGid)) fail();
    if (typeof variantGid !== 'string' || !VARIANT_GID_PATTERN.test(variantGid)) fail();

    let token = '';
    try {
      token = await dependencies.getAccessToken();
    } catch {
      fail();
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) fail();

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
          variables: { id: productGid, variantId: variantGid },
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail();
      text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail();
      status = response.status;
    } catch (error) {
      if (error instanceof ShopifyProductContentError) throw error;
      fail();
    } finally {
      clearTimeout(timeout);
    }
    if (status !== 200) fail();

    let body: Record<string, unknown> | null;
    try {
      body = asRecord(JSON.parse(text));
    } catch {
      return fail();
    }
    if (body === null || body.errors !== undefined) fail();
    const product = asRecord(asRecord(body.data)?.product);
    if (product === null) fail();
    // The response must be the product that was asked for, never a redirect
    // or a substituted id.
    if (product.id !== productGid) fail();

    const rawDescription = product.descriptionHtml;
    const descriptionHtml = typeof rawDescription === 'string'
      && rawDescription.length > 0
      && rawDescription.length <= MAX_DESCRIPTION_CHARACTERS
      ? rawDescription
      : null;

    const nodes = asRecord(product.media)?.nodes;
    const imageUrls: string[] = [];
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (imageUrls.length >= MAX_IMAGES) break;
        // Non-image media (video, 3D) has no `image` and is simply skipped.
        const url = safeShopifyImageUrl(asRecord(asRecord(node)?.image)?.url as string | undefined);
        if (url !== null && !imageUrls.includes(url)) imageUrls.push(url);
      }
    }

    // The variant is optional: a missing or mismatched one costs identifiers,
    // never the whole read, so description and images still reach the editor.
    const variant = asRecord(asRecord(body.data)?.productVariant);
    const variantMatches = variant !== null && variant.id === variantGid;

    return Object.freeze({
      descriptionHtml,
      imageUrls: Object.freeze(imageUrls),
      brand: brandFromVendor(product.vendor as string | undefined, STORE_NAME),
      mpn: variantMatches ? mpnFromSku(variant.sku as string | undefined) : null,
      upc: variantMatches ? normalizedGtin(variant.barcode as string | undefined) : null,
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
