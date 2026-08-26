/**
 * Contract tests for the isolated listing-lifecycle operator CLI's CREATE
 * dispatch. Everything runs against real on-disk listing-control and
 * migration-state stores; only the live workspace read and the provider HTTP
 * adapter are faked. No network access of any kind occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveScopeKey,
  openMigrationStoreReadOnly,
  type IntegrationScope,
} from '../../migration-store/index.js';
import {
  initializeListingControlStore,
  openListingControlStoreReadOnly,
  type ListingRevision,
} from '../../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import {
  createListingDraftService,
  parseSaveListingDraftRequest,
} from '../../server/listing-draft-service.js';
import type { ListingWorkspaceDto } from '../../server/listing-workspace-reader.js';
import {
  applyListingCreateDescriptionTemplate,
  buildListingCreatePayloads,
  classifyCreateOutcome,
  deriveListingCreateManifest,
  ListingLifecycleManifestError,
} from '../manifest.js';
import {
  buildListingLifecycleAdminProgram,
  type ListingLifecycleAdminIo,
} from '../program.js';
import type { ListingCreateDispatchAdapter } from '../create-dispatch-adapter.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000700001';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000700001';
const PRODUCT_GID = 'gid://shopify/Product/10310708200001';
const SKU = 'CAN2470-U300';
const OFFER_ID = '558800112233';
const LISTING_ID = '147600000001';
const IMAGE_URL = 'https://cdn.shopify.com/s/files/1/0001/products/canon-2470.jpg';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A fresh not-listed (unmanaged) workspace row: Shopify only, zero eBay artifacts. */
function notListedWorkspace(): ListingWorkspaceDto {
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-19T18:59:00.000Z',
      detailObservedAtUtc: null,
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: false, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU,
        title: 'Canon EF 24-70mm f/2.8L', variantTitle: 'Default',
        productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 2,
        price: { amount: '149.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'not_listed', listingId: null, offerId: null, url: null,
        activeMatchCount: 0, inventoryItemCount: 0,
        offerCount: 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'not_listed',
      lastVerifiedAtUtc: '2026-08-19T18:59:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: 'shopify_only', joinKey: 'exact_raw_sku',
      shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
      inventorySku: null, offerId: null, listingId: null,
      managementModel: 'none',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: null,
  };
}

/** The same item after a successful create: a fully bound active inventory listing. */
function listedWorkspace(descriptionHtml: string | null = 'Clean plain text description'):
ListingWorkspaceDto {
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-19T19:10:00.000Z',
      detailObservedAtUtc: '2026-08-19T19:10:01.000Z',
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: true, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU,
        title: 'Canon EF 24-70mm f/2.8L', variantTitle: 'Default',
        productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 2,
        price: { amount: '149.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'active', listingId: LISTING_ID, offerId: OFFER_ID,
        url: `https://www.ebay.com/itm/${LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
      lastVerifiedAtUtc: '2026-08-19T19:10:00.000Z',
      audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
        attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
    },
    mapping: {
      state: 'mapped', joinKey: 'exact_raw_sku',
      shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
      inventorySku: SKU, offerId: OFFER_ID, listingId: LISTING_ID,
      managementModel: 'inventory_offer',
      ownership: { listing: 'unverified', mapping: 'unverified',
        price: 'marketplace_connect', inventory: 'marketplace_connect' },
      editMode: 'read_only',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
        observedAtUtc: '2026-08-19T19:10:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${LISTING_ID}`, offerId: OFFER_ID },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: 'Canon EF 24-70mm f/2.8L',
          descriptionHtml,
          imageUrls: [IMAGE_URL] },
        category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent glass', descriptors: [] },
        aspects: { Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '149.95', currency: 'USD' }, totalQuantity: 2, soldQuantity: 0,
          availableQuantity: 2, availableQuantityBasis: 'reported', bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
          paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
          returnsAccepted: true, returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
          offer: true, offerToListing: true }, lifecycleAligned: true,
        inventoryItem: { sku: SKU, content: { title: 'Canon EF 24-70mm f/2.8L',
          descriptionHtml: null, imageUrls: [IMAGE_URL] }, condition: { id: '3000', name: 'Used',
          description: 'Excellent glass', descriptors: [] }, aspects: {},
          identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
          shipToLocationQuantity: 2 },
        offer: { offerId: OFFER_ID, sku: SKU, marketplaceId: 'EBAY_US', status: 'PUBLISHED',
          listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0, format: 'FIXED_PRICE',
          duration: 'GTC', descriptionHtml: null, primaryCategoryId: '3323',
          secondaryCategoryId: null, storeCategoryNames: [], price: null, availableQuantity: 2,
          quantityLimitPerBuyer: null, bestOfferEnabled: false, autoAcceptPrice: null,
          autoDeclinePrice: null, fulfillmentPolicyId: '111', paymentPolicyId: '222',
          returnPolicyId: '333', merchantLocationKey: 'warehouse-1',
          includeCatalogProductDetails: false },
      },
    },
  };
}

