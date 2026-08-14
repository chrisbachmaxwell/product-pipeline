import crypto from 'node:crypto';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../../shopify/production-identity.js';
import { decodeShopifySessionTokenForRequest } from '../../shopify/request-verification.js';
import { isTestMode } from './test-mode.js';
function constantTimeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function bearerToken(req) {
    const authorization = req.get('Authorization');
    if (!authorization)
        return null;
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    return match?.[1] ?? null;
}
/**
 * Verify an App Bridge session JWT locally. This performs no OAuth exchange,
 * token refresh, database access, or platform request.
 */
export async function verifyShopifySessionToken(token) {
    try {
        const payload = await decodeShopifySessionTokenForRequest(token);
        if (payload === null)
            return null;
        const expectedDestination = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}`;
        const valid = (payload.dest.replace(/\/$/, '') === expectedDestination &&
            payload.iss.replace(/\/$/, '') === `${expectedDestination}/admin`);
        if (!valid || typeof payload.sub !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.sub))
            return null;
        return Object.freeze({
            kind: 'shopify_session',
            actorId: `shopify-user:${payload.sub}`,
            subject: payload.sub,
            shopifyStoreDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
        });
    }
    catch {
        return null;
    }
}
export function apiPrincipal(req) {
    return (req.apiPrincipal) ?? null;
}
/**
 * API authentication supports either:
 * - a cryptographically verified Shopify App Bridge session JWT; or
 * - outside production only, an exact X-API-Key header behind an explicit
 *   ALLOW_OPERATOR_API_KEY=true opt-in.
 *
 * Origin, Referer, Host, CORS, and query parameters are never treated as
 * identity. Non-production TEST_MODE is the only authentication bypass.
 */
export function createApiKeyAuth(dependencies = {}) {
    const readApiKey = dependencies.apiKey ?? (() => process.env.API_KEY);
    const operatorApiKeyEnabled = dependencies.operatorApiKeyEnabled ??
        (() => process.env.ALLOW_OPERATOR_API_KEY === 'true');
    const isProduction = dependencies.production ?? (() => process.env.NODE_ENV === 'production');
    const verifySession = dependencies.sessionTokenVerifier ?? verifyShopifySessionToken;
    const testModeEnabled = dependencies.testMode ?? isTestMode;
    return async (req, res, next) => {
        if (testModeEnabled()) {
            req.apiPrincipal = Object.freeze({
                kind: 'test_mode', actorId: 'test-mode', subject: null, shopifyStoreDomain: null,
            });
            next();
            return;
        }
        const expectedApiKey = readApiKey();
        const providedApiKey = req.get('X-API-Key');
        if (!isProduction() &&
            operatorApiKeyEnabled() &&
            expectedApiKey &&
            providedApiKey &&
            constantTimeEqual(providedApiKey, expectedApiKey)) {
            req.apiPrincipal = Object.freeze({
                kind: 'operator_api_key', actorId: 'operator-api-key', subject: null,
                shopifyStoreDomain: null,
            });
            next();
            return;
        }
        const sessionToken = bearerToken(req);
        const principal = sessionToken ? await verifySession(sessionToken) : null;
        if (principal) {
            req.apiPrincipal = principal;
            next();
            return;
        }
        res.status(401).json({
            error: 'Unauthorized',
            code: 'API_AUTH_REQUIRED',
        });
    };
}
export const apiKeyAuth = createApiKeyAuth();
/**
 * Basic in-memory rate limiting. Production ingress rate limiting remains a
 * separate infrastructure concern.
 */
const rateLimitStore = new Map();
const RATE_LIMIT_REQUESTS = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
function pruneRateLimitStore(now) {
    for (const [key, bucket] of rateLimitStore) {
        if (now - bucket.lastRefill >= RATE_LIMIT_WINDOW_MS)
            rateLimitStore.delete(key);
    }
}
function rateLimitBucket(clientIp, now) {
    pruneRateLimitStore(now);
    let bucket = rateLimitStore.get(clientIp);
    if (!bucket) {
        if (rateLimitStore.size >= MAX_RATE_LIMIT_BUCKETS)
            return null;
        bucket = { tokens: RATE_LIMIT_REQUESTS, lastRefill: now };
        rateLimitStore.set(clientIp, bucket);
    }
    return bucket;
}
export const rateLimit = (req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = rateLimitBucket(clientIp, now);
    if (!bucket) {
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
    }
    const timeDiff = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timeDiff / RATE_LIMIT_WINDOW_MS * RATE_LIMIT_REQUESTS);
    bucket.tokens = Math.min(RATE_LIMIT_REQUESTS, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
        res.set({
            'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': new Date(now + RATE_LIMIT_WINDOW_MS).toISOString(),
        });
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
    }
    bucket.tokens--;
    res.set({
        'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
        'X-RateLimit-Remaining': bucket.tokens.toString(),
        'X-RateLimit-Reset': new Date(bucket.lastRefill + RATE_LIMIT_WINDOW_MS).toISOString(),
    });
    next();
};
export const API_RATE_LIMIT_TESTING = Object.freeze({
    maximumBuckets: MAX_RATE_LIMIT_BUCKETS,
    touch(clientIp, now) { return rateLimitBucket(clientIp, now) !== null; },
    size() { return rateLimitStore.size; },
    reset() { rateLimitStore.clear(); },
});
