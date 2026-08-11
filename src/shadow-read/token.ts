import { denyShadowRead } from './errors.js';

export type ReadProvider = 'shopify' | 'ebay';

export type EphemeralReadTokenInput = Readonly<{
  provider: ReadProvider;
  accessToken: string;
  issuedAtUtc: string;
  expiresAtUtc: string;
  scopes: readonly string[];
}>;

export type EphemeralReadTokenPolicy = Readonly<{
  provider: ReadProvider;
  allowedScopes: readonly string[];
  minimumRemainingValidityMs: number;
  maximumLifetimeMs: number;
}>;

export type ValidatedEphemeralReadToken = Readonly<{
  kind: 'validated-ephemeral-read-token';
  provider: ReadProvider;
  issuedAtUtc: string;
  expiresAtUtc: string;
  scopes: readonly string[];
  toJSON: () => Readonly<{
    kind: 'validated-ephemeral-read-token';
    provider: ReadProvider;
    issuedAtUtc: string;
    expiresAtUtc: string;
    scopes: readonly string[];
    secret: '[REDACTED]';
  }>;
}>;

const INPUT_KEYS = ['accessToken', 'expiresAtUtc', 'issuedAtUtc', 'provider', 'scopes'] as const;
const POLICY_KEYS = [
  'allowedScopes',
  'maximumLifetimeMs',
  'minimumRemainingValidityMs',
  'provider',
] as const;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_SCOPE_COUNT = 8;
const MAX_SCOPE_LENGTH = 256;
const MAX_EPHEMERAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_MINIMUM_REMAINING_MS = 60 * 60 * 1_000;
const TOKEN_SECRETS = new WeakMap<object, string>();
const TOKEN_MINIMUM_REMAINING = new WeakMap<object, number>();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCanonicalUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function isReadOnlyScope(provider: ReadProvider, scope: string): boolean {
  return (KNOWN_READ_SCOPES[provider] as readonly string[]).includes(scope);
}

function validatePolicy(input: unknown): EphemeralReadTokenPolicy {
  if (!isRecord(input) || !hasExactKeys(input, POLICY_KEYS)) {
    denyShadowRead('configuration-denied');
  }

  const provider = input.provider;
  const allowedScopes = input.allowedScopes;
  const minimumRemainingValidityMs = input.minimumRemainingValidityMs;
  const maximumLifetimeMs = input.maximumLifetimeMs;

  if (
    (provider !== 'shopify' && provider !== 'ebay')
    || !Array.isArray(allowedScopes)
    || allowedScopes.length === 0
    || allowedScopes.length > MAX_SCOPE_COUNT
    || !allowedScopes.every((scope): scope is string => typeof scope === 'string')
    || !allowedScopes.every((scope) => scope.length >= 1 && scope.length <= MAX_SCOPE_LENGTH)
    || new Set(allowedScopes).size !== allowedScopes.length
    || !allowedScopes.every((scope) => isReadOnlyScope(provider, scope))
    || !Number.isInteger(minimumRemainingValidityMs)
    || Number(minimumRemainingValidityMs) < 1
    || Number(minimumRemainingValidityMs) > MAX_MINIMUM_REMAINING_MS
    || !Number.isInteger(maximumLifetimeMs)
    || Number(maximumLifetimeMs) <= Number(minimumRemainingValidityMs)
    || Number(maximumLifetimeMs) > MAX_EPHEMERAL_LIFETIME_MS
  ) {
    denyShadowRead('configuration-denied');
  }

  return {
    provider,
    allowedScopes: Object.freeze([...allowedScopes]),
    minimumRemainingValidityMs: Number(minimumRemainingValidityMs),
    maximumLifetimeMs: Number(maximumLifetimeMs),
  };
}

class ValidatedToken implements ValidatedEphemeralReadToken {
  readonly kind = 'validated-ephemeral-read-token' as const;
  readonly provider: ReadProvider;
  readonly issuedAtUtc: string;
  readonly expiresAtUtc: string;
  readonly scopes: readonly string[];

  constructor(input: EphemeralReadTokenInput, minimumRemainingValidityMs: number) {
    this.provider = input.provider;
    this.issuedAtUtc = input.issuedAtUtc;
    this.expiresAtUtc = input.expiresAtUtc;
    this.scopes = Object.freeze([...input.scopes]);
    TOKEN_SECRETS.set(this, input.accessToken);
    TOKEN_MINIMUM_REMAINING.set(this, minimumRemainingValidityMs);
    Object.freeze(this);
  }

