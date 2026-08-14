import crypto from 'node:crypto';
import { loadShopifyCredentials, } from '../config/credentials.js';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from './production-identity.js';
const MAX_SECRET_LENGTH = 8_192;
const MAXIMUM_PREVIOUS_SECRET_LIFETIME_MS = 60 * 60 * 1_000;
const SAFE_CREDENTIAL = /^[^\s\u0000-\u001f\u007f]+$/u;
const SHOPIFY_HMAC = /^[A-Za-z0-9+/]{43}=$/;
class ShopifyRequestVerificationConfigurationError extends Error {
    constructor() {
        super('Shopify request verification is unavailable');
        this.name = 'ShopifyRequestVerificationConfigurationError';
    }
}
function denyConfiguration() {
    throw new ShopifyRequestVerificationConfigurationError();
}
function safeCredential(value, minimumLength) {
    if (typeof value !== 'string'
        || value.length < minimumLength
        || value.length > MAX_SECRET_LENGTH
        || value.trim() !== value
        || !SAFE_CREDENTIAL.test(value))
        denyConfiguration();
    return value;
}
function equalSecret(left, right) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}
function previousSecret(currentSecret, environment, now) {
    const previous = environment.SHOPIFY_PREVIOUS_CLIENT_SECRET;
    const expiresAtUtc = environment.SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC;
    if (previous === undefined && expiresAtUtc === undefined)
        return null;
    if (previous === undefined || expiresAtUtc === undefined)
        return denyConfiguration();
    const validated = safeCredential(previous, 16);
    if (equalSecret(currentSecret, validated))
        return denyConfiguration();
    const expiresAt = Date.parse(expiresAtUtc);
    if (!Number.isSafeInteger(expiresAt)
        || new Date(expiresAt).toISOString() !== expiresAtUtc)
        return denyConfiguration();
    if (expiresAt <= now)
        return null;
    if (expiresAt - now > MAXIMUM_PREVIOUS_SECRET_LIFETIME_MS)
        return denyConfiguration();
    return validated;
}
async function loadVerificationMaterial(dependencies) {
    const environment = dependencies.environment ?? process.env;
    const now = dependencies.now?.() ?? Date.now();
    let credentials;
    const developmentFileAllowed = environment.NODE_ENV === 'development'
        || environment.NODE_ENV === 'test';
    if (!developmentFileAllowed) {
        credentials = {
            clientId: safeCredential(environment.SHOPIFY_CLIENT_ID, 8),
            clientSecret: safeCredential(environment.SHOPIFY_CLIENT_SECRET, 16),
            storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
        };
    }
    else {
        credentials = await (dependencies.loadCredentials ?? loadShopifyCredentials)();
    }
    if (credentials.storeDomain !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain) {
        return denyConfiguration();
    }
    const clientId = safeCredential(credentials.clientId, 8);
    if (clientId !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId)
        return denyConfiguration();
    const current = safeCredential(credentials.clientSecret, 16);
    const previous = previousSecret(current, environment, now);
    return Object.freeze({
        clientId,
        storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
        secrets: previous === null
            ? Object.freeze([current])
            : Object.freeze([current, previous]),
    });
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function decodeCanonicalSegment(segment, maximumBytes) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > maximumBytes * 2) {
        return denyConfiguration();
    }
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.length === 0 || bytes.length > maximumBytes || bytes.toString('base64url') !== segment) {
        return denyConfiguration();
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return denyConfiguration();
    }
}
function numericDate(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * Decode an App Bridge session token against the current secret and, only
 * during a bounded rotation window, the previous secret. No token exchange or
 * provider request is performed here.
 */
export async function decodeShopifySessionTokenForRequest(token, dependencies = {}) {
    try {
        const material = await loadVerificationMaterial(dependencies);
        const segments = token.split('.');
        if (segments.length !== 3)
            return null;
        const [encodedHeader, encodedPayload, encodedSignature] = segments;
        if (!/^[A-Za-z0-9_-]{43}$/.test(encodedSignature))
            return null;
        const signature = Buffer.from(encodedSignature, 'base64url');
        if (signature.length !== 32 || signature.toString('base64url') !== encodedSignature)
            return null;
        const header = record(decodeCanonicalSegment(encodedHeader, 1_024));
        const payload = record(decodeCanonicalSegment(encodedPayload, 8_192));
        if (header === null || payload === null || header.alg !== 'HS256'
            || (header.typ !== undefined && header.typ !== 'JWT') || header.crit !== undefined)
            return null;
        const unsigned = `${encodedHeader}.${encodedPayload}`;
        let signatureMatched = false;
        for (const secret of material.secrets) {
            const expected = crypto.createHmac('sha256', secret).update(unsigned).digest();
            signatureMatched = crypto.timingSafeEqual(expected, signature) || signatureMatched;
        }
        if (!signatureMatched)
            return null;
        const nowSeconds = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000);
        const exp = numericDate(payload.exp);
        const nbf = numericDate(payload.nbf);
        const iat = numericDate(payload.iat);
        const expectedDestination = `https://${material.storeDomain}`;
        if (payload.aud !== material.clientId
            || payload.dest !== expectedDestination
            || payload.iss !== `${expectedDestination}/admin`
            || exp === null
            || nbf === null
            || iat === null
            || exp <= nowSeconds
            || nbf > nowSeconds + 5
            || iat > nowSeconds + 5
            || exp <= iat
            || exp - iat > 300
            || typeof payload.sub !== 'string')
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
/** Verify a Shopify webhook without parsing or retaining its body. */
export async function verifyShopifyWebhookHmac(hmacHeader, rawBody, dependencies = {}) {
    try {
        if (!hmacHeader || !rawBody || !SHOPIFY_HMAC.test(hmacHeader))
            return false;
        const received = Buffer.from(hmacHeader, 'base64');
        if (received.length !== 32 || received.toString('base64') !== hmacHeader)
            return false;
        const material = await loadVerificationMaterial(dependencies);
        let matched = false;
        for (const secret of material.secrets) {
            const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
            matched = crypto.timingSafeEqual(expected, received) || matched;
        }
        return matched;
    }
    catch {
        return false;
    }
}
export const SHOPIFY_REQUEST_VERIFICATION_TESTING = Object.freeze({
    maximumPreviousSecretLifetimeMs: MAXIMUM_PREVIOUS_SECRET_LIFETIME_MS,
});
