import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sha256Digest, type EvidenceCaptureConfig, type LoadedEvidenceCaptureConfig } from '../config.js';
import { EBAY_READ_SCOPES, type EbayGetRequest } from '../ebay.js';
import {
  createEbayNetworkTransport,
  createShopifyNetworkDispatcher,
  EVIDENCE_AUTHORITY_ENVIRONMENT,
  EvidenceNetworkError,
  inspectEvidenceAuthorityAvailability,
} from '../network.js';
import { SHOPIFY_GRAPHQL_DOCUMENTS } from '../shopify.js';

function loadedConfig(): LoadedEvidenceCaptureConfig {
  const { publicKey } = generateKeyPairSync('ed25519');
  const config: EvidenceCaptureConfig = {
    schemaVersion: 1,
    project: 'product-pipeline',
    lane: 'production-shadow',
    mode: 'authoritative-read-capture',
    outputDirectory: '.local/evidence-capture',
    identities: {
      shopifyStoreDomain: 'usedcameragear.myshopify.com',
      shopifyShopGid: 'gid://shopify/Shop/1',
      shopifyAppGid: 'gid://shopify/App/2',
      ebayEnvironment: 'production',
      ebayUserId: 'immutable-seller-id',
      ebayMarketplaceId: 'EBAY_US',
      ebayRegistrationMarketplaceId: 'EBAY_US',
    },
    collector: {
      name: 'product-pipeline-evidence-capture',
      version: 1,
      buildCommit: 'a'.repeat(40),
    },
    signing: {
      keyId: 'capture-key-v1',
      publicKeySpkiDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    },
    limits: {
      requestTimeoutMs: 15_000,
      maxPagesPerSource: 100,
      maxRecordsPerSource: 10_000,
      maxResponseBytes: 4 * 1024 * 1024,
      minimumEbayAccessValiditySeconds: 900,
      maxOrderWindowHours: 168,
    },
    safety: {
      externalPlatformReads: true,
      externalPlatformWrites: false,
      historicalBackfill: false,
      oauthAcquisition: false,
      accessRefresh: false,
      rawPayloadPersistence: false,
      personalDataPersistence: false,
      cutoverWatermarkUtc: null,
      ownershipTransferAllowed: false,
    },
  };
  return {
    config,
    repositoryRoot: '/safe/repository',
    configAbsolutePath: '/safe/repository/config/evidence-capture.json',
    outputDirectoryAbsolutePath: '/safe/repository/.local/evidence-capture',
    scopeDigest: sha256Digest(config.identities),
    configDigest: sha256Digest(config),
  };
}

function authorityEnvironment() {
  return {
    [EVIDENCE_AUTHORITY_ENVIRONMENT.shopifyAccess]: 'shopify-read-authority-value',
    [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayAccess]: 'ebay-read-authority-value',
    [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayScopes]: [
      EBAY_READ_SCOPES.identity,
      EBAY_READ_SCOPES.inventory,
      EBAY_READ_SCOPES.fulfillment,
    ].join(' '),
    [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayIssuedAt]: '2026-08-11T19:30:00.000Z',
    [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayExpiresAt]: '2026-08-11T21:00:00.000Z',
    PRODUCT_PIPELINE_EVIDENCE_SIGNING_KEY_PKCS8_B64: 'present-only',
  };
}

