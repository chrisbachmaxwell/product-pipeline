import type { FixtureReadTransportConfig } from '../transport.js';
import {
  validateEphemeralReadToken,
  type EphemeralReadTokenPolicy,
  type ReadProvider,
  type ValidatedEphemeralReadToken,
} from '../token.js';

export const NOW_UTC = '2026-08-11T18:00:00.000Z';
export const FIXTURE_SECRET = 'fixture-access-token-1234567890';
export const SHOPIFY_SCOPE = 'read_products';
export const EBAY_SCOPE =
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly';

export function shopifyPolicy(): EphemeralReadTokenPolicy {
  return {
    provider: 'shopify',
    allowedScopes: [SHOPIFY_SCOPE, 'read_orders'],
    minimumRemainingValidityMs: 5 * 60 * 1_000,
    maximumLifetimeMs: 60 * 60 * 1_000,
  };
}

export function ebayPolicy(): EphemeralReadTokenPolicy {
  return {
    provider: 'ebay',
    allowedScopes: [
      EBAY_SCOPE,
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    ],
    minimumRemainingValidityMs: 5 * 60 * 1_000,
    maximumLifetimeMs: 2 * 60 * 60 * 1_000,
  };
}

export function tokenFor(provider: ReadProvider = 'shopify'): ValidatedEphemeralReadToken {
  return validateEphemeralReadToken({
    provider,
    accessToken: FIXTURE_SECRET,
    issuedAtUtc: '2026-08-11T17:55:00.000Z',
    expiresAtUtc: '2026-08-11T18:45:00.000Z',
    scopes: [provider === 'shopify' ? SHOPIFY_SCOPE : EBAY_SCOPE],
  }, provider === 'shopify' ? shopifyPolicy() : ebayPolicy(), NOW_UTC);
}

export function transportConfig(
  overrides: Partial<FixtureReadTransportConfig> = {},
): FixtureReadTransportConfig {
  return {
    shopify: {
      host: 'usedcameragear.myshopify.com',
      storeDomain: 'usedcameragear.myshopify.com',
      allowedPathTemplates: [
        '/admin/api/{version}/products.json',
      ],
      allowedOrderPathTemplates: ['/admin/api/{version}/orders.json'],
      allowedQueryParameters: ['limit', 'page_info'],
    },
    ebay: {
      host: 'api.sandbox.ebay.com',
      environment: 'sandbox',
      sellerAccount: 'usedcam-test',
      marketplaceId: 'EBAY_US',
      allowedPathTemplates: [
        '/sell/inventory/v1/inventory_item',
        '/sell/inventory/v1/inventory_item/{sku}',
      ],
      allowedOrderPathTemplates: ['/sell/fulfillment/v1/order'],
      allowedQueryParameters: ['limit', 'offset'],
    },
    limits: {
      timeoutMs: 100,
      maxPages: 4,
      maxRecords: 10,
      maxResponseBytes: 4_096,
    },
    ...overrides,
  };
}
