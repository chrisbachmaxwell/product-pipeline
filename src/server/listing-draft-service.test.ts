import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeListingControlStore,
  openListingControlStoreReadOnly,
} from '../listing-control-store/index.js';
import type { ListingWorkspaceDto } from './listing-workspace-reader.js';
import {
  LISTING_DRAFT_SCOPE,
  LISTING_DRAFT_SERVICE_TESTING,
  ListingDraftServiceError,
  createListingDraftService,
  parseSaveListingDraftRequest,
} from './listing-draft-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function workspace(options: { listed?: boolean; title?: string; ebayTitle?: string;
  description?: string; sku?: string } = {}): ListingWorkspaceDto {
  const listed = options.listed ?? true;
  const productId = 'gid://shopify/Product/10310708035875';
  const variantId = 'gid://shopify/ProductVariant/55396000563491';
  const sku = options.sku ?? 'CAN3570-U119';
  const listingId = listed ? '147502608418' : null;
  const offerId = listed ? '234942877011' : null;
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-13T21:59:00.000Z',
      detailObservedAtUtc: listed ? '2026-08-13T22:00:01.000Z' : null,
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: listed, externalWritesPerformed: 0,
    },
    catalog: {
      id: `shopify-variant:${variantId}`,
      shopify: {
        productId, variantId, sku, title: options.title ?? 'Shopify New', variantTitle: 'Default',
        productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 1,
        price: { amount: '39.95', currency: 'USD' },
      },
      ebay: {
        sku, state: listed ? 'active' : 'not_listed', listingId, offerId,
        url: listed ? `https://www.ebay.com/itm/${listingId}` : null,
        activeMatchCount: listed ? 1 : 0, inventoryItemCount: listed ? 1 : 0,
        offerCount: listed ? 1 : 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: listed ? 'active' : 'not_listed',
      lastVerifiedAtUtc: '2026-08-13T21:59:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: listed ? 'mapped' : 'shopify_only', joinKey: 'exact_raw_sku',
      shopifyProductId: productId, shopifyVariantId: variantId,
      inventorySku: listed ? sku : null, offerId, listingId,
      managementModel: listed ? 'inventory_offer' : 'none',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: listed ? {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
        observedAtUtc: '2026-08-13T22:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: productId, shopifyVariantId: variantId, sku, listingId: listingId!,
        publicListingUrl: `https://www.ebay.com/itm/${listingId}`, offerId },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: options.ebayTitle ?? 'eBay Old',
          descriptionHtml: options.description ?? '<p>Safe &amp; clean</p>',
          imageUrls: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'] },
        category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
        aspects: { Mount: ['Canon EF'], Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '39.95', currency: 'USD' }, totalQuantity: 1, soldQuantity: 0,
          availableQuantity: 1, availableQuantityBasis: 'reported', bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
          paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
          returnsAccepted: true, returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
          offer: true, offerToListing: true }, lifecycleAligned: true,
        inventoryItem: { sku, content: { title: options.ebayTitle ?? 'eBay Old',
          descriptionHtml: null, imageUrls: [] }, condition: { id: '3000', name: 'Used',
          description: null, descriptors: [] }, aspects: {}, identifiers: { brand: 'Canon',
          mpn: null, upc: [], ean: [], isbn: [], epid: null }, shipToLocationQuantity: 1 },
        offer: { offerId: offerId!, sku, marketplaceId: 'EBAY_US', status: 'PUBLISHED',
          listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0, format: 'FIXED_PRICE',
          duration: 'GTC', descriptionHtml: null, primaryCategoryId: '3323',
          secondaryCategoryId: null, storeCategoryNames: [], price: null, availableQuantity: 1,
          quantityLimitPerBuyer: null, bestOfferEnabled: false, autoAcceptPrice: null,
          autoDeclinePrice: null, fulfillmentPolicyId: '111', paymentPolicyId: '222',
          returnPolicyId: '333', merchantLocationKey: 'warehouse-1',
          includeCatalogProductDetails: false },
      },
    } : null,
  };
}