/** The created-offer-but-publish-failed state: an unpublished offer artifact. */
function offerPendingWorkspace(): ListingWorkspaceDto {
  const base = notListedWorkspace();
  return {
    ...base,
    catalog: {
      ...base.catalog,
      ebay: {
        ...base.catalog.ebay,
        state: 'attention', listingId: null, offerId: OFFER_ID,
        activeMatchCount: 0, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 1,
      },
      lifecycleStatus: 'attention',
    },
    mapping: { ...base.mapping, state: 'attention' },
  };
}

type DraftValues = {
  title: string | null;
  category: string | null;
  condition: string | null;
  conditionDescription: string | null;
  description: string | null;
  images: string | null;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocation: string | null;
};

const DEFAULT_DRAFT: DraftValues = {
  title: null,
  category: '3323',
  condition: '3000',
  conditionDescription: 'Excellent glass',
  description: 'Clean plain text description',
  images: JSON.stringify([IMAGE_URL]),
  fulfillmentPolicyId: '111',
  paymentPolicyId: '222',
  returnPolicyId: '333',
  merchantLocation: 'warehouse-1',
};

type World = {
  draftDatabasePath: string;
  migrationDatabasePath: string;
  revision: ListingRevision;
  setWorkspace: (dto: ListingWorkspaceDto) => void;
  adapterCalls: string[];
  itemPayloads: Array<Record<string, unknown>>;
  offerPayloads: Array<Record<string, unknown>>;
  publishCalls: string[];
  failItemPut: () => void;
  failPublish: () => void;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  run: (argv: string[]) => Promise<void>;
};

async function createWorld(draftOverrides: Partial<DraftValues> = {}): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-lifecycle-create-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  const draftDatabasePath = path.join(root, 'listing-control.sqlite');
  initializeListingControlStore({
    databasePath: draftDatabasePath,
    scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-19T18:00:00.000Z',
  }).close();

  let current = notListedWorkspace();
  const service = createListingDraftService({
    readWorkspace: async () => current,
    databasePath: () => draftDatabasePath,
    writerInstanceReady: () => true,
  });
  const opened = await service.get(CATALOG_ID, true);
  await service.save(parseSaveListingDraftRequest({
    schemaVersion: 1, action: 'save_local_draft', catalogId: CATALOG_ID,
    expectedRevisionDigest: null,
    base: { sourceDigest: opened.base.sourceDigest, ebayDigest: opened.base.ebayDigest },
    draft: { ...DEFAULT_DRAFT, ...draftOverrides },
  }), 'shopify-user:operator');
  const draftStore = openListingControlStoreReadOnly({
    databasePath: draftDatabasePath, expectedScope: LISTING_DRAFT_SCOPE,
  });
  const revision = draftStore.getLatestRevision(VARIANT_GID);
  draftStore.close();
  if (!revision) throw new Error('revision fixture was not created');

  const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
  createMigrationStore({
    databasePath: migrationDatabasePath,
    scope: MIGRATION_SCOPE,
    createdAtUtc: '2026-08-19T18:00:00.000Z',
  }).close();

  const adapterCalls: string[] = [];
  const itemPayloads: Array<Record<string, unknown>> = [];
  const offerPayloads: Array<Record<string, unknown>> = [];
  const publishCalls: string[] = [];
  let itemPutFails = false;
  let publishFails = false;
  const adapter: ListingCreateDispatchAdapter = Object.freeze({
    putInventoryItem: async (_sku, payload) => {
      adapterCalls.push('putInventoryItem');
      if (itemPutFails) throw new Error('provider write failed');
      itemPayloads.push(payload);
    },
    createOffer: async (payload) => {
      adapterCalls.push('createOffer');
      offerPayloads.push(payload);
      current = offerPendingWorkspace();
      return OFFER_ID;
    },
    publishOffer: async (offerId) => {
      adapterCalls.push('publishOffer');
      publishCalls.push(offerId);
      if (publishFails) throw new Error('provider publish failed');
      const description = offerPayloads.at(-1)?.listingDescription;
      current = listedWorkspace(typeof description === 'string' ? description : null);
      return LISTING_ID;
    },
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const io: ListingLifecycleAdminIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    setExitCode: (code) => exitCodes.push(code),
  };
  const run = async (argv: string[]): Promise<void> => {
    await buildListingLifecycleAdminProgram({
      readWorkspace: async () => current,
      draftDatabasePath: () => draftDatabasePath,
      createCreateAdapter: () => adapter,
      io,
    }).parseAsync(argv, { from: 'user' });
  };

  return {
    draftDatabasePath,
    migrationDatabasePath,
    revision,
    setWorkspace: (dto) => { current = dto; },
    adapterCalls,
    itemPayloads,
    offerPayloads,
    publishCalls,
    failItemPut: () => { itemPutFails = true; },
    failPublish: () => { publishFails = true; },
    stdout,
    stderr,
    exitCodes,
    run,
  };
}

