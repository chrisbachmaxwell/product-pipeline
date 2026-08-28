import { parseStringPromise } from 'xml2js';
import { loadEbayCredentials } from '../config/credentials.js';
import { warn } from '../utils/logger.js';
import { openShadowDatabase } from './shadow-db.js';
import {
  buildLiveListingCatalogSnapshot,
  LiveListingCatalogError,
  type CapturedEbayActiveListing,
  type CapturedEbayInventoryItem,
  type CapturedEbayOffer,
  type CapturedShopifyVariant,
  type LiveListingCatalogSnapshot,
} from './live-listing-catalog.js';

const SHOPIFY_STORE_DOMAIN = 'usedcameragear.myshopify.com';
const SHOPIFY_SHOP_ID = 'gid://shopify/Shop/86254518563';
const SHOPIFY_API_VERSION = '2026-07';
const EBAY_EXPECTED_SELLER = 'usedcameragear';
const EBAY_MARKETPLACE_ID = 'EBAY_US';
const EBAY_TOKEN_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
] as const;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SNAPSHOT_TTL_MS = 60_000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60_000;

export const LISTING_CATALOG_FAILURE_CODES = Object.freeze([
  'AUTH_READ_FAILED',
  'TOKEN_REFRESH_FAILED',
  'SHOPIFY_CAPTURE_FAILED',
  'TRADING_CAPTURE_FAILED',
  'INVENTORY_CAPTURE_FAILED',
  'PROJECTION_FAILED',
] as const);
type ListingCatalogFailureCode = (typeof LISTING_CATALOG_FAILURE_CODES)[number];

type FetchLike = typeof fetch;

export type RuntimeAuthMaterial = Readonly<{
  shopifyAccessToken: string;
  ebayRefreshToken: string;
  ebayAppId: string;
  ebayCertId: string;
}>;

type TransientEbayToken = Readonly<{
  accessToken: string;
  expiresIn: number;
}>;

function deny(): never {
  throw new LiveListingCatalogError();
}

async function catalogPhase<T>(
  code: ListingCatalogFailureCode,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    warn(`LISTING_CATALOG_${code}`);
    return deny();
  }
}

function catalogProjection<T>(code: ListingCatalogFailureCode, operation: () => T): T {
  try {
    return operation();
  } catch {
    warn(`LISTING_CATALOG_${code}`);
    return deny();
  }
}

function safeInteger(value: unknown, minimum = 0): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : deny();
}

function safeText(value: unknown, maximum = 512): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : deny();
}

function optionalText(value: unknown, maximum = 512): string | null {
  return value == null ? null : safeText(value, maximum);
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : deny();
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function readRuntimeAuthMaterial(): Promise<RuntimeAuthMaterial> {
  const database = openShadowDatabase();
  try {
    const rows = database.prepare(
      `SELECT platform, access_token, refresh_token
       FROM auth_tokens
       WHERE platform IN ('shopify', 'ebay')`,
    ).all() as Array<{ platform: string; access_token: string; refresh_token: string | null }>;
    const shopify = rows.find((row) => row.platform === 'shopify');
    const ebay = rows.find((row) => row.platform === 'ebay');
    const ebayCredentials = await loadEbayCredentials();
    const ebayAppId = ebayCredentials.appId;
    const ebayCertId = ebayCredentials.certId;
    if (!shopify?.access_token || !ebay?.refresh_token || !ebayAppId || !ebayCertId) deny();
    return Object.freeze({
      shopifyAccessToken: shopify.access_token,
      ebayRefreshToken: ebay.refresh_token,
      ebayAppId,
      ebayCertId,
    });
  } finally {
    database.close();
  }
}

async function boundedFetchText(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) deny();
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) deny();
    return { status: response.status, ok: response.ok, text };
  } catch {
    return deny();
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedFetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Record<string, any>> {
  const response = await boundedFetchText(fetchImpl, url, init);
  if (!response.ok) deny();
  try {
    return asRecord(JSON.parse(response.text));
  } catch {
    return deny();
  }
}

export function createTransientEbayTokenProvider(dependencies: Readonly<{
  loadAuth: () => Promise<RuntimeAuthMaterial>;
  exchange: (auth: RuntimeAuthMaterial) => Promise<TransientEbayToken>;
  now?: () => number;
}>) {
  const now = dependencies.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  let flight: Promise<string> | null = null;

  return async (): Promise<string> => {
    if (cached && cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS > now()) return cached.token;
    if (flight) return flight;
    flight = (async () => {
      const issued = await dependencies.exchange(await dependencies.loadAuth());
      if (!issued.accessToken || !Number.isInteger(issued.expiresIn) || issued.expiresIn <= 300) deny();
      cached = { token: issued.accessToken, expiresAt: now() + issued.expiresIn * 1_000 };
      return issued.accessToken;
    })();
    try {
      return await flight;
    } finally {
      flight = null;
    }
  };
}

export async function exchangeRuntimeEbayToken(
  auth: RuntimeAuthMaterial,
  fetchImpl: FetchLike = fetch,
): Promise<TransientEbayToken> {
  const basic = Buffer.from(`${auth.ebayAppId}:${auth.ebayCertId}`).toString('base64');
  const body = await boundedFetchJson(fetchImpl, 'https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.ebayRefreshToken,
      scope: EBAY_TOKEN_SCOPES.join(' '),
    }),
  });
  const returnedScopes = body.scope === undefined
    ? null
    : safeText(body.scope, 1024).split(/\s+/).filter(Boolean).sort();
  if (body.token_type !== 'User Access Token'
    || (returnedScopes !== null
      && JSON.stringify(returnedScopes) !== JSON.stringify([...EBAY_TOKEN_SCOPES].sort()))) deny();
  return Object.freeze({
    accessToken: safeText(body.access_token, 4096),
    expiresIn: safeInteger(body.expires_in, 1),
  });
}

