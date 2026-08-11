import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import shadowApiRoutes, {
  projectLocalListing,
  SHADOW_API_GET_PATHS,
} from './shadow-api.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function registeredGetPaths(): string[] {
  const stack = (shadowApiRoutes as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  }).stack;
  return stack
    .filter((layer) => layer.route?.methods.get)
    .map((layer) => layer.route!.path);
}

async function requestShadowPath(pathname: string): Promise<number> {
  const app = express();
  app.use(shadowApiRoutes);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not available' });
  });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
    return await new Promise<number>((resolve, reject) => {
      const request = http.get(
        { hostname: '127.0.0.1', port: address.port, path: pathname },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('shadow API allowlist', () => {
  it('registers only the migration, projected-listing, and capability reads', () => {
    expect(registeredGetPaths()).toEqual([...SHADOW_API_GET_PATHS]);
    expect(SHADOW_API_GET_PATHS).not.toEqual(expect.arrayContaining([
      '/api/status',
      '/api/orders',
      '/api/ebay/orders',
      '/api/logs',
      '/api/settings',
      '/api/test/ebay-offer/:sku',
      '/api/products/overview',
    ]));
  });

  it('projects local listing rows without notes, credentials, or unrelated legacy fields', () => {
    const projected = projectLocalListing({
      id: 7,
      shopify_product_id: 'shopify-1',
      ebay_listing_id: 'ebay-1',
      status: 'active',
      shopify_title: 'Camera',
      shopify_sku: 'SAFE-SKU',
      shopify_price: 125,
      original_price: 130,
      updated_at: 123456,
      product_notes: 'private operator note',
      access_token: 'must-not-escape',
      buyer_username: 'must-not-escape',
      shipping_address_json: '{"name":"must-not-escape"}',
      ad_rate: 9.5,
    });

    expect(projected).toEqual({
      id: 7,
      shopify_product_id: 'shopify-1',
      ebay_listing_id: 'ebay-1',
      status: 'active',
      shopify_title: 'Camera',
      shopify_sku: 'SAFE-SKU',
      shopify_price: 125,
      original_price: 130,
      updated_at: 123456,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /private operator note|must-not-escape|buyer|shipping|access[_-]?token|ad_rate/i,
    );
  });

  it.each([
    '/api/status',
    '/api/orders',
    '/api/ebay/orders',
    '/api/ebay/orders/1',
    '/api/logs',
    '/api/settings',
    '/api/test/ebay-offer/SAFE-SKU',
    '/api/products/overview',
    '/api/listings/stale',
  ])('returns 404 for unmounted legacy GET %s', async (pathname) => {
    await expect(requestShadowPath(pathname)).resolves.toBe(404);
  });

  it('does not mount legacy routers or a remote/token reader in the running server', async () => {
    const [server, shadowRouter] = await Promise.all([
      fs.readFile(path.join(sourceRoot, 'server/index.ts'), 'utf8'),
      fs.readFile(path.join(sourceRoot, 'server/routes/shadow-api.ts'), 'utf8'),
    ]);

    expect(server).toMatch(/shadowApiRoutes/);
    expect(server).not.toMatch(
      /apiRoutes|helpRoutes|featureRoutes|ebayOrderRoutes|ebayMetadataRoutes|migrationRoutes/,
    );
    expect(server).not.toMatch(
      /getDb|getRawDb|initExtraTables|initPhotoTemplatesTable|seedDefaultSettings|seedHelpArticles/,
    );
    expect(server).toMatch(/express\.json\(\{ limit: '64kb' \}\)/);
    expect(server).not.toMatch(/limit:\s*['"]50mb['"]/i);
    expect(server).toMatch(/if \(isTestMode\(\)\) \{\s*app\.get\('\/api\/test-mode'/s);
    expect(server).toMatch(/express\.static\(webDistPath, \{ index: false \}\)/);
    expect(shadowRouter).not.toMatch(
      /\bfetch\s*\(|getValidEbayToken|refreshEbayUserToken|auth_tokens|shopify\/products|ebay\/inventory/,
    );
    expect(shadowRouter).toMatch(/openShadowDatabase/);
    expect(shadowRouter).not.toMatch(/getDb|getRawDb|db\/client/);
    expect(shadowRouter).not.toMatch(/SELECT\s+\*/i);
  });
});
