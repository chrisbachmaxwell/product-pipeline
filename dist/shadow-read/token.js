import { denyShadowRead } from './errors.js';
const INPUT_KEYS = ['accessToken', 'expiresAtUtc', 'issuedAtUtc', 'provider', 'scopes'];
const POLICY_KEYS = [
    'allowedScopes',
    'maximumLifetimeMs',
    'minimumRemainingValidityMs',
    'provider',
];
const MAX_TOKEN_LENGTH = 8_192;
const MAX_SCOPE_COUNT = 8;
const MAX_SCOPE_LENGTH = 256;
const MAX_EPHEMERAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_MINIMUM_REMAINING_MS = 60 * 60 * 1_000;
const TOKEN_SECRETS = new WeakMap();
const TOKEN_MINIMUM_REMAINING = new WeakMap();
export const KNOWN_READ_SCOPES = Object.freeze({
    shopify: Object.freeze([
        'read_products',
        'read_inventory',
        'read_orders',
        'read_fulfillments',
        'read_locations',
        'read_publications',
        'read_product_listings',
    ]),
    ebay: Object.freeze([
        'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    ]),
});
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function parseCanonicalUtc(value) {
    if (typeof value !== 'string')
        return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value)
        return null;
    return parsed;
}
function isReadOnlyScope(provider, scope) {
    return KNOWN_READ_SCOPES[provider].includes(scope);
}
function validatePolicy(input) {
    if (!isRecord(input) || !hasExactKeys(input, POLICY_KEYS)) {
        denyShadowRead('configuration-denied');
    }
    const provider = input.provider;
    const allowedScopes = input.allowedScopes;
    const minimumRemainingValidityMs = input.minimumRemainingValidityMs;
    const maximumLifetimeMs = input.maximumLifetimeMs;
    if ((provider !== 'shopify' && provider !== 'ebay')
        || !Array.isArray(allowedScopes)
        || allowedScopes.length === 0
        || allowedScopes.length > MAX_SCOPE_COUNT
        || !allowedScopes.every((scope) => typeof scope === 'string')
        || !allowedScopes.every((scope) => scope.length >= 1 && scope.length <= MAX_SCOPE_LENGTH)
        || new Set(allowedScopes).size !== allowedScopes.length
        || !allowedScopes.every((scope) => isReadOnlyScope(provider, scope))
        || !Number.isInteger(minimumRemainingValidityMs)
        || Number(minimumRemainingValidityMs) < 1
        || Number(minimumRemainingValidityMs) > MAX_MINIMUM_REMAINING_MS
        || !Number.isInteger(maximumLifetimeMs)
        || Number(maximumLifetimeMs) <= Number(minimumRemainingValidityMs)
        || Number(maximumLifetimeMs) > MAX_EPHEMERAL_LIFETIME_MS) {
        denyShadowRead('configuration-denied');
    }
    return {
        provider,
        allowedScopes: Object.freeze([...allowedScopes]),
        minimumRemainingValidityMs: Number(minimumRemainingValidityMs),
        maximumLifetimeMs: Number(maximumLifetimeMs),
    };
}
class ValidatedToken {
    kind = 'validated-ephemeral-read-token';
    provider;
    issuedAtUtc;
    expiresAtUtc;
    scopes;
    constructor(input, minimumRemainingValidityMs) {
        this.provider = input.provider;
        this.issuedAtUtc = input.issuedAtUtc;
        this.expiresAtUtc = input.expiresAtUtc;
        this.scopes = Object.freeze([...input.scopes]);
        TOKEN_SECRETS.set(this, input.accessToken);
        TOKEN_MINIMUM_REMAINING.set(this, minimumRemainingValidityMs);
        Object.freeze(this);
    }
    toJSON() {
        return Object.freeze({
            kind: this.kind,
            provider: this.provider,
            issuedAtUtc: this.issuedAtUtc,
            expiresAtUtc: this.expiresAtUtc,
            scopes: this.scopes,
            secret: '[REDACTED]',
        });
    }
}
/**
 * Validates only explicitly supplied token material. This module has no token
 * acquisition, refresh, environment, file, database, or network behavior.
 */
export function validateEphemeralReadToken(rawToken, rawPolicy, nowUtc) {
    const policy = validatePolicy(rawPolicy);
    const nowMs = parseCanonicalUtc(nowUtc);
    if (nowMs === null)
        denyShadowRead('configuration-denied');
    if (!isRecord(rawToken) || !hasExactKeys(rawToken, INPUT_KEYS)) {
        denyShadowRead('token-denied');
    }
    const provider = rawToken.provider;
    const accessToken = rawToken.accessToken;
    const scopes = rawToken.scopes;
    const issuedAtMs = parseCanonicalUtc(rawToken.issuedAtUtc);
    const expiresAtMs = parseCanonicalUtc(rawToken.expiresAtUtc);
    if (provider !== 'shopify' && provider !== 'ebay')
        denyShadowRead('token-denied');
    if (provider !== policy.provider
        || typeof accessToken !== 'string'
        || accessToken.length < 12
        || accessToken.length > MAX_TOKEN_LENGTH
        || accessToken.trim() !== accessToken
        || /[\u0000-\u001f\u007f\s]/.test(accessToken)
        || !Array.isArray(scopes)
        || scopes.length === 0
        || scopes.length > MAX_SCOPE_COUNT
        || !scopes.every((scope) => typeof scope === 'string')
        || !scopes.every((scope) => scope.length >= 1 && scope.length <= MAX_SCOPE_LENGTH)
        || new Set(scopes).size !== scopes.length
        || issuedAtMs === null
        || expiresAtMs === null
        || issuedAtMs > nowMs
        || expiresAtMs <= issuedAtMs
        || expiresAtMs - issuedAtMs > policy.maximumLifetimeMs) {
        denyShadowRead('token-denied');
    }
    if (expiresAtMs <= nowMs)
        denyShadowRead('token-expired');
    if (expiresAtMs - nowMs <= policy.minimumRemainingValidityMs) {
        denyShadowRead('token-near-expiry');
    }
    const allowedScopes = new Set(policy.allowedScopes);
    if (!scopes.every((scope) => isReadOnlyScope(provider, scope))
        || !scopes.every((scope) => allowedScopes.has(scope))) {
        denyShadowRead('token-scope-denied');
    }
    return new ValidatedToken({
        provider,
        accessToken,
        issuedAtUtc: rawToken.issuedAtUtc,
        expiresAtUtc: rawToken.expiresAtUtc,
        scopes: scopes,
    }, policy.minimumRemainingValidityMs);
}
/**
 * Narrow adapter seam used by the injected transport. It re-checks expiry and
 * exact scopes immediately before a request and has no refresh fallback.
 */
export function assertEphemeralReadAuthorizedForTransport(token, provider, requiredScopes, nowUtc) {
    const secret = TOKEN_SECRETS.get(token);
    const minimumRemainingValidityMs = TOKEN_MINIMUM_REMAINING.get(token);
    const nowMs = parseCanonicalUtc(nowUtc);
    const expiresAtMs = parseCanonicalUtc(token?.expiresAtUtc);
    if (!secret
        || minimumRemainingValidityMs === undefined
        || nowMs === null
        || expiresAtMs === null
        || token.kind !== 'validated-ephemeral-read-token'
        || token.provider !== provider
        || !Array.isArray(requiredScopes)
        || requiredScopes.length === 0
        || requiredScopes.length > MAX_SCOPE_COUNT
        || !requiredScopes.every((scope) => typeof scope === 'string' && scope.length >= 1 && scope.length <= MAX_SCOPE_LENGTH)
        || new Set(requiredScopes).size !== requiredScopes.length) {
        denyShadowRead('token-denied');
    }
    if (expiresAtMs <= nowMs)
        denyShadowRead('token-expired');
    if (expiresAtMs - nowMs <= minimumRemainingValidityMs) {
        denyShadowRead('token-near-expiry');
    }
    const grantedScopes = new Set(token.scopes);
    if (!requiredScopes.every((scope) => isReadOnlyScope(provider, scope))
        || !requiredScopes.every((scope) => grantedScopes.has(scope))) {
        denyShadowRead('token-scope-denied');
    }
}