const runtimeEbayToken = createTransientEbayTokenProvider({
  loadAuth: readRuntimeAuthMaterial,
  exchange: exchangeRuntimeEbayToken,
});

/**
 * Internal read-authority seam for exact eBay GET detail readers. Callers must
 * never return, persist, or log the token and must retain the same account and
 * method allowlists as this module.
 */
export async function getRuntimeEbayReadToken(): Promise<string> {
  return catalogPhase('TOKEN_REFRESH_FAILED', runtimeEbayToken);
}

/**
 * Same read-authority seam for the exact Shopify GET readers. The bulk
 * catalog sweep deliberately does NOT carry per-product description or media
 * — that is thousands of variants of payload refreshed on a timer for data
 * only one open draft needs — so the draft path reads it per item and needs
 * the same stored token. Callers must never return, persist, or log it.
 */
export async function getRuntimeShopifyReadToken(): Promise<string> {
  const auth = await catalogPhase('TOKEN_REFRESH_FAILED', readRuntimeAuthMaterial);
  return auth.shopifyAccessToken;
}

const SHOPIFY_PREFLIGHT = `query RuntimeListingCatalogPreflight {
  shop { id myshopifyDomain currencyCode }
  currentAppInstallation { accessScopes { handle } }
}`;

const SHOPIFY_VARIANTS = `query RuntimeListingCatalogVariants($first: Int!, $after: String) {
  productVariants(first: $first, after: $after, sortKey: ID) {
    nodes {
      id sku title price inventoryQuantity updatedAt image { url }
      product {
        id title status updatedAt mediaCount { count }
        featuredMedia { preview { image { url } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function shopifyGraphql(
  accessToken: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const body = await boundedFetchJson(
    fetch,
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ operationName, query, variables }),
    },
  );
  if (body.errors !== undefined || !body.data) deny();
  return asRecord(body.data);
}

/**
 * Accept a Shopify CDN image URL, or null when it is absent or not exactly
 * that shape.
 *
 * This previously required an empty query string, which rejected EVERY image
 * in the store: Shopify serves every CDN asset with a `?v=<epoch>`
 * cache-buster. Verified against Production — 0 of 156 image-bearing rows
 * resolved a URL — which made `preflight-create` deny
 * `CREATE_REQUIRED_FIELD_MISSING: images` for every possible listing, so no
 * listing could ever be created.
 *
 * The safety property is the pinned scheme and host, not the absence of a
 * query. The version parameter is benign and identifies the exact asset
 * revision, so it is preserved rather than stripped. It is accepted ONLY in
 * that exact shape — a single `v` key whose value is all digits; any other
 * parameter, any fragment, any other host or scheme still rejects.
 */
export function safeShopifyImageUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let image: URL;
  try {
    image = new URL(value);
  } catch {
    return null;
  }
  if (image.protocol !== 'https:' || image.hostname !== 'cdn.shopify.com') return null;
  if (image.hash !== '') return null;
  if (image.search !== '') {
    const keys = [...image.searchParams.keys()];
    if (keys.length !== 1
      || keys[0] !== 'v'
      || !/^\d{1,20}$/u.test(image.searchParams.get('v') ?? '')) return null;
  }
  return image.toString();
}

async function captureShopify(accessToken: string): Promise<{
  variants: CapturedShopifyVariant[];
  coverage: Omit<LiveListingCatalogSnapshot['coverage']['shopify'], never>;
}> {
  const preflight = await shopifyGraphql(
    accessToken,
    'RuntimeListingCatalogPreflight',
    SHOPIFY_PREFLIGHT,
  );
  const shop = asRecord(preflight.shop);
  const installation = asRecord(preflight.currentAppInstallation);
  const scopes = asArray(installation.accessScopes).map((scope) =>
    safeText(asRecord(scope).handle, 128));
  if (shop.id !== SHOPIFY_SHOP_ID || shop.myshopifyDomain !== SHOPIFY_STORE_DOMAIN
    || !scopes.includes('read_products') || !scopes.includes('read_inventory')) deny();
  const currency = safeText(shop.currencyCode, 16);

  const variants: CapturedShopifyVariant[] = [];
  const seenVariantIds = new Set<string>();
  const seenCursors = new Set<string>();
  const productStatusCounts: Record<string, number> = {};
  let excludedZeroInventory = 0;
  let excludedUnknownInventory = 0;
  let totalVariantsCaptured = 0;
  let after: string | null = null;
  let pageCount = 0;

  for (; pageCount < 100; pageCount += 1) {
    const data = await shopifyGraphql(
      accessToken,
      'RuntimeListingCatalogVariants',
      SHOPIFY_VARIANTS,
      { first: 100, after },
    );
    const connection = asRecord(data.productVariants);
    const nodes = asArray(connection.nodes);
    const pageInfo = asRecord(connection.pageInfo);
    if (nodes.length > 100) deny();
    for (const raw of nodes) {
      const node = asRecord(raw);
      const variantId = safeText(node.id, 256);
      if (seenVariantIds.has(variantId)) deny();
      seenVariantIds.add(variantId);
      totalVariantsCaptured += 1;
      const product = asRecord(node.product);
      const productStatus = safeText(product.status, 32).toUpperCase();
      productStatusCounts[productStatus] = (productStatusCounts[productStatus] ?? 0) + 1;
      let available: number | null = null;
      if (node.inventoryQuantity == null || !Number.isInteger(node.inventoryQuantity)) {
        excludedUnknownInventory += 1;
      } else {
        available = node.inventoryQuantity as number;
      }
      if (available !== null && available <= 0) {
        excludedZeroInventory += 1;
      }
      const imageValue = optionalText(node.image?.url ?? product.featuredMedia?.preview?.image?.url, 2048);
      const primaryImageUrl = safeShopifyImageUrl(imageValue);
      variants.push(Object.freeze({
        productId: safeText(product.id, 256),
        variantId,
        sku: node.sku == null || node.sku === '' ? '' : safeText(node.sku, 128),
        title: safeText(product.title, 512),
        variantTitle: safeText(node.title, 256),
        productStatus,
        primaryImageUrl,
        imageCount: safeInteger(asRecord(product.mediaCount).count),
        available,
        price: Object.freeze({ amount: safeText(node.price, 64), currency }),
      }));
    }
    const hasNextPage = pageInfo.hasNextPage;
    if (typeof hasNextPage !== 'boolean') deny();
    if (!hasNextPage) {
      pageCount += 1;
      break;
    }
    if (pageCount === 99) deny();
    const cursor = safeText(pageInfo.endCursor, 512);
    if (seenCursors.has(cursor) || nodes.length === 0) deny();
    seenCursors.add(cursor);
    after = cursor;
  }
  if (pageCount === 0 || pageCount > 100) deny();
  const observedAtUtc = new Date().toISOString();
  return {
    variants,
    coverage: Object.freeze({
      source: 'shopify-admin-graphql' as const,
      storeDomain: SHOPIFY_STORE_DOMAIN,
      shopId: SHOPIFY_SHOP_ID,
      observedAtUtc,
      paginationComplete: true as const,
      variantPageCount: pageCount,
      totalVariantsCaptured,
      positiveStockVariants: variants.filter((variant) =>
        variant.available !== null && variant.available > 0).length,
      excludedZeroInventory,
      excludedUnknownInventory,
      productStatusCounts: Object.freeze({ ...productStatusCounts }),
    }),
  };
}


async function tradingCall(
  accessToken: string,
  callName: 'GetUser' | 'GetMyeBaySelling',
  body: string,
): Promise<Record<string, any>> {
  const response = await boundedFetchText(fetch, 'https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    body,
  });
  if (!response.ok) deny();
  let parsed: unknown;
  try {
    parsed = await parseStringPromise(response.text, {
      explicitArray: false,
      explicitRoot: true,
      trim: true,
      normalizeTags: false,
    });
  } catch {
    return deny();
  }
  const root = asRecord(parsed)[`${callName}Response`];
  const result = asRecord(root);
  if (result.Ack !== 'Success' || result.Errors !== undefined) deny();
  return result;
}

/**
 * Optional editor-facet extraction from already-captured census bodies.
 * These helpers never deny(): facet data is a best-effort byproduct of the
 * bulk reads, so an absent or malformed value is dropped per listing rather
 * than failing the whole capture.
 */
function facetRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function facetDigits(value: unknown, maximum: number): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : value;
  return typeof text === 'string' && text.length > 0 && text.length <= maximum
    && /^\d+$/u.test(text) ? text : null;
}

function facetText(value: unknown, maximum = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim().length > 0 && !/[\u0000-\u001F\u007F]/u.test(value)
    ? value
    : null;
}

type TradingListingFacets = Partial<Pick<CapturedEbayActiveListing,
  'primaryCategoryId' | 'primaryCategoryName'
  | 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId'>>;

/** Facets the GetMyeBaySelling item body already carries; keys only when valid. */
function tradingListingFacets(item: Record<string, any>): TradingListingFacets {
  const primary = facetRecord(item.PrimaryCategory);
  const profiles = facetRecord(item.SellerProfiles);
  const facets: Record<string, string> = {};
  const primaryCategoryId = facetDigits(primary?.CategoryID, 32);
  if (primaryCategoryId !== null) {
    facets.primaryCategoryId = primaryCategoryId;
    const primaryCategoryName = facetText(primary?.CategoryName, 256);
    if (primaryCategoryName !== null) facets.primaryCategoryName = primaryCategoryName;
  }
  const fulfillmentPolicyId = facetDigits(
    facetRecord(profiles?.SellerShippingProfile)?.ShippingProfileID, 64);
  if (fulfillmentPolicyId !== null) facets.fulfillmentPolicyId = fulfillmentPolicyId;
  const paymentPolicyId = facetDigits(
    facetRecord(profiles?.SellerPaymentProfile)?.PaymentProfileID, 64);
  if (paymentPolicyId !== null) facets.paymentPolicyId = paymentPolicyId;
  const returnPolicyId = facetDigits(
    facetRecord(profiles?.SellerReturnProfile)?.ReturnProfileID, 64);
  if (returnPolicyId !== null) facets.returnPolicyId = returnPolicyId;
  return Object.freeze(facets);
}

type OfferListingFacets = Partial<Pick<CapturedEbayOffer,
  'categoryId' | 'fulfillmentPolicyId' | 'paymentPolicyId'
  | 'returnPolicyId' | 'merchantLocationKey'>>;

/** Facets the bulk getOffers body already carries natively; keys only when valid. */
function offerListingFacets(offer: Record<string, any>): OfferListingFacets {
  const listingPolicies = facetRecord(offer.listingPolicies);
  const facets: Record<string, string> = {};
  const categoryId = facetDigits(offer.categoryId, 32);
  if (categoryId !== null) facets.categoryId = categoryId;
  const fulfillmentPolicyId = facetDigits(listingPolicies?.fulfillmentPolicyId, 64);
  if (fulfillmentPolicyId !== null) facets.fulfillmentPolicyId = fulfillmentPolicyId;
  const paymentPolicyId = facetDigits(listingPolicies?.paymentPolicyId, 64);
  if (paymentPolicyId !== null) facets.paymentPolicyId = paymentPolicyId;
  const returnPolicyId = facetDigits(listingPolicies?.returnPolicyId, 64);
  if (returnPolicyId !== null) facets.returnPolicyId = returnPolicyId;
  const merchantLocationKey = facetText(offer.merchantLocationKey, 256);
  if (merchantLocationKey !== null) facets.merchantLocationKey = merchantLocationKey;
  return Object.freeze(facets);
}

function activeSkuRecords(item: Record<string, any>, listingId: string): CapturedEbayActiveListing[] {
  const records: CapturedEbayActiveListing[] = [];
  const facets = tradingListingFacets(item);
  if (typeof item.SKU === 'string' && item.SKU.length <= 128 && item.SKU.length > 0) {
    records.push(Object.freeze({ listingId, sku: item.SKU, ...facets }));
  }
  for (const raw of asArray(item.Variations?.Variation)) {
    const variation = asRecord(raw);
    if (typeof variation.SKU === 'string' && variation.SKU.length <= 128 && variation.SKU.length > 0) {
      records.push(Object.freeze({ listingId, sku: variation.SKU, ...facets }));
    }
  }
  if (records.length === 0) records.push(Object.freeze({ listingId, sku: '', ...facets }));
  return records;
}

async function captureTrading(accessToken: string): Promise<{
  listings: CapturedEbayActiveListing[];
  pageCount: number;
  activeListingCount: number;
}> {
  const user = await tradingCall(
    accessToken,
    'GetUser',
    '<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"/>',
  );
  if (String(user.User?.UserID ?? '').toLocaleLowerCase('en-US') !== EBAY_EXPECTED_SELLER) deny();

  const listings: CapturedEbayActiveListing[] = [];
  const seenListingIds = new Set<string>();
  let expectedPages: number | null = null;
  let expectedEntries: number | null = null;
  let page = 1;
  for (; page <= 50; page += 1) {
    const result = await tradingCall(
      accessToken,
      'GetMyeBaySelling',
      `<?xml version="1.0" encoding="utf-8"?>\n<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><IncludeNotes>false</IncludeNotes><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><HideVariations>false</HideVariations><DetailLevel>ReturnAll</DetailLevel></GetMyeBaySellingRequest>`,
    );
    const active = result.ActiveList == null ? {} : asRecord(result.ActiveList);
    const pagination = active.PaginationResult == null ? {} : asRecord(active.PaginationResult);
    const totalPages = safeInteger(Number(pagination.TotalNumberOfPages ?? 0));
    const totalEntries = safeInteger(Number(pagination.TotalNumberOfEntries ?? 0));
    if (expectedPages === null) {
      expectedPages = totalPages;
      expectedEntries = totalEntries;
      if (totalPages > 50 || totalEntries > 10_000) deny();
    }
    if (totalPages !== expectedPages || totalEntries !== expectedEntries) deny();
    const items = asArray(active.ItemArray?.Item);
    if (items.length > 200 || (totalEntries > 0 && items.length === 0)) deny();
    for (const raw of items) {
      const item = asRecord(raw);
      const listingId = safeText(item.ItemID, 32);
      if (!/^\d+$/.test(listingId) || seenListingIds.has(listingId)) deny();
      seenListingIds.add(listingId);
      listings.push(...activeSkuRecords(item, listingId));
    }
    if (page >= totalPages) break;
  }
  if (expectedPages === null || expectedEntries === null || seenListingIds.size !== expectedEntries) deny();
  return { listings, pageCount: expectedPages, activeListingCount: expectedEntries };
}

async function inventoryGet(accessToken: string, path: string): Promise<Record<string, any>> {
  if (!path.startsWith('/sell/inventory/v1/')) deny();
  return boundedFetchJson(fetch, `https://api.ebay.com${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
    },
  });
}

