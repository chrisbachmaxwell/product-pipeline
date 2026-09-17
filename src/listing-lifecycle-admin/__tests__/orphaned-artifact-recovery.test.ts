/**
 * Contract tests for the RECOVER-ORPHANED-ARTIFACT ceremony (Brain L66/L68,
 * schema v6): removing the inventory-item/offer pair orphaned when an
 * external relist superseded a RESOLVED create job's published listing.
 * Everything runs against real on-disk listing-control and migration-state
 * stores (schema v6); only the live workspace read and the provider HTTP
 * adapters are faked. No network access of any kind occurs.
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
  buildListingLifecycleAdminProgram,
  type ListingLifecycleAdminIo,
} from '../program.js';
import type { ListingCreateDispatchAdapter } from '../create-dispatch-adapter.js';
import type {
  ListingRecoverDispatchAdapter,
  RecoveredOfferStatus,
} from '../recover-dispatch-adapter.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000700077';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000700077';
const PRODUCT_GID = 'gid://shopify/Product/10310708200077';
const SKU = 'CAN7020-U215';
const OFFER_ID = '558800112277';
const OLD_LISTING_ID = '147600000001';
const NEW_LISTING_ID = '147600000777';
const IMAGE_URL = 'https://cdn.shopify.com/s/files/1/0001/products/canon-70200.jpg';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function baseWorkspace(): ListingWorkspaceDto {
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-09-16T18:00:00.000Z',
      detailObservedAtUtc: null,
      freshness: 'live', backgroundRefreshSeconds: 60,
      remoteReadPerformed: false, externalWritesPerformed: 0,
    },
    catalog: {
      id: CATALOG_ID,
      shopify: {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU,
        title: 'Canon EF 70-200mm f/2.8L IS III', variantTitle: 'Default',
        productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 1,
        price: { amount: '1499.95', currency: 'USD' },
      },
      ebay: {
        sku: SKU, state: 'not_listed', listingId: null, offerId: null, url: null,
        activeMatchCount: 0, inventoryItemCount: 0,
        offerCount: 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'not_listed',
      lastVerifiedAtUtc: '2026-09-16T18:00:00.000Z',
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

/** Fully live via the create ceremony's own offer (classifies `observed`). */
function listedWorkspace(descriptionHtml: string | null): ListingWorkspaceDto {
  const base = baseWorkspace();
  return {
    ...base,
    evidence: { ...base.evidence, detailObservedAtUtc: '2026-09-16T18:00:01.000Z',
      remoteReadPerformed: true },
    catalog: {
      ...base.catalog,
      ebay: {
        ...base.catalog.ebay,
        state: 'active', listingId: OLD_LISTING_ID, offerId: OFFER_ID,
        url: `https://www.ebay.com/itm/${OLD_LISTING_ID}`,
        activeMatchCount: 1, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
    },
    mapping: {
      ...base.mapping,
      state: 'mapped', inventorySku: SKU, offerId: OFFER_ID, listingId: OLD_LISTING_ID,
      managementModel: 'inventory_offer',
    },
    ebayDetail: {
      schemaVersion: 1,
      evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
        observedAtUtc: '2026-09-16T18:00:01.000Z', complete: true,
        remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
      identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
        listingId: OLD_LISTING_ID,
        publicListingUrl: `https://www.ebay.com/itm/${OLD_LISTING_ID}`, offerId: OFFER_ID },
      actual: {
        lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
          startAtUtc: null, endAtUtc: null },
        content: { title: 'Canon EF 70-200mm f/2.8L IS III',
          descriptionHtml,
          imageUrls: [IMAGE_URL] },
        category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
        condition: { id: '3000', name: 'Used', description: 'Excellent glass', descriptors: [] },
        aspects: { Brand: ['Canon'] },
        identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
        commerce: { price: { value: '1499.95', currency: 'USD' }, totalQuantity: 1,
          soldQuantity: 0, availableQuantity: 1, availableQuantityBasis: 'reported',
          bestOfferEnabled: false },
        policies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
          paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
          returnsAccepted: true, returnPeriod: null, returnShippingCostPayer: null },
        location: { publicLocation: 'Utah', countryCode: 'US' },
      },
      management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
        exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
          offer: true, offerToListing: true }, lifecycleAligned: true,
        inventoryItem: { sku: SKU, content: { title: 'Canon EF 70-200mm f/2.8L IS III',
          descriptionHtml: null, imageUrls: [IMAGE_URL] }, condition: { id: '3000', name: 'Used',
          description: 'Excellent glass', descriptors: [] }, aspects: {},
          identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
          shipToLocationQuantity: 1 },
        offer: { offerId: OFFER_ID, sku: SKU, marketplaceId: 'EBAY_US', status: 'PUBLISHED',
          listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0, format: 'FIXED_PRICE',
          duration: 'GTC', descriptionHtml: null, primaryCategoryId: '3323',
          secondaryCategoryId: null, storeCategoryNames: [], price: null, availableQuantity: 1,
          quantityLimitPerBuyer: null, bestOfferEnabled: false, autoAcceptPrice: null,
          autoDeclinePrice: null, fulfillmentPolicyId: '111', paymentPolicyId: '222',
          returnPolicyId: '333', merchantLocationKey: 'warehouse-1',
          includeCatalogProductDetails: false },
      },
    },
  };
}

