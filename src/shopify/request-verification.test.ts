import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeShopifySessionTokenForRequest,
  verifyShopifyWebhookHmac,
} from './request-verification.js';

const NOW = Date.parse('2026-08-14T18:00:00.000Z');
const BODY = Buffer.from('{"id":"gid://shopify/Product/1"}');

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    SHOPIFY_CLIENT_ID: '2db0555e4848a8264383dc0edfcfb8fe',
    SHOPIFY_CLIENT_SECRET: 'new-test-shopify-secret',
    ...overrides,
  };
}

function hmac(secret: string): string {
  return crypto.createHmac('sha256', secret).update(BODY).digest('base64');
}

describe('Shopify request verification rotation boundary', () => {
  it('accepts webhook signatures from current and bounded previous secrets', async () => {
    const dependencies = {
      environment: environment({
        SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old-test-shopify-secret',
        SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:30:00.000Z',
      }),
      now: () => NOW,
      loadCredentials: vi.fn(async () => { throw new Error('file fallback must not run'); }),
    };

    await expect(verifyShopifyWebhookHmac(hmac('new-test-shopify-secret'), BODY, dependencies))
      .resolves.toBe(true);
    await expect(verifyShopifyWebhookHmac(hmac('old-test-shopify-secret'), BODY, dependencies))
      .resolves.toBe(true);
    expect(dependencies.loadCredentials).not.toHaveBeenCalled();
  });

  it('rejects noncanonical HMAC and an unrelated signature', async () => {
    const dependencies = { environment: environment(), now: () => NOW };
    await expect(verifyShopifyWebhookHmac('not-base64', BODY, dependencies)).resolves.toBe(false);
    await expect(verifyShopifyWebhookHmac(hmac('unrelated-shopify-secret'), BODY, dependencies))
      .resolves.toBe(false);
  });

  it('ignores the previous secret at the exact cutoff while preserving primary verification', async () => {
    const dependencies = {
      environment: environment({
        SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old-test-shopify-secret',
        SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:00:00.000Z',
      }),
      now: () => NOW,
    };
    await expect(verifyShopifyWebhookHmac(hmac('new-test-shopify-secret'), BODY, dependencies))
      .resolves.toBe(true);
    await expect(verifyShopifyWebhookHmac(hmac('old-test-shopify-secret'), BODY, dependencies))
      .resolves.toBe(false);
  });

  it.each([
    {
      SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old-test-shopify-secret',
      SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: undefined,
    },
    {
      SHOPIFY_PREVIOUS_CLIENT_SECRET: undefined,
      SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:30:00.000Z',
    },
    {
      SHOPIFY_PREVIOUS_CLIENT_SECRET: 'new-test-shopify-secret',
      SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:30:00.000Z',
    },
    {
      SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old-test-shopify-secret',
      SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T19:00:00.001Z',
    },
    {
      SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old test shopify secret',
      SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:30:00.000Z',
    },
  ])('fails every verifier closed for malformed overlap configuration %#', async (overrides) => {
    const dependencies = { environment: environment(overrides), now: () => NOW };
    await expect(verifyShopifyWebhookHmac(hmac('new-test-shopify-secret'), BODY, dependencies))
      .resolves.toBe(false);
    await expect(decodeShopifySessionTokenForRequest('not-a-jwt', dependencies))
      .resolves.toBeNull();
  });

  it('requires Production credentials from the environment without file fallback', async () => {
    const loadCredentials = vi.fn(async () => ({
      clientId: 'fallback-client-id',
      clientSecret: 'fallback-client-secret',
      storeDomain: 'usedcameragear.myshopify.com',
    }));
    await expect(verifyShopifyWebhookHmac(hmac('fallback-client-secret'), BODY, {
      environment: { NODE_ENV: 'production' },
      now: () => NOW,
      loadCredentials,
    })).resolves.toBe(false);
    expect(loadCredentials).not.toHaveBeenCalled();
  });

  it('also rejects credential-file fallback when NODE_ENV is ambiguous', async () => {
    const loadCredentials = vi.fn(async () => ({
      clientId: '2db0555e4848a8264383dc0edfcfb8fe',
      clientSecret: 'fallback-client-secret',
      storeDomain: 'usedcameragear.myshopify.com',
    }));
    await expect(verifyShopifyWebhookHmac(hmac('fallback-client-secret'), BODY, {
      environment: {},
      now: () => NOW,
      loadCredentials,
    })).resolves.toBe(false);
    expect(loadCredentials).not.toHaveBeenCalled();
  });
});