function requireExactInventoryNext(value: unknown, expectedPath: string): void {
  const rawNext = safeText(value, 2048);
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(rawNext, 'https://api.ebay.com');
    expected = new URL(expectedPath, 'https://api.ebay.com');
  } catch {
    return deny();
  }
  const sortedParams = (url: URL): string => JSON.stringify(
    [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)),
  );
  if (actual.protocol !== 'https:' || actual.hostname !== 'api.ebay.com'
    || actual.username !== '' || actual.password !== '' || actual.hash !== ''
    || actual.pathname !== expected.pathname
    || sortedParams(actual) !== sortedParams(expected)) deny();
}

async function captureInventory(accessToken: string): Promise<{
  items: CapturedEbayInventoryItem[];
  offers: CapturedEbayOffer[];
  itemPages: number;
  offerPages: number;
}> {
  const items: CapturedEbayInventoryItem[] = [];
  const seenSkus = new Set<string>();
  let expectedItems: number | null = null;
  let offset = 0;
  let itemPages = 0;
  while (itemPages < 50) {
    const body = await inventoryGet(accessToken, `/sell/inventory/v1/inventory_item?limit=200&offset=${offset}`);
    itemPages += 1;
    const total = safeInteger(body.total);
    if (expectedItems === null) expectedItems = total;
    if (total !== expectedItems || total > 10_000) deny();
    const page = asArray(body.inventoryItems);
    if (page.length > 200 || (items.length < total && page.length === 0)) deny();
    for (const raw of page) {
      const sku = safeText(asRecord(raw).sku, 128);
      if (seenSkus.has(sku)) deny();
      seenSkus.add(sku);
      items.push(Object.freeze({ sku }));
    }
    if (items.length === total) break;
    if (items.length > total || typeof body.next !== 'string') deny();
    offset = items.length;
    requireExactInventoryNext(
      body.next,
      `/sell/inventory/v1/inventory_item?limit=200&offset=${offset}`,
    );
  }
  if (expectedItems === null || items.length !== expectedItems) deny();

  const offers: CapturedEbayOffer[] = [];
  const seenOfferIds = new Set<string>();
  let offerPages = 0;
  for (const item of items) {
    const priorOfferCount = offers.length;
    let expectedOffers: number | null = null;
    let collected = 0;
    let offerOffset = 0;
    while (offerPages < 500) {
      const query = new URLSearchParams({
        sku: item.sku,
        marketplace_id: EBAY_MARKETPLACE_ID,
        limit: '25',
        offset: String(offerOffset),
      });
      const body = await inventoryGet(accessToken, `/sell/inventory/v1/offer?${query.toString()}`);
      offerPages += 1;
      const total = safeInteger(body.total);
      if (expectedOffers === null) expectedOffers = total;
      if (total !== expectedOffers || priorOfferCount + total > 10_000) deny();
      const page = asArray(body.offers);
      if (page.length > 25 || (collected < total && page.length === 0)) deny();
      for (const raw of page) {
        const offer = asRecord(raw);
        const offerId = safeText(offer.offerId, 128);
        if (offer.sku !== item.sku || offer.marketplaceId !== EBAY_MARKETPLACE_ID
          || seenOfferIds.has(offerId)) deny();
        seenOfferIds.add(offerId);
        const listing = offer.listing == null ? null : asRecord(offer.listing);
        offers.push(Object.freeze({
          offerId,
          sku: item.sku,
          status: optionalText(offer.status, 64),
          listingId: optionalText(listing?.listingId, 32),
          listingStatus: optionalText(listing?.listingStatus, 64),
          ...offerListingFacets(offer),
        }));
        collected += 1;
      }
      if (collected === total) break;
      if (collected > total || typeof body.next !== 'string') deny();
      offerOffset = collected;
      const expectedNext = new URLSearchParams({
        sku: item.sku,
        marketplace_id: EBAY_MARKETPLACE_ID,
        limit: '25',
        offset: String(offerOffset),
      });
      requireExactInventoryNext(body.next, `/sell/inventory/v1/offer?${expectedNext.toString()}`);
    }
    if (expectedOffers === null || collected !== expectedOffers) deny();
  }
  return { items, offers, itemPages, offerPages };
}

