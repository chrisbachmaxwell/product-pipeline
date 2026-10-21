import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeListingControlStore } from '../listing-control-store/index.js';
import { createLiveListingCatalogCache } from './live-listing-catalog-source.js';
import type { LiveListingCatalogRow, LiveListingCatalogSnapshot } from './live-listing-catalog.js';
import { LISTING_DRAFT_SCOPE, ListingDraftServiceError, createListingDraftService } from './listing-draft-service.js';
import { ListingWorkspaceReaderError, createListingWorkspaceReader } from './listing-workspace-reader.js';
import { getPublishAllStatus, releasePublishLock, startPublishAllRun, type PublishAllDependencies } from './publish-all.js';

/**
 * Incident #213: seven ready items all skipped with LISTING_DRAFT_UNAVAILABLE.
 * The workspace reader fails closed while the catalog cache records an
 * unresolved refresh failure, and the cache serves its young snapshot without
 * retrying, so ONE failed background/webhook refresh after the run-start
 * census refused every draft until the TTL ran out. This drives the real
 * cache, reader and draft service (temporary local store) through a run.
 */

const PRODUCT = 'gid://shopify/Product/10310708035875';
const VARIANT = 'gid://shopify/ProductVariant/55396000563491';
const CATALOG_ID = `shopify-variant:${VARIANT}`;
const SKU = 'BIGSTOPPER-U021';
const MANIFEST = `sha256:${'c'.repeat(64)}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.PUBLISH_PREFLIGHT_ARGV;
  delete process.env.PUBLISH_DISPATCH_ARGV;
  releasePublishLock();
});

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-all-unavailable-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const target = path.join(root, 'drafts.sqlite');
  initializeListingControlStore({ databasePath: target, scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-13T21:00:00.000Z' }).close();
  return target;
}

function snapshot(): LiveListingCatalogSnapshot {
  const observedAtUtc = new Date().toISOString();
  const row = {
    id: CATALOG_ID,
    readyToList: true,
    shopify: {
      productId: PRODUCT, variantId: VARIANT, sku: SKU, title: 'LEE Big Stopper 100x100mm ND Filter',
      variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1,
      available: 1, price: { amount: '99.95', currency: 'USD' }, productTags: ['condition-excellent'],
    },
    ebay: {
      sku: SKU, state: 'not_listed', listingId: null, offerId: null, url: null,
      activeMatchCount: 0, inventoryItemCount: 0, offerCount: 0, unpublishedArtifactCount: 0,
    },
    lifecycleStatus: 'not_listed',
    lastVerifiedAtUtc: observedAtUtc,
    audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
      attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
  } as unknown as LiveListingCatalogRow;
  return { observedAtUtc, rows: [row] } as unknown as LiveListingCatalogSnapshot;
}

function harness(captures: Array<'ok' | 'fail'>) {
  let calls = 0;
  const cache = createLiveListingCatalogCache(async () => {
    const outcome = captures[calls] ?? 'ok';
    calls += 1;
    if (outcome === 'fail') throw new Error('SHOPIFY_CAPTURE_FAILED');
    return snapshot();
  });
  const readWorkspace = createListingWorkspaceReader({
    getSnapshot: cache,
    getSnapshotStatus: cache.status,
    getEbayAccessToken: async () => 'unused',
    readEbayDetail: async () => { throw new Error('not listed'); },
    readShopifyContent: async () => ({
      descriptionHtml: '<p>Clean filter.</p>',
      imageUrls: ['https://cdn.shopify.com/s/files/1/0862/5451/8563/files/bigstopper.jpg'],
      brand: 'LEE', mpn: 'BIGSTOPPER', upc: null,
    }),
  });
  const db = databasePath();
  const draftService = createListingDraftService({
    readWorkspace, databasePath: () => db, writerInstanceReady: () => true,
  });
  let first = true;
  const steps: string[][] = [];
  const dependencies: PublishAllDependencies = {
    // The run-start census succeeds; right after it a background (or
    // webhook) refresh fails, which is what left the cache flagged.
    getSnapshot: async () => {
      const value = await cache.refresh();
      if (first) {
        first = false;
        await cache.refresh().catch(() => undefined);
      }
      return value;
    },
    draftService: draftService as unknown as PublishAllDependencies['draftService'],
    getCategoryAspects: async () => ({ available: true, aspects: [] }),
    fillAspects: null,
    findUnresolvedCreate: () => null,
    latestRevisionDigest: () => null,
    agingUnresolvedCreateSkus: () => new Set(),
    runStep: async (argv) => {
      steps.push([...argv]);
      if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
      return { json: { status: 'created-and-reconciled', listingId: '147000000213' } };
    },
    sleep: async () => undefined,
  };
  return { cache, readWorkspace, draftService, dependencies, steps, captureCount: () => calls };
}

function arm(): void {
  process.env.PUBLISH_PREFLIGHT_ARGV = JSON.stringify(['cli.js', 'preflight-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}']);
  process.env.PUBLISH_DISPATCH_ARGV = JSON.stringify(['cli.js', 'dispatch-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--manifest-digest', '{manifestDigest}']);
}

describe('publish-all draft refused by a failed catalog refresh (incident #213)', () => {
  it('names the catalog gate behind LISTING_DRAFT_UNAVAILABLE', async () => {
    const { cache, readWorkspace, draftService } = harness(['ok', 'fail']);
    await cache.refresh();
    await cache.refresh().catch(() => undefined);
    await expect(readWorkspace(CATALOG_ID)).rejects.toMatchObject({
      constructor: ListingWorkspaceReaderError, kind: 'unavailable', detail: 'catalog_refresh_failed',
    });
    const refused = await draftService.get(CATALOG_ID).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListingDraftServiceError);
    expect(refused).toMatchObject({
      code: 'LISTING_DRAFT_UNAVAILABLE', detail: 'workspace_catalog_refresh_failed',
    });
  });

  it('refreshes the catalog once, prepares the draft, and publishes the item', async () => {
    arm();
    const { dependencies, steps, captureCount } = harness(['ok', 'fail', 'ok']);
    const { started, run } = startPublishAllRun('test', dependencies);
    expect(started).toBe(true);
    await run;
    const item = getPublishAllStatus().items[0]!;
    expect(item).toMatchObject({ sku: SKU, status: 'published' });
    expect(captureCount()).toBe(3);
    expect(steps.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
  });

  it('skips with the catalog cause, not "save it once", when the fresh read fails too', async () => {
    arm();
    const { dependencies, steps } = harness(['ok', 'fail', 'fail', 'fail']);
    const { run } = startPublishAllRun('test', dependencies);
    await run;
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('LISTING_DRAFT_UNAVAILABLE: workspace_catalog_refresh_failed');
    expect(item.reason).toContain('a fresh read failed too');
    expect(item.reason).not.toContain('save it once');
    expect(steps).toHaveLength(0);
  });
});
