/**
 * Contract tests for the isolated listing-lifecycle operator CLI's
 * RECOVER-CREATE cleanup ceremony (Brain L34): removing the exact unpublished
 * offer/inventory-item residue an unresolved create job left behind and
 * truthfully resolving the original job as `resolved_residue_removed`.
 * Everything runs against real on-disk listing-control and migration-state
 * stores (schema v5); only the live workspace read and the provider HTTP
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
import {
  ListingRecoverDispatchError,
  type ListingRecoverDispatchAdapter,
  type RecoveredOfferStatus,
} from '../recover-dispatch-adapter.js';

const MIGRATION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000700002';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000700002';
const PRODUCT_GID = 'gid://shopify/Product/10310708200002';
const SKU = 'CAN2470-U301';
const OFFER_ID = '558800112244';
const IMAGE_URL = 'https://cdn.shopify.com/s/files/1/0001/products/canon-2470.jpg';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function notListedWorkspace(): ListingWorkspaceDto {
  return {
    schemaVersion: 1,
    evidence: {
      catalogObservedAtUtc: '2026-08-27T18:59:00.000Z',
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
      lastVerifiedAtUtc: '2026-08-27T18:59:00.000Z',
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

/** The created-offer-but-publish-failed state: an unpublished offer artifact. */
function offerPendingWorkspace(offerId: string = OFFER_ID): ListingWorkspaceDto {
  const base = notListedWorkspace();
  return {
    ...base,
    catalog: {
      ...base.catalog,
      ebay: {
        ...base.catalog.ebay,
        state: 'attention', listingId: null, offerId,
        activeMatchCount: 0, inventoryItemCount: 1,
        offerCount: 1, unpublishedArtifactCount: 1,
      },
      lifecycleStatus: 'attention',
    },
    mapping: { ...base.mapping, state: 'attention' },
  };
}

/**
 * The residue exactly as the REAL live catalog emits it (L40).
 *
 * `buildLiveListingCatalogSnapshot` fills `ebay.offerId` only from
 * `matchingOffer`, which it computes solely inside the `activeListing ? ... :
 * null` branch. An unpublished offer has no active listing, so a genuine
 * created-offer-but-publish-failed capture always reports `offerId: null`
 * while still counting the artifacts. This mirrors the Production row
 * observed for the 2026-08-27 G16 incident: activeMatchCount 0,
 * inventoryItemCount 1, offerCount 1, unpublishedArtifactCount 2, offerId
 * null, attentionReasons ['ebay_unpublished_artifact'].
 *
 * `offerPendingWorkspace` above keeps a populated offer id to exercise the
 * contradiction path, but that combination is NOT one the real capture can
 * produce — so success paths must be proven against THIS fixture.
 */