export async function captureLiveListingCatalog(): Promise<LiveListingCatalogSnapshot> {
  const auth = await catalogPhase('AUTH_READ_FAILED', readRuntimeAuthMaterial);
  const accessToken = await catalogPhase('TOKEN_REFRESH_FAILED', runtimeEbayToken);
  const [shopify, trading, inventory] = await Promise.all([
    catalogPhase('SHOPIFY_CAPTURE_FAILED', () => captureShopify(auth.shopifyAccessToken)),
    catalogPhase('TRADING_CAPTURE_FAILED', () => captureTrading(accessToken)),
    catalogPhase('INVENTORY_CAPTURE_FAILED', () => captureInventory(accessToken)),
  ]);
  const ebayObservedAtUtc = new Date().toISOString();
  const observedAtUtc = new Date().toISOString();
  return catalogProjection('PROJECTION_FAILED', () => buildLiveListingCatalogSnapshot({
    observedAtUtc,
    shopifyVariants: shopify.variants,
    ebayActiveListings: trading.listings,
    ebayInventoryItems: inventory.items,
    ebayOffers: inventory.offers,
    coverage: Object.freeze({
      shopify: shopify.coverage,
      ebay: Object.freeze({
        source: 'ebay-trading-api+ebay-inventory-api' as const,
        marketplaceId: EBAY_MARKETPLACE_ID,
        sellerAccountVerified: true as const,
        observedAtUtc: ebayObservedAtUtc,
        trading: Object.freeze({
          paginationComplete: true as const,
          pageCount: trading.pageCount,
          activeListingCount: trading.activeListingCount,
        }),
        inventory: Object.freeze({
          inventoryItemsComplete: true as const,
          inventoryItemPageCount: inventory.itemPages,
          inventoryItemCount: inventory.items.length,
          offersComplete: true as const,
          offerPageCount: inventory.offerPages,
          offerCount: inventory.offers.length,
          unpublishedArtifactsChecked: true as const,
        }),
      }),
    }),
  }));
}