describe('evidence capture network boundary', () => {
  it('performs only the exact static Shopify semantic-read query', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        'X-Shopify-Access-Token': 'shopify-read-authority-value',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        operationName: 'ProductPipelineShopifyPreflight',
        query: SHOPIFY_GRAPHQL_DOCUMENTS.preflight,
        variables: {},
      });
      return new Response(JSON.stringify({ data: { safe: true } }), {
        status: 200,
        headers: { 'x-shopify-api-version': '2026-07' },
      });
    });
    const dispatcher = createShopifyNetworkDispatcher({
      loaded: loadedConfig(),
      environment: authorityEnvironment(),
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    const response = await dispatcher({
      method: 'POST',
      url: 'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      authority: { kind: 'injected-shopify-read-authority', secretExposed: false },
      redirect: 'error',
      signal: new AbortController().signal,
      body: {
        operationName: 'ProductPipelineShopifyPreflight',
        query: SHOPIFY_GRAPHQL_DOCUMENTS.preflight,
        variables: {},
      },
    });
    expect(response).toEqual({
      status: 200,
      apiVersion: '2026-07',
      body: { data: { safe: true } },
    });
    expect(JSON.stringify(response)).not.toContain('authority-value');
  });

  it('rejects altered GraphQL documents before fetch', async () => {
    const fetch = vi.fn();
    const dispatcher = createShopifyNetworkDispatcher({
      loaded: loadedConfig(),
      environment: authorityEnvironment(),
      fetch,
    });
    await expect(dispatcher({
      method: 'POST',
      url: 'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      authority: { kind: 'injected-shopify-read-authority', secretExposed: false },
      redirect: 'error',
      signal: new AbortController().signal,
      body: {
        operationName: 'ProductPipelineShopifyPreflight',
        query: 'mutation { productDelete(input: {}) { userErrors { message } } }',
        variables: {},
      },
    })).rejects.toBeInstanceOf(EvidenceNetworkError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops an undeclared streaming response at the configured byte cap', async () => {
    const base = loadedConfig();
    const loaded: LoadedEvidenceCaptureConfig = {
      ...base,
      config: {
        ...base.config,
        limits: { ...base.config.limits, maxResponseBytes: 1_024 },
      },
    };
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(800));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'x-shopify-api-version': '2026-07' },
    }));
    const dispatcher = createShopifyNetworkDispatcher({
      loaded,
      environment: authorityEnvironment(),
      fetch,
    });
    await expect(dispatcher({
      method: 'POST',
      url: 'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      authority: { kind: 'injected-shopify-read-authority', secretExposed: false },
      redirect: 'error',
      signal: new AbortController().signal,
      body: {
        operationName: 'ProductPipelineShopifyPreflight',
        query: SHOPIFY_GRAPHQL_DOCUMENTS.preflight,
        variables: {},
      },
    })).rejects.toThrow(/response-denied/);
  });

  it('performs only allowlisted eBay GETs with no body or refresh behavior', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer ebay-read-authority-value' });
      return new Response(JSON.stringify({ total: 0, limit: 200 }), { status: 200 });
    });
    const { transport, authorization } = createEbayNetworkTransport({
      loaded: loadedConfig(),
      environment: authorityEnvironment(),
      fetch,
      nowUtc: '2026-08-11T20:00:00.000Z',
    });
    expect(authorization.refreshSupported).toBe(false);
    expect(authorization.credentialProvidedToCollector).toBe(false);
    expect(JSON.stringify(authorization)).not.toContain('authority-value');
    const request: EbayGetRequest = {
      method: 'GET',
      url: 'https://api.ebay.com/sell/inventory/v1/inventory_item?limit=200&offset=0',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      requiredScope: EBAY_READ_SCOPES.inventory,
      signal: new AbortController().signal,
      credentialProvidedToCollector: false,
    };
    expect(await transport.get(request)).toEqual({ status: 200, body: { total: 0, limit: 200 } });
  });

  it('rejects an alternate eBay host, path, or query before fetch', async () => {
    const fetch = vi.fn();
    const { transport } = createEbayNetworkTransport({
      loaded: loadedConfig(),
      environment: authorityEnvironment(),
      fetch,
      nowUtc: '2026-08-11T20:00:00.000Z',
    });
    await expect(transport.get({
      method: 'GET',
      url: 'https://api.ebay.com/sell/inventory/v1/offer?sku=SAFE&limit=25&offset=0&marketplace_id=EBAY_US&extra=1',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      requiredScope: EBAY_READ_SCOPES.inventory,
      signal: new AbortController().signal,
      credentialProvidedToCollector: false,
    })).rejects.toBeInstanceOf(EvidenceNetworkError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed on missing, expired, and near-expiry authority metadata', () => {
    expect(() => createShopifyNetworkDispatcher({
      loaded: loadedConfig(),
      environment: {},
      fetch: vi.fn(),
    })).toThrow(EvidenceNetworkError);

    const expired = authorityEnvironment();
    expired[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayExpiresAt] = '2026-08-11T19:59:59.000Z';
    expect(() => createEbayNetworkTransport({
      loaded: loadedConfig(),
      environment: expired,
      fetch: vi.fn(),
      nowUtc: '2026-08-11T20:00:00.000Z',
    })).toThrow(/authority-expired/);

    const nearExpiry = authorityEnvironment();
    nearExpiry[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayExpiresAt] = '2026-08-11T20:10:00.000Z';
    expect(() => createEbayNetworkTransport({
      loaded: loadedConfig(),
      environment: nearExpiry,
      fetch: vi.fn(),
      nowUtc: '2026-08-11T20:00:00.000Z',
    })).toThrow(/authority-near-expiry/);

    const broadScopes = authorityEnvironment();
    broadScopes[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayScopes] +=
      ' https://api.ebay.com/oauth/api_scope/sell.inventory';
    expect(() => createEbayNetworkTransport({
      loaded: loadedConfig(),
      environment: broadScopes,
      fetch: vi.fn(),
      nowUtc: '2026-08-11T20:00:00.000Z',
    })).toThrow(/authority-invalid/);
  });

  it('reports only presence metadata and never authority values', () => {
    const availability = inspectEvidenceAuthorityAvailability(authorityEnvironment());
    expect(availability).toEqual({
      shopifyAccessPresent: true,
      ebayAccessPresent: true,
      ebayScopeMetadataPresent: true,
      ebayExpiryMetadataPresent: true,
      signingAuthorityPresent: true,
    });
    expect(JSON.stringify(availability)).not.toContain('authority-value');
  });
});
