import { describe, expect, it } from 'vitest';
import { ShadowReadError } from '../errors.js';
import {
  assertEphemeralReadAuthorizedForTransport,
  validateEphemeralReadToken,
} from '../token.js';
import {
  EBAY_SCOPE,
  FIXTURE_SECRET,
  NOW_UTC,
  SHOPIFY_SCOPE,
  ebayPolicy,
  shopifyPolicy,
  tokenFor,
} from './fixtures.js';

function expectCode(action: () => unknown, code: ShadowReadError['code']): void {
  try {
    action();
    throw new Error('Expected the read contract to deny the operation.');
  } catch (error) {
    expect(error).toBeInstanceOf(ShadowReadError);
    expect((error as ShadowReadError).code).toBe(code);
  }
}

function rawShopifyToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'shopify',
    accessToken: FIXTURE_SECRET,
    issuedAtUtc: '2026-08-11T17:55:00.000Z',
    expiresAtUtc: '2026-08-11T18:45:00.000Z',
    scopes: [SHOPIFY_SCOPE],
    ...overrides,
  };
}

describe('ephemeral no-refresh read authority', () => {
  it('accepts exact Shopify and eBay read-only scopes', () => {
    expect(tokenFor('shopify')).toMatchObject({ provider: 'shopify', scopes: [SHOPIFY_SCOPE] });
    expect(tokenFor('ebay')).toMatchObject({ provider: 'ebay', scopes: [EBAY_SCOPE] });
  });

  it('redacts the token from object and JSON representations', () => {
    const validated = tokenFor();
    const rendered = JSON.stringify(validated);
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain(FIXTURE_SECRET);
    expect(Object.values(validated)).not.toContain(FIXTURE_SECRET);
  });

  it('denies missing token material and a refresh-token extension', () => {
    const missing = rawShopifyToken();
    delete missing.accessToken;
    expectCode(() => validateEphemeralReadToken(missing, shopifyPolicy(), NOW_UTC), 'token-denied');
    expectCode(() => validateEphemeralReadToken({
      ...rawShopifyToken(),
      refreshToken: 'fixture-refresh-token-must-not-be-accepted',
    }, shopifyPolicy(), NOW_UTC), 'token-denied');
  });

  it('denies expired and near-expiry tokens without a refresh fallback', () => {
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      expiresAtUtc: NOW_UTC,
    }), shopifyPolicy(), NOW_UTC), 'token-expired');
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      expiresAtUtc: '2026-08-11T18:05:00.000Z',
    }), shopifyPolicy(), NOW_UTC), 'token-near-expiry');
  });

  it('denies non-ephemeral lifetime and future-issued authority', () => {
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      issuedAtUtc: '2026-08-11T16:00:00.000Z',
    }), shopifyPolicy(), NOW_UTC), 'token-denied');
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      issuedAtUtc: '2026-08-11T18:01:00.000Z',
    }), shopifyPolicy(), NOW_UTC), 'token-denied');
  });

  it('denies unknown and write scopes, even if policy configuration attempts to allow a write scope', () => {
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      scopes: ['read_unapproved_resource'],
    }), shopifyPolicy(), NOW_UTC), 'token-scope-denied');
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      scopes: ['write_products'],
    }), shopifyPolicy(), NOW_UTC), 'token-scope-denied');
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      scopes: ['write_products'],
    }), {
      ...shopifyPolicy(),
      allowedScopes: ['write_products'],
    }, NOW_UTC), 'configuration-denied');
  });

  it('denies broad eBay sell scopes without the readonly suffix', () => {
    expectCode(() => validateEphemeralReadToken({
      provider: 'ebay',
      accessToken: FIXTURE_SECRET,
      issuedAtUtc: '2026-08-11T17:55:00.000Z',
      expiresAtUtc: '2026-08-11T18:45:00.000Z',
      scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'],
    }, ebayPolicy(), NOW_UTC), 'token-scope-denied');
  });

  it('caps scope count/length and rejects unknown read-looking policy scopes', () => {
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      scopes: Array.from({ length: 9 }, (_, index) => `scope-${index}`),
    }), shopifyPolicy(), NOW_UTC), 'token-denied');
    expectCode(() => validateEphemeralReadToken(rawShopifyToken({
      scopes: ['x'.repeat(257)],
    }), shopifyPolicy(), NOW_UTC), 'token-denied');
    expectCode(() => validateEphemeralReadToken(rawShopifyToken(), {
      ...shopifyPolicy(),
      allowedScopes: ['read_unapproved_resource'],
    }, NOW_UTC), 'configuration-denied');
  });

  it('re-checks provider, exact scope, and expiry at the transport seam', () => {
    const token = tokenFor('shopify');
    expectCode(() => assertEphemeralReadAuthorizedForTransport(
      token,
      'ebay',
      [EBAY_SCOPE],
      NOW_UTC,
    ), 'token-denied');
    expectCode(() => assertEphemeralReadAuthorizedForTransport(
      token,
      'shopify',
      ['read_orders'],
      NOW_UTC,
    ), 'token-scope-denied');
    expectCode(() => assertEphemeralReadAuthorizedForTransport(
      token,
      'shopify',
      [SHOPIFY_SCOPE],
      '2026-08-11T18:40:00.000Z',
    ), 'token-near-expiry');
  });

  it('never copies rejected token material into public errors', () => {
    try {
      validateEphemeralReadToken(rawShopifyToken({ scopes: ['write_products'] }), shopifyPolicy(), NOW_UTC);
      throw new Error('Expected denial');
    } catch (error) {
      const rendered = JSON.stringify(error);
      expect(rendered).not.toContain(FIXTURE_SECRET);
      expect(String(error)).not.toContain(FIXTURE_SECRET);
    }
  });
});
