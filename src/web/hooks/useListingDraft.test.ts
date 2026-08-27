import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ListingWorkspaceResponse } from './useListingWorkspace';
import {
  canonicalDraftImages,
  canonicalDraftItemSpecifics,
  effectiveDraftImages,
  isListingDraftBoundToWorkspace,
  isListingDraftResponse,
  isListingDraftSaveInput,
  parseDraftImages,
  verifiedDraftImageUrl,
  type ListingDraftResponse,
} from './useListingDraft';
import {
  buildListingDraftSaveInput,
  initialDraftValues,
  isSemanticImageChange,
  isSemanticScalarChange,
} from '../components/ListingDraftEditor';

const sha = `sha256:${'a'.repeat(64)}` as const;
const field = (editable = true) => ({
  shopify: 'Shopify', ebay: 'eBay', draft: null, editable,
});

const draft = (): ListingDraftResponse => ({
  schemaVersion: 1,
  mode: 'local_draft_only',
  catalogId: 'shopify-variant:gid://shopify/ProductVariant/2',
  identity: {
    shopifyProductGid: 'gid://shopify/Product/1',
    shopifyVariantGid: 'gid://shopify/ProductVariant/2',
    rawSku: 'SKU-1',
    ebaySellerId: 'usedcameragear',
    ebayMarketplaceId: 'EBAY_US',
    managementModel: 'inventory_api',
    ebayInventorySku: 'SKU-1',
    ebayOfferId: 'offer-1',
    ebayListingId: '123456789012',
  },
  base: {
    catalogObservedAtUtc: '2026-08-13T18:00:00.000Z',
    detailObservedAtUtc: '2026-08-13T18:00:01.000Z',
    sourceDigest: sha,
    ebayDigest: sha,
  },
  revision: null,
  sections: {
    listing: {
      title: field(), category: field(), condition: field(), conditionDescription: field(),
      price: field(false), quantity: field(false),
    },
    content: {
      description: field(), images: field(), itemSpecifics: field(), identifiers: field(false),
    },
    delivery: {
      fulfillmentPolicyId: field(), paymentPolicyId: field(), returnPolicyId: field(),
      merchantLocation: field(),
    },
  },
  capabilities: { saveDraft: true, previewChanges: true, apply: false, publish: false },
  externalWritesPerformed: 0,
});

const workspace = (): ListingWorkspaceResponse => ({
  schemaVersion: 1,
  evidence: {
    catalogObservedAtUtc: '2026-08-13T18:00:00.000Z',
    detailObservedAtUtc: '2026-08-13T18:00:01.000Z',
    freshness: 'live',
    backgroundRefreshSeconds: 60,
    remoteReadPerformed: true,
    externalWritesPerformed: 0,
  },
  catalog: {
    id: 'shopify-variant:gid://shopify/ProductVariant/2',
    shopify: {
      productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/2',
      sku: 'SKU-1', title: 'Product', variantTitle: 'Default Title', productStatus: 'ACTIVE',
      primaryImageUrl: null, imageCount: 1, available: 1,
      price: { amount: '10.00', currency: 'USD' },
    },
    ebay: {
      sku: 'SKU-1', state: 'active', listingId: '123456789012', offerId: 'offer-1',
      url: 'https://www.ebay.com/itm/123456789012', activeMatchCount: 1,
      inventoryItemCount: 1, offerCount: 1, unpublishedArtifactCount: 0,
    },
    lifecycleStatus: 'active', lastVerifiedAtUtc: '2026-08-13T18:00:00.000Z',
    audit: {
      verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
      attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true,
    },
  },
  mapping: {
    state: 'mapped', joinKey: 'exact_raw_sku',
    shopifyProductId: 'gid://shopify/Product/1',
    shopifyVariantId: 'gid://shopify/ProductVariant/2', inventorySku: 'SKU-1',
    offerId: 'offer-1', listingId: '123456789012', managementModel: 'inventory_offer',
    ownership: {
      listing: 'unverified', mapping: 'unverified',
      price: 'marketplace_connect', inventory: 'marketplace_connect',
    },
    editMode: 'read_only',
  },
  ebayDetail: null,
});