export function createLiveListingCatalogCache(
  capture: () => Promise<LiveListingCatalogSnapshot>,
  options: Readonly<{ now?: () => number; ttlMs?: number }> = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
  let cached: {
    value: LiveListingCatalogSnapshot;
    refreshedAt: number;
    expiresAt: number;
  } | null = null;
  let flight: Promise<LiveListingCatalogSnapshot> | null = null;
  let lastAttemptAt: number | null = null;
  let lastFailureAt: number | null = null;
  const refresh = async (): Promise<LiveListingCatalogSnapshot> => {
    if (flight) return flight;
    lastAttemptAt = now();
    flight = Promise.resolve().then(capture);
    try {
      const value = await flight;
      const refreshedAt = now();
      cached = { value, refreshedAt, expiresAt: refreshedAt + ttlMs };
      lastFailureAt = null;
      return value;
    } catch (error) {
      lastFailureAt = now();
      throw error;
    } finally {
      flight = null;
    }
  };
  const get = async (): Promise<LiveListingCatalogSnapshot> => {
    if (cached && cached.expiresAt > now()) return cached.value;
    try {
      return await refresh();
    } catch (error) {
      if (cached) return cached.value;
      throw error;
    }
  };
  return Object.assign(get, {
    refresh,
    status: () => Object.freeze({
      hasSuccessfulSnapshot: cached !== null,
      observedAtUtc: cached?.value.observedAtUtc ?? null,
      lastSuccessAtEpochMs: cached?.refreshedAt ?? null,
      lastAttemptAtEpochMs: lastAttemptAt,
      lastFailureAtEpochMs: lastFailureAt,
      expiresAtEpochMs: cached?.expiresAt ?? null,
      refreshInFlight: flight !== null,
    }),
  });
}