/** The orphan shape: an external relist is live; the pair dangles. */
function orphanedWorkspace(liveListingId: string = NEW_LISTING_ID): ListingWorkspaceDto {
  const base = baseWorkspace();
  return {
    ...base,
    catalog: {
      ...base.catalog,
      ebay: {
        ...base.catalog.ebay,
        state: 'attention', listingId: liveListingId, offerId: null,
        url: `https://www.ebay.com/itm/${liveListingId}`,
        activeMatchCount: 1, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 2,
      },
      lifecycleStatus: 'attention',
      audit: {
        ...base.catalog.audit,
        unresolvedCount: 1,
        attentionReasons: ['ebay_unpublished_artifact'],
      },
    },
    mapping: { ...base.mapping, state: 'attention' },
  };
}

/** Post-cleanup: the supersessor sells on, zero artifacts. */
function orphanCleanWorkspace(liveListingId: string = NEW_LISTING_ID): ListingWorkspaceDto {
  const base = baseWorkspace();
  return {
    ...base,
    catalog: {
      ...base.catalog,
      ebay: {
        ...base.catalog.ebay,
        state: 'active', listingId: liveListingId, offerId: null,
        url: `https://www.ebay.com/itm/${liveListingId}`,
        activeMatchCount: 1, inventoryItemCount: 0,
        offerCount: 0, unpublishedArtifactCount: 0,
      },
      lifecycleStatus: 'active',
    },
  };
}

const DEFAULT_DRAFT = {
  title: null,
  category: '3323',
  condition: '3000',
  conditionDescription: 'Excellent glass',
  description: 'Clean plain text description',
  images: JSON.stringify([IMAGE_URL]),
  itemSpecifics: JSON.stringify({ Brand: ['Canon'], Type: ['Camera Lens'] }),
  fulfillmentPolicyId: '111',
  paymentPolicyId: '222',
  returnPolicyId: '333',
  merchantLocation: 'warehouse-1',
};

type World = {
  migrationDatabasePath: string;
  revision: ListingRevision;
  setWorkspace: (dto: ListingWorkspaceDto) => void;
  recoverCalls: string[];
  setOffer: (offer: {
    present?: boolean; sku?: string; status?: RecoveredOfferStatus; listingId?: string | null;
  }) => void;
  setItemPresent: (present: boolean) => void;
  holdWorkspaceOnRemoval: (hold: boolean) => void;
  failPublish: (fail: boolean) => void;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  run: (argv: string[]) => Promise<void>;
};

