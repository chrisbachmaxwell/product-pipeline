import crypto from 'node:crypto';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { rotationDenied, translateRotationError } from './errors.js';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_RESPONSE_MAX_BYTES = 32 * 1_024;
const GRAPHQL_RESPONSE_MAX_BYTES = 128 * 1_024;
const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const SAFE_TOKEN = /^[^\s\u0000-\u001f\u007f]+$/u;
export const SHOPIFY_ROTATION_GRAPHQL_DOCUMENT = `query ProductPipelineShopifyCredentialRotationVerify {
  shop {
    id
    myshopifyDomain
  }
  currentAppInstallation {
    app {
      apiKey
    }
    accessScopes {
      handle
    }
  }
}`;
export const CANONICAL_SHOPIFY_SCOPE_TEXT = PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes.join(',');
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function exactToken(value, code) {
    if (typeof value !== 'string'
        || value.length < 16
        || value.length > MAX_ACCESS_TOKEN_LENGTH
        || value.trim() !== value
        || !SAFE_TOKEN.test(value))
        return rotationDenied(code);
    return value;
}
function sameToken(left, right) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}
async function boundedJson(response, maximumBytes) {
    const contentType = response.headers.get('content-type');
    if (contentType === null || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        return rotationDenied('provider-denied');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
            return rotationDenied('provider-denied');
        }
    }
    if (response.body === null)
        return rotationDenied('provider-denied');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            total += chunk.value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                return rotationDenied('provider-denied');
            }
            chunks.push(chunk.value);
        }
    }
    catch (error) {
        return translateRotationError(error, 'provider-denied');
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
        return rotationDenied('provider-denied');
    }
}
async function boundedFetch(fetchImpl, url, init, maximumBytes, dependencies) {
    const controller = new AbortController();
    const schedule = dependencies.scheduleTimeout ?? setTimeout;
    const clear = dependencies.clearScheduledTimeout ?? clearTimeout;
    const timer = schedule(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
        if (!response.ok || response.status !== 200)
            return rotationDenied('provider-denied');
        return await boundedJson(response, maximumBytes);
    }
    catch (error) {
        return translateRotationError(error, 'provider-denied');
    }
    finally {
        clear(timer);
    }
}
function exactScopes(value) {
    if (!Array.isArray(value) || value.length !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes.length) {
        return rotationDenied('verification-denied');
    }
    const scopes = value.map((entry) => {
        const item = record(entry);
        return item && typeof item.handle === 'string' ? item.handle : rotationDenied('verification-denied');
    });
    const unique = [...new Set(scopes)].sort();
    const expected = [...PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes];
    if (unique.length !== expected.length
        || unique.some((scope, index) => scope !== expected[index])
        || unique.some((scope) => scope.startsWith('write_'))) {
        return rotationDenied('verification-denied');
    }
    return PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes;
}
function exactScopeText(value) {
    if (typeof value !== 'string')
        return rotationDenied('provider-denied');
    const scopes = value.split(',');
    if (scopes.some((scope) => scope.trim() !== scope || scope.length === 0)) {
        return rotationDenied('provider-denied');
    }
    const unique = [...new Set(scopes)].sort();
    const expected = [...PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes];
    if (scopes.length !== expected.length
        || unique.length !== expected.length
        || unique.some((scope, index) => scope !== expected[index])) {
        return rotationDenied('provider-denied');
    }
}
export async function verifyShopifyAccessToken(accessToken, dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const token = exactToken(accessToken, 'verification-denied');
    const endpoint = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}/admin/api/${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.adminApiVersion}/graphql.json`;
    const payload = record(await boundedFetch(fetchImpl, endpoint, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({
            operationName: 'ProductPipelineShopifyCredentialRotationVerify',
            query: SHOPIFY_ROTATION_GRAPHQL_DOCUMENT,
            variables: {},
        }),
    }, GRAPHQL_RESPONSE_MAX_BYTES, dependencies));
    if (payload === null || payload.errors !== undefined)
        return rotationDenied('verification-denied');
    const data = record(payload.data);
    const shop = record(data?.shop);
    const installation = record(data?.currentAppInstallation);
    const app = record(installation?.app);
    if (shop?.id !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid
        || shop.myshopifyDomain !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain
        || app?.apiKey !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId
        || installation === null)
        return rotationDenied('verification-denied');
    return Object.freeze({
        storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
        shopGid: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid,
        clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
        scopes: exactScopes(installation.accessScopes),
    });
}
/** One request only. Callers must never blindly retry an ambiguous result. */
export async function requestRotatedShopifyAccessToken(input) {
    if (input.config.refreshToken === null)
        return rotationDenied('configuration-denied');
    const dependencies = input.dependencies ?? {};
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const currentAccessToken = exactToken(input.currentAccessToken, 'provider-denied');
    const endpoint = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}/admin/oauth/access_token`;
    const payload = record(await boundedFetch(fetchImpl, endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: input.config.clientId,
            client_secret: input.config.clientSecret,
            refresh_token: input.config.refreshToken,
            access_token: currentAccessToken,
        }),
    }, TOKEN_RESPONSE_MAX_BYTES, dependencies));
    if (payload === null)
        return rotationDenied('provider-denied');
    const keys = Object.keys(payload).sort();
    if (keys.some((key) => key !== 'access_token' && key !== 'scope')
        || !keys.includes('access_token'))
        return rotationDenied('provider-denied');
    const freshAccessToken = exactToken(payload.access_token, 'provider-denied');
    if (sameToken(freshAccessToken, currentAccessToken))
        return rotationDenied('provider-denied');
    if (payload.scope !== undefined)
        exactScopeText(payload.scope);
    return Object.freeze({
        accessToken: freshAccessToken,
        refreshToken: null,
        scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
        expiresAt: null,
    });
}
export const SHOPIFY_CREDENTIAL_ROTATION_NETWORK_LIMITS = Object.freeze({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tokenResponseMaxBytes: TOKEN_RESPONSE_MAX_BYTES,
    graphqlResponseMaxBytes: GRAPHQL_RESPONSE_MAX_BYTES,
});
