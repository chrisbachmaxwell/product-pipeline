import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { createSandboxAdapter, readCredentialPacket, } from '../sandbox-listing-canary-admin/adapter.js';
import { SANDBOX_MARKER } from '../sandbox-listing-canary-admin/manifest.js';
import { SANDBOX_ALIGNMENT_SCOPE, deny, } from './contracts.js';
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 20_000;
async function boundedShopifyFetch(fetchImpl, url, init) {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.host !== SANDBOX_ALIGNMENT_SCOPE.shopify.storeDomain
        || parsedUrl.username !== '' || parsedUrl.password !== '' || parsedUrl.port !== ''
        || parsedUrl.search !== '' || parsedUrl.hash !== '')
        deny('TRANSPORT_TARGET_DENIED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
            deny('PROVIDER_RESPONSE_INVALID');
        const textBody = await response.text();
        if (Buffer.byteLength(textBody, 'utf8') > MAX_RESPONSE_BYTES)
            deny('PROVIDER_RESPONSE_INVALID');
        let body = null;
        if (textBody !== '') {
            try {
                body = JSON.parse(textBody);
            }
            catch {
                deny('PROVIDER_RESPONSE_INVALID');
            }
        }
        return { status: response.status, body };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'SandboxAlignmentError')
            throw error;
        return deny('PROVIDER_TRANSPORT_FAILED');
    }
    finally {
        clearTimeout(timeout);
    }
}
function object(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        deny('PROVIDER_RESPONSE_INVALID');
    return value;
}
function exactText(value, max = 512) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max)
        deny('PROVIDER_RESPONSE_INVALID');
    return value;
}
function exactInteger(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        deny('PROVIDER_RESPONSE_INVALID');
    return value;
}
function readShopifyToken(databasePath) {
    const resolvedPath = databasePath ?? process.env.DATABASE_PATH
        ?? path.join(os.homedir(), '.clawdbot', 'ebaysync.db');
    const database = new Database(resolvedPath, { readonly: true, fileMustExist: true });
    try {
        database.pragma('query_only = ON');
        if (database.pragma('query_only', { simple: true }) !== 1)
            deny('SHOPIFY_AUTHORITY_UNAVAILABLE');
        const rows = database.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`)
            .all();
        const row = rows[0];
        if (rows.length !== 1 || !row || typeof row.access_token !== 'string'
            || row.access_token.length === 0 || row.access_token.length > 4096) {
            deny('SHOPIFY_AUTHORITY_UNAVAILABLE');
        }
        return row.access_token;
    }
    finally {
        database.close();
    }
}
const SHOPIFY_QUERY = `query SandboxAlignmentSource($variantId: ID!) {
  shop { id myshopifyDomain currencyCode }
  currentAppInstallation { app { apiKey } accessScopes { handle } }
  productVariant(id: $variantId) {
    id sku price inventoryQuantity
    product { id title status tags publishedAt }
  }
}`;
function toEbayState(snapshot, target) {
    if (!snapshot.inventory || snapshot.offers.length !== 1 || snapshot.tradingListings.length !== 1) {
        deny('EBAY_SANDBOX_STATE_MISMATCH');
    }
    const offer = snapshot.offers[0];
    const trading = snapshot.tradingListings[0];
    const inventory = snapshot.inventory;
    if (offer.offerId !== target.offerId || offer.listingId !== target.listingId
        || trading.itemId !== target.listingId || trading.sku !== target.sku
        || trading.listingStatus !== 'Active'
        || !inventory.product.title.startsWith(SANDBOX_MARKER)
        || !inventory.product.description.includes(SANDBOX_MARKER)
        || !offer.listingDescription.includes(SANDBOX_MARKER)
        || !trading.title.startsWith(SANDBOX_MARKER)
        || !trading.description.includes(SANDBOX_MARKER)) {
        deny('EBAY_SANDBOX_STATE_MISMATCH');
    }
    return Object.freeze({
        sellerId: SANDBOX_ALIGNMENT_SCOPE.ebay.sellerId,
        registrationMarketplaceId: 'EBAY_US', sku: offer.sku, offerId: offer.offerId,
        listingId: offer.listingId, marketplaceId: offer.marketplaceId,
        merchantLocationKey: offer.merchantLocationKey, format: offer.format,
        listingDuration: offer.listingDuration, status: offer.status, listingStatus: 'ACTIVE',
        itemQuantity: inventory.availability.shipToLocationAvailability.quantity,
        offerQuantity: offer.availableQuantity, tradingQuantity: trading.quantity,
        price: Object.freeze({ currency: offer.pricingSummary.price.currency, value: offer.pricingSummary.price.value }),
        tradingPrice: Object.freeze({ currency: trading.currency, value: trading.price }),
    });
}
export async function createSandboxAlignmentAdapters(dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const now = dependencies.now ?? (() => new Date());
    const packet = dependencies.credentialPacket
        ?? await readCredentialPacket(dependencies.stdin ?? process.stdin, now());
    if (packet.sellerId !== SANDBOX_ALIGNMENT_SCOPE.ebay.sellerId)
        deny('EBAY_SANDBOX_STATE_MISMATCH');
    const sandbox = dependencies.sandboxAdapter ?? createSandboxAdapter({
        token: packet.accessToken, expectedSellerId: packet.sellerId, fetchImpl, now,
    });
    async function readShopifySource() {
        const token = readShopifyToken(dependencies.databasePath);
        const scope = SANDBOX_ALIGNMENT_SCOPE.shopify;
        const response = await boundedShopifyFetch(fetchImpl, `https://${scope.storeDomain}/admin/api/${scope.apiVersion}/graphql.json`, {
            method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ operationName: 'SandboxAlignmentSource', query: SHOPIFY_QUERY,
                variables: { variantId: scope.variantId } }),
        });
        if (response.status !== 200)
            deny('SHOPIFY_READ_FAILED');
        const root = object(response.body);
        if (root.errors !== undefined)
            deny('SHOPIFY_READ_FAILED');
        const data = object(root.data);
        const shop = object(data.shop);
        const install = object(data.currentAppInstallation);
        const app = object(install.app);
        const variant = object(data.productVariant);
        const product = object(variant.product);
        if (!Array.isArray(install.accessScopes) || !Array.isArray(product.tags))
            deny('SHOPIFY_READ_FAILED');
        return Object.freeze({
            storeDomain: exactText(shop.myshopifyDomain), shopId: exactText(shop.id), appClientId: exactText(app.apiKey),
            scopes: Object.freeze(install.accessScopes.map((entry) => exactText(object(entry).handle)).sort()),
            productId: exactText(product.id), variantId: exactText(variant.id), title: exactText(product.title),
            status: exactText(product.status),
            tags: Object.freeze(product.tags.map((tag) => exactText(tag)).sort()),
            publishedAt: product.publishedAt, sku: exactText(variant.sku),
            currency: exactText(shop.currencyCode), price: exactText(variant.price),
            quantity: exactInteger(variant.inventoryQuantity),
        });
    }
    async function readEbayState(target) {
        await sandbox.verifyIdentity();
        return toEbayState(await sandbox.snapshot(target.sku), target);
    }
    return Object.freeze({
        readShopifySource,
        readEbayState,
        updatePrice: async (target, price) => sandbox.bulkUpdatePriceQuantity({ field: 'price', ...target, price }),
        updateQuantity: async (target, quantity) => sandbox.bulkUpdatePriceQuantity({ field: 'quantity', ...target, quantity }),
    });
}