async function createWorld(): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-lifecycle-orphan-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  const draftDatabasePath = path.join(root, 'listing-control.sqlite');
  initializeListingControlStore({
    databasePath: draftDatabasePath,
    scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-09-16T18:00:00.000Z',
  }).close();

  let current = baseWorkspace();
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
    draft: DEFAULT_DRAFT,
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
    createdAtUtc: '2026-09-16T18:00:00.000Z',
  }).close();

  let publishFails = false;
  const offerPayloads: Array<Record<string, unknown>> = [];
  const createAdapter: ListingCreateDispatchAdapter = Object.freeze({
    putInventoryItem: async () => undefined,
    createOffer: async (payload: Record<string, unknown>) => {
      offerPayloads.push(payload);
      return OFFER_ID;
    },
    publishOffer: async () => {
      if (publishFails) throw new Error('publish refused');
      const description = offerPayloads.at(-1)?.listingDescription;
      current = listedWorkspace(typeof description === 'string' ? description : null);
      return OLD_LISTING_ID;
    },
  });

  const recoverCalls: string[] = [];
  let offer = {
    present: true, sku: SKU,
    status: 'PUBLISHED' as RecoveredOfferStatus, listingId: OLD_LISTING_ID as string | null,
  };
  let itemPresent = true;
  let holdWorkspace = false;
  const recoverAdapter: ListingRecoverDispatchAdapter = Object.freeze({
    getOffer: async (offerId) => {
      recoverCalls.push(`getOffer:${offerId}`);
      return offer.present
        ? Object.freeze({ found: true, sku: offer.sku!, status: offer.status!,
          listingId: offer.listingId ?? null })
        : Object.freeze({ found: false, sku: null, status: null, listingId: null });
    },
    countOffersForSku: async (sku) => {
      recoverCalls.push(`countOffersForSku:${sku}`);
      return offer.present ? 1 : 0;
    },
    deleteOffer: async (offerId) => {
      recoverCalls.push(`deleteOffer:${offerId}`);
      offer = { ...offer, present: false };
      if (!holdWorkspace) {
        current = { ...orphanedWorkspace(), catalog: { ...orphanedWorkspace().catalog,
          ebay: { ...orphanedWorkspace().catalog.ebay,
            offerCount: 0, unpublishedArtifactCount: 1 } } };
      }
    },
    getInventoryItem: async (sku) => {
      recoverCalls.push(`getInventoryItem:${sku}`);
      return itemPresent
        ? Object.freeze({ found: true, sku })
        : Object.freeze({ found: false, sku: null });
    },
    deleteInventoryItem: async (sku) => {
      recoverCalls.push(`deleteInventoryItem:${sku}`);
      itemPresent = false;
      if (!holdWorkspace) current = orphanCleanWorkspace();
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
      createCreateAdapter: () => createAdapter,
      createRecoverAdapter: () => recoverAdapter,
      io,
    }).parseAsync(argv, { from: 'user' });
  };

  return {
    migrationDatabasePath,
    revision,
    setWorkspace: (dto) => { current = dto; },
    recoverCalls,
    setOffer: (next) => { offer = { ...offer, ...next }; },
    setItemPresent: (present) => { itemPresent = present; },
    holdWorkspaceOnRemoval: (hold) => { holdWorkspace = hold; },
    failPublish: (fail) => { publishFails = fail; },
    stdout,
    stderr,
    exitCodes,
    run,
  };
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

type ResolvedCreate = {
  jobId: string;
  attemptId: string;
  intentKey: string;
  manifestDigest: string;
};

