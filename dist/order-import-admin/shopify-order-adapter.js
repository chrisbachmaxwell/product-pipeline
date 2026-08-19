/**
 * Bounded Shopify Admin GraphQL adapter for the isolated order-import
 * operator CLI. It can reach exactly one URL — the pinned Used Camera Gear
 * store's Admin GraphQL endpoint at the pinned API version — with exactly
 * four compiled operations: the identity/scope preflight, the dedup/verify
 * order-tag search, the exact-SKU variant lookup, and the single orderCreate
 * mutation the dispatch ceremony authorizes. Errors are redacted to fixed
 * codes; no token, payload, or provider body is ever thrown or logged.
 *
 * PII boundary: buyer shipping details enter only the orderCreate variables
 * of the one provider call. The adapter never returns, logs, or stores them.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its mutation is reachable only from
 * the import ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling it.
 */
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { openShadowDatabase } from '../server/shadow-db.js';
const SHOPIFY_GRAPHQL_URL = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}`
    + `/admin/api/${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.adminApiVersion}/graphql.json`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const SAFE_SKU = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const ORDER_GID = /^gid:\/\/shopify\/Order\/[^/\s]+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[^/\s]+$/;
export class ShopifyOrderAdapterError extends Error {
    code;
    constructor(code) {
        super('Shopify order adapter failed');
        this.code = code;
        this.name = 'ShopifyOrderAdapterError';
    }
}
const deny = (code) => {
    throw new ShopifyOrderAdapterError(code);
};
function asRecord(value, code) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : deny(code);
}
const PREFLIGHT_QUERY = `query OrderImportPreflight {
  shop { id myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;
const ORDERS_BY_TAG_QUERY = `query OrderImportOrdersByTag($query: String!) {
  orders(first: 5, query: $query) { nodes { id } }
}`;
const VARIANT_BY_SKU_QUERY = `query OrderImportVariantBySku($query: String!) {
  productVariants(first: 1, query: $query) { nodes { id sku } }
}`;
const ORDER_CREATE_MUTATION = `mutation OrderImportCreate($order: OrderCreateOrderInput!) {
  orderCreate(order: $order) {
    order { id }
    userErrors { field message }
  }
}`;
export function createShopifyOrderAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function graphql(operationName, query, variables, failure) {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('SHOPIFY_AUTHORITY_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            deny('SHOPIFY_AUTHORITY_UNAVAILABLE');
        }
        const body = JSON.stringify({ operationName, query, variables });
        if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES)
            deny(failure);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(SHOPIFY_GRAPHQL_URL, {
                method: 'POST',
                headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body,
                redirect: 'error',
                signal: controller.signal,
            });
            const declaredLength = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
                deny(failure);
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
                deny(failure);
            if (!response.ok)
                deny(failure);
            const parsed = asRecord(JSON.parse(text), failure);
            if (parsed.errors !== undefined || !parsed.data)
                deny(failure);
            return asRecord(parsed.data, failure);
        }
        catch (error) {
            if (error instanceof ShopifyOrderAdapterError)
                throw error;
            return deny(failure);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return Object.freeze({
        getInstallationScopes: async () => {
            const data = await graphql('OrderImportPreflight', PREFLIGHT_QUERY, {}, 'SHOPIFY_READ_FAILED');
            const shop = asRecord(data.shop, 'SHOPIFY_READ_FAILED');
            if (shop.id !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid
                || shop.myshopifyDomain !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain) {
                deny('SHOPIFY_IDENTITY_MISMATCH');
            }
            const installation = asRecord(data.currentAppInstallation, 'SHOPIFY_READ_FAILED');
            const scopes = Array.isArray(installation.accessScopes) ? installation.accessScopes : [];
            return scopes.map((scope) => {
                const handle = asRecord(scope, 'SHOPIFY_READ_FAILED').handle;
                if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) {
                    return deny('SHOPIFY_READ_FAILED');
                }
                return handle;
            });
        },
        findOrderGidsByTag: async (tag) => {
            if (typeof tag !== 'string' || !SAFE_TAG.test(tag))
                deny('SHOPIFY_TARGET_INVALID');
            const data = await graphql('OrderImportOrdersByTag', ORDERS_BY_TAG_QUERY, { query: `tag:'${tag}'` }, 'SHOPIFY_READ_FAILED');
            const nodes = asRecord(data.orders, 'SHOPIFY_READ_FAILED').nodes;
            return (Array.isArray(nodes) ? nodes : deny('SHOPIFY_READ_FAILED')).map((node) => {
                const gid = asRecord(node, 'SHOPIFY_READ_FAILED').id;
                if (typeof gid !== 'string' || !ORDER_GID.test(gid))
                    return deny('SHOPIFY_READ_FAILED');
                return gid;
            });
        },
        findVariantGidBySku: async (sku) => {
            if (typeof sku !== 'string' || !SAFE_SKU.test(sku))
                deny('SHOPIFY_TARGET_INVALID');
            const data = await graphql('OrderImportVariantBySku', VARIANT_BY_SKU_QUERY, { query: `sku:'${sku}'` }, 'SHOPIFY_READ_FAILED');
            const nodes = asRecord(data.productVariants, 'SHOPIFY_READ_FAILED').nodes;
            if (!Array.isArray(nodes) || nodes.length === 0)
                return null;
            const node = asRecord(nodes[0], 'SHOPIFY_READ_FAILED');
            // The search is a prefix/token match on the provider side; only an
            // exact SKU echo may bind an order line to this variant.
            if (node.sku !== sku)
                return null;
            const gid = node.id;
            if (typeof gid !== 'string' || !VARIANT_GID.test(gid))
                return deny('SHOPIFY_READ_FAILED');
            return gid;
        },
        createOrder: async (orderInput) => {
            const data = await graphql('OrderImportCreate', ORDER_CREATE_MUTATION, { order: orderInput }, 'SHOPIFY_WRITE_FAILED');
            const result = asRecord(data.orderCreate, 'SHOPIFY_WRITE_FAILED');
            const userErrors = Array.isArray(result.userErrors) ? result.userErrors : [];
            const orderGidValue = result.order !== null && typeof result.order === 'object'
                ? result.order.id
                : null;
            const orderGid = typeof orderGidValue === 'string' && ORDER_GID.test(orderGidValue)
                ? orderGidValue
                : null;
            return Object.freeze({ orderGid, userErrorsPresent: userErrors.length > 0 });
        },
    });
}
/**
 * Default production Shopify authority: the existing offline access token in
 * the shadow ledger's `auth_tokens` shopify row, read query-only. The token
 * is never persisted elsewhere, logged, or returned outside the adapter.
 */
export function createProductionShopifyOrderTokenProvider() {
    return async () => {
        const database = openShadowDatabase();
        try {
            const row = database.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
            if (!row?.access_token)
                throw new ShopifyOrderAdapterError('SHOPIFY_AUTHORITY_UNAVAILABLE');
            return row.access_token;
        }
        finally {
            database.close();
        }
    };
}
