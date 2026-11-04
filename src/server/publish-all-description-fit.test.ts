import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeListingControlStore } from '../listing-control-store/index.js';
import { MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH } from '../listing-lifecycle-admin/manifest.js';
import { isAllowlistedListingHtml } from '../shared/listing-html.js';
import { createLiveListingCatalogCache } from './live-listing-catalog-source.js';
import type { LiveListingCatalogRow, LiveListingCatalogSnapshot } from './live-listing-catalog.js';
import { LISTING_DRAFT_SCOPE, createListingDraftService } from './listing-draft-service.js';
import { createListingWorkspaceReader } from './listing-workspace-reader.js';
import {
  EBAY_INVENTORY_DESCRIPTION_MAX,
  fitEbayDescription,
  getPublishAllStatus,
  releasePublishLock,
  startPublishAllRun,
  type PublishAllDependencies,
} from './publish-all.js';

/**
 * Incident #248: Publish-All failed 4726B001-U019 and 4895C002-U210 on every
 * run with `Preflight refused …: CREATE_INVENTORY_PRODUCT_DESCRIPTION_TOO_LARGE`.
 * The draft inherits the Shopify description verbatim and the create manifest
 * binds it to eBay's 4,000-character Inventory Product.description (L30), but
 * nothing in the publish path ever fitted it — unlike the title (#180).
 */

const PRODUCT = 'gid://shopify/Product/10310708035999';
const VARIANT = 'gid://shopify/ProductVariant/55396000563999';
const CATALOG_ID = `shopify-variant:${VARIANT}`;
const SKU = '4726B001-U019';
const MANIFEST = `sha256:${'d'.repeat(64)}`;

function longDescription(paragraphs: number): string {
  const sentence = 'This lens is in excellent cosmetic condition with clean glass and smooth focus. ';
  return Array.from({ length: paragraphs }, (_, index) =>
    `<p><span>Paragraph ${index + 1}.</span> ${sentence.repeat(3).trim()}</p>`).join('\n');
}