/** The precondition: one create that dispatched, published, and RESOLVED. */
async function dispatchResolvedCreate(world: World): Promise<ResolvedCreate> {
  await world.run(['establish-ownership',
    '--migration-store', world.migrationDatabasePath,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--evidence-digest', `sha256:${'a'.repeat(64)}`,
    '--responsibility', 'listingCreate',
  ]);
  await world.run(['preflight-create',
    '--catalog-id', CATALOG_ID, '--sku', SKU,
    '--revision-digest', world.revision.revisionDigest,
  ]);
  const manifestDigest = lastJson(world.stdout).manifestDigest as string;
  await world.run(['dispatch-create',
    '--catalog-id', CATALOG_ID, '--sku', SKU,
    '--revision-digest', world.revision.revisionDigest,
    '--manifest-digest', manifestDigest,
    '--migration-store', world.migrationDatabasePath,
  ]);
  const dispatched = lastJson(world.stdout);
  expect(dispatched).toMatchObject({ resolution: 'resolved_existing' });
  return {
    jobId: dispatched.jobId as string,
    attemptId: dispatched.attemptId as string,
    intentKey: dispatched.intentKey as string,
    manifestDigest,
  };
}

/** External relist happens; a fresh reconcile records the artifact evidence. */
async function recordOrphanEvidence(world: World, source: ResolvedCreate): Promise<void> {
  world.setWorkspace(orphanedWorkspace());
  await world.run(['reconcile', '--action', 'create',
    '--catalog-id', CATALOG_ID, '--sku', SKU,
    '--revision-digest', world.revision.revisionDigest,
    '--migration-store', world.migrationDatabasePath,
    '--job-id', source.jobId, '--attempt-id', source.attemptId,
  ]);
  expect(lastJson(world.stdout)).toMatchObject({
    command: 'reconcile',
    unresolvedCode: 'CREATE_OFFER_UNPUBLISHED',
  });
}

function orphanArguments(world: World, source: ResolvedCreate, overrides: Partial<{
  offerId: string;
  supersededByListingId: string;
}> = {}): string[] {
  return [
    '--migration-store', world.migrationDatabasePath,
    '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
    '--catalog-id', CATALOG_ID,
    '--sku', SKU,
    '--job-id', source.jobId,
    '--attempt-id', source.attemptId,
    '--intent-key', source.intentKey,
    '--evidence-digest', source.manifestDigest,
    '--offer-id', overrides.offerId ?? OFFER_ID,
    '--superseded-by-listing-id', overrides.supersededByListingId ?? NEW_LISTING_ID,
  ];
}

function attemptResolution(world: World, jobId: string, attemptId: string): string | null {
  const store = openMigrationStoreReadOnly({
    databasePath: world.migrationDatabasePath,
    expectedScope: MIGRATION_SCOPE,
  });
  try {
    const status = store.getAttemptStatus(jobId, attemptId);
    expect(status).not.toBeNull();
    return (status as NonNullable<typeof status>).resolution;
  } finally {
    store.close();
  }
}

