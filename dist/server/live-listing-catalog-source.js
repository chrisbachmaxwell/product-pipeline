import { parseStringPromise } from 'xml2js';
import { loadEbayCredentials } from '../config/credentials.js';
import { warn } from '../utils/logger.js';
import { openShadowDatabase } from './shadow-db.js';
import { buildLiveListingCatalogSnapshot, LiveListingCatalogError, } from './live-listing-catalog.js';
const SHOPIFY_STORE_DOMAIN = 'usedcameragear.myshopify.com';
const SHOPIFY_SHOP_ID = 'gid://shopify/Shop/86254518563';
const SHOPIFY_API_VERSION = '2026-07';
const EBAY_EXPECTED_SELLER = 'usedcameragear';
const EBAY_MARKETPLACE_ID = 'EBAY_US';
const EBAY_TOKEN_SCOPES = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
];
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
]);
function deny() {
    throw new LiveListingCatalogError();
}
async function catalogPhase(code, operation) {
    try {
        return await operation();
    }
    catch {
        warn(`LISTING_CATALOG_${code}`);
        return deny();
    }
}
function catalogProjection(code, operation) {
    try {
        return operation();
    }
    catch {
        warn(`LISTING_CATALOG_${code}`);
        return deny();
    }
}
function safeInteger(value, minimum = 0) {
    return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : deny();
}
function safeText(value, maximum = 512) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : deny();
}
function optionalText(value, maximum = 512) {
    return value == null ? null : safeText(value, maximum);
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : deny();
}
function asArray(value) {
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? value : [value];
}
async function readRuntimeAuthMaterial() {
    const database = openShadowDatabase();
    try {
        const rows = database.prepare(`SELECT platform, access_token, refresh_token
       FROM auth_tokens
       WHERE platform IN ('shopify', 'ebay')`).all();
        const shopify = rows.find((row) => row.platform === 'shopify');
        const ebay = rows.find((row) => row.platform === 'ebay');
        const ebayCredentials = await loadEbayCredentials();
        const ebayAppId = ebayCredentials.appId;
        const ebayCertId = ebayCredentials.certId;
        if (!shopify?.access_token || !ebay?.refresh_token || !ebayAppId || !ebayCertId)
            deny();
        return Object.freeze({
            shopifyAccessToken: shopify.access_token,
            ebayRefreshToken: ebay.refresh_token,
            ebayAppId,
            ebayCertId,
        });
    }
    finally {
        database.close();
    }
}
async function boundedFetchText(fetchImpl, url, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
            deny();
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
            deny();
        return { status: response.status, ok: response.ok, text };
    }
    catch {
        return deny();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function boundedFetchJson(fetchImpl, url, init) {
    const response = await boundedFetchText(fetchImpl, url, init);
    if (!response.ok)
        deny();
    try {
        return asRecord(JSON.parse(response.text));
    }
    catch {
        return deny();
    }
}
export function createTransientEbayTokenProvider(dependencies) {
    const now = dependencies.now ?? Date.now;
    let cached = null;
    let flight = null;
    return async () => {
        if (cached && cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS > now())
            return cached.token;
        if (flight)
            return flight;
        flight = (async () => {
            const issued = await dependencies.exchange(await dependencies.loadAuth());
            if (!issued.accessToken || !Number.isInteger(issued.expiresIn) || issued.expiresIn <= 300)
                deny();
            cached = { token: issued.accessToken, expiresAt: now() + issued.expiresIn * 1_000 };
            return issued.accessToken;
        })();
        try {
            return await flight;
        }
        finally {
            flight = null;
        }
    };
}
export async function exchangeRuntimeEbayToken(auth, fetchImpl = fetch) {
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
            && JSON.stringify(returnedScopes) !== JSON.stringify([...EBAY_TOKEN_SCOPES].sort())))
        deny();
    return Object.freeze({
        accessToken: safeText(body.access_token, 4096),
        expiresIn: safeInteger(body.expires_in, 1),
    });
}
const runtimeEbayToken = createTransientEbayTokenProvider({
    loadAuth: readRuntimeAuthMaterial,
    exchange: exchangeRuntimeEbayToken,
});
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
async function shopifyGraphql(accessToken, operationName, query, variables = {}) {
    const body = await boundedFetchJson(fetch, `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ operationName, query, variables }),
    });
    if (body.errors !== undefined || !body.data)
        deny();
    return asRecord(body.data);
}
async function captureShopify(accessToken) {
    const preflight = await shopifyGraphql(accessToken, 'RuntimeListingCatalogPreflight', SHOPIFY_PREFLIGHT);
    const shop = asRecord(preflight.shop);
    const installation = asRecord(preflight.currentAppInstallation);
    const scopes = asArray(installation.accessScopes).map((scope) => safeText(asRecord(scope).handle, 128));
    if (shop.id !== SHOPIFY_SHOP_ID || shop.myshopifyDomain !== SHOPIFY_STORE_DOMAIN
        || !scopes.includes('read_products') || !scopes.includes('read_inventory'))
        deny();
    const currency = safeText(shop.currencyCode, 16);
    const variants = [];
    const seenVariantIds = new Set();
    const seenCursors = new Set();
    const productStatusCounts = {};
    let excludedZeroInventory = 0;
    let excludedUnknownInventory = 0;
    let totalVariantsCaptured = 0;
    let after = null;
    let pageCount = 0;
    for (; pageCount < 100; pageCount += 1) {
        const data = await shopifyGraphql(accessToken, 'RuntimeListingCatalogVariants', SHOPIFY_VARIANTS, { first: 100, after });
        const connection = asRecord(data.productVariants);
        const nodes = asArray(connection.nodes);
        const pageInfo = asRecord(connection.pageInfo);
        if (nodes.length > 100)
            deny();
        for (const raw of nodes) {
            const node = asRecord(raw);
            const variantId = safeText(node.id, 256);
            if (seenVariantIds.has(variantId))
                deny();
            seenVariantIds.add(variantId);
            totalVariantsCaptured += 1;
            const product = asRecord(node.product);
            const productStatus = safeText(product.status, 32).toUpperCase();
            productStatusCounts[productStatus] = (productStatusCounts[productStatus] ?? 0) + 1;
            if (node.inventoryQuantity == null || !Number.isInteger(node.inventoryQuantity)) {
                excludedUnknownInventory += 1;
                continue;
            }
            const available = node.inventoryQuantity;
            if (available <= 0) {
                excludedZeroInventory += 1;
                continue;
            }
            const imageValue = optionalText(node.image?.url ?? product.featuredMedia?.preview?.image?.url, 2048);
            let primaryImageUrl = null;
            if (imageValue) {
                try {
                    const image = new URL(imageValue);
                    if (image.protocol === 'https:' && image.hostname === 'cdn.shopify.com'
                        && image.search === '' && image.hash === '')
                        primaryImageUrl = image.toString();
                }
                catch {
                    primaryImageUrl = null;
                }
            }
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
        if (typeof hasNextPage !== 'boolean')
            deny();
        if (!hasNextPage) {
            pageCount += 1;
            break;
        }
        if (pageCount === 99)
            deny();
        const cursor = safeText(pageInfo.endCursor, 512);
        if (seenCursors.has(cursor) || nodes.length === 0)
            deny();
        seenCursors.add(cursor);
        after = cursor;
    }
    if (pageCount === 0 || pageCount > 100)
        deny();
    const observedAtUtc = new Date().toISOString();
    return {
        variants,
        coverage: Object.freeze({
            source: 'shopify-admin-graphql',
            storeDomain: SHOPIFY_STORE_DOMAIN,
            shopId: SHOPIFY_SHOP_ID,
            observedAtUtc,
            paginationComplete: true,
            variantPageCount: pageCount,
            totalVariantsCaptured,
            positiveStockVariants: variants.length,
            excludedZeroInventory,
            excludedUnknownInventory,
            productStatusCounts: Object.freeze({ ...productStatusCounts }),
        }),
    };
}
async function tradingCall(accessToken, callName, body) {
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
    if (!response.ok)
        deny();
    let parsed;
    try {
        parsed = await parseStringPromise(response.text, {
            explicitArray: false,
            explicitRoot: true,
            trim: true,
            normalizeTags: false,
        });
    }
    catch {
        return deny();
    }
    const root = asRecord(parsed)[`${callName}Response`];
    const result = asRecord(root);
    if (result.Ack !== 'Success' || result.Errors !== undefined)
        deny();
    return result;
}
function activeSkuRecords(item, listingId) {
    const records = [];
    if (typeof item.SKU === 'string' && item.SKU.length <= 128 && item.SKU.length > 0) {
        records.push(Object.freeze({ listingId, sku: item.SKU }));
    }
    for (const raw of asArray(item.Variations?.Variation)) {
        const variation = asRecord(raw);
        if (typeof variation.SKU === 'string' && variation.SKU.length <= 128 && variation.SKU.length > 0) {
            records.push(Object.freeze({ listingId, sku: variation.SKU }));
        }
    }
    return records;
}
async function captureTrading(accessToken) {
    const user = await tradingCall(accessToken, 'GetUser', '<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"/>');
    if (String(user.User?.UserID ?? '').toLocaleLowerCase('en-US') !== EBAY_EXPECTED_SELLER)
        deny();
    const listings = [];
    const seenListingIds = new Set();
    let expectedPages = null;
    let expectedEntries = null;
    let page = 1;
    for (; page <= 50; page += 1) {
        const result = await tradingCall(accessToken, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>\n<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><IncludeNotes>false</IncludeNotes><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><HideVariations>false</HideVariations><DetailLevel>ReturnAll</DetailLevel></GetMyeBaySellingRequest>`);
        const active = result.ActiveList == null ? {} : asRecord(result.ActiveList);
        const pagination = active.PaginationResult == null ? {} : asRecord(active.PaginationResult);
        const totalPages = safeInteger(Number(pagination.TotalNumberOfPages ?? 0));
        const totalEntries = safeInteger(Number(pagination.TotalNumberOfEntries ?? 0));
        if (expectedPages === null) {
            expectedPages = totalPages;
            expectedEntries = totalEntries;
            if (totalPages > 50 || totalEntries > 10_000)
                deny();
        }
        if (totalPages !== expectedPages || totalEntries !== expectedEntries)
            deny();
        const items = asArray(active.ItemArray?.Item);
        if (items.length > 200 || (totalEntries > 0 && items.length === 0))
            deny();
        for (const raw of items) {
            const item = asRecord(raw);
            const listingId = safeText(item.ItemID, 32);
            if (!/^\d+$/.test(listingId) || seenListingIds.has(listingId))
                deny();
            seenListingIds.add(listingId);
            listings.push(...activeSkuRecords(item, listingId));
        }
        if (page >= totalPages)
            break;
    }
    if (expectedPages === null || expectedEntries === null || seenListingIds.size !== expectedEntries)
        deny();
    return { listings, pageCount: expectedPages, activeListingCount: expectedEntries };
}
async function inventoryGet(accessToken, path) {
    if (!path.startsWith('/sell/inventory/v1/'))
        deny();
    return boundedFetchJson(fetch, `https://api.ebay.com${path}`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Accept-Language': 'en-US',
        },
    });
}
function requireExactInventoryNext(value, expectedPath) {
    const rawNext = safeText(value, 2048);
    let actual;
    let expected;
    try {
        actual = new URL(rawNext, 'https://api.ebay.com');
        expected = new URL(expectedPath, 'https://api.ebay.com');
    }
    catch {
        return deny();
    }
    const sortedParams = (url) => JSON.stringify([...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)));
    if (actual.protocol !== 'https:' || actual.hostname !== 'api.ebay.com'
        || actual.username !== '' || actual.password !== '' || actual.hash !== ''
        || actual.pathname !== expected.pathname
        || sortedParams(actual) !== sortedParams(expected))
        deny();
}
async function captureInventory(accessToken) {
    const items = [];
    const seenSkus = new Set();
    let expectedItems = null;
    let offset = 0;
    let itemPages = 0;
    while (itemPages < 50) {
        const body = await inventoryGet(accessToken, `/sell/inventory/v1/inventory_item?limit=200&offset=${offset}`);
        itemPages += 1;
        const total = safeInteger(body.total);
        if (expectedItems === null)
            expectedItems = total;
        if (total !== expectedItems || total > 10_000)
            deny();
        const page = asArray(body.inventoryItems);
        if (page.length > 200 || (items.length < total && page.length === 0))
            deny();
        for (const raw of page) {
            const sku = safeText(asRecord(raw).sku, 128);
            if (seenSkus.has(sku))
                deny();
            seenSkus.add(sku);
            items.push(Object.freeze({ sku }));
        }
        if (items.length === total)
            break;
        if (items.length > total || typeof body.next !== 'string')
            deny();
        offset = items.length;
        requireExactInventoryNext(body.next, `/sell/inventory/v1/inventory_item?limit=200&offset=${offset}`);
    }
    if (expectedItems === null || items.length !== expectedItems)
        deny();
    const offers = [];
    const seenOfferIds = new Set();
    let offerPages = 0;
    for (const item of items) {
        const priorOfferCount = offers.length;
        let expectedOffers = null;
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
            if (expectedOffers === null)
                expectedOffers = total;
            if (total !== expectedOffers || priorOfferCount + total > 10_000)
                deny();
            const page = asArray(body.offers);
            if (page.length > 25 || (collected < total && page.length === 0))
                deny();
            for (const raw of page) {
                const offer = asRecord(raw);
                const offerId = safeText(offer.offerId, 128);
                if (offer.sku !== item.sku || offer.marketplaceId !== EBAY_MARKETPLACE_ID
                    || seenOfferIds.has(offerId))
                    deny();
                seenOfferIds.add(offerId);
                const listing = offer.listing == null ? null : asRecord(offer.listing);
                offers.push(Object.freeze({
                    offerId,
                    sku: item.sku,
                    status: optionalText(offer.status, 64),
                    listingId: optionalText(listing?.listingId, 32),
                    listingStatus: optionalText(listing?.listingStatus, 64),
                }));
                collected += 1;
            }
            if (collected === total)
                break;
            if (collected > total || typeof body.next !== 'string')
                deny();
            offerOffset = collected;
            const expectedNext = new URLSearchParams({
                sku: item.sku,
                marketplace_id: EBAY_MARKETPLACE_ID,
                limit: '25',
                offset: String(offerOffset),
            });
            requireExactInventoryNext(body.next, `/sell/inventory/v1/offer?${expectedNext.toString()}`);
        }
        if (expectedOffers === null || collected !== expectedOffers)
            deny();
    }
    return { items, offers, itemPages, offerPages };
}
export async function captureLiveListingCatalog() {
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
                source: 'ebay-trading-api+ebay-inventory-api',
                marketplaceId: EBAY_MARKETPLACE_ID,
                sellerAccountVerified: true,
                observedAtUtc: ebayObservedAtUtc,
                trading: Object.freeze({
                    paginationComplete: true,
                    pageCount: trading.pageCount,
                    activeListingCount: trading.activeListingCount,
                }),
                inventory: Object.freeze({
                    inventoryItemsComplete: true,
                    inventoryItemPageCount: inventory.itemPages,
                    inventoryItemCount: inventory.items.length,
                    offersComplete: true,
                    offerPageCount: inventory.offerPages,
                    offerCount: inventory.offers.length,
                    unpublishedArtifactsChecked: true,
                }),
            }),
        }),
    }));
}
export function createLiveListingCatalogCache(capture, options = {}) {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    let cached = null;
    let flight = null;
    return async () => {
        if (cached && cached.expiresAt > now())
            return cached.value;
        if (flight)
            return flight;
        flight = capture();
        try {
            const value = await flight;
            cached = { value, expiresAt: now() + ttlMs };
            return value;
        }
        finally {
            flight = null;
        }
    };
}
export const getLiveListingCatalogSnapshot = createLiveListingCatalogCache(captureLiveListingCatalog);
export const LIVE_LISTING_CATALOG_SOURCE_TESTING = Object.freeze({
    catalogPhase,
    captureShopify,
    tradingCall,
    captureTrading,
    captureInventory,
});