function body(base: { sourceDigest: string; ebayDigest: string }, title: string | null = 'Operator Title') {
  return {
    schemaVersion: 1, action: 'save_local_draft',
    catalogId: 'shopify-variant:gid://shopify/ProductVariant/55396000563491',
    expectedRevisionDigest: null, base,
    draft: { title, category: null, condition: null, conditionDescription: null,
      description: null, images: null, itemSpecifics: null,
      fulfillmentPolicyId: null, paymentPolicyId: null,
      returnPolicyId: null, merchantLocation: null },
  };
}

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-draft-service-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const target = path.join(root, 'drafts.sqlite');
  initializeListingControlStore({ databasePath: target, scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-13T21:00:00.000Z' }).close();
  return target;
}

describe('local listing draft service', () => {
  it('accepts only the nested semantic base and strict editable contract', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(parseSaveListingDraftRequest(body({ sourceDigest: digest, ebayDigest: digest })).base)
      .toEqual({ sourceDigest: digest, ebayDigest: digest });
    expect(() => parseSaveListingDraftRequest({ ...body({ sourceDigest: digest, ebayDigest: digest }),
      actor: 'browser' })).toThrow(ListingDraftServiceError);
    expect(() => parseSaveListingDraftRequest({ ...body({ sourceDigest: digest, ebayDigest: digest }),
      base: undefined, sourceDigest: digest, ebayDigest: digest })).toThrow(ListingDraftServiceError);
  });

  it('enforces exact text, provider ID, plaintext, and image URL contracts', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const valid = body({ sourceDigest: digest, ebayDigest: digest });
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, title: 'x'.repeat(81) } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      catalogId: 'shopify-variant:shpat_1234567890123456' })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, category: 'camera-lenses' } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, description: '<script>x</script>' } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, description: '<p onclick="x()">hi</p>' } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, description: '<a href="javascript:alert(1)">x</a>' } })).toThrow();
    expect(parseSaveListingDraftRequest({ ...valid, draft: { ...valid.draft,
      description: '<p>Clean <strong>bold</strong> and a <a href="https://example.com/spec">link</a></p><ul><li>one</li></ul>' } })
      .draft.description)
      .toBe('<p>Clean <strong>bold</strong> and a <a href="https://example.com/spec">link</a></p><ul><li>one</li></ul>');
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, images: JSON.stringify(['https://cdn.shopify.com/a.jpg?token=x']) } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, images: JSON.stringify(['https://cdn.shopify.com/a.jpg?v=']) } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, images: JSON.stringify(['https://cdn.shopify.com/a.jpg?v=a%20b']) } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, images: '[]' } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid, draft: { ...valid.draft,
      images: JSON.stringify([`https://cdn.shopify.com/a.jpg?v=${'x'.repeat(65)}`]) } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid,
      draft: { ...valid.draft, images: JSON.stringify(['https://cdn.shopify.com/a.jpg?v=a!b']) } })).toThrow();
    expect(parseSaveListingDraftRequest({ ...valid, draft: { ...valid.draft,
      images: JSON.stringify(['https://cdn.shopify.com/a.jpg?v=1&width=800']) } }).draft.images)
      .toBe('["https://cdn.shopify.com/a.jpg?v=1&width=800"]');
    expect(parseSaveListingDraftRequest({ ...valid, draft: { ...valid.draft,
      itemSpecifics: '{"Type":["Lens"],"Brand":["Canon"]}' } }).draft.itemSpecifics)
      .toBe('{"Brand":["Canon"],"Type":["Lens"]}');
    expect(() => parseSaveListingDraftRequest({ ...valid, draft: { ...valid.draft,
      itemSpecifics: '{"Brand":[]}' } })).toThrow();
    expect(() => parseSaveListingDraftRequest({ ...valid, draft: { ...valid.draft,
      itemSpecifics: JSON.stringify({ Brand: ['x'.repeat(66)] }) } })).toThrow();
  });

  it('inherits observed eBay values and treats divergent explicit Shopify value as override', () => {
    const basis = LISTING_DRAFT_SERVICE_TESTING.eligibleBasis(workspace());
    const inherited = LISTING_DRAFT_SERVICE_TESTING.fieldsForRevision(basis, {});
    expect(inherited.find((field) => field.field === 'title')).toMatchObject({
      proposedValue: 'eBay Old', proposedSource: 'observed', overrideValue: null,
    });
    const explicit = LISTING_DRAFT_SERVICE_TESTING.fieldsForRevision(basis, { title: 'Shopify New' });
    expect(explicit.find((field) => field.field === 'title')).toMatchObject({
      proposedValue: 'Shopify New', proposedSource: 'override', overrideValue: 'Shopify New',
    });
  });

  it('uses source-only inheritance and unmanaged identity for proven Shopify-only rows', () => {
    const basis = LISTING_DRAFT_SERVICE_TESTING.eligibleBasis(workspace({ listed: false }));
    expect(basis.identity).toMatchObject({ managementModel: 'unmanaged', ebayInventorySku: null,
      ebayOfferId: null, ebayListingId: null });
    expect(LISTING_DRAFT_SERVICE_TESTING.fieldsForRevision(basis, {})
      .find((field) => field.field === 'title')).toMatchObject({
        proposedValue: 'Shopify New', proposedSource: 'source',
      });
  });

  it('distinguishes explicit condition-description omission from non-null inheritance', () => {
    const basis = LISTING_DRAFT_SERVICE_TESTING.eligibleBasis(workspace());
    expect(LISTING_DRAFT_SERVICE_TESTING.fieldsForRevision(basis, {})
      .find((field) => field.field === 'condition_description')).toMatchObject({
        proposedValue: 'Excellent', proposedSource: 'observed',
      });
    expect(LISTING_DRAFT_SERVICE_TESTING.fieldsForRevision(
      basis,
      { condition_description: '' },
    ).find((field) => field.field === 'condition_description')).toMatchObject({
      proposedValue: null, proposedSource: 'omit', overrideValue: null,
    });
  });

  it('clears a previously saved optional condition note and preserves explicit omission',
    async () => {
      const current = workspace({ listed: false });
      const db = databasePath();
      let tick = 0;
      const service = createListingDraftService({
        readWorkspace: async () => current,
        databasePath: () => db,
        writerInstanceReady: () => true,
        now: () => new Date(`2026-08-13T22:02:0${tick++}.000Z`),
        uuid: () => `condition-note-${tick}`,
      });
      const opened = await service.get(current.catalog.id, true);
      const firstBody = body({
        sourceDigest: opened.base.sourceDigest,
        ebayDigest: opened.base.ebayDigest,
      });
      const firstRequest = {
        ...firstBody,
        draft: { ...firstBody.draft, conditionDescription: 'Operational test only' },
      };
      const first = await service.save(
        parseSaveListingDraftRequest(firstRequest),
        'shopify-user:1',
      );
      expect(first.sections.listing.conditionDescription.draft).toBe('Operational test only');

      const omitBody = body({
          sourceDigest: first.base.sourceDigest,
          ebayDigest: first.base.ebayDigest,
      });
      const omitRequest = {
        ...omitBody,
        expectedRevisionDigest: first.revision!.revisionDigest,
        draft: { ...omitBody.draft, conditionDescription: '' },
      };
      const omitted = await service.save(
        parseSaveListingDraftRequest(omitRequest),
        'shopify-user:1',
      );
      expect(omitted.sections.listing.conditionDescription.draft).toBe('');

      const store = openListingControlStoreReadOnly({
        databasePath: db,
        expectedScope: LISTING_DRAFT_SCOPE,
      });
      expect(store.getLatestRevision(current.catalog.shopify!.variantId)?.fields
        .find((field) => field.field === 'condition_description')).toMatchObject({
          proposedValue: null,
          proposedSource: 'omit',
          overrideValue: null,
        });
      store.close();
    });

  it('denies a noncanonical SKU before advertising local draft eligibility', () => {
    expect(() => LISTING_DRAFT_SERVICE_TESTING.eligibleBasis(
      workspace({ listed: false, sku: 'CANON-É' }),
    )).toThrow(ListingDraftServiceError);
  });

  it('normalizes eBay HTML safely without truncating semantic suffixes', () => {
    expect(LISTING_DRAFT_SERVICE_TESTING.htmlToPlainText(
      '<style>bad</style><script>alert(1)</script><p>Safe &amp; clean</p>',
    )).toBe('Safe & clean');
    const prefix = 'x'.repeat(20_100);
    const first = LISTING_DRAFT_SERVICE_TESTING.eligibleBasis(workspace({ description: `${prefix}A` }));
    const second = LISTING_DRAFT_SERVICE_TESTING.eligibleBasis(workspace({ description: `${prefix}B` }));
    expect(first.ebayDigest).not.toBe(second.ebayDigest);
  });

  it('canonicalizes reordered maps without changing semantic eBay digest', () => {
    expect(LISTING_DRAFT_SERVICE_TESTING.canonicalJson({ z: ['1'], a: { y: 2, x: 1 } }))
      .toBe(LISTING_DRAFT_SERVICE_TESTING.canonicalJson({ a: { x: 1, y: 2 }, z: ['1'] }));
  });

  it('saves one immutable local override, rejects replay/no-op, and ignores timestamp-only refresh', async () => {
    const first = workspace();
    const second = { ...first, evidence: { ...first.evidence,
      catalogObservedAtUtc: '2026-08-13T22:01:00.000Z',
      detailObservedAtUtc: '2026-08-13T22:01:01.000Z' },
      catalog: { ...first.catalog, lastVerifiedAtUtc: '2026-08-13T22:01:00.000Z' },
      ebayDetail: first.ebayDetail && { ...first.ebayDetail,
        evidence: { ...first.ebayDetail.evidence, observedAtUtc: '2026-08-13T22:01:01.000Z' } } } as ListingWorkspaceDto;
    let current = first;
    const db = databasePath();
    const service = createListingDraftService({ readWorkspace: async () => current,
      databasePath: () => db, writerInstanceReady: () => true,
      now: () => new Date('2026-08-13T22:02:00.000Z'), uuid: () => 'fixed-uuid' });
    const opened = await service.get(first.catalog.id, true);
    expect(opened.sections.content.itemSpecifics.editable).toBe(true);
    current = second;
    const semanticBase = { sourceDigest: opened.base.sourceDigest, ebayDigest: opened.base.ebayDigest };
    const created = await service.save(parseSaveListingDraftRequest(body(semanticBase)), 'shopify-user:1');
    expect(created.revision).toMatchObject({ revisionNumber: 1, state: 'draft' });
    expect(created.sections.listing.title.draft).toBe('Operator Title');
    await expect(service.save(parseSaveListingDraftRequest(body(semanticBase)), 'shopify-user:1'))
      .rejects.toMatchObject({ code: 'LISTING_DRAFT_STALE' });
  });

  it('saves an active divergent draft while preserving a long inherited eBay description', async () => {
    const description = 'X'.repeat(300_000);
    const current = workspace({ description, title: 'Shopify New', ebayTitle: 'eBay Old' });
    const db = databasePath();
    const service = createListingDraftService({
      readWorkspace: async () => current,
      databasePath: () => db,
      writerInstanceReady: () => true,
      now: () => new Date('2026-08-13T22:02:00.000Z'),
      uuid: () => 'long-description-revision',
    });
    const opened = await service.get(current.catalog.id, true);
    const created = await service.save(parseSaveListingDraftRequest(body({
      sourceDigest: opened.base.sourceDigest,
      ebayDigest: opened.base.ebayDigest,
    })), 'shopify-user:1');
    expect(created.revision).toMatchObject({ revisionNumber: 1, state: 'draft' });
    expect(created.sections.content.description).toMatchObject({
      ebay: description,
      draft: null,
    });

    const persisted = openListingControlStoreReadOnly({
      databasePath: db,
      expectedScope: LISTING_DRAFT_SCOPE,
    });
    const descriptionField = persisted.getLatestRevision(
      'gid://shopify/ProductVariant/55396000563491',
    )?.fields.find((field) => field.field === 'description');
    expect(descriptionField).toMatchObject({
      observedValue: description,
      proposedValue: description,
      proposedSource: 'observed',
    });
    expect(persisted.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
    persisted.verifyIntegrity();
    persisted.close();
  });

  it('keeps admin/config and the local route free of commerce writers and provider credentials', () => {
    const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
    const config = fs.readFileSync(path.resolve(sourceRoot, '../listing-control-config.ts'), 'utf8');
    const admin = fs.readFileSync(path.resolve(sourceRoot, '../listing-control-admin/program.ts'), 'utf8');
    const service = fs.readFileSync(path.resolve(sourceRoot, 'listing-draft-service.ts'), 'utf8');
    const route = fs.readFileSync(path.resolve(sourceRoot, 'routes/listing-drafts.ts'), 'utf8');
    expect(config).not.toMatch(/server\/|shopify\/|ebay\/|token|fetch\s*\(/i);
    expect(admin).not.toMatch(/server\/listing-draft|shopify\/|ebay\/|token|fetch\s*\(/i);
    expect(`${service}\n${route}`).not.toMatch(
      /from ['"][^'"]*(?:shopify|ebay|sync|inventory|order|token-manager)[^'"]*['"]|\b(?:createOffer|updateOffer|publishOffer|createShopifyOrder)\b/,
    );
  });
});