describe('listing-lifecycle operator CLI — recover-orphaned-artifact', () => {
  it('removes the orphaned pair end to end and never touches the source truth', async () => {
    const world = await createWorld();
    const source = await dispatchResolvedCreate(world);
    await recordOrphanEvidence(world, source);

    await world.run(['recover-orphaned-artifact', ...orphanArguments(world, source)]);
    const recovered = lastJson(world.stdout);
    expect(recovered).toMatchObject({
      command: 'recover-orphaned-artifact',
      status: 'recovered-and-reconciled',
      effect: 'residue_removed',
      recoveryResolution: 'resolved_residue_removed',
      liveListingIntact: true,
      supersededByListingId: NEW_LISTING_ID,
      externalCommerceWritesAttempted: 2,
    });
    expect(world.recoverCalls).toEqual([
      `getOffer:${OFFER_ID}`,
      `deleteOffer:${OFFER_ID}`,
      `getOffer:${OFFER_ID}`,
      `deleteInventoryItem:${SKU}`,
      `getInventoryItem:${SKU}`,
    ]);
    // The source create's truth is untouched: it resolved as existing and
    // stays that way — only the recovery job carries residue_removed.
    expect(attemptResolution(world, source.jobId, source.attemptId))
      .toBe('resolved_existing');
    expect(attemptResolution(world,
      recovered.recoveryJobId as string,
      recovered.recoveryAttemptId as string)).toBe('resolved_residue_removed');
  });

  it('refuses an UNRESOLVED source create — that is recover-create’s job', async () => {
    const world = await createWorld();
    world.failPublish(true);
    const source = await dispatchResolvedCreate(world).catch(() => null);
    expect(source).toBeNull();
    // Rebuild the identifiers from the failed dispatch output instead.
    const dispatched = lastJson(world.stdout);
    const failed: ResolvedCreate = {
      jobId: dispatched.jobId as string,
      attemptId: dispatched.attemptId as string,
      intentKey: dispatched.intentKey as string,
      manifestDigest: dispatched.manifestDigest as string,
    };
    world.setWorkspace(orphanedWorkspace());
    await world.run(['recover-orphaned-artifact', ...orphanArguments(world, failed)]);
    expect(lastJson(world.stderr)).toMatchObject({
      status: 'denied', code: 'RECOVER_ORPHAN_SOURCE_NOT_RESOLVED',
    });
    expect(world.recoverCalls).toHaveLength(0);
  });

  it('refuses when the offer is bound to the LIVE listing — that is a working listing', async () => {
    const world = await createWorld();
    const source = await dispatchResolvedCreate(world);
    await recordOrphanEvidence(world, source);
    world.setOffer({ listingId: NEW_LISTING_ID });
    await world.run(['recover-orphaned-artifact', ...orphanArguments(world, source)]);
    expect(lastJson(world.stderr)).toMatchObject({
      status: 'denied', code: 'RECOVER_ORPHAN_OFFER_BOUND_TO_LIVE_LISTING',
    });
    expect(world.recoverCalls).toEqual([`getOffer:${OFFER_ID}`]);
  });

  it('refuses a supersession mismatch before any provider read', async () => {
    const world = await createWorld();
    const source = await dispatchResolvedCreate(world);
    await recordOrphanEvidence(world, source);
    await world.run(['recover-orphaned-artifact',
      ...orphanArguments(world, source, { supersededByListingId: '147699999999' })]);
    expect(lastJson(world.stderr)).toMatchObject({
      status: 'denied', code: 'RECOVER_ORPHAN_SUPERSESSION_MISMATCH',
    });
    expect(world.recoverCalls).toHaveLength(0);
  });

  it('leaves a delayed capture unresolved and closes later via recover-orphaned-reconcile',
    async () => {
      const world = await createWorld();
      const source = await dispatchResolvedCreate(world);
      await recordOrphanEvidence(world, source);
      world.holdWorkspaceOnRemoval(true);
      await world.run(['recover-orphaned-artifact', ...orphanArguments(world, source)]);
      const recovered = lastJson(world.stdout);
      expect(recovered).toMatchObject({
        status: 'recovery-unresolved',
        unresolvedCode: 'RECOVER_RESIDUE_STILL_PRESENT',
      });
      // The capture catches up; the zero-write reconcile closes truthfully.
      world.setWorkspace(orphanCleanWorkspace());
      await world.run(['recover-orphaned-reconcile', ...orphanArguments(world, source),
        '--recovery-job-id', recovered.recoveryJobId as string,
        '--recovery-attempt-id', recovered.recoveryAttemptId as string,
      ]);
      expect(lastJson(world.stdout)).toMatchObject({
        command: 'recover-orphaned-reconcile',
        status: 'recovered-and-reconciled',
        recoveryResolution: 'resolved_residue_removed',
        externalWritesPerformed: 0,
      });
      expect(attemptResolution(world, source.jobId, source.attemptId))
        .toBe('resolved_existing');
    });
});
