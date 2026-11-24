import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeListingControlStore } from '../listing-control-store/index.js';
import { createLiveListingCatalogCache } from './live-listing-catalog-source.js';
import type { LiveListingCatalogRow, LiveListingCatalogSnapshot } from './live-listing-catalog.js';
import { LISTING_DRAFT_SCOPE, createListingDraftService } from './listing-draft-service.js';
import { createListingWorkspaceReader } from './listing-workspace-reader.js';
import { getPublishAllStatus, releasePublishLock, startPublishAllRun, type PublishAllDependencies } from './publish-all.js';

/**
 * Incident #261: Publish All skipped DSCRX1RM2B-U794 with LISTING_DRAFT_STALE
 * ("open the item and save it once"). The first-draft save re-reads the
 * workspace and compares content digests with the read it was built from;
 * when the item's facts moved in between (a webhook refresh, a concurrent
 * save) the save was refused and the prepare loop never retried it. This
 * drives the real reader and draft service (temporary local store).
 */

const PRODUCT = 'gid://shopify/Product/10310708035894';
const VARIANT = 'gid://shopify/ProductVariant/55396000563794';
const CATALOG_ID = `shopify-variant:${VARIANT}`;
const SKU = 'DSCRX1RM2B-U794';
const MANIFEST = `sha256:${'d'.repeat(64)}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.PUBLISH_PREFLIGHT_ARGV;
  delete process.env.PUBLISH_DISPATCH_ARGV;
  releasePublishLock();
});

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-all-stale-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const target = path.join(root, 'drafts.sqlite');
  initializeListingControlStore({ databasePath: target, scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-11-24T21:00:00.000Z' }).close();
  return target;
}

function snapshot(): LiveListingCatalogSnapshot {
  const observedAtUtc = new Date().toISOString();
  const row = {
    id: CATALOG_ID,
    readyToList: true,
    shopify: {
      productId: PRODUCT, variantId: VARIANT, sku: SKU, title: 'Sony RX1R II Compact Camera',
      variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1,
      available: 1, price: { amount: '1999.95', currency: 'USD' }, productTags: ['condition-excellent'],
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

/**
 * `moves(read)` decides whether the store content changed before the given
 * (1-based) workspace read; each change alters the description, so the
 * source digest of that read differs from the one before it.
 */
function harness(moves: (read: number) => boolean) {
  const cache = createLiveListingCatalogCache(async () => snapshot());
  let reads = 0;
  let version = 0;
  const readWorkspace = createListingWorkspaceReader({
    getSnapshot: cache,
    getSnapshotStatus: cache.status,
    getEbayAccessToken: async () => 'unused',
    readEbayDetail: async () => { throw new Error('not listed'); },
    readShopifyContent: async () => {
      reads += 1;
      if (moves(reads)) version += 1;
      return {
        descriptionHtml: `<p>Clean camera, revision ${version}.</p>`,
        imageUrls: ['https://cdn.shopify.com/s/files/1/0862/5451/8563/files/rx1r.jpg'],
        brand: 'Sony', mpn: 'DSC-RX1RM2', upc: null,
      };
    },
  });
  const db = databasePath();
  const draftService = createListingDraftService({
    readWorkspace, databasePath: () => db, writerInstanceReady: () => true,
  });
  const steps: string[][] = [];
  const saves: string[] = [];
  const service = {
    get: (catalogId: string) => draftService.get(catalogId),
    save: async (request: Parameters<typeof draftService.save>[0], actor: string) => {
      saves.push(actor);
      return draftService.save(request, actor);
    },
  };
  const dependencies: PublishAllDependencies = {
    getSnapshot: async () => cache.refresh(),
    draftService: service as unknown as PublishAllDependencies['draftService'],
    getCategoryAspects: async () => ({ available: true, aspects: [] }),
    fillAspects: null,
    findUnresolvedCreate: () => null,
    latestRevisionDigest: () => null,
    agingUnresolvedCreateSkus: () => new Set(),
    runStep: async (argv) => {
      steps.push([...argv]);
      if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
      return { json: { status: 'created-and-reconciled', listingId: '147000000261' } };
    },
    sleep: async () => undefined,
  };
  return { dependencies, steps, saves };
}

function arm(): void {
  process.env.PUBLISH_PREFLIGHT_ARGV = JSON.stringify(['cli.js', 'preflight-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}']);
  process.env.PUBLISH_DISPATCH_ARGV = JSON.stringify(['cli.js', 'dispatch-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--manifest-digest', '{manifestDigest}']);
}

describe('publish-all first-draft save refused as stale (incident #261)', () => {
  it('re-reads once, saves the draft from the fresh basis, and publishes the item', async () => {
    arm();
    // The content moves exactly between the first read and the first save.
    const { dependencies, steps, saves } = harness((read) => read === 2);
    const { started, run } = startPublishAllRun('test', dependencies);
    expect(started).toBe(true);
    await run;
    const item = getPublishAllStatus().items[0]!;
    expect(item).toMatchObject({ sku: SKU, status: 'published' });
    expect(saves.filter((actor) => actor === 'publish-all')).toHaveLength(2);
    expect(steps.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
  });

  it('fails closed with a clear skip reason when the retry is stale too', async () => {
    arm();
    // The content moves before every read: each save sees a new basis.
    const { dependencies, steps, saves } = harness(() => true);
    const { run } = startPublishAllRun('test', dependencies);
    await run;
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('LISTING_DRAFT_STALE');
    expect(item.reason).toContain('the next run retries it');
    expect(item.reason).not.toContain('save it once');
    expect(saves).toEqual(['publish-all', 'publish-all']);
    expect(steps).toHaveLength(0);
  });
});