describe('fitEbayDescription (incident #248)', () => {
  it('matches the create manifest limit', () => {
    expect(EBAY_INVENTORY_DESCRIPTION_MAX).toBe(MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH);
  });

  it('returns a description that already fits unchanged', () => {
    expect(fitEbayDescription('<p>Short.</p>')).toBe('<p>Short.</p>');
    expect(fitEbayDescription(null)).toBeNull();
    expect(fitEbayDescription('   ')).toBeNull();
  });

  it('compacts markup without losing visible text when that is enough', () => {
    const sentences = Array.from({ length: 140 }, () => 'Clean glass, smooth focus.');
    const body = `<div>\n  <span>${sentences.join('\n        ')}</span>\n</div>`
      + '<p> </p><p>&nbsp;</p>\n\n<br><br><br><br>';
    expect(body.length).toBeGreaterThan(EBAY_INVENTORY_DESCRIPTION_MAX);
    const fitted = fitEbayDescription(body)!;
    expect(fitted.length).toBeLessThanOrEqual(EBAY_INVENTORY_DESCRIPTION_MAX);
    expect(fitted).toBe(`<div>${sentences.join(' ')}</div>`);
  });

  it('cuts at the last whole paragraph and keeps the markup balanced and allowlisted', () => {
    const body = longDescription(40);
    const fitted = fitEbayDescription(body)!;
    expect(fitted.length).toBeLessThanOrEqual(EBAY_INVENTORY_DESCRIPTION_MAX);
    expect(fitted.length).toBeGreaterThan(EBAY_INVENTORY_DESCRIPTION_MAX / 2);
    expect(fitted.startsWith('<p>Paragraph 1.')).toBe(true);
    expect(fitted.endsWith('</p>')).toBe(true);
    expect(fitted).not.toContain('…');
    expect(isAllowlistedListingHtml(fitted)).toBe(true);
    expect(fitted.trim()).toBe(fitted);
  });

  it('closes open lists when it cuts between list items', () => {
    const items = Array.from({ length: 200 }, (_, index) => `<li>Included accessory number ${index + 1}</li>`);
    const fitted = fitEbayDescription(`<h2>In the box</h2><ul>${items.join('')}</ul><p>Tail.</p>`)!;
    expect(fitted.length).toBeLessThanOrEqual(EBAY_INVENTORY_DESCRIPTION_MAX);
    expect(fitted.endsWith('</li></ul>')).toBe(true);
    expect(fitted.match(/<ul>/gu)).toHaveLength(1);
    expect(fitted.match(/<\/ul>/gu)).toHaveLength(1);
  });

  it('falls back to a whole-word cut with an ellipsis when one block is too large', () => {
    const fitted = fitEbayDescription(`<p><b>${'word '.repeat(2000).trim()}</b></p>`)!;
    expect(fitted.length).toBeLessThanOrEqual(EBAY_INVENTORY_DESCRIPTION_MAX);
    expect(fitted).toMatch(/word…<\/b><\/p>$/u);
    expect(isAllowlistedListingHtml(fitted)).toBe(true);
  });

  it('never cuts inside an entity or a link', () => {
    const body = `<p>${'Tom &amp; Jerry <a href="https://example.com/a">manual link</a> '.repeat(120).trim()}</p>`;
    const fitted = fitEbayDescription(body)!;
    expect(fitted.length).toBeLessThanOrEqual(EBAY_INVENTORY_DESCRIPTION_MAX);
    expect(fitted).not.toMatch(/&[a-z]*…|&[a-z]*<\//u);
    expect((fitted.match(/<a /gu) ?? []).length).toBe((fitted.match(/<\/a>/gu) ?? []).length);
    expect(isAllowlistedListingHtml(fitted)).toBe(true);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.PUBLISH_PREFLIGHT_ARGV;
  delete process.env.PUBLISH_DISPATCH_ARGV;
  releasePublishLock();
});

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-all-description-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const target = path.join(root, 'drafts.sqlite');
  initializeListingControlStore({ databasePath: target, scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-11-04T21:00:00.000Z' }).close();
  return target;
}

function snapshot(): LiveListingCatalogSnapshot {
  const observedAtUtc = new Date().toISOString();
  const row = {
    id: CATALOG_ID,
    readyToList: true,
    shopify: {
      productId: PRODUCT, variantId: VARIANT, sku: SKU, title: 'Canon EF 70-200mm f/2.8L IS III USM',
      variantTitle: 'Default', productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1,
      available: 1, price: { amount: '1599.95', currency: 'USD' }, productTags: ['condition-excellent'],
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

function harness(descriptionHtml: string) {
  const cache = createLiveListingCatalogCache(async () => snapshot());
  const readWorkspace = createListingWorkspaceReader({
    getSnapshot: cache,
    getSnapshotStatus: cache.status,
    getEbayAccessToken: async () => 'unused',
    readEbayDetail: async () => { throw new Error('not listed'); },
    readShopifyContent: async () => ({
      descriptionHtml,
      imageUrls: ['https://cdn.shopify.com/s/files/1/0862/5451/8563/files/lens.jpg'],
      brand: 'Canon', mpn: '3044C002', upc: null,
    }),
  });
  const db = databasePath();
  const draftService = createListingDraftService({
    readWorkspace, databasePath: () => db, writerInstanceReady: () => true,
  });
  const steps: string[][] = [];
  const preflightDescriptions: number[] = [];
  const dependencies: PublishAllDependencies = {
    getSnapshot: () => cache.refresh(),
    draftService: draftService as unknown as PublishAllDependencies['draftService'],
    getCategoryAspects: async () => ({ available: true, aspects: [] }),
    fillAspects: null,
    findUnresolvedCreate: () => null,
    latestRevisionDigest: () => null,
    agingUnresolvedCreateSkus: () => new Set(),
    runStep: async (argv) => {
      steps.push([...argv]);
      if (argv[1] === 'preflight-create') {
        // Mirror the manifest's L30 gate on the stored revision.
        const dto = await draftService.get(CATALOG_ID);
        const leaf = dto.sections.content.description;
        const description = leaf.draft ?? leaf.shopify ?? '';
        preflightDescriptions.push(description.length);
        if (description.length > MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH) {
          return { json: { status: 'denied', code: 'CREATE_INVENTORY_PRODUCT_DESCRIPTION_TOO_LARGE', field: 'description' } };
        }
        return { json: { status: 'preview', manifestDigest: MANIFEST } };
      }
      return { json: { status: 'created-and-reconciled', listingId: '147000000248' } };
    },
    sleep: async () => undefined,
  };
  return { cache, draftService, dependencies, steps, preflightDescriptions };
}

function arm(): void {
  process.env.PUBLISH_PREFLIGHT_ARGV = JSON.stringify(['cli.js', 'preflight-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}']);
  process.env.PUBLISH_DISPATCH_ARGV = JSON.stringify(['cli.js', 'dispatch-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--manifest-digest', '{manifestDigest}']);
}

describe('publish-all fits an over-long description before preflight (incident #248)', () => {
  it('publishes an item whose existing draft inherits a description over 4,000 characters', async () => {
    arm();
    const { cache, draftService, dependencies, steps, preflightDescriptions } = harness(longDescription(40));
    // The incident items already had a stored inherit-only revision from an
    // earlier run, so the first-draft save path never ran for them.
    await cache.refresh();
    const before = await draftService.get(CATALOG_ID);
    expect(before.sections.content.description.shopify!.length)
      .toBeGreaterThan(MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH);
    await draftService.save({
      schemaVersion: 1, action: 'save_local_draft', catalogId: CATALOG_ID,
      expectedRevisionDigest: null,
      base: { sourceDigest: before.base.sourceDigest, ebayDigest: before.base.ebayDigest },
      draft: {
        title: null, category: null, condition: null, conditionDescription: 'Excellent.',
        description: null, images: null, itemSpecifics: null, fulfillmentPolicyId: null,
        paymentPolicyId: null, returnPolicyId: null, merchantLocation: null,
      },
    }, 'publish-all');

    const { run } = startPublishAllRun('test', dependencies);
    await run;

    const item = getPublishAllStatus().items[0]!;
    expect(item).toMatchObject({ sku: SKU, status: 'published', listingId: '147000000248' });
    expect(item.reason).toContain('Description shortened from');
    expect(steps.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(preflightDescriptions).toHaveLength(1);
    expect(preflightDescriptions[0]).toBeLessThanOrEqual(MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH);
    const after = await draftService.get(CATALOG_ID);
    const fitted = after.sections.content.description.draft!;
    expect(fitted.length).toBeLessThanOrEqual(MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH);
    expect(isAllowlistedListingHtml(fitted)).toBe(true);
    expect(fitted.startsWith('<p>Paragraph 1.')).toBe(true);
  });

  it('leaves a description that already fits untouched', async () => {
    arm();
    const { draftService, dependencies, steps } = harness('<p>Clean lens.</p>');
    const { run } = startPublishAllRun('test', dependencies);
    await run;
    const item = getPublishAllStatus().items[0]!;
    expect(item).toMatchObject({ sku: SKU, status: 'published' });
    expect(item.reason).toBeUndefined();
    expect(steps.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    const after = await draftService.get(CATALOG_ID);
    expect(after.sections.content.description.draft).toBeNull();
  });
});