export type LiveListingCatalogCacheStatus = ReturnType<
  ReturnType<typeof createLiveListingCatalogCache>['status']
>;

export function hasUnresolvedLiveListingRefreshFailure(
  status: LiveListingCatalogCacheStatus | null | undefined,
): boolean {
  return status?.lastFailureAtEpochMs !== null
    && status?.lastFailureAtEpochMs !== undefined;
}

export const getLiveListingCatalogSnapshot = createLiveListingCatalogCache(captureLiveListingCatalog);

const LIVE_CATALOG_REFRESH_INTERVAL_MS = 60_000;

export function startLiveListingCatalogRefresher(
  cache: Readonly<{ refresh: () => Promise<unknown> }> = getLiveListingCatalogSnapshot,
  options: Readonly<{
    intervalMs?: number;
    setIntervalImpl?: typeof setInterval;
  }> = {},
): () => void {
  const intervalMs = options.intervalMs ?? LIVE_CATALOG_REFRESH_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 300_000) deny();
  const schedule = options.setIntervalImpl ?? setInterval;
  const timer = schedule(() => {
    void cache.refresh().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  void cache.refresh().catch(() => undefined);
  return () => clearInterval(timer);
}

export type LiveListingCatalogRouteDependencies = Readonly<{
  getSnapshot: () => Promise<LiveListingCatalogSnapshot>;
  getSnapshotStatus?: () => LiveListingCatalogCacheStatus;
}>;

export const LIVE_LISTING_CATALOG_SOURCE_TESTING = Object.freeze({
  catalogPhase,
  captureShopify,
  tradingCall,
  captureTrading,
  captureInventory,
  tradingListingFacets,
  offerListingFacets,
  LIVE_CATALOG_REFRESH_INTERVAL_MS,
});
