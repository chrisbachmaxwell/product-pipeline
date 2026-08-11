/**
 * Shopify authoritative evidence collector.
 *
 * This module deliberately has no default transport, credential loader, environment
 * lookup, persistence, retry loop, or write operation. A caller must inject the only
 * dispatch capability, and every dispatched document is a static Admin GraphQL query.
 */
export const SHOPIFY_ADMIN_API_VERSION = '2026-07';
export const SHOPIFY_REQUIRED_READ_SCOPES = Object.freeze([
    'read_inventory',
    'read_orders',
    'read_products',
]);
const MAX_ORDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ORDER_WINDOW_LAG_MS = 15 * 60 * 1_000;
export const SHOPIFY_GRAPHQL_DOCUMENTS = Object.freeze({
    preflight: `query ProductPipelineShopifyPreflight {
  shop {
    id
    myshopifyDomain
    currencyCode
  }
  currentAppInstallation {
    id
    app {
      id
    }
    accessScopes {
      handle
    }
  }
}`,
    variants: `query ProductPipelineShopifyVariants($first: Int!, $after: String) {
  productVariants(first: $first, after: $after, sortKey: ID) {
    nodes {
      id
      sku
      price
      inventoryQuantity
      updatedAt
      product {
        id
        status
        updatedAt
      }
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 25, includeInactive: true) {
          nodes {
            id
            isActive
            updatedAt
            location {
              id
            }
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
    orders: `query ProductPipelineShopifyOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    nodes {
      id
      createdAt
      updatedAt
      app {
        id
        name
      }
      sourceName
      sourceIdentifier
      displayFinancialStatus
      displayFulfillmentStatus
      test
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
});
export class ShopifyReadError extends Error {
    code;
    constructor(code) {
        super(`Shopify authoritative read failed closed: ${code}`);
        this.name = 'ShopifyReadError';
        this.code = code;
    }
}
const CONFIG_KEYS = [
    'authorityExpiresAtUtc',
    'expectedAppId',
    'expectedShopId',
    'limits',
    'orderWindow',
    'storeDomain',
];
const LIMIT_KEYS = [
    'maxOrderPages',
    'maxRequests',
    'maxResponseBytes',
    'maxVariantPages',
    'orderPageSize',
    'variantPageSize',
];
const WINDOW_KEYS = ['endUtc', 'startUtc'];
const STORE_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SHOP_GID = /^gid:\/\/shopify\/Shop\/[A-Za-z0-9_-]+$/;
const APP_GID = /^gid:\/\/shopify\/App\/[A-Za-z0-9_-]+$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[A-Za-z0-9_-]+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[A-Za-z0-9_-]+$/;
const INVENTORY_ITEM_GID = /^gid:\/\/shopify\/InventoryItem\/[A-Za-z0-9_-]+$/;
const INVENTORY_LEVEL_GID = /^gid:\/\/shopify\/InventoryLevel\/[A-Za-z0-9_?=&-]+$/;
const LOCATION_GID = /^gid:\/\/shopify\/Location\/[A-Za-z0-9_-]+$/;
const ORDER_GID = /^gid:\/\/shopify\/Order\/[A-Za-z0-9_-]+$/;
const INSTALLATION_GID = /^gid:\/\/shopify\/AppInstallation\/[A-Za-z0-9_-]+$/;
const CURRENCY = /^[A-Z]{3}$/;
const MONEY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const SCOPE = /^[a-z][a-z0-9_]{1,127}$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,4096}$/;
const SOURCE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
function fail(code) {
    throw new ShopifyReadError(code);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function validInteger(value, minimum, maximum) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function parseUtc(value) {
    if (typeof value !== 'string' || !ISO_UTC.test(value))
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function requiredString(value, maximum = 4096) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > maximum
        || /[\u0000-\u001f\u007f]/.test(value))
        fail('response-invalid');
    return value;
}
function nullableSourceValue(value) {
    if (value === null)
        return null;
    const normalized = requiredString(value, 255);
    if (!SOURCE_VALUE.test(normalized))
        fail('response-invalid');
    return normalized;
}
function requiredUtc(value) {
    const normalized = requiredString(value, 64);
    if (parseUtc(normalized) === null)
        fail('response-invalid');
    return normalized;
}
function requiredGid(value, pattern) {
    const normalized = requiredString(value, 255);
    if (!pattern.test(normalized))
        fail('response-invalid');
    return normalized;
}
function parsePageInfo(value) {
    if (!isRecord(value) || typeof value.hasNextPage !== 'boolean')
        fail('response-invalid');
    const endCursor = value.endCursor;
    if (endCursor !== null && (typeof endCursor !== 'string' || !CURSOR.test(endCursor))) {
        fail('response-invalid');
    }
    if (value.hasNextPage && endCursor === null)
        fail('pagination-incomplete');
    return Object.freeze({ hasNextPage: value.hasNextPage, endCursor: endCursor });
}
function validateConfig(raw, now) {
    if (!isRecord(raw) || !hasExactKeys(raw, CONFIG_KEYS))
        fail('configuration-denied');
    if (typeof raw.storeDomain !== 'string'
        || !STORE_DOMAIN.test(raw.storeDomain)
        || typeof raw.expectedShopId !== 'string'
        || !SHOP_GID.test(raw.expectedShopId)
        || typeof raw.expectedAppId !== 'string'
        || !APP_GID.test(raw.expectedAppId))
        fail('configuration-denied');
    if (raw.authorityExpiresAtUtc !== null
        && parseUtc(raw.authorityExpiresAtUtc) === null)
        fail('configuration-denied');
    if (raw.authorityExpiresAtUtc !== null
        && Date.parse(raw.authorityExpiresAtUtc) <= now.getTime())
        fail('credential-expired');
    if (!isRecord(raw.limits) || !hasExactKeys(raw.limits, LIMIT_KEYS)) {
        fail('configuration-denied');
    }
    if (!validInteger(raw.limits.variantPageSize, 1, 25)
        || !validInteger(raw.limits.orderPageSize, 1, 100)
        || !validInteger(raw.limits.maxVariantPages, 1, 1_000)
        || !validInteger(raw.limits.maxOrderPages, 1, 1_000)
        || !validInteger(raw.limits.maxRequests, 3, 2_001)
        || !validInteger(raw.limits.maxResponseBytes, 1_024, 5 * 1_024 * 1_024))
        fail('configuration-denied');
    if (!isRecord(raw.orderWindow) || !hasExactKeys(raw.orderWindow, WINDOW_KEYS)) {
        fail('configuration-denied');
    }
    const start = parseUtc(raw.orderWindow.startUtc);
    const end = parseUtc(raw.orderWindow.endUtc);
    if (start === null
        || end === null
        || start >= end
        || end - start > MAX_ORDER_WINDOW_MS
        || end > now.getTime()
        || now.getTime() - end > MAX_ORDER_WINDOW_LAG_MS)
        fail('configuration-denied');
    const orderQuery = `created_at:>='${raw.orderWindow.startUtc}' created_at:<'${raw.orderWindow.endUtc}'`;
    return Object.freeze({
        ...raw,
        endpoint: `https://${raw.storeDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
        orderQuery,
    });
}
function responseBodyBytes(body) {
    try {
        return new TextEncoder().encode(JSON.stringify(body)).byteLength;
    }
    catch {
        fail('response-invalid');
    }
}
function hasThrottledError(body) {
    if (!Array.isArray(body.errors))
        return false;
    return body.errors.some((entry) => isRecord(entry)
        && isRecord(entry.extensions)
        && entry.extensions.code === 'THROTTLED');
}
function validateSuccessfulGraphqlBody(body) {
    if (!isRecord(body))
        fail('response-invalid');
    if (hasThrottledError(body))
        fail('throttled');
    if (Array.isArray(body.errors) && body.errors.length > 0)
        fail('graphql-error');
    if (!isRecord(body.data))
        fail('response-invalid');
    if (body.extensions !== undefined) {
        if (!isRecord(body.extensions))
            fail('response-invalid');
        const cost = body.extensions.cost;
        if (cost !== undefined) {
            if (!isRecord(cost))
                fail('response-invalid');
            const throttle = cost.throttleStatus;
            if (throttle !== undefined) {
                if (!isRecord(throttle)
                    || typeof throttle.currentlyAvailable !== 'number'
                    || typeof throttle.maximumAvailable !== 'number'
                    || typeof throttle.restoreRate !== 'number'
                    || !Number.isFinite(throttle.currentlyAvailable)
                    || !Number.isFinite(throttle.maximumAvailable)
                    || !Number.isFinite(throttle.restoreRate)
                    || throttle.currentlyAvailable < 0
                    || throttle.maximumAvailable <= 0
                    || throttle.restoreRate <= 0)
                    fail('response-invalid');
            }
        }
    }
    return body.data;
}
function normalizeVariant(value, currencyCode) {
    if (!isRecord(value))
        fail('response-invalid');
    const product = value.product;
    const inventoryItem = value.inventoryItem;
    if (!isRecord(product) || !isRecord(inventoryItem))
        fail('response-invalid');
    const levels = inventoryItem.inventoryLevels;
    if (!isRecord(levels) || !Array.isArray(levels.nodes))
        fail('response-invalid');
    const levelPageInfo = parsePageInfo(levels.pageInfo);
    if (levelPageInfo.hasNextPage)
        fail('pagination-incomplete');
    const seenLevelIds = new Set();
    const inventoryByLocation = levels.nodes.map((entry) => {
        if (!isRecord(entry) || !isRecord(entry.location) || !Array.isArray(entry.quantities)) {
            fail('response-invalid');
        }
        const inventoryLevelId = requiredGid(entry.id, INVENTORY_LEVEL_GID);
        if (seenLevelIds.has(inventoryLevelId))
            fail('duplicate-resource');
        seenLevelIds.add(inventoryLevelId);
        const available = entry.quantities.filter((quantity) => isRecord(quantity) && quantity.name === 'available');
        if (available.length !== 1 || !Number.isSafeInteger(available[0].quantity)) {
            fail('response-invalid');
        }
        if (typeof entry.isActive !== 'boolean')
            fail('response-invalid');
        return Object.freeze({
            inventoryLevelId,
            locationId: requiredGid(entry.location.id, LOCATION_GID),
            active: entry.isActive,
            available: available[0].quantity,
            updatedAtUtc: requiredUtc(entry.updatedAt),
        });
    }).sort((a, b) => a.locationId.localeCompare(b.locationId));
    const price = requiredString(value.price, 128);
    if (!MONEY.test(price))
        fail('response-invalid');
    if (value.inventoryQuantity !== null && !Number.isSafeInteger(value.inventoryQuantity)) {
        fail('response-invalid');
    }
    if (typeof inventoryItem.tracked !== 'boolean')
        fail('response-invalid');
    const sku = value.sku === null || value.sku === '' ? null : requiredString(value.sku, 255);
    return Object.freeze({
        productId: requiredGid(product.id, PRODUCT_GID),
        productStatus: requiredString(product.status, 64),
        productUpdatedAtUtc: requiredUtc(product.updatedAt),
        variantId: requiredGid(value.id, VARIANT_GID),
        sku,
        price: Object.freeze({ amount: price, currencyCode }),
        aggregateAvailable: value.inventoryQuantity,
        variantUpdatedAtUtc: requiredUtc(value.updatedAt),
        inventoryItemId: requiredGid(inventoryItem.id, INVENTORY_ITEM_GID),
        inventoryTracked: inventoryItem.tracked,
        inventoryByLocation: Object.freeze(inventoryByLocation),
    });
}
function normalizeOrder(value, window) {
    if (!isRecord(value) || typeof value.test !== 'boolean')
        fail('response-invalid');
    const createdAtUtc = requiredUtc(value.createdAt);
    const created = Date.parse(createdAtUtc);
    if (created < Date.parse(window.startUtc) || created >= Date.parse(window.endUtc)) {
        fail('response-invalid');
    }
    let app = null;
    if (value.app !== null) {
        if (!isRecord(value.app))
            fail('response-invalid');
        app = Object.freeze({
            id: requiredGid(value.app.id, APP_GID),
            name: requiredString(value.app.name, 128),
        });
    }
    const financialStatus = value.displayFinancialStatus === null
        ? null
        : requiredString(value.displayFinancialStatus, 64);
    return Object.freeze({
        orderId: requiredGid(value.id, ORDER_GID),
        createdAtUtc,
        updatedAtUtc: requiredUtc(value.updatedAt),
        app,
        sourceName: nullableSourceValue(value.sourceName),
        sourceIdentifier: nullableSourceValue(value.sourceIdentifier),
        financialStatus,
        fulfillmentStatus: requiredString(value.displayFulfillmentStatus, 64),
        test: value.test,
    });
}
function makeSignal(signal) {
    return signal ?? new AbortController().signal;
}
/**
 * Capture a complete, bounded Shopify evidence set through an injected dispatcher.
 * The function returns no token, response envelope, customer field, raw error, or
 * cursor and never attempts token refresh.
 */
export async function captureShopifyAuthoritativeEvidence(rawConfig, dependencies) {
    if (!dependencies || typeof dependencies.dispatcher !== 'function') {
        fail('configuration-denied');
    }
    const now = dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        fail('configuration-denied');
    const config = validateConfig(rawConfig, now);
    const signal = makeSignal(dependencies.signal);
    let requestCount = 0;
    const dispatch = async (operationName, query, variables) => {
        requestCount += 1;
        if (requestCount > config.limits.maxRequests)
            fail('request-limit-exceeded');
        let response;
        try {
            response = await dependencies.dispatcher(Object.freeze({
                method: 'POST',
                url: config.endpoint,
                headers: Object.freeze({
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                }),
                authority: Object.freeze({
                    kind: 'injected-shopify-read-authority',
                    secretExposed: false,
                }),
                redirect: 'error',
                signal,
                body: Object.freeze({ operationName, query, variables: Object.freeze({ ...variables }) }),
            }));
        }
        catch (error) {
            if (error instanceof ShopifyReadError)
                throw error;
            fail('transport-unavailable');
        }
        if (!isRecord(response))
            fail('response-invalid');
        if (response.status === 429)
            fail('throttled');
        if (!Number.isInteger(response.status) || response.status !== 200)
            fail('transport-unavailable');
        if (response.apiVersion !== SHOPIFY_ADMIN_API_VERSION)
            fail('api-version-mismatch');
        if (responseBodyBytes(response.body) > config.limits.maxResponseBytes)
            fail('response-invalid');
        return validateSuccessfulGraphqlBody(response.body);
    };
    const preflight = await dispatch('ProductPipelineShopifyPreflight', SHOPIFY_GRAPHQL_DOCUMENTS.preflight, Object.freeze({}));
    const shop = preflight.shop;
    const installation = preflight.currentAppInstallation;
    if (!isRecord(shop) || !isRecord(installation) || !isRecord(installation.app)) {
        fail('response-invalid');
    }
    const shopId = requiredGid(shop.id, SHOP_GID);
    const storeDomain = requiredString(shop.myshopifyDomain, 255);
    const currencyCode = requiredString(shop.currencyCode, 3);
    const installationId = requiredGid(installation.id, INSTALLATION_GID);
    void installationId;
    const appId = requiredGid(installation.app.id, APP_GID);
    if (shopId !== config.expectedShopId
        || storeDomain !== config.storeDomain
        || appId !== config.expectedAppId)
        fail('identity-mismatch');
    if (!CURRENCY.test(currencyCode) || !Array.isArray(installation.accessScopes)) {
        fail('response-invalid');
    }
    const grantedScopes = installation.accessScopes.map((entry) => {
        if (!isRecord(entry) || typeof entry.handle !== 'string' || !SCOPE.test(entry.handle)) {
            fail('response-invalid');
        }
        return entry.handle;
    });
    if (new Set(grantedScopes).size !== grantedScopes.length)
        fail('response-invalid');
    if (grantedScopes.includes('read_all_orders')
        || grantedScopes.some((scope) => scope.startsWith('write_'))
        || SHOPIFY_REQUIRED_READ_SCOPES.some((scope) => !grantedScopes.includes(scope)))
        fail('scope-denied');
    grantedScopes.sort();
    const variants = [];
    const seenVariantIds = new Set();
    const seenVariantCursors = new Set();
    let variantCursor = null;
    let variantPageCount = 0;
    while (true) {
        variantPageCount += 1;
        if (variantPageCount > config.limits.maxVariantPages)
            fail('pagination-incomplete');
        const data = await dispatch('ProductPipelineShopifyVariants', SHOPIFY_GRAPHQL_DOCUMENTS.variants, Object.freeze({ first: config.limits.variantPageSize, after: variantCursor }));
        const connection = data.productVariants;
        if (!isRecord(connection) || !Array.isArray(connection.nodes))
            fail('response-invalid');
        const page = connection.nodes.map((node) => normalizeVariant(node, currencyCode));
        for (const variant of page) {
            if (seenVariantIds.has(variant.variantId))
                fail('duplicate-resource');
            seenVariantIds.add(variant.variantId);
            variants.push(variant);
        }
        const pageInfo = parsePageInfo(connection.pageInfo);
        if (!pageInfo.hasNextPage)
            break;
        if (pageInfo.endCursor === null || seenVariantCursors.has(pageInfo.endCursor)) {
            fail('pagination-loop');
        }
        seenVariantCursors.add(pageInfo.endCursor);
        variantCursor = pageInfo.endCursor;
    }
    const orders = [];
    const seenOrderIds = new Set();
    const seenOrderCursors = new Set();
    let orderCursor = null;
    let orderPageCount = 0;
    while (true) {
        orderPageCount += 1;
        if (orderPageCount > config.limits.maxOrderPages)
            fail('pagination-incomplete');
        const data = await dispatch('ProductPipelineShopifyOrders', SHOPIFY_GRAPHQL_DOCUMENTS.orders, Object.freeze({
            first: config.limits.orderPageSize,
            after: orderCursor,
            query: config.orderQuery,
        }));
        const connection = data.orders;
        if (!isRecord(connection) || !Array.isArray(connection.nodes))
            fail('response-invalid');
        const page = connection.nodes.map((node) => normalizeOrder(node, config.orderWindow));
        for (const order of page) {
            if (seenOrderIds.has(order.orderId))
                fail('duplicate-resource');
            seenOrderIds.add(order.orderId);
            orders.push(order);
        }
        const pageInfo = parsePageInfo(connection.pageInfo);
        if (!pageInfo.hasNextPage)
            break;
        if (pageInfo.endCursor === null || seenOrderCursors.has(pageInfo.endCursor)) {
            fail('pagination-loop');
        }
        seenOrderCursors.add(pageInfo.endCursor);
        orderCursor = pageInfo.endCursor;
    }
    return Object.freeze({
        identity: Object.freeze({ shopId, storeDomain, appId }),
        variants: Object.freeze(variants),
        orders: Object.freeze(orders),
        provenance: Object.freeze({
            source: 'shopify-admin-graphql',
            apiVersion: SHOPIFY_ADMIN_API_VERSION,
            endpointHost: storeDomain,
            shopId,
            appId,
            grantedScopes: Object.freeze(grantedScopes),
            observedAtUtc: now.toISOString(),
            orderWindow: Object.freeze({ ...config.orderWindow }),
            variantPageCount,
            orderPageCount,
            requestCount,
            paginationComplete: true,
            readOnly: true,
            externalWritesPerformed: false,
            historicalBackfillPerformed: false,
        }),
    });
}