describe('local listing draft UI contract', () => {
  it('accepts only the exact local-only non-publishing contract', () => {
    expect(isListingDraftResponse(draft(), draft().catalogId)).toBe(true);
    expect(isListingDraftResponse({
      ...draft(), capabilities: { ...draft().capabilities, publish: true },
    }, draft().catalogId)).toBe(false);
    expect(isListingDraftResponse({
      ...draft(), sections: {
        ...draft().sections,
        listing: { ...draft().sections.listing, price: field(true) },
      },
    }, draft().catalogId)).toBe(false);
  });

  it('binds draft identity to the exact trusted workspace', () => {
    expect(isListingDraftBoundToWorkspace(draft(), workspace())).toBe(true);
    expect(isListingDraftBoundToWorkspace({
      ...draft(), identity: { ...draft().identity, ebayOfferId: 'other' },
    }, workspace())).toBe(false);
    expect(isListingDraftBoundToWorkspace({
      ...draft(), identity: { ...draft().identity, rawSku: '' },
    }, workspace())).toBe(false);

    const tradingWorkspace = {
      ...workspace(),
      mapping: { ...workspace().mapping, managementModel: 'legacy_trading' as const },
    };
    const tradingDraft = {
      ...draft(),
      identity: {
        ...draft().identity,
        managementModel: 'trading_api' as const,
        ebayInventorySku: null,
      },
    };
    expect(isListingDraftBoundToWorkspace(tradingDraft, tradingWorkspace)).toBe(true);
  });

  it('parses images without exposing arbitrary origins or tokenized URLs', () => {
    const images = [
      'https://cdn.shopify.com/a.jpg',
      'https://i.ebayimg.com/b.jpg',
      'https://evil.example/c.jpg',
      'https://cdn.shopify.com/d.jpg?token=secret',
    ];
    expect(parseDraftImages(canonicalDraftImages(images))).toEqual(images.slice(0, 2));
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/a.jpg')).toBe(
      'https://cdn.shopify.com/a.jpg',
    );
    expect(verifiedDraftImageUrl('https://user:pass@cdn.shopify.com/a.jpg')).toBeNull();
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/a.jpg?v=123')).toBe(
      'https://cdn.shopify.com/a.jpg?v=123',
    );
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/a.jpg?token=secret')).toBeNull();
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/a.jpg?unknown=1')).toBeNull();
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/a.jpg?v=1&v=2')).toBeNull();
    expect(effectiveDraftImages({
      shopify: canonicalDraftImages(['https://cdn.shopify.com/inherited.jpg']),
      ebay: null,
      draft: null,
      editable: true,
    })).toEqual(['https://cdn.shopify.com/inherited.jpg']);
  });

  it('keeps inherited scalars out of operator override state', () => {
    const input = draft();
    expect(initialDraftValues(input).title).toBeNull();
    input.sections.listing.title.draft = 'Saved draft';
    expect(initialDraftValues(input).title).toBe('Saved draft');
  });

  it('submits only the condition override when only condition is edited', () => {
    const input = draft();
    const values = { ...initialDraftValues(input), condition: '3000' };
    const payload = buildListingDraftSaveInput(input, values, null);
    expect(payload.draft).toEqual({
      title: null,
      category: null,
      condition: '3000',
      conditionDescription: null,
      description: null,
      images: null,
      itemSpecifics: null,
      fulfillmentPolicyId: null,
      paymentPolicyId: null,
      returnPolicyId: null,
      merchantLocation: null,
    });
    expect(payload.base).toEqual({ sourceDigest: sha, ebayDigest: sha });
    expect(payload).not.toHaveProperty('identity');
    expect(payload).not.toHaveProperty('actor');
    expect(payload.base).not.toHaveProperty('catalogObservedAtUtc');
    expect(isListingDraftSaveInput(payload)).toBe(true);
  });

  it('preserves the explicit optional condition-description omission sentinel', () => {
    const input = draft();
    input.sections.listing.conditionDescription.draft = 'Operational test only';
    const values = { ...initialDraftValues(input), conditionDescription: '' };
    const payload = buildListingDraftSaveInput(input, values, null);
    expect(payload.draft.conditionDescription).toBe('');
    expect(isListingDraftSaveInput(payload)).toBe(true);
  });

  it('canonicalizes bounded item specifics for exact draft approval', () => {
    expect(canonicalDraftItemSpecifics('{"Type":["Lens"],"Brand":["Canon"]}')).toBe(
      '{"Brand":["Canon"],"Type":["Lens"]}',
    );
    expect(canonicalDraftItemSpecifics('{}')).toBeNull();
    expect(canonicalDraftItemSpecifics('{"Brand":[]}')).toBeNull();
  });

  it('preserves a saved image override during an unrelated scalar edit', () => {
    const input = draft();
    const savedImages = canonicalDraftImages(['https://cdn.shopify.com/saved.jpg']);
    input.sections.content.images.draft = savedImages;
    input.revision = {
      revisionId: 'revision-1', revisionNumber: 1, revisionDigest: sha,
      state: 'draft', createdAtUtc: '2026-08-13T18:10:00.000Z',
    };
    const values = { ...initialDraftValues(input), condition: '3000' };
    const payload = buildListingDraftSaveInput(input, values, initialDraftValues(input).images);
    expect(payload.draft.images).toBe(savedImages);
    expect(payload.expectedRevisionDigest).toBe(sha);
  });

  it('freezes the edit CAS basis instead of advancing with a refetch', () => {
    const editBase = draft();
    editBase.revision = {
      revisionId: 'revision-1', revisionNumber: 1, revisionDigest: sha,
      state: 'draft', createdAtUtc: '2026-08-13T18:10:00.000Z',
    };
    const newerDigest = `sha256:${'b'.repeat(64)}` as const;
    const refetched = {
      ...editBase,
      base: { ...editBase.base, sourceDigest: newerDigest, ebayDigest: newerDigest },
      revision: {
        revisionId: 'revision-2', revisionNumber: 2, revisionDigest: newerDigest,
        state: 'draft' as const, createdAtUtc: '2026-08-13T18:11:00.000Z',
      },
    };
    const values = { ...initialDraftValues(editBase), condition: '3000' };
    const payload = buildListingDraftSaveInput(editBase, values, null);
    expect(payload.expectedRevisionDigest).toBe(sha);
    expect(payload.base).toEqual({ sourceDigest: sha, ebayDigest: sha });
    expect(refetched.revision.revisionDigest).toBe(newerDigest);
  });

  it('binds a Shopify-only not-listed draft without an inventory SKU', () => {
    const shopifyOnlyWorkspace: ListingWorkspaceResponse = {
      ...workspace(),
      catalog: {
        ...workspace().catalog,
        ebay: {
          ...workspace().catalog.ebay,
          state: 'not_listed', listingId: null, offerId: null, url: null,
          activeMatchCount: 0, inventoryItemCount: 0, offerCount: 0,
        },
        lifecycleStatus: 'not_listed',
      },
      mapping: {
        ...workspace().mapping,
        state: 'shopify_only', inventorySku: null, offerId: null, listingId: null,
        managementModel: 'none',
      },
    };
    const shopifyOnlyDraft: ListingDraftResponse = {
      ...draft(),
      identity: {
        ...draft().identity,
        managementModel: 'unmanaged', ebayInventorySku: null,
        ebayOfferId: null, ebayListingId: null,
      },
    };
    expect(isListingDraftBoundToWorkspace(shopifyOnlyDraft, shopifyOnlyWorkspace)).toBe(true);
  });

  it('rejects unsafe HTML draft descriptions and keeps remote/local scope explicit', () => {
    const unsafe = draft();
    unsafe.sections.content.description.draft = '<p onclick="alert(1)">Hidden markup</p>';
    expect(isListingDraftResponse(unsafe, unsafe.catalogId)).toBe(false);
    unsafe.sections.content.description.draft = '<script>alert(1)</script>';
    expect(isListingDraftResponse(unsafe, unsafe.catalogId)).toBe(false);
    unsafe.sections.content.description.draft = '<img src="x">';
    expect(isListingDraftResponse(unsafe, unsafe.catalogId)).toBe(false);
    const formatted = draft();
    formatted.sections.content.description.draft =
      '<h2>Details</h2><p>Includes <strong>hood</strong> and <a href="https://example.com/manual">manual</a></p>';
    expect(isListingDraftResponse(formatted, formatted.catalogId)).toBe(true);
    const page = readFileSync(
      fileURLToPath(new URL('../pages/ListingDetail.tsx', import.meta.url)),
      'utf8',
    );
    const editor = readFileSync(
      fileURLToPath(new URL('../components/ListingDraftEditor.tsx', import.meta.url)),
      'utf8',
    );
    expect(page).toContain('Remote read only');
    expect(page).toContain('editing && canEdit && validDraft');
    expect(page).not.toContain('editing && validDraft ?');
    expect(page).toContain('if (!currentEditEligible) setEditing(false)');
    expect(page).toMatch(/useEffect\(\(\) => \{[\s\S]*?if \(!currentEditEligible\) setEditing\(false\);[\s\S]*?\}, \[currentEditEligible\]\)/u);
    expect(page.indexOf('useEffect(() => {')).toBeLessThan(page.indexOf('if (workspace.isLoading)'));
    expect(page.indexOf('useEffect(() => {')).toBeLessThan(page.indexOf('if (workspace.error'));
    expect(page).toMatch(/const currentEditEligible = Boolean\([\s\S]*?!workspace\.error[\s\S]*?&& !localDraft\.error[\s\S]*?&& currentWorkspace/u);
    expect(page).toContain('const refreshed = await localDraft.refetch()');
    expect(page).toContain('isListingDraftBoundToWorkspace(refreshed.data, trustedWorkspace)');
    expect(page).not.toMatch(/onClick=\{\(\) => setEditing\(true\)\}/u);
    expect(editor).toContain('descriptionSummary');
    expect(editor).toContain('Omit optional field');
    expect(editor).toContain("setValue('conditionDescription', '')");
    expect(editor).toContain("setValue('conditionDescription', null)");
    expect(editor).not.toMatch(/dangerouslySetInnerHTML/u);
  });

  it('mirrors the strict save field contract', () => {
    const input = draft();
    const valid = buildListingDraftSaveInput(input, {
      ...initialDraftValues(input),
      title: 'Canon lens',
      category: '3323',
      condition: '3000',
      description: 'Plain text description',
      fulfillmentPolicyId: '123',
      merchantLocation: 'pictureline-boise',
    }, canonicalDraftImages(['https://cdn.shopify.com/image.jpg?v=123']));
    expect(isListingDraftSaveInput(valid)).toBe(true);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, title: ' Canon lens' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, description: '<p>Allowlisted <em>HTML</em></p>' },
    })).toBe(true);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, description: '<p style="color:red">HTML</p>' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, description: '<script>alert(1)</script>' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, description: '<a href="javascript:alert(1)">x</a>' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, description: ' Description' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, conditionDescription: 'Description ' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, images: canonicalDraftImages(['https://cdn.shopify.com/image.jpg?token=secret']) },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, images: '[]' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, merchantLocation: '.location' },
    })).toBe(false);
    expect(isListingDraftSaveInput({
      ...valid,
      draft: { ...valid.draft, merchantLocation: 'location-1' },
    })).toBe(true);
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/image.jpg?v=')).toBeNull();
    expect(verifiedDraftImageUrl(`https://cdn.shopify.com/image.jpg?v=${'a'.repeat(65)}`)).toBeNull();
    expect(verifiedDraftImageUrl('https://cdn.shopify.com/image.jpg?v=a%20b')).toBeNull();
  });

  it('treats exact inherited scalar and image values as no change', () => {
    const inheritedScalar = field(true);
    expect(isSemanticScalarChange(inheritedScalar, null, 'eBay')).toBe(false);
    expect(isSemanticScalarChange(inheritedScalar, null, 'Different')).toBe(true);

    const inheritedImages = canonicalDraftImages(['https://cdn.shopify.com/inherited.jpg']);
    const inheritedImageField = {
      shopify: inheritedImages,
      ebay: null,
      draft: null,
      editable: true,
    };
    expect(isSemanticImageChange(inheritedImageField, true, inheritedImages)).toBe(false);
    expect(isSemanticImageChange(inheritedImageField, true,
      canonicalDraftImages(['https://cdn.shopify.com/different.jpg']))).toBe(true);

    const savedOverrideField = { ...inheritedImageField, draft: inheritedImages };
    expect(isSemanticImageChange(savedOverrideField, true, null)).toBe(true);
  });
});
