import { Session, shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import { loadShopifyCredentials, } from '../config/credentials.js';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from './production-identity.js';
const SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const SHOPIFY_TOKEN_RESPONSE_MAX_BYTES = 32 * 1_024;
const SHOPIFY_ACCESS_TOKEN_MAX_LENGTH = 8_192;
const SAFE_ACCESS_TOKEN = /^[^\s\u0000-\u001f\u007f]+$/u;
class ShopifyClientCredentialsTokenError extends Error {
    code = 'shopify-token-denied';
    constructor() {
        super('Shopify client credentials token request failed');
        this.name = 'ShopifyClientCredentialsTokenError';
    }
}
function denyClientCredentialsToken() {
    throw new ShopifyClientCredentialsTokenError();
}
async function readBoundedJson(response) {
    const contentType = response.headers.get('content-type');
    if (contentType === null || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        return denyClientCredentialsToken();
    }
    const declared = response.headers.get('content-length');
    if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0 || length > SHOPIFY_TOKEN_RESPONSE_MAX_BYTES) {
            return denyClientCredentialsToken();
        }
    }
    if (response.body === null)
        return denyClientCredentialsToken();
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            total += chunk.value.byteLength;
            if (total > SHOPIFY_TOKEN_RESPONSE_MAX_BYTES) {
                await reader.cancel();
                return denyClientCredentialsToken();
            }
            chunks.push(chunk.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return denyClientCredentialsToken();
    }
}
export const createShopifyApi = async () => {
    const shopify = await loadShopifyCredentials();
    return shopifyApi({
        apiKey: shopify.clientId,
        apiSecretKey: shopify.clientSecret,
        scopes: [...PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes],
        hostName: shopify.storeDomain,
        apiVersion: (process.env.SHOPIFY_API_VERSION ?? '2024-01'),
        isEmbeddedApp: false,
    });
};
export const createShopifyGraphqlClient = async (accessToken) => {
    const shopify = await loadShopifyCredentials();
    const api = await createShopifyApi();
    const session = new Session({
        id: `offline_${shopify.storeDomain}`,
        shop: shopify.storeDomain,
        state: 'ebaysync',
        isOnline: false,
        accessToken,
    });
    return new api.clients.Graphql({ session });
};
export const requestShopifyClientCredentialsToken = async (dependencies = {}) => {
    const controller = new AbortController();
    const schedule = dependencies.scheduleTimeout ?? setTimeout;
    const clear = dependencies.clearScheduledTimeout ?? clearTimeout;
    const timer = schedule(() => controller.abort(), SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS);
    try {
        // Token acquisition always uses the primary/new secret. Previous-secret
        // overlap exists only in inbound request verification.
        const shopify = await (dependencies.loadCredentials ?? loadShopifyCredentials)();
        if (shopify.storeDomain !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain
            || shopify.clientId !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId
            || shopify.clientSecret.length < 16
            || shopify.clientSecret.length > SHOPIFY_ACCESS_TOKEN_MAX_LENGTH
            || shopify.clientSecret.trim() !== shopify.clientSecret
            || !SAFE_ACCESS_TOKEN.test(shopify.clientSecret))
            return denyClientCredentialsToken();
        const response = await (dependencies.fetchImpl ?? fetch)(`https://${shopify.storeDomain}/admin/oauth/access_token`, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: shopify.clientId,
                client_secret: shopify.clientSecret,
                grant_type: 'client_credentials',
            }),
        });
        if (!response.ok || response.status !== 200)
            return denyClientCredentialsToken();
        const payload = await readBoundedJson(response);
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            return denyClientCredentialsToken();
        }
        const accessToken = payload.access_token;
        if (typeof accessToken !== 'string'
            || accessToken.length < 16
            || accessToken.length > SHOPIFY_ACCESS_TOKEN_MAX_LENGTH
            || accessToken.trim() !== accessToken
            || !SAFE_ACCESS_TOKEN.test(accessToken))
            return denyClientCredentialsToken();
        return accessToken;
    }
    catch {
        return denyClientCredentialsToken();
    }
    finally {
        clear(timer);
    }
};
export const SHOPIFY_CLIENT_CREDENTIALS_TOKEN_LIMITS = Object.freeze({
    requestTimeoutMs: SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS,
    responseMaxBytes: SHOPIFY_TOKEN_RESPONSE_MAX_BYTES,
});
