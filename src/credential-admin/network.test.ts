import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import type { ShopifyCredentialRotationConfig } from './config.js';
import {
  CANONICAL_SHOPIFY_SCOPE_TEXT,
  requestRotatedShopifyAccessToken,
  SHOPIFY_CREDENTIAL_ROTATION_NETWORK_LIMITS,
  SHOPIFY_ROTATION_GRAPHQL_DOCUMENT,
  verifyShopifyAccessToken,
} from './network.js';

const OLD_TOKEN = 'old-shopify-access-token-value';
const NEW_TOKEN = 'new-shopify-access-token-value';
const REFRESH_TOKEN = 'temporary-dashboard-refresh-token';
const CLIENT_SECRET = 'new-production-client-secret';

function config(): ShopifyCredentialRotationConfig {
  return Object.freeze({
    databasePath: '/data/ebaysync.db',
    clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
    clientSecret: CLIENT_SECRET,
    previousClientSecret: 'old-production-client-secret',
    previousClientSecretExpiresAtEpochMs: Date.parse('2026-08-14T19:00:00.000Z'),
    refreshToken: REFRESH_TOKEN,
    storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
    authorizationExpiresAtEpochMs: Date.parse('2026-08-14T19:00:00.000Z'),
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function authority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      shop: {
        id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid,
        myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
      },
      currentAppInstallation: {
        app: { apiKey: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId },
        accessScopes: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes
          .map((handle) => ({ handle })),
      },
    },
    ...overrides,
  };
}

describe('Shopify credential rotation network boundary', () => {
  it('uses the exact official one-shot rotation body, then verifies exact read-only authority', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ access_token: NEW_TOKEN, scope: CANONICAL_SHOPIFY_SCOPE_TEXT }))
      .mockResolvedValueOnce(json(authority()));
    const fresh = await requestRotatedShopifyAccessToken({
      config: config(),
      currentAccessToken: OLD_TOKEN,
      dependencies: { fetchImpl },
    });
    expect(fresh).toEqual({
      accessToken: NEW_TOKEN,
      refreshToken: null,
      scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
      expiresAt: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0]!;
    expect(tokenUrl).toBe(
      'https://usedcameragear.myshopify.com/admin/oauth/access_token',
    );
    expect(tokenInit).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(tokenInit?.body))).toEqual({
      client_id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      access_token: OLD_TOKEN,
    });
    expect(JSON.parse(String(tokenInit?.body))).not.toHaveProperty('grant_type');

    await expect(verifyShopifyAccessToken(NEW_TOKEN, { fetchImpl })).resolves.toEqual({
      storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
      shopGid: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid,
      clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
      scopes: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes,
    });
    const [graphqlUrl, graphqlInit] = fetchImpl.mock.calls[1]!;
    expect(graphqlUrl).toBe(
      'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
    );
    const graphqlBody = JSON.parse(String(graphqlInit?.body));
    expect(graphqlBody).toEqual({
      operationName: 'ProductPipelineShopifyCredentialRotationVerify',
      query: SHOPIFY_ROTATION_GRAPHQL_DOCUMENT,
      variables: {},
    });
    expect(graphqlBody.query).not.toMatch(/\bmutation\b/i);
    expect((graphqlInit?.headers as Record<string, string>)['X-Shopify-Access-Token'])
      .toBe(NEW_TOKEN);
  });

  it.each([
    { label: 'wrong shop', body: authority({ data: { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain }, currentAppInstallation: { app: { apiKey: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId }, accessScopes: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes.map((handle) => ({ handle })) } } }) },
    { label: 'wrong app', body: authority({ data: { shop: { id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid, myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain }, currentAppInstallation: { app: { apiKey: 'wrong-client-id' }, accessScopes: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes.map((handle) => ({ handle })) } } }) },
    { label: 'missing scope', body: authority({ data: { shop: { id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid, myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain }, currentAppInstallation: { app: { apiKey: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId }, accessScopes: [{ handle: 'read_products' }] } } }) },
    { label: 'extra write scope', body: authority({ data: { shop: { id: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid, myshopifyDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain }, currentAppInstallation: { app: { apiKey: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId }, accessScopes: [...PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes.map((handle) => ({ handle })), { handle: 'write_products' }] } } }) },
    { label: 'GraphQL errors', body: { data: authority().data, errors: [{ message: 'denied' }] } },
  ])('rejects $label before any local caller can commit', async ({ body }) => {
    await expect(verifyShopifyAccessToken(NEW_TOKEN, {
      fetchImpl: async () => json(body),
    })).rejects.toMatchObject({ code: 'verification-denied' });
  });

  it.each([
    { label: 'same token', response: json({ access_token: OLD_TOKEN }) },
    { label: 'expiry metadata', response: json({ access_token: NEW_TOKEN, expires_in: 3600 }) },
    { label: 'refresh metadata', response: json({ access_token: NEW_TOKEN, refresh_token: 'unexpected' }) },
    { label: 'wrong scopes', response: json({ access_token: NEW_TOKEN, scope: 'read_products,write_products' }) },
    { label: 'duplicate scope', response: json({ access_token: NEW_TOKEN, scope: `${CANONICAL_SHOPIFY_SCOPE_TEXT},read_products` }) },
    { label: 'HTTP failure', response: json({ error: 'denied' }, { status: 401 }) },
    { label: 'wrong content type', response: new Response('{}', { status: 200, headers: { 'Content-Type': 'text/plain' } }) },
    { label: 'malformed JSON', response: new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }) },
    { label: 'oversized declaration', response: new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(SHOPIFY_CREDENTIAL_ROTATION_NETWORK_LIMITS.tokenResponseMaxBytes + 1) } }) },
  ])('fails closed for token response: $label', async ({ response }) => {
    await expect(requestRotatedShopifyAccessToken({
      config: config(),
      currentAccessToken: OLD_TOKEN,
      dependencies: { fetchImpl: async () => response },
    })).rejects.toMatchObject({ code: 'provider-denied' });
  });

  it('bounds every request with an aborting timeout and performs no retry', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      throw new Error('timeout was not attached');
    });
    await expect(requestRotatedShopifyAccessToken({
      config: config(),
      currentAccessToken: OLD_TOKEN,
      dependencies: {
        fetchImpl,
        scheduleTimeout: ((callback: () => void) => {
          callback();
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }),
        clearScheduledTimeout: () => undefined,
      },
    })).rejects.toMatchObject({ code: 'provider-denied' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