  toJSON(): ReturnType<ValidatedEphemeralReadToken['toJSON']> {
    return Object.freeze({
      kind: this.kind,
      provider: this.provider,
      issuedAtUtc: this.issuedAtUtc,
      expiresAtUtc: this.expiresAtUtc,
      scopes: this.scopes,
      secret: '[REDACTED]' as const,
    });
  }
}

/**
 * Validates only explicitly supplied token material. This module has no token
 * acquisition, refresh, environment, file, database, or network behavior.
 */
export function validateEphemeralReadToken(
  rawToken: unknown,
  rawPolicy: unknown,
  nowUtc: string,
): ValidatedEphemeralReadToken {
  const policy = validatePolicy(rawPolicy);
  const nowMs = parseCanonicalUtc(nowUtc);
  if (nowMs === null) denyShadowRead('configuration-denied');

  if (!isRecord(rawToken) || !hasExactKeys(rawToken, INPUT_KEYS)) {
    denyShadowRead('token-denied');
  }

  const provider = rawToken.provider;
  const accessToken = rawToken.accessToken;
  const scopes = rawToken.scopes;
  const issuedAtMs = parseCanonicalUtc(rawToken.issuedAtUtc);
  const expiresAtMs = parseCanonicalUtc(rawToken.expiresAtUtc);

  if (provider !== 'shopify' && provider !== 'ebay') denyShadowRead('token-denied');
  if (
    provider !== policy.provider
    || typeof accessToken !== 'string'
    || accessToken.length < 12
    || accessToken.length > MAX_TOKEN_LENGTH
    || accessToken.trim() !== accessToken
    || /[\u0000-\u001f\u007f\s]/.test(accessToken)
    || !Array.isArray(scopes)
    || scopes.length === 0
    || scopes.length > MAX_SCOPE_COUNT
    || !scopes.every((scope): scope is string => typeof scope === 'string')
    || !scopes.every((scope) => scope.length >= 1 && scope.length <= MAX_SCOPE_LENGTH)
    || new Set(scopes).size !== scopes.length
    || issuedAtMs === null
    || expiresAtMs === null
    || issuedAtMs > nowMs
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > policy.maximumLifetimeMs
  ) {
    denyShadowRead('token-denied');
  }

  if (expiresAtMs <= nowMs) denyShadowRead('token-expired');
  if (expiresAtMs - nowMs <= policy.minimumRemainingValidityMs) {
    denyShadowRead('token-near-expiry');
  }

  const allowedScopes = new Set(policy.allowedScopes);
  if (
    !scopes.every((scope) => isReadOnlyScope(provider, scope))
    || !scopes.every((scope) => allowedScopes.has(scope))
  ) {
    denyShadowRead('token-scope-denied');
  }

  return new ValidatedToken({
    provider,
    accessToken,
    issuedAtUtc: rawToken.issuedAtUtc as string,
    expiresAtUtc: rawToken.expiresAtUtc as string,
    scopes: scopes as string[],
  }, policy.minimumRemainingValidityMs);
}

/**
 * Narrow adapter seam used by the injected transport. It re-checks expiry and
 * exact scopes immediately before a request and has no refresh fallback.
 */
export function assertEphemeralReadAuthorizedForTransport(
  token: ValidatedEphemeralReadToken,
  provider: ReadProvider,
  requiredScopes: readonly string[],
  nowUtc: string,
): void {
  const secret = TOKEN_SECRETS.get(token as object);
  const minimumRemainingValidityMs = TOKEN_MINIMUM_REMAINING.get(token as object);
  const nowMs = parseCanonicalUtc(nowUtc);
  const expiresAtMs = parseCanonicalUtc(token?.expiresAtUtc);

  if (
    !secret
    || minimumRemainingValidityMs === undefined
    || nowMs === null
    || expiresAtMs === null
    || token.kind !== 'validated-ephemeral-read-token'
    || token.provider !== provider
    || !Array.isArray(requiredScopes)
    || requiredScopes.length === 0
    || requiredScopes.length > MAX_SCOPE_COUNT
    || !requiredScopes.every((scope) =>
      typeof scope === 'string' && scope.length >= 1 && scope.length <= MAX_SCOPE_LENGTH)
    || new Set(requiredScopes).size !== requiredScopes.length
  ) {
    denyShadowRead('token-denied');
  }

  if (expiresAtMs <= nowMs) denyShadowRead('token-expired');
  if (expiresAtMs - nowMs <= minimumRemainingValidityMs) {
    denyShadowRead('token-near-expiry');
  }

  const grantedScopes = new Set(token.scopes);
  if (
    !requiredScopes.every((scope) => isReadOnlyScope(provider, scope))
    || !requiredScopes.every((scope) => grantedScopes.has(scope))
  ) {
    denyShadowRead('token-scope-denied');
  }
}