function targetArguments(revisionDigest: string): string[] {
  return [
    '--catalog-id', CATALOG_ID,
    '--sku', SKU,
    '--revision-digest', revisionDigest,
  ];
}

function establishArguments(world: World): string[] {
  return ['establish-ownership',
    '--migration-store', world.migrationDatabasePath,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--evidence-digest', `sha256:${'a'.repeat(64)}`,
    '--responsibility', 'listingCreate',
  ];
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe('listing-lifecycle operator CLI — create', () => {
  it('dispatches one approved create end to end with durable state and reconciliation', async () => {
    const world = await createWorld();

    await world.run(establishArguments(world));
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'established', responsibility: 'listingCreate', version: 2,
    });

    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({
      command: 'preflight-create',
      status: 'preview',
      proposed: expect.objectContaining({
        conditionId: '3000',
        conditionEnum: 'USED_EXCELLENT',
        categoryId: '3323',
        merchantLocationKey: 'warehouse-1',
        price: { amount: '149.95', currency: 'USD' },
        quantity: 2,
      }),
    });
    expect(world.exitCodes.at(-1)).toBe(2);
    const manifestDigest = preview.manifestDigest as string;
    expect(manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Wrong manifest digest is an exact-approval mismatch: nothing dispatches.
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', `sha256:${'b'.repeat(64)}`,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_MANIFEST_DIGEST_MISMATCH' });
    expect(world.adapterCalls).toHaveLength(0);

    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch-create',
      status: 'dispatched-and-reconciled',
      effect: 'created_state_observed',
      resolution: 'resolved_existing',
      providerDispatchReported: true,
      offerId: OFFER_ID,
      listingId: LISTING_ID,
      manifestDigest,
      externalCommerceWritesAttempted: 3,
    });
    expect(typeof dispatched.jobId).toBe('string');
    expect(typeof dispatched.attemptId).toBe('string');
    expect(typeof dispatched.intentKey).toBe('string');

    // The bounded provider sequence: item PUT, offer POST, publish POST.
    expect(world.adapterCalls).toEqual(['putInventoryItem', 'createOffer', 'publishOffer']);
    expect(world.itemPayloads).toHaveLength(1);
    expect(world.itemPayloads[0]).toEqual({
      product: {
        title: 'Canon EF 24-70mm f/2.8L',
        imageUrls: [IMAGE_URL],
        description: 'Clean plain text description',
      },
      condition: 'USED_EXCELLENT',
      conditionDescription: 'Excellent glass',
      availability: { shipToLocationAvailability: { quantity: 2 } },
    });
    expect(world.offerPayloads).toHaveLength(1);
    expect(world.offerPayloads[0]).toEqual({
      sku: SKU,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 2,
      categoryId: '3323',
      listingPolicies: {
        fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
      },
      pricingSummary: { price: { value: '149.95', currency: 'USD' } },
      merchantLocationKey: 'warehouse-1',
      listingDescription: 'Clean plain text description',
    });
    expect(world.publishCalls).toEqual([OFFER_ID]);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing',
      responsibility: 'listingCreate',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      action_approvals: 1,
      approval_consumptions: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      target_effect_observations: 1,
      listing_revise_observations: 0,
      order_links: 0,
      order_watermarks: 0,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // Replaying after a successful create is denied by the fresh target gate:
    // the item is now listed, so there is nothing left to create.
    const callsBefore = world.adapterCalls.length;
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_TARGET_ALREADY_LISTED' });
    expect(world.adapterCalls.length).toBe(callsBefore);
  });

  it('binds the opt-in branded HTML to preflight, dispatch payloads, and reconciliation', async () => {
    const world = await createWorld();
    await world.run(establishArguments(world));

    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest),
      '--description-template', 'ucg-branded-v1',
    ]);
    const preview = lastJson(world.stdout);
    expect(preview).toMatchObject({
      status: 'preview',
      descriptionTemplate: { templateVersion: 'ucg-branded-v1', applied: true },
    });
    const manifestDigest = preview.manifestDigest as string;

    // A templated digest cannot authorize an untemplated dispatch.
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_MANIFEST_DIGEST_MISMATCH' });
    expect(world.adapterCalls).toHaveLength(0);

    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--description-template', 'ucg-branded-v1',
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'dispatched-and-reconciled',
      effect: 'created_state_observed',
      descriptionTemplate: { templateVersion: 'ucg-branded-v1', applied: true },
    });
    const itemDescription = (world.itemPayloads[0]?.product as Record<string, unknown>)
      .description;
    const offerDescription = world.offerPayloads[0]?.listingDescription;
    expect(itemDescription).toBe(offerDescription);
    expect(itemDescription).toContain('<!-- template:ucg-branded-v1 -->');
  });

  it('re-derives the templated intent and exact HTML during recovery reconciliation', async () => {
    const world = await createWorld();
    await world.run(establishArguments(world));
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest),
      '--description-template', 'ucg-branded-v1',
    ]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;
    world.failPublish();
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--description-template', 'ucg-branded-v1',
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({ status: 'dispatched-unresolved' });
    const exactHtml = world.offerPayloads[0]?.listingDescription as string;
    world.setWorkspace(listedWorkspace(exactHtml));

    // Omitting the template derives a different desired-state intent.
    await world.run(['reconcile',
      '--action', 'create', '--catalog-id', CATALOG_ID, '--sku', SKU,
      '--revision-digest', world.revision.revisionDigest,
      '--migration-store', world.migrationDatabasePath,
      '--job-id', dispatched.jobId as string, '--attempt-id', dispatched.attemptId as string,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_INTENT_NOT_FOUND' });

    await world.run(['reconcile',
      '--action', 'create', '--catalog-id', CATALOG_ID, '--sku', SKU,
      '--revision-digest', world.revision.revisionDigest,
      '--description-template', 'ucg-branded-v1',
      '--migration-store', world.migrationDatabasePath,
      '--job-id', dispatched.jobId as string, '--attempt-id', dispatched.attemptId as string,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'reconciled',
      effect: 'created_state_observed',
      resolution: 'resolved_existing',
      descriptionTemplate: { templateVersion: 'ucg-branded-v1', applied: true },
    });
  });

  it('fails closed for unsupported templates and requires exact raw HTML after create', async () => {
    const world = await createWorld();
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest),
      '--description-template', 'ucg-branded-v2',
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_TEMPLATE_UNSUPPORTED' });
    expect(world.adapterCalls).toHaveLength(0);

    const derived = deriveListingCreateManifest(world.revision);
    const templated = applyListingCreateDescriptionTemplate({
      derived,
      revision: world.revision,
      templateVersion: 'ucg-branded-v1',
    });
    const exactHtml = templated.manifest.proposed.description as string;
    expect(classifyCreateOutcome({
      workspace: listedWorkspace(exactHtml.replace(/\n/gu, '\r\n')),
      sku: SKU,
      expectedListingId: LISTING_ID,
      expectedDescriptionHtml: exactHtml,
    }).kind).toBe('observed');
    expect(classifyCreateOutcome({
      workspace: listedWorkspace(`${exactHtml} `),
      sku: SKU,
      expectedListingId: LISTING_ID,
      expectedDescriptionHtml: exactHtml,
    }).kind).toBe('unverified');
  });

  it('leaves a missing description byte-identical when the template is requested', async () => {
    const world = await createWorld({ description: null });
    const derived = deriveListingCreateManifest(world.revision);
    const templated = applyListingCreateDescriptionTemplate({
      derived,
      revision: world.revision,
      templateVersion: 'ucg-branded-v1',
    });
    expect(templated).toMatchObject({
      manifestDigest: derived.manifestDigest,
      descriptionTemplateApplied: false,
    });
    expect(classifyCreateOutcome({
      workspace: listedWorkspace('unexpected provider description'),
      sku: SKU,
      expectedListingId: LISTING_ID,
      expectedDescriptionHtml: null,
    }).kind).toBe('unverified');
    expect(classifyCreateOutcome({
      workspace: listedWorkspace(null),
      sku: SKU,
      expectedListingId: LISTING_ID,
      expectedDescriptionHtml: null,
    }).kind).toBe('observed');

    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest),
      '--description-template', 'ucg-branded-v1',
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      manifestDigest: derived.manifestDigest,
      descriptionTemplate: { templateVersion: 'ucg-branded-v1', applied: false },
    });
  });

  it('fails closed on already-listed targets, missing ownership, and wrong targets', async () => {
    const world = await createWorld();

    // Ownership not established yet.
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_OWNERSHIP_NOT_ESTABLISHED' });
    expect(world.adapterCalls).toHaveLength(0);

    // Wrong exact target.
    await world.run(['preflight-create',
      '--catalog-id', CATALOG_ID,
      '--sku', 'WRONG-SKU',
      '--revision-digest', world.revision.revisionDigest,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_EXACT_TARGET_MISMATCH' });

    // An already-listed target can never be a create target.
    world.setWorkspace(listedWorkspace());
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_TARGET_ALREADY_LISTED' });
    expect(world.adapterCalls).toHaveLength(0);
  });

  it('denies a create manifest missing a required policy id, naming the field', async () => {
    const world = await createWorld({ fulfillmentPolicyId: null });
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    expect(lastJson(world.stderr)).toMatchObject({
      command: 'preflight-create',
      status: 'denied',
      code: 'CREATE_REQUIRED_FIELD_MISSING',
      field: 'fulfillment_policy',
    });
    expect(world.exitCodes.at(-1)).toBe(1);
  });

  it('denies an unsupported numeric condition id via the fixed mapping table', async () => {
    const world = await createWorld({ condition: '2010' });
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    expect(lastJson(world.stderr)).toMatchObject({
      code: 'CREATE_CONDITION_UNSUPPORTED',
    });

    // The pure derivation denies the same way, and each fixed table entry maps.
    const badRevision: ListingRevision = {
      ...world.revision,
      fields: world.revision.fields,
    };
    expect(() => deriveListingCreateManifest(badRevision))
      .toThrow(ListingLifecycleManifestError);
    const { manifest } = deriveListingCreateManifest({
      ...world.revision,
      fields: world.revision.fields.map((field) => field.field === 'condition'
        ? { ...field, proposedValue: '7000', overrideValue: '7000' }
        : field),
    });
    expect(manifest.proposed.conditionEnum).toBe('FOR_PARTS_OR_NOT_WORKING');
    const payloads = buildListingCreatePayloads(manifest);
    expect(payloads.inventoryItemPayload.condition).toBe('FOR_PARTS_OR_NOT_WORKING');
  });

  it('records a provider-failed create (no offer) as a durable confirmed_missing outcome and denies replay', async () => {
    const world = await createWorld();
    await world.run(establishArguments(world));
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    world.failItemPut();
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch-create',
      status: 'dispatched-unresolved',
      providerDispatchReported: false,
      offerId: null,
      listingId: null,
      effect: 'created_state_absent',
      resolution: 'confirmed_missing',
      externalCommerceWritesAttempted: 1,
    });
    expect(world.exitCodes.at(-1)).toBe(1);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'confirmed_missing',
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    // The remote state is unchanged, so a replay of the same manifest reaches
    // — and is denied by — the durable intent-uniqueness layer.
    const callsBefore = world.adapterCalls.length;
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    expect(lastJson(world.stderr)).toMatchObject({ code: 'CREATE_INTENT_ALREADY_RECORDED' });
    expect(world.adapterCalls.length).toBe(callsBefore);
  });

  it('leaves a created-offer-but-publish-failed job unresolved with the offer named in the output', async () => {
    const world = await createWorld();
    await world.run(establishArguments(world));
    await world.run(['preflight-create', ...targetArguments(world.revision.revisionDigest)]);
    const manifestDigest = lastJson(world.stdout).manifestDigest as string;

    world.failPublish();
    await world.run(['dispatch-create', ...targetArguments(world.revision.revisionDigest),
      '--manifest-digest', manifestDigest,
      '--migration-store', world.migrationDatabasePath,
    ]);
    const dispatched = lastJson(world.stdout);
    expect(dispatched).toMatchObject({
      command: 'dispatch-create',
      status: 'dispatched-unresolved',
      providerDispatchReported: false,
      offerId: OFFER_ID,
      listingId: null,
      effect: 'offer_unpublished',
      resolution: null,
      unresolvedCode: 'CREATE_OFFER_UNPUBLISHED',
      externalCommerceWritesAttempted: 3,
    });
    expect(world.exitCodes.at(-1)).toBe(1);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'reconciliation_required',
    });
    expect(store.getCounts()).toMatchObject({
      target_effect_observations: 0,
      attempt_resolutions: 0,
      reconciliation_exceptions: 1,
    });
    store.close();

    // The reconcile command reports the unpublished offer with the fixed
    // code, and --accept-absent can never resolve a state where a durable
    // remote artifact exists.
    await world.run(['reconcile',
      '--action', 'create',
      '--catalog-id', CATALOG_ID,
      '--sku', SKU,
      '--revision-digest', world.revision.revisionDigest,
      '--migration-store', world.migrationDatabasePath,
      '--job-id', dispatched.jobId as string,
      '--attempt-id', dispatched.attemptId as string,
      '--accept-absent',
    ]);
    const reconciled = lastJson(world.stdout);
    expect(reconciled).toMatchObject({
      command: 'reconcile',
      status: 'unresolved',
      effect: 'offer_unpublished',
      resolution: null,
      unresolvedCode: 'CREATE_OFFER_UNPUBLISHED',
      offerId: OFFER_ID,
      externalWritesPerformed: 0,
    });
    expect(world.exitCodes.at(-1)).toBe(1);

    // Once the operator finishes the publish out of band, a fresh reconcile
    // observes the created state and resolves the job.
    world.setWorkspace(listedWorkspace());
    await world.run(['reconcile',
      '--action', 'create',
      '--catalog-id', CATALOG_ID,
      '--sku', SKU,
      '--revision-digest', world.revision.revisionDigest,
      '--migration-store', world.migrationDatabasePath,
      '--job-id', dispatched.jobId as string,
      '--attempt-id', dispatched.attemptId as string,
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      command: 'reconcile',
      status: 'reconciled',
      effect: 'created_state_observed',
      resolution: 'resolved_existing',
      listingId: LISTING_ID,
    });
    const reopened = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(reopened.getJobStatus(dispatched.jobId as string)).toMatchObject({
      state: 'resolved_existing',
    });
    expect(reopened.verifyAuditChain()).toMatchObject({ valid: true });
    reopened.close();
  });

  it('keeps the CLI free of server-mount and legacy writer imports', () => {
    const sourceRoot = path.dirname(new URL('..', import.meta.url).pathname);
    const files = [
      'listing-lifecycle-admin/program.ts',
      'listing-lifecycle-admin/manifest.ts',
      'listing-lifecycle-admin/create-dispatch-adapter.ts',
      'listing-lifecycle-admin/end-dispatch-adapter.ts',
      'listing-lifecycle-admin/index.ts',
    ].map((file) => [file, fs.readFileSync(path.join(sourceRoot, file), 'utf8')] as const);
    const serverIndex = fs.readFileSync(path.join(sourceRoot, 'server/index.ts'), 'utf8');
    // The server never mounts or imports the dispatch slice.
    expect(serverIndex).not.toMatch(/listing-lifecycle-admin/);
    // The slice never touches legacy sync writers or order paths.
    const combined = files.map(([, source]) => source).join('\n');
    expect(combined).not.toMatch(
      /from ['"][^'"]*(?:\/sync\/|order-sync|product-sync|inventory-sync|price-sync|token-manager)[^'"]*['"]/,
    );
    // Provider writes exist only in the two bounded adapter modules.
    for (const [file, source] of files) {
      if (file.endsWith('dispatch-adapter.ts')) continue;
      expect(source, `${file} must not perform network access`).not.toMatch(/fetch\s*\(/);
    }
  });
});
