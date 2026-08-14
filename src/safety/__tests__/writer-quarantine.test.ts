import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ebayRequest } from '../../ebay/client.js';
import { createShippingFulfillment } from '../../ebay/fulfillment.js';
import { createOffer, updateInventoryQuantity, updateOffer } from '../../ebay/inventory.js';
import { buildLegacyCli } from '../../cli/index.js';
import { runOrderSync } from '../../server/sync-helper.js';
import { createShopifyOrder } from '../../shopify/orders.js';
import { setInventoryLevel } from '../../shopify/inventory.js';
import { syncFulfillments } from '../../sync/fulfillment-sync.js';
import {
  handleInventoryWebhook,
  syncAllInventory,
  updateEbayInventory,
} from '../../sync/inventory-sync.js';
import {
  applyPriceDropSchedule,
  enablePromotedListings,
  republishStaleListings,
  runListingManagement,
} from '../../sync/listing-manager.js';
import { syncOrders } from '../../sync/order-sync.js';
import { syncPrices } from '../../sync/price-sync.js';
import {
  autoSyncNewProducts,
  endEbayListing,
  syncProducts,
  updateProductOnEbay,
} from '../../sync/product-sync.js';
import {
  getMigrationPolicyStatus,
  MARKETPLACE_CONNECT_BASELINE,
  WriterQuarantinedError,
  writerQuarantineMiddleware,
} from '../writer-quarantine.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('writer quarantine policy', () => {
  it('is hard-coded read-only and cannot be opened with runtime flags', () => {
    vi.stubEnv('WRITES_ENABLED', 'true');
    vi.stubEnv('TEST_MODE', 'true');
    vi.stubEnv('AUTO_SYNC_ENABLED', 'true');

    const status = getMigrationPolicyStatus('2026-08-11T18:00:00.000Z');
    expect(status.effectiveMode).toBe('shadow-read-only');
    expect(status.externalWritesAllowed).toBe(false);
    expect(status.historicalBackfillAllowed).toBe(false);
    expect(status.cutoverWatermarkUtc).toBeNull();
    expect(status.servedAt).toBe('2026-08-11T18:00:00.000Z');
    expect(status).not.toHaveProperty('observedAt');
    expect(status.quarantine.runtimeOverrideAvailable).toBe(false);
    expect(MARKETPLACE_CONNECT_BASELINE.responsibilities.orderImport.owner).toBe(
      'marketplace-connect',
    );

  });

  it('default-denies every state-changing API method with a stable 423 response', () => {
    const next = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    writerQuarantineMiddleware(
      { method: 'POST', originalUrl: '/api/sync/trigger?dry=false', path: '/sync/trigger' } as never,
      { status } as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(423);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'WRITER_QUARANTINED',
        responsibility: 'orderImport',
        externalWritesAllowed: false,
        cutoverWatermarkUtc: null,
      }),
    );
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('permits read method %s', (method) => {
    const next = vi.fn();
    writerQuarantineMiddleware(
      { method, originalUrl: '/api/migration/status', path: '/migration/status' } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it.each(['/api/listing-draft', '/api/listing-proposal'])(
    'permits only exact local control append %s without provider authority',
    (originalUrl) => {
      const next = vi.fn();
      writerQuarantineMiddleware(
        { method: 'POST', originalUrl, path: originalUrl.slice(4) } as never,
        {} as never,
        next,
      );
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it.each([
    '/api/listing-proposal/', '/api/Listing-proposal',
    '/api/listing-proposal?publish=true', '/api/listing-proposals',
  ])('keeps proposal sibling %s quarantined', (originalUrl) => {
    const next = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    writerQuarantineMiddleware(
      { method: 'POST', originalUrl, path: originalUrl.slice(4) } as never,
      { status } as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(423);
  });

  it('removes every mutation command from the legacy CLI', () => {
    const commands = buildLegacyCli().commands.map((command) => command.name());
    expect(commands).toEqual(['status']);
    for (const forbidden of ['sync', 'import', 'publish', 'write', 'cleanup', 'inventory']) {
      expect(commands).not.toContain(forbidden);
    }
  });
});

describe('writer entry points fail before network or database work', () => {
  it('blocks low-level platform writers before fetch', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network should be unreachable');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const attempts = [
      () => ebayRequest({ method: 'POST', path: '/sell/inventory/v1/offer', accessToken: 'x' }),
      () => createOffer('x', {} as never),
      () => updateOffer('x', 'offer', {} as never),
      () => updateInventoryQuantity('x', 'SKU', 1),
      () => createShippingFulfillment('x', 'order', {} as never),
      () => createShopifyOrder('x', {} as never),
      () => setInventoryLevel('x', 1, 1, 1),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(WriterQuarantinedError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks every mapped sync trigger before fetch or local DB initialization', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network should be unreachable');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const attempts = [
      () => runOrderSync({ confirm: true, dryRun: false }),
      () => syncOrders('x', 'y', { confirm: true, dryRun: false }),
      () => syncPrices('x', 'y', { dryRun: false }),
      () => syncAllInventory('x', 'y', { dryRun: false }),
      () => updateEbayInventory('x', 'SKU', 1, { dryRun: false }),
      () => handleInventoryWebhook('x', '1', '2', 1),
      () => syncProducts('x', 'y', ['1'], {}, { dryRun: false }),
      () => autoSyncNewProducts('x', 'y', { auto_list: 'true' }),
      () => updateProductOnEbay('x', 'y', '1'),
      () => endEbayListing('x', '1'),
      () => syncFulfillments('x', 'y', { dryRun: false }),
      () => republishStaleListings('x'),
      () => applyPriceDropSchedule('x'),
      () => enablePromotedListings('x', ['1']),
      () => runListingManagement('x'),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(WriterQuarantinedError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps mapped automatic dispatches absent from server and webhook sources', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const server = await fs.readFile(path.join(sourceRoot, 'server/index.ts'), 'utf8');
    const ebayWebhook = await fs.readFile(
      path.join(sourceRoot, 'server/routes/ebay-notifications.ts'),
      'utf8',
    );
    const shopifyWebhook = await fs.readFile(
      path.join(sourceRoot, 'server/routes/shopify-webhooks.ts'),
      'utf8',
    );

    expect(server).not.toMatch(/startSyncScheduler|startCloudWatcher|runOrderSync|runListingManagement/);
    expect(server).not.toMatch(/shopifyAuthRoutes|ebayAuthRoutes|routes\/shopify-auth|routes\/ebay-auth/);
    expect(ebayWebhook).not.toMatch(/runOrderSync|syncOrders|fetchAllEbayOrders/);
    expect(ebayWebhook).not.toMatch(/getRawDb|parseStringPromise|INSERT\s+INTO|\.prepare\s*\(/i);
    expect(shopifyWebhook).not.toMatch(
      /syncProducts|updateProductOnEbay|updateEbayInventory|createShippingFulfillment|autoListProduct/,
    );
    expect(shopifyWebhook).not.toMatch(/getRawDb|INSERT\s+INTO|\.prepare\s*\(/i);
  });

  it('keeps tracked executable artifacts aligned with the source quarantine', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const distRoot = path.resolve(sourceRoot, '../dist');
    const server = await fs.readFile(path.join(distRoot, 'server/index.js'), 'utf8');
    const auth = await fs.readFile(path.join(distRoot, 'server/middleware/auth.js'), 'utf8');
    const shadowApi = await fs.readFile(path.join(distRoot, 'server/routes/shadow-api.js'), 'utf8');
    const shadowDb = await fs.readFile(path.join(distRoot, 'server/shadow-db.js'), 'utf8');
    const cli = await fs.readFile(path.join(distRoot, 'cli/index.js'), 'utf8');

    expect(server).toMatch(/writerQuarantineMiddleware/);
    expect(server).toMatch(/shadowApiRoutes/);
    expect(server).not.toMatch(
      /shopifyAuthRoutes|ebayAuthRoutes|startSyncScheduler|startCloudWatcher|chatRoutes|pipelineRoutes/,
    );
    expect(server).not.toMatch(
      /apiRoutes|ebayOrderRoutes|ebayMetadataRoutes|helpRoutes|featureRoutes|getDb|getRawDb|seedHelpArticles/,
    );
    expect(auth).toMatch(/decodeSessionToken|ALLOW_OPERATOR_API_KEY/);
    expect(auth).not.toMatch(/req\.headers\.referer|req\.query\.api_key|sameOrigin/);
    expect(shadowApi).toMatch(/openShadowDatabase/);
    expect(shadowApi).not.toMatch(/getRawDb|getValidEbayToken|\bfetch\s*\(/);
    expect(shadowDb).toMatch(/readonly:\s*true|fileMustExist:\s*true|query_only = ON/);
    expect(cli).toMatch(/\.command\(['"]status['"]\)/);
    expect(cli).not.toMatch(
      /\.command\(['"](?:sync|import|publish|inventory|orders|products|watcher|pipeline|drafts|images|listings|tim)['"]\)/,
    );
  });

  it('mounts only the five read-only control-plane pages', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const app = await fs.readFile(path.join(sourceRoot, 'web/App.tsx'), 'utf8');
    const routePaths = [...app.matchAll(/<Route path="([^"]+)"/g)].map((match) => match[1]);

    expect(routePaths).toEqual([
      '/',
      '/listings',
      '/listings/:id',
      '/orders',
      '/issues',
      '/reconciliation',
      '/settings',
      '*',
    ]);
    expect(app).not.toMatch(/ChatWidget|PipelineToasts|EbayOrders|ReviewQueue|ImageProcessor/);
  });
});