function productionResidueWorkspace(): ListingWorkspaceDto {
  const base = notListedWorkspace();
  return {
    ...base,
    catalog: {
      ...base.catalog,
      ebay: {
        ...base.catalog.ebay,
        state: 'attention', listingId: null, offerId: null,
        activeMatchCount: 0, inventoryItemCount: 1,
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

/** Only the inventory item remains (offer deleted, item delete pending). */
function inventoryOnlyWorkspace(): ListingWorkspaceDto {
  const base = notListedWorkspace();
  return {
    ...base,
    catalog: {
      ...base.catalog,
      ebay: { ...base.catalog.ebay, state: 'attention', inventoryItemCount: 1 },
      lifecycleStatus: 'attention',
    },
    mapping: { ...base.mapping, state: 'attention' },
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
  setOfferStatus: (status: RecoveredOfferStatus | 'absent') => void;
  setOfferSku: (sku: string) => void;
  failDeleteOffer: (fail: boolean) => void;
  failDeleteItem: (fail: boolean) => void;
  holdWorkspaceOnRemoval: (hold: boolean) => void;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  run: (argv: string[]) => Promise<void>;
};

async function createWorld(): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-lifecycle-recover-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);

  const draftDatabasePath = path.join(root, 'listing-control.sqlite');
  initializeListingControlStore({
    databasePath: draftDatabasePath,
    scope: LISTING_DRAFT_SCOPE,
    createdAtUtc: '2026-08-27T18:00:00.000Z',
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
    createdAtUtc: '2026-08-27T18:00:00.000Z',
  }).close();

  // The create adapter used only to manufacture the unpublished residue: the
  // publish call always fails, exactly like the production incident.
  const createAdapter: ListingCreateDispatchAdapter = Object.freeze({
    putInventoryItem: async () => { current = inventoryOnlyWorkspace(); },
    createOffer: async () => {
      current = offerPendingWorkspace();
      return OFFER_ID;
    },
    publishOffer: async () => {
      throw new Error('publish secret token=VERY_SECRET raw-body');
    },
  });

  const recoverCalls: string[] = [];
  let offerStatus: RecoveredOfferStatus | 'absent' = 'UNPUBLISHED';
  let offerSku = SKU;
  let itemPresent = true;
  let deleteOfferFails = false;
  let deleteItemFails = false;
  let holdWorkspace = false;
  const recoverAdapter: ListingRecoverDispatchAdapter = Object.freeze({
    getOffer: async (offerId) => {
      recoverCalls.push(`getOffer:${offerId}`);
      return offerStatus === 'absent'
        ? Object.freeze({ found: false, sku: null, status: null })
        : Object.freeze({ found: true, sku: offerSku, status: offerStatus });
    },
    deleteOffer: async (offerId) => {
      recoverCalls.push(`deleteOffer:${offerId}`);
      if (deleteOfferFails) {
        throw new ListingRecoverDispatchError('RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
      }
      offerStatus = 'absent';
      if (!holdWorkspace) current = inventoryOnlyWorkspace();
    },
    getInventoryItem: async (sku) => {
      recoverCalls.push(`getInventoryItem:${sku}`);
      return itemPresent
        ? Object.freeze({ found: true, sku })
        : Object.freeze({ found: false, sku: null });
    },
    deleteInventoryItem: async (sku) => {
      recoverCalls.push(`deleteInventoryItem:${sku}`);
      if (deleteItemFails) throw new Error('delete secret token=VERY_SECRET raw-body');
      itemPresent = false;
      if (!holdWorkspace) current = notListedWorkspace();
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
    setOfferStatus: (status) => { offerStatus = status; },
    setOfferSku: (sku) => { offerSku = sku; },
    failDeleteOffer: (fail) => { deleteOfferFails = fail; },
    failDeleteItem: (fail) => { deleteItemFails = fail; },
    holdWorkspaceOnRemoval: (hold) => { holdWorkspace = hold; },
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

type UnresolvedCreate = {
  jobId: string;
  attemptId: string;
  intentKey: string;
  manifestDigest: string;
};

/** Reproduce the incident shape: one exact create whose Publish Offer fails. */
async function dispatchUnpublishedCreate(world: World): Promise<UnresolvedCreate> {
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
  expect(dispatched).toMatchObject({
    status: 'dispatched-unresolved',
    effect: 'offer_unpublished',
    unresolvedCode: 'CREATE_OFFER_UNPUBLISHED',
    offerId: OFFER_ID,
  });
  return {
    jobId: dispatched.jobId as string,
    attemptId: dispatched.attemptId as string,
    intentKey: dispatched.intentKey as string,
    manifestDigest,
  };
}

function recoverArguments(world: World, source: UnresolvedCreate, overrides: Partial<{
  confirmScope: string;
  sku: string;
  jobId: string;
  attemptId: string;
  intentKey: string;
  evidenceDigest: string;
  offerId: string;
}> = {}): string[] {
  return ['recover-create',
    '--migration-store', world.migrationDatabasePath,
    '--confirm-scope', overrides.confirmScope ?? deriveScopeKey(MIGRATION_SCOPE),
    '--catalog-id', CATALOG_ID,
    '--sku', overrides.sku ?? SKU,
    '--job-id', overrides.jobId ?? source.jobId,
    '--attempt-id', overrides.attemptId ?? source.attemptId,
    '--intent-key', overrides.intentKey ?? source.intentKey,
    '--evidence-digest', overrides.evidenceDigest ?? source.manifestDigest,
    '--offer-id', overrides.offerId ?? OFFER_ID,
  ];
}

function storeCounts(world: World): Record<string, number> {
  const store = openMigrationStoreReadOnly({
    databasePath: world.migrationDatabasePath,
    expectedScope: MIGRATION_SCOPE,
  });
  try {
    return store.getCounts();
  } finally {
    store.close();
  }
}

function jobState(world: World, jobId: string): string {
  const store = openMigrationStoreReadOnly({
    databasePath: world.migrationDatabasePath,
    expectedScope: MIGRATION_SCOPE,
  });
  try {
    const status = store.getJobStatus(jobId);
    expect(status).not.toBeNull();
    return (status as NonNullable<typeof status>).state;
  } finally {
    store.close();
  }
}

describe('listing-lifecycle operator CLI — recover-create', () => {
  it('removes the exact residue and truthfully resolves both jobs end to end', async () => {
    const world = await createWorld();
    const source = await dispatchUnpublishedCreate(world);

    await world.run(recoverArguments(world, source));
    const recovered = lastJson(world.stdout);
    expect(recovered).toMatchObject({
      command: 'recover-create',
      status: 'recovered-and-reconciled',
      sourceJobId: source.jobId,
      sourceAttemptId: source.attemptId,
      offerId: OFFER_ID,
      providerDispatchReported: true,
      effect: 'residue_removed',
      recoveryResolution: 'resolved_residue_removed',
      sourceResolution: 'resolved_residue_removed',
      unresolvedCode: null,
      externalCommerceWritesAttempted: 2,
    });
    // Exactly the bounded provider sequence: verify, delete offer, verify
    // gone, delete inventory item, verify gone — nothing else.
    expect(world.recoverCalls).toEqual([
      `getOffer:${OFFER_ID}`,
      `deleteOffer:${OFFER_ID}`,
      `getOffer:${OFFER_ID}`,
      `deleteInventoryItem:${SKU}`,
      `getInventoryItem:${SKU}`,
    ]);

    const store = openMigrationStoreReadOnly({
      databasePath: world.migrationDatabasePath,
      expectedScope: MIGRATION_SCOPE,
    });
    expect(store.getJobStatus(source.jobId)).toMatchObject({
      state: 'resolved_residue_removed',
      responsibility: 'listingCreate',
    });
    expect(store.getJobStatus(recovered.recoveryJobId as string)).toMatchObject({
      state: 'resolved_residue_removed',
      responsibility: 'listingCreate',
    });
    expect(store.getAttemptStatus(source.jobId, source.attemptId)).toMatchObject({
      resolution: 'resolved_residue_removed',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 2,
      action_approvals: 2,
      approval_consumptions: 2,
      execution_jobs: 2,
      intent_attempts: 2,
      attempt_resolutions: 2,
      target_effect_observations: 2,
      order_links: 0,
      order_watermarks: 0,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
    store.close();

    const redactedOutput = JSON.stringify([...world.stdout, ...world.stderr]);
    expect(redactedOutput).not.toContain('VERY_SECRET');
    expect(redactedOutput).not.toContain('raw-body');

    // Idempotent denial after success: the original job is terminal, so a
    // repeat invocation is a fixed-code denial before any provider call.
    const callsBefore = world.recoverCalls.length;
    world.setWorkspace(offerPendingWorkspace());
    await world.run(recoverArguments(world, source));
    expect(lastJson(world.stderr)).toMatchObject({ code: 'RECOVER_STATE_MISMATCH' });
    expect(world.recoverCalls).toHaveLength(callsBefore);
  });

  // L40 regression. Before the fix the residue guard required the fresh
  // capture's `observedOfferId` to equal the named offer id, but the real
  // catalog cannot surface an offer id for an unpublished offer, so the
  // ceremony denied RECOVER_RESIDUE_STATE_MISMATCH against every genuine
  // Production residue and could never succeed.
  it('recovers residue the live catalog reports with no observable offer id (L40)', async () => {
    const world = await createWorld();
    const source = await dispatchUnpublishedCreate(world);
    world.setWorkspace(productionResidueWorkspace());

    await world.run(recoverArguments(world, source));
    expect(lastJson(world.stdout)).toMatchObject({
      command: 'recover-create',
      status: 'recovered-and-reconciled',
      sourceJobId: source.jobId,
      offerId: OFFER_ID,
      effect: 'residue_removed',
      recoveryResolution: 'resolved_residue_removed',
      sourceResolution: 'resolved_residue_removed',
      unresolvedCode: null,
    });
    expect(world.recoverCalls).toEqual([
      `getOffer:${OFFER_ID}`,
      `deleteOffer:${OFFER_ID}`,
      `getOffer:${OFFER_ID}`,
      `deleteInventoryItem:${SKU}`,
      `getInventoryItem:${SKU}`,
    ]);
  });

  // The safety property the removed comparison was assumed to provide is
  // still enforced, one layer down: with the offer id unobservable in the
  // capture, the store's recorded artifact evidence is the sole authority for
  // which offer may be deleted, so a foreign offer id is refused before any
  // provider call and the source job stays untouched.
  it('still refuses a foreign offer id when the capture omits one (L40)', async () => {
    const world = await createWorld();
    const source = await dispatchUnpublishedCreate(world);
    world.setWorkspace(productionResidueWorkspace());

    await world.run(recoverArguments(world, source, { offerId: '999999999999' }));
    expect(lastJson(world.stderr)).toMatchObject({
      status: 'denied',
      code: 'RECOVER_ARTIFACT_EVIDENCE_MISMATCH',
    });
    expect(world.recoverCalls).toHaveLength(0);
    expect(jobState(world, source.jobId)).toBe('reconciliation_required');
  });

  it('denies every identity mismatch with a fixed code before any provider call', async () => {
    const world = await createWorld();
    const source = await dispatchUnpublishedCreate(world);
    const intentsBefore = storeCounts(world).idempotency_intents;

    const denials: Array<[Partial<Parameters<typeof recoverArguments>[2]>, string]> = [
      [{ confirmScope: `sha256:${'d'.repeat(64)}` }, 'RECOVER_SCOPE_CONFIRMATION_MISMATCH'],
      [{ sku: 'WRONG-SKU' }, 'RECOVER_EXACT_TARGET_MISMATCH'],
      [{ jobId: 'listing-create-job:00000000-0000-0000-0000-000000000000' },
        'RECOVER_STATE_MISMATCH'],
      [{ attemptId: 'listing-create-attempt:00000000-0000-0000-0000-000000000000' },
        'RECOVER_ATTEMPT_MISMATCH'],
      [{ intentKey: `sha256:${'e'.repeat(64)}` }, 'RECOVER_INTENT_BINDING_MISMATCH'],
      [{ evidenceDigest: `sha256:${'f'.repeat(64)}` }, 'RECOVER_EVIDENCE_MISMATCH'],
      // A different offer id no longer matches the freshly observed residue.
      [{ offerId: '999999999999' }, 'RECOVER_RESIDUE_STATE_MISMATCH'],
    ];
    for (const [overrides, code] of denials) {
      await world.run(recoverArguments(world, source, overrides));
      expect(lastJson(world.stderr), code).toMatchObject({ status: 'denied', code });
    }
    // A forged workspace naming a foreign offer passes the residue precheck
    // but fails the store's recorded artifact-evidence binding.
    world.setWorkspace(offerPendingWorkspace('999999999999'));
    await world.run(recoverArguments(world, source, { offerId: '999999999999' }));
    expect(lastJson(world.stderr)).toMatchObject({
      status: 'denied',
      code: 'RECOVER_ARTIFACT_EVIDENCE_MISMATCH',
    });
    world.setWorkspace(offerPendingWorkspace());

    expect(world.recoverCalls).toHaveLength(0);
    expect(storeCounts(world).idempotency_intents).toBe(intentsBefore);
    expect(jobState(world, source.jobId)).toBe('reconciliation_required');
  });

  it('refuses a published offer outright and spends nothing', async () => {
    const world = await createWorld();
    const source = await dispatchUnpublishedCreate(world);

    world.setOfferStatus('PUBLISHED');
    await world.run(recoverArguments(world, source));
    expect(lastJson(world.stderr)).toMatchObject({
      status: 'denied', code: 'RECOVER_OFFER_PUBLISHED',
    });
    expect(world.recoverCalls).toEqual([`getOffer:${OFFER_ID}`]);
    expect(storeCounts(world).idempotency_intents).toBe(1);
    expect(jobState(world, source.jobId)).toBe('reconciliation_required');

    // An absent offer and a foreign SKU are the same class of refusal.
    world.setOfferStatus('absent');
    await world.run(recoverArguments(world, source));
    expect(lastJson(world.stderr)).toMatchObject({ code: 'RECOVER_OFFER_NOT_FOUND' });
    world.setOfferStatus('UNPUBLISHED');
    world.setOfferSku('OTHER-SKU');
    await world.run(recoverArguments(world, source));
    expect(lastJson(world.stderr)).toMatchObject({ code: 'RECOVER_OFFER_SKU_MISMATCH' });
    world.setOfferSku(SKU);
    expect(storeCounts(world).idempotency_intents).toBe(1);

    // The denials spent nothing: the exact same ceremony still succeeds.
    await world.run(recoverArguments(world, source));
    expect(lastJson(world.stdout)).toMatchObject({ status: 'recovered-and-reconciled' });
  });

  it('keeps everything unresolved on a provider delete failure and recovers via a chained retry',
    async () => {
      const world = await createWorld();
      const source = await dispatchUnpublishedCreate(world);

      world.failDeleteOffer(true);
      await world.run(recoverArguments(world, source));
      const failed = lastJson(world.stdout);
      expect(failed).toMatchObject({
        status: 'recovery-unresolved',
        providerDispatchReported: false,
        dispatchFailureStage: 'delete_offer',
        dispatchFailureCode: 'RECOVER_DISPATCH_WRITE_FAILED',
        recoveryResolution: null,
        sourceResolution: null,
      });
      expect(world.exitCodes.at(-1)).toBe(1);
      expect(jobState(world, source.jobId)).toBe('reconciliation_required');
      expect(jobState(world, failed.recoveryJobId as string)).toBe('reconciliation_required');
      const redactedOutput = JSON.stringify([...world.stdout, ...world.stderr]);
      expect(redactedOutput).not.toContain('VERY_SECRET');
      expect(redactedOutput).not.toContain('raw-body');

      // The spent recovery intent can never replay...
      world.failDeleteOffer(false);
      await world.run(recoverArguments(world, source));
      expect(lastJson(world.stderr)).toMatchObject({ code: 'RECOVER_INTENT_ALREADY_RECORDED' });

      // ...but an explicitly chained retry binds the failed prior ceremony
      // (L29) into a new deterministic recovery digest and completes.
      await world.run([...recoverArguments(world, source),
        '--prior-recovery-job-id', failed.recoveryJobId as string,
        '--prior-recovery-attempt-id', failed.recoveryAttemptId as string,
      ]);
      const chained = lastJson(world.stdout);
      expect(chained).toMatchObject({
        status: 'recovered-and-reconciled',
        recoveryResolution: 'resolved_residue_removed',
        sourceResolution: 'resolved_residue_removed',
      });
      expect(jobState(world, source.jobId)).toBe('resolved_residue_removed');
      expect(jobState(world, chained.recoveryJobId as string)).toBe('resolved_residue_removed');
      // The abandoned prior recovery job closes truthfully too.
      expect(jobState(world, failed.recoveryJobId as string)).toBe('resolved_residue_removed');
      // A chained retry against a bogus prior job is a fixed-code denial.
      const world2 = await createWorld();
      const source2 = await dispatchUnpublishedCreate(world2);
      await world2.run([...recoverArguments(world2, source2),
        '--prior-recovery-job-id', 'listing-create-recovery-job:missing',
        '--prior-recovery-attempt-id', 'listing-create-recovery-attempt:missing',
      ]);
      expect(lastJson(world2.stderr)).toMatchObject({ code: 'RECOVER_PRIOR_RECOVERY_MISMATCH' });
    });

  it('leaves a delayed capture unresolved and completes later through recover-reconcile',
    async () => {
      const world = await createWorld();
      const source = await dispatchUnpublishedCreate(world);

      // Deletions succeed remotely, but the fresh capture lags behind.
      world.holdWorkspaceOnRemoval(true);
      await world.run(recoverArguments(world, source));
      const pending = lastJson(world.stdout);
      expect(pending).toMatchObject({
        status: 'recovery-unresolved',
        providerDispatchReported: true,
        effect: 'artifact',
        unresolvedCode: 'RECOVER_RESIDUE_STILL_PRESENT',
        recoveryResolution: null,
        sourceResolution: null,
      });
      expect(jobState(world, source.jobId)).toBe('reconciliation_required');
      expect(jobState(world, pending.recoveryJobId as string)).toBe('reconciliation_required');

      // Once the capture catches up, the zero-write recover-reconcile proves
      // removal at the provider AND on the capture, then resolves both jobs.
      world.setWorkspace(notListedWorkspace());
      await world.run([...recoverArguments(world, source).map((argument) =>
        argument === 'recover-create' ? 'recover-reconcile' : argument),
        '--recovery-job-id', pending.recoveryJobId as string,
        '--recovery-attempt-id', pending.recoveryAttemptId as string,
      ]);
      const reconciled = lastJson(world.stdout);
      expect(reconciled).toMatchObject({
        command: 'recover-reconcile',
        status: 'recovered-and-reconciled',
        effect: 'residue_removed',
        recoveryResolution: 'resolved_residue_removed',
        sourceResolution: 'resolved_residue_removed',
        externalWritesPerformed: 0,
      });
      expect(jobState(world, source.jobId)).toBe('resolved_residue_removed');
      expect(jobState(world, pending.recoveryJobId as string)).toBe('resolved_residue_removed');

      // recover-reconcile performed only reads: two verification GETs.
      expect(world.recoverCalls.filter((call) => call.startsWith('delete'))).toHaveLength(2);
    });

  it('never resolves through recover-reconcile while the provider still holds residue',
    async () => {
      const world = await createWorld();
      const source = await dispatchUnpublishedCreate(world);
      world.failDeleteItem(true);
      await world.run(recoverArguments(world, source));
      const failed = lastJson(world.stdout);
      expect(failed).toMatchObject({
        status: 'recovery-unresolved',
        dispatchFailureStage: 'delete_inventory_item',
      });

      // The workspace claims a clean row, but the provider still returns the
      // inventory item: the capture alone must not terminalize anything.
      world.setWorkspace(notListedWorkspace());
      await world.run([...recoverArguments(world, source).map((argument) =>
        argument === 'recover-create' ? 'recover-reconcile' : argument),
        '--recovery-job-id', failed.recoveryJobId as string,
        '--recovery-attempt-id', failed.recoveryAttemptId as string,
      ]);
      expect(lastJson(world.stdout)).toMatchObject({
        status: 'recovery-unresolved',
        unresolvedCode: 'RECOVER_REMOVAL_UNVERIFIED',
        recoveryResolution: null,
        sourceResolution: null,
      });
      expect(jobState(world, source.jobId)).toBe('reconciliation_required');
      expect(jobState(world, failed.recoveryJobId as string)).toBe('reconciliation_required');
    });

  it('still denies --accept-absent on the original job while the artifact exists', async () => {
    const world = await createWorld();
    const source = await dispatchUnpublishedCreate(world);
    await world.run(['reconcile',
      '--action', 'create', '--catalog-id', CATALOG_ID, '--sku', SKU,
      '--revision-digest', world.revision.revisionDigest,
      '--migration-store', world.migrationDatabasePath,
      '--job-id', source.jobId, '--attempt-id', source.attemptId,
      '--accept-absent',
    ]);
    expect(lastJson(world.stdout)).toMatchObject({
      status: 'unresolved',
      effect: 'offer_unpublished',
      unresolvedCode: 'CREATE_OFFER_UNPUBLISHED',
      resolution: null,
    });
    expect(jobState(world, source.jobId)).toBe('reconciliation_required');
  });

  it('keeps the recovery slice free of server mounts and bounds provider writes to the adapters',
    () => {
      const sourceRoot = path.dirname(new URL('..', import.meta.url).pathname);
      const files = [
        'listing-lifecycle-admin/recovery.ts',
        'listing-lifecycle-admin/recover-dispatch-adapter.ts',
      ].map((file) => [file, fs.readFileSync(path.join(sourceRoot, file), 'utf8')] as const);
      const serverIndex = fs.readFileSync(path.join(sourceRoot, 'server/index.ts'), 'utf8');
      expect(serverIndex).not.toMatch(/listing-lifecycle-admin/);
      for (const [file, source] of files) {
        if (file.endsWith('dispatch-adapter.ts')) {
          // The bounded adapter reaches exactly one host and never publishes.
          expect(source).toMatch(/https:\/\/api\.ebay\.com/);
          // Only GET and DELETE exist; POST/PUT (publish, create, revise)
          // are structurally impossible.
          expect(source).not.toMatch(/method: 'POST'|method: 'PUT'|\/publish/);
          continue;
        }
        expect(source, `${file} must not perform network access`).not.toMatch(/fetch\s*\(/);
      }
    });
});
