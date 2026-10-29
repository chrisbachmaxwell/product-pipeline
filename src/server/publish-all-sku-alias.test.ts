import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeListingControlStore } from '../listing-control-store/index.js';
import { ebayInventorySkuFor } from '../shared/sku-alias.js';
import { createLiveListingCatalogCache } from './live-listing-catalog-source.js';
import type { LiveListingCatalogRow, LiveListingCatalogSnapshot } from './live-listing-catalog.js';
import { LISTING_DRAFT_SCOPE, createListingDraftService } from './listing-draft-service.js';
import { createListingWorkspaceReader } from './listing-workspace-reader.js';
import {
  OPERATOR_DATA_SKIP_REASONS,
  getPublishAllStatus,
  releasePublishLock,
  startPublishAllRun,
  type PublishAllDependencies,
} from './publish-all.js';

/**
 * Incident #239 (L116): Publish All skipped `ILCE6400/B-U641` because its
 * Shopify SKU holds a `/`, which eBay's Inventory API refuses. The create now
 * targets the SKU's canonical PP1_ alias, so the same ready row goes through
 * the real catalog cache, workspace reader, draft service and local store to
 * preflight and dispatch. A SKU without an alias still skips, as operator data.
 */

const PRODUCT = 'gid://shopify/Product/10310708035875';
const VARIANT = 'gid://shopify/ProductVariant/55396000563491';
const CATALOG_ID = `shopify-variant:${VARIANT}`;
const MANIFEST = `sha256:${'c'.repeat(64)}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.PUBLISH_PREFLIGHT_ARGV;
  delete process.env.PUBLISH_DISPATCH_ARGV;
  releasePublishLock();
});

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-all-sku-alias-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const target = path.join(root, 'drafts.sqlite');
  initializeListingControlStore({ databasePath: target, scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-13T21:00:00.000Z' }).close();
  return target;
}

function snapshot(sku: string): LiveListingCatalogSnapshot {
  const observedAtUtc = new Date().toISOString();
  const row = {
    id: CATALOG_ID,
    readyToList: true,
    shopify: {
      productId: PRODUCT, variantId: VARIANT, sku, title: 'Sony a6400 Mirrorless Camera Body',
      variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1,
      available: 1, price: { amount: '649.95', currency: 'USD' }, productTags: ['condition-excellent'],
    },
    ebay: {
      sku: ebayInventorySkuFor(sku) ?? sku, state: 'not_listed', listingId: null, offerId: null,
      url: null, activeMatchCount: 0, inventoryItemCount: 0, offerCount: 0,
      unpublishedArtifactCount: 0,
    },
    lifecycleStatus: 'not_listed',
    lastVerifiedAtUtc: observedAtUtc,
    audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
      attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
  } as unknown as LiveListingCatalogRow;
  return { observedAtUtc, rows: [row] } as unknown as LiveListingCatalogSnapshot;
}

function harness(sku: string) {
  const cache = createLiveListingCatalogCache(async () => snapshot(sku));
  const readWorkspace = createListingWorkspaceReader({
    getSnapshot: cache,
    getSnapshotStatus: cache.status,
    getEbayAccessToken: async () => 'unused',
    readEbayDetail: async () => { throw new Error('not listed'); },
    readShopifyContent: async () => ({
      descriptionHtml: '<p>Clean camera body.</p>',
      imageUrls: ['https://cdn.shopify.com/s/files/1/0862/5451/8563/files/a6400.jpg'],
      brand: 'Sony', mpn: 'ILCE6400/B', upc: null,
    }),
  });
  const db = databasePath();
  const draftService = createListingDraftService({
    readWorkspace, databasePath: () => db, writerInstanceReady: () => true,
  });
  const steps: string[][] = [];
  const dependencies: PublishAllDependencies = {
    getSnapshot: async () => cache.refresh(),
    draftService: draftService as unknown as PublishAllDependencies['draftService'],
    getCategoryAspects: async () => ({ available: true, aspects: [] }),
    fillAspects: null,
    findUnresolvedCreate: () => null,
    latestRevisionDigest: () => null,
    agingUnresolvedCreateSkus: () => new Set(),
    runStep: async (argv) => {
      steps.push([...argv]);
      if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
      return { json: { status: 'created-and-reconciled', listingId: '147000000239' } };
    },
    sleep: async () => undefined,
  };
  return { dependencies, steps };
}

function arm(): void {
  process.env.PUBLISH_PREFLIGHT_ARGV = JSON.stringify(['cli.js', 'preflight-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}']);
  process.env.PUBLISH_DISPATCH_ARGV = JSON.stringify(['cli.js', 'dispatch-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--manifest-digest', '{manifestDigest}']);
}

describe('publish-all with a Shopify SKU eBay refuses (incident #239)', () => {
  it('publishes ILCE6400/B-U641 through its PP1_ alias instead of skipping it', async () => {
    arm();
    const { dependencies, steps } = harness('ILCE6400/B-U641');
    const { started, run } = startPublishAllRun('test', dependencies);
    expect(started).toBe(true);
    await run;
    expect(getPublishAllStatus().items[0]).toMatchObject({
      sku: 'ILCE6400/B-U641', status: 'published',
    });
    expect(steps.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    // The ceremony is named by the Shopify SKU; it derives the alias itself.
    expect(steps[0]).toContain('ILCE6400/B-U641');
  });

  it('still skips a SKU with no alias, as store data only the operator can change', async () => {
    arm();
    const { dependencies, steps } = harness('A+B-U001');
    const { run } = startPublishAllRun('test', dependencies);
    await run;
    const item = getPublishAllStatus().items[0]!;
    expect(item).toMatchObject({ sku: 'A+B-U001', status: 'skipped' });
    expect(OPERATOR_DATA_SKIP_REASONS).toContain(item.reason);
    expect(steps).toHaveLength(0);
  });
});
