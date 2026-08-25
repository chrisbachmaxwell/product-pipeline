/**
 * Schema v3 — Marketplace Connect replacement slice regressions.
 *
 * These tests prove that the v3 production allowances admit exactly the six
 * reviewed writer responsibilities (listingCreate, listingRevise,
 * listingEndRelist, price, inventory, orderImport) under the same
 * one-intent/one-approval/one-job/one-attempt discipline as the v2
 * listing-revise slice, and that the order-incident protections got stronger,
 * not weaker: a production order watermark now requires the recorded
 * ProductPipeline single-writer orderImport ownership chain AND the one-hour
 * no-backfill clamp, so a historical eBay order import remains structurally
 * impossible. The later v4 fulfillment slice changes only fulfillment;
 * mapping and feedback stay fully denied.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveScopeKey,
  inspectMigrationStoreReadOnly,
  MigrationStore,
  MigrationStoreError,
  openMigrationStore,
  sha256Digest,
  upgradeMigrationStore,
  type Digest,
  type ExternalIdentity,
  type IntegrationScope,
  type TargetEffectResponsibility,
} from '../index.js';
import { initializeSchema } from '../schema.js';

const PRODUCTION_SCOPE: IntegrationScope = {
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'production',
  ebaySellerId: 'usedcameragear',
  ebayMarketplaceId: 'EBAY_US',
};

const temporaryDirectories: string[] = [];
const openStores: MigrationStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function digest(label: string): Digest {
  return sha256Digest(label);
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-replacement-v3-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createProductionStore(): MigrationStore {
  const store = createMigrationStore({
    databasePath: path.join(temporaryDirectory(), 'migration-state.sqlite'),
    scope: PRODUCTION_SCOPE,
    createdAtUtc: '2026-08-19T18:00:00.000Z',
  });
  openStores.push(store);
  return store;
}

function expectMigrationError(operation: () => unknown, code: MigrationStoreError['code']): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationStoreError);
  expect((caught as MigrationStoreError).code).toBe(code);
}

function registerVariant(store: MigrationStore, tag: string, gid: string): ExternalIdentity {
  return store.registerIdentity(
    {
      platform: 'shopify',
      kind: 'variant',
      bindingKey: `variant:${tag}`,
      storeDomain: PRODUCTION_SCOPE.shopifyStoreDomain,
      externalGid: `gid://shopify/ProductVariant/${gid}`,
    },
    { eventId: `identity:variant:${tag}`, occurredAtUtc: '2026-08-19T18:00:01.000Z' },
  );
}

function registerEbayIdentity(
  store: MigrationStore,
  kind: 'inventory_sku' | 'offer' | 'listing' | 'order',
  externalId: string,
  occurredAtUtc = '2026-08-19T18:00:02.000Z',
): ExternalIdentity {
  return store.registerIdentity(
    {
      platform: 'ebay',
      kind,
      bindingKey: `${kind}:${externalId}`,
      environment: PRODUCTION_SCOPE.ebayEnvironment,
      sellerId: PRODUCTION_SCOPE.ebaySellerId,
      marketplaceId: PRODUCTION_SCOPE.ebayMarketplaceId,
      externalId,
    },
    { eventId: `identity:${kind}:${externalId}`, occurredAtUtc },
  );
}

/** Class A chain: truthful paused genesis, then ProductPipeline ownership. */
function recordNoIncumbentChain(
  store: MigrationStore,
  responsibility: 'listingCreate' | 'listingEndRelist' | 'listingRevise',
): void {
  store.recordOwnershipVersion({
    responsibility,
    version: 1,
    owner: 'paused',
    singleWriterVerified: true,
    evidenceDigest: digest(`${responsibility}-quarantine-genesis`),
    effectiveAtUtc: '2026-08-19T18:00:03.000Z',
    recordedAtUtc: '2026-08-19T18:00:03.000Z',
    audit: { eventId: `ownership:${responsibility}:v1`, occurredAtUtc: '2026-08-19T18:00:03.000Z' },
  });
  store.recordOwnershipVersion({
    responsibility,
    version: 2,
    owner: 'product_pipeline',
    singleWriterVerified: true,
    evidenceDigest: digest(`${responsibility}-single-writer-evidence`),
    effectiveAtUtc: '2026-08-19T18:00:04.000Z',
    recordedAtUtc: '2026-08-19T18:00:04.000Z',
    audit: { eventId: `ownership:${responsibility}:v2`, occurredAtUtc: '2026-08-19T18:00:04.000Z' },
  });
}

/** Class B chain: verified MC incumbent genesis, staged pause, then ProductPipeline. */
function recordVerifiedIncumbentChain(
  store: MigrationStore,
  responsibility: 'orderImport' | 'price' | 'inventory',
): { productPipelineEvidence: Digest } {
  store.recordOwnershipVersion({
    responsibility,
    version: 1,
    owner: 'marketplace_connect',
    singleWriterVerified: true,
    evidenceDigest: digest(`${responsibility}-marketplace-connect-baseline`),
    effectiveAtUtc: '2026-08-19T18:00:03.000Z',
    recordedAtUtc: '2026-08-19T18:00:03.000Z',
    audit: { eventId: `ownership:${responsibility}:v1`, occurredAtUtc: '2026-08-19T18:00:03.000Z' },
  });
  store.recordOwnershipVersion({
    responsibility,
    version: 2,
    owner: 'paused',
    singleWriterVerified: true,
    evidenceDigest: digest(`${responsibility}-marketplace-connect-disabled-evidence`),
    effectiveAtUtc: '2026-08-19T18:00:04.000Z',
    recordedAtUtc: '2026-08-19T18:00:04.000Z',
    audit: { eventId: `ownership:${responsibility}:v2`, occurredAtUtc: '2026-08-19T18:00:04.000Z' },
  });
  const productPipelineEvidence = digest(`${responsibility}-product-pipeline-single-writer`);
  store.recordOwnershipVersion({
    responsibility,
    version: 3,
    owner: 'product_pipeline',
    singleWriterVerified: true,
    evidenceDigest: productPipelineEvidence,
    effectiveAtUtc: '2026-08-19T18:00:05.000Z',
    recordedAtUtc: '2026-08-19T18:00:05.000Z',
    audit: { eventId: `ownership:${responsibility}:v3`, occurredAtUtc: '2026-08-19T18:00:05.000Z' },
  });
  return { productPipelineEvidence };
}

/**
 * One full production writer lifecycle: intent -> single-use expiring exact
 * approval -> reserved job -> dispatch boundary -> reconciliation_required ->
 * production_canary run with a durable target-effect observation.
 */
function runLifecycleThroughReconciliation(input: {
  store: MigrationStore;
  action: 'create_ebay_listing' | 'update_ebay_price' | 'update_ebay_inventory'
    | 'end_or_relist_ebay_listing';
  responsibility: TargetEffectResponsibility;
  source: ExternalIdentity;
  target: ExternalIdentity;
  ownershipVersion: number;
  effect: 'effect_observed' | 'effect_absent';
  tag: string;
}): { intentKey: Digest; resultDigest: Digest } {
  const { store } = input;
  const intentKey = store.createIdempotencyIntent({
    action: input.action,
    sourceIdentityKey: input.source.identityKey,
    targetIdentityKey: input.target.identityKey,
    desiredStateDigest: digest(`manifest:${input.tag}`),
    createdAtUtc: '2026-08-19T18:00:06.000Z',
    audit: { eventId: `intent:${input.tag}`, occurredAtUtc: '2026-08-19T18:00:06.000Z' },
  });
  const approvalToken = `one-action-approval-${input.tag}-0001`;
  const approvalEvidenceDigest = digest(`approval-evidence:${input.tag}`);
  store.issueActionApproval({
    approvalToken,
    intentKey,
    responsibility: input.responsibility,
    targetIdentityKey: input.target.identityKey,
    ownershipVersion: input.ownershipVersion,
    issuedAtUtc: '2026-08-19T18:00:07.000Z',
    expiresAtUtc: '2026-08-19T18:10:07.000Z',
    evidenceDigest: approvalEvidenceDigest,
    audit: { eventId: `approval:${input.tag}`, occurredAtUtc: '2026-08-19T18:00:07.000Z' },
  });
  store.reserveExecutionJob({
    jobId: `job:${input.tag}`,
    approvalToken,
    intentKey,
    responsibility: input.responsibility,
    targetIdentityKey: input.target.identityKey,
    ownershipVersion: input.ownershipVersion,
    approvalEvidenceDigest,
    reservedAtUtc: '2026-08-19T18:00:08.000Z',
    evidenceDigest: digest(`reserved:${input.tag}`),
    audit: { eventId: `job:${input.tag}:reserved`, occurredAtUtc: '2026-08-19T18:00:08.000Z' },
  });
  store.markDispatchingOutcomeUnknown({
    jobId: `job:${input.tag}`,
    attemptId: `attempt:${input.tag}`,
    approvalToken,
    approvalEvidenceDigest,
    occurredAtUtc: '2026-08-19T18:00:09.000Z',
    evidenceDigest: digest(`dispatch:${input.tag}`),
    audit: { eventId: `job:${input.tag}:dispatching`, occurredAtUtc: '2026-08-19T18:00:09.000Z' },
  });
  store.requirePostDispatchReconciliation({
    jobId: `job:${input.tag}`,
    attemptId: `attempt:${input.tag}`,
    occurredAtUtc: '2026-08-19T18:00:10.000Z',
    evidenceDigest: digest(`reconciliation-required:${input.tag}`),
    audit: {
      eventId: `job:${input.tag}:reconciliation-required`,
      occurredAtUtc: '2026-08-19T18:00:10.000Z',
    },
  });
  const resultDigest = digest(`post-dispatch-result:${input.tag}`);
  store.recordReconciliationRun({
    runId: `reconciliation:${input.tag}`,
    responsibility: input.responsibility,
    targetIdentityKey: input.target.identityKey,
    mode: 'production_canary',
    status: 'passed',
    sourceSnapshotDigest: digest(`source-snapshot:${input.tag}`),
    targetSnapshotDigest: digest(`target-snapshot:${input.tag}`),
    resultDigest,
    authoritative: true,
    authorityEvidenceDigest: digest(`authority:${input.tag}`),
    externalWritesObserved: 0,
    startedAtUtc: '2026-08-19T18:00:11.000Z',
    completedAtUtc: '2026-08-19T18:00:12.000Z',
    exceptions: [],
    targetEffectObservation: {
      observationId: `observation:${input.tag}`,
      intentKey,
      responsibility: input.responsibility,
      effect: input.effect,
      observedDigest: digest(`observed-target-state:${input.tag}`),
    },
    audit: { eventId: `reconciliation:${input.tag}`, occurredAtUtc: '2026-08-19T18:00:12.000Z' },
  });
  return { intentKey, resultDigest };
}

describe('schema v3 production listingCreate and price lifecycles', () => {
  it('executes one approved listingCreate dispatch through target-effect resolution', () => {
    const store = createProductionStore();
    const variant = registerVariant(store, 'PPV3-CREATE-001', '55396000563491');
    const inventorySku = registerEbayIdentity(store, 'inventory_sku', 'PPV3-CREATE-001');
    recordNoIncumbentChain(store, 'listingCreate');

    const { resultDigest } = runLifecycleThroughReconciliation({
      store,
      action: 'create_ebay_listing',
      responsibility: 'listingCreate',
      source: variant,
      target: inventorySku,
      ownershipVersion: 2,
      effect: 'effect_observed',
      tag: 'listing-create',
    });
    store.resolveUnknownAttempt({
      jobId: 'job:listing-create',
      attemptId: 'attempt:listing-create',
      resolution: 'resolved_existing',
      reconciliationRunId: 'reconciliation:listing-create',
      reconciliationResultDigest: resultDigest,
      reconciledAtUtc: '2026-08-19T18:00:13.000Z',
      audit: { eventId: 'resolution:listing-create', occurredAtUtc: '2026-08-19T18:00:13.000Z' },
    });

    expect(store.getJobStatus('job:listing-create')).toMatchObject({
      state: 'resolved_existing',
      attemptOutcome: 'outcome_unknown',
    });
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 1,
      action_approvals: 1,
      approval_consumptions: 1,
      execution_jobs: 1,
      intent_attempts: 1,
      attempt_resolutions: 1,
      reconciliation_runs: 1,
      target_effect_observations: 1,
      listing_revise_observations: 0,
      order_links: 0,
      order_watermarks: 0,
    });
    expect(store.countExecutionRowsOutsideResponsibility('listingCreate')).toBe(0);
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });

    // The read-only projection accepts the slice-scoped production store.
    const projection = inspectMigrationStoreReadOnly({
      databasePath: store.databasePath,
      expectedScope: PRODUCTION_SCOPE,
    });
    expect(projection.status).toBe('verified');
    expect(projection.counts).toMatchObject({
      idempotencyIntents: 1,
      executionJobs: 1,
      targetEffectObservations: 1,
    });
    expect(projection.ownership.find((entry) => entry.responsibility === 'listingCreate'))
      .toMatchObject({ configured: true, owner: 'product_pipeline', version: 2 });
    expect(projection.readiness).toMatchObject({ canaryReady: false, cutoverReady: false });
  });

  it('executes one approved update_ebay_price dispatch and binds resolution to the recorded effect', () => {
    const store = createProductionStore();
    const variant = registerVariant(store, 'PPV3-PRICE-001', '55396000563492');
    const offer = registerEbayIdentity(store, 'offer', 'offer-777001');
    recordVerifiedIncumbentChain(store, 'price');

    const { resultDigest } = runLifecycleThroughReconciliation({
      store,
      action: 'update_ebay_price',
      responsibility: 'price',
      source: variant,
      target: offer,
      ownershipVersion: 3,
      effect: 'effect_absent',
      tag: 'price-update',
    });

    // The recorded observation says the price effect is absent, so a
    // resolved_existing claim must fail, and an order link is always invalid.
    expectMigrationError(() => store.resolveUnknownAttempt({
      jobId: 'job:price-update',
      attemptId: 'attempt:price-update',
      resolution: 'resolved_existing',
      reconciliationRunId: 'reconciliation:price-update',
      reconciliationResultDigest: resultDigest,
      reconciledAtUtc: '2026-08-19T18:00:13.000Z',
      audit: { eventId: 'resolution:price-denied', occurredAtUtc: '2026-08-19T18:00:13.000Z' },
    }), 'CONFLICT');
    expectMigrationError(() => store.resolveUnknownAttempt({
      jobId: 'job:price-update',
      attemptId: 'attempt:price-update',
      resolution: 'confirmed_missing',
      reconciliationRunId: 'reconciliation:price-update',
      reconciliationResultDigest: resultDigest,
      orderLinkId: 'link:invalid',
      shopifyOrderIdentityKey: digest('not-an-identity'),
      reconciledAtUtc: '2026-08-19T18:00:13.000Z',
      audit: { eventId: 'resolution:price-link-denied', occurredAtUtc: '2026-08-19T18:00:13.000Z' },
    }), 'INVALID_INPUT');

    store.resolveUnknownAttempt({
      jobId: 'job:price-update',
      attemptId: 'attempt:price-update',
      resolution: 'confirmed_missing',
      reconciliationRunId: 'reconciliation:price-update',
      reconciliationResultDigest: resultDigest,
      reconciledAtUtc: '2026-08-19T18:00:14.000Z',
      audit: { eventId: 'resolution:price-update', occurredAtUtc: '2026-08-19T18:00:14.000Z' },
    });
    expect(store.getJobStatus('job:price-update')).toMatchObject({ state: 'confirmed_missing' });
    expect(store.getCounts()).toMatchObject({
      target_effect_observations: 1,
      attempt_resolutions: 1,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
  });
});

describe('schema v3 production order watermark clamp', () => {
  it('permits the watermark only under ProductPipeline ownership and the one-hour clamp', () => {
    const store = createProductionStore();

    // While Marketplace Connect still owns orderImport, no production
    // watermark can exist.
    store.recordOwnershipVersion({
      responsibility: 'orderImport',
      version: 1,
      owner: 'marketplace_connect',
      singleWriterVerified: true,
      evidenceDigest: digest('orderImport-marketplace-connect-baseline'),
      effectiveAtUtc: '2026-08-19T18:00:03.000Z',
      recordedAtUtc: '2026-08-19T18:00:03.000Z',
      audit: { eventId: 'ownership:orderImport:v1', occurredAtUtc: '2026-08-19T18:00:03.000Z' },
    });
    expect(() => store.establishOrderWatermark({
      boundaryExclusiveUtc: '2026-08-19T18:00:00.000Z',
      ownershipVersion: 1,
      ownershipEvidenceDigest: digest('orderImport-marketplace-connect-baseline'),
      acceptedEvidenceDigest: digest('watermark-packet'),
      createdAtUtc: '2026-08-19T18:00:04.000Z',
      audit: { eventId: 'watermark:denied-mc', occurredAtUtc: '2026-08-19T18:00:04.000Z' },
    })).toThrow(/Production watermark requires current ProductPipeline single-writer orderImport ownership/);

    store.recordOwnershipVersion({
      responsibility: 'orderImport',
      version: 2,
      owner: 'paused',
      singleWriterVerified: true,
      evidenceDigest: digest('orderImport-marketplace-connect-disabled-evidence'),
      effectiveAtUtc: '2026-08-19T18:00:05.000Z',
      recordedAtUtc: '2026-08-19T18:00:05.000Z',
      audit: { eventId: 'ownership:orderImport:v2', occurredAtUtc: '2026-08-19T18:00:05.000Z' },
    });
    const productPipelineEvidence = digest('orderImport-product-pipeline-single-writer');
    store.recordOwnershipVersion({
      responsibility: 'orderImport',
      version: 3,
      owner: 'product_pipeline',
      singleWriterVerified: true,
      evidenceDigest: productPipelineEvidence,
      effectiveAtUtc: '2026-08-19T18:00:06.000Z',
      recordedAtUtc: '2026-08-19T18:00:06.000Z',
      audit: { eventId: 'ownership:orderImport:v3', occurredAtUtc: '2026-08-19T18:00:06.000Z' },
    });

    // A boundary two hours before establishment is rejected even with the
    // correct ProductPipeline ownership: history is out of reach forever.
    expectMigrationError(() => store.establishOrderWatermark({
      boundaryExclusiveUtc: '2026-08-19T16:30:00.000Z',
      ownershipVersion: 3,
      ownershipEvidenceDigest: productPipelineEvidence,
      acceptedEvidenceDigest: digest('watermark-packet'),
      createdAtUtc: '2026-08-19T18:30:00.000Z',
      audit: { eventId: 'watermark:denied-clamp', occurredAtUtc: '2026-08-19T18:30:00.000Z' },
    }), 'INVALID_INPUT');
    expect(() => store.establishOrderWatermark({
      boundaryExclusiveUtc: '2026-08-19T16:30:00.000Z',
      ownershipVersion: 3,
      ownershipEvidenceDigest: productPipelineEvidence,
      acceptedEvidenceDigest: digest('watermark-packet'),
      createdAtUtc: '2026-08-19T18:30:00.000Z',
      audit: { eventId: 'watermark:denied-clamp', occurredAtUtc: '2026-08-19T18:30:00.000Z' },
    })).toThrow(/one-hour no-backfill clamp/);

    // The SQL trigger enforces the clamp independently of the TypeScript
    // guard: a direct historical-boundary insert is denied at the database.
    const { databasePath } = store;
    store.close();
    const raw = new Database(databasePath);
    try {
      const scopeKey = deriveScopeKey(PRODUCTION_SCOPE);
      expect(() => raw
        .prepare(
          `INSERT INTO order_watermarks (
            watermark_key, scope_key, source_platform, responsibility,
            ownership_version, ownership_evidence_digest, accepted_evidence_digest,
            event_field, boundary_mode, boundary_exclusive_utc,
            boundary_exclusive_epoch_ms, created_at_utc, created_epoch_ms
          ) VALUES (?, ?, 'ebay', 'orderImport', 3, ?, ?, 'creationDate', 'exclusive', ?, ?, ?, ?)`,
        )
        .run(
          digest('raw-backfill-watermark'),
          scopeKey,
          productPipelineEvidence,
          digest('watermark-packet'),
          '2026-08-19T16:30:00.000Z',
          Date.parse('2026-08-19T16:30:00.000Z'),
          '2026-08-19T18:30:00.000Z',
          Date.parse('2026-08-19T18:30:00.000Z'),
        )).toThrow(/no-backfill clamp denied/);
    } finally {
      raw.close();
    }
    const reopened = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
    openStores.push(reopened);

    // A boundary thirty minutes before establishment satisfies the clamp.
    expect(reopened.establishOrderWatermark({
      boundaryExclusiveUtc: '2026-08-19T18:00:00.000Z',
      ownershipVersion: 3,
      ownershipEvidenceDigest: productPipelineEvidence,
      acceptedEvidenceDigest: digest('watermark-packet'),
      createdAtUtc: '2026-08-19T18:30:00.000Z',
      audit: { eventId: 'watermark:established', occurredAtUtc: '2026-08-19T18:30:00.000Z' },
    })).toMatchObject({
      eventField: 'creationDate',
      boundaryExclusiveUtc: '2026-08-19T18:00:00.000Z',
    });
    expect(reopened.getOrderWatermark()).toMatchObject({
      boundaryMode: 'exclusive',
      boundaryExclusiveUtc: '2026-08-19T18:00:00.000Z',
    });

    // The watermark is one-per-scope forever.
    expectMigrationError(() => reopened.establishOrderWatermark({
      boundaryExclusiveUtc: '2026-08-19T18:10:00.000Z',
      ownershipVersion: 3,
      ownershipEvidenceDigest: productPipelineEvidence,
      acceptedEvidenceDigest: digest('watermark-packet-second'),
      createdAtUtc: '2026-08-19T18:31:00.000Z',
      audit: { eventId: 'watermark:second-denied', occurredAtUtc: '2026-08-19T18:31:00.000Z' },
    }), 'CONFLICT');

    // Strictly-greater eligibility: pre- and equal-boundary observations are
    // permanently ineligible, a post-boundary observation admits one intent.
    const preOrder = registerEbayIdentity(reopened, 'order', 'EBAY-ORDER-PRE', '2026-08-19T18:32:00.000Z');
    const equalOrder = registerEbayIdentity(reopened, 'order', 'EBAY-ORDER-EQUAL', '2026-08-19T18:32:01.000Z');
    const postOrder = registerEbayIdentity(reopened, 'order', 'EBAY-ORDER-POST', '2026-08-19T18:32:02.000Z');
    reopened.recordOrderPage({
      pageId: 'page:v3-boundary',
      cursorBefore: null,
      cursorAfter: 'cursor-after-v3-boundary',
      observedAtUtc: '2026-08-19T18:40:00.000Z',
      snapshotDigest: digest('v3-boundary-page'),
      orders: [
        {
          observationId: 'observation:pre',
          ebayOrderIdentityKey: preOrder.identityKey,
          sourceCreationDateUtc: '2026-08-19T10:00:00.000Z',
        },
        {
          observationId: 'observation:equal',
          ebayOrderIdentityKey: equalOrder.identityKey,
          sourceCreationDateUtc: '2026-08-19T18:00:00.000Z',
        },
        {
          observationId: 'observation:post',
          ebayOrderIdentityKey: postOrder.identityKey,
          sourceCreationDateUtc: '2026-08-19T18:20:00.000Z',
        },
      ],
      audit: { eventId: 'page:v3-boundary', occurredAtUtc: '2026-08-19T18:40:00.000Z' },
    });

    for (const [identity, tag] of [[preOrder, 'pre'], [equalOrder, 'equal']] as const) {
      // Twice, to prove the denial is permanent, not ordering-dependent.
      for (const suffix of ['first', 'second'] as const) {
        expectMigrationError(() => reopened.createIdempotencyIntent({
          action: 'import_shopify_order',
          sourceIdentityKey: identity.identityKey,
          targetIdentityKey: null,
          desiredStateDigest: digest(`denied-order:${tag}`),
          createdAtUtc: '2026-08-19T18:41:00.000Z',
          audit: {
            eventId: `intent:denied:${tag}:${suffix}`,
            occurredAtUtc: '2026-08-19T18:41:00.000Z',
          },
        }), 'WATERMARK_REQUIRED');
      }
      expect(reopened.isOrderEligible(
        tag === 'pre' ? '2026-08-19T10:00:00.000Z' : '2026-08-19T18:00:00.000Z',
      )).toBe(false);
    }

    const intentKey = reopened.createIdempotencyIntent({
      action: 'import_shopify_order',
      sourceIdentityKey: postOrder.identityKey,
      targetIdentityKey: null,
      desiredStateDigest: digest('normalized-shopify-order-payload'),
      createdAtUtc: '2026-08-19T18:41:01.000Z',
      audit: { eventId: 'intent:order-import', occurredAtUtc: '2026-08-19T18:41:01.000Z' },
    });
    expect(reopened.getIntent(intentKey)).toMatchObject({
      responsibility: 'orderImport',
      action: 'import_shopify_order',
    });
    expect(reopened.getCounts()).toMatchObject({
      order_watermarks: 1,
      order_observations: 3,
      idempotency_intents: 1,
      order_links: 0,
      execution_jobs: 0,
    });
    expect(reopened.verifyAuditChain()).toMatchObject({ valid: true });

    // The projection accepts this state: a production watermark backed by
    // the ProductPipeline single-writer orderImport chain.
    const verified = inspectMigrationStoreReadOnly({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
    });
    expect(verified.status).toBe('verified');
    expect(verified.orders).toMatchObject({
      watermarkUtc: '2026-08-19T18:00:00.000Z',
      watermarkEstablished: true,
      eligibleForCreation: 0,
      historicalBackfillAllowed: false,
    });

    // Once orderImport ownership leaves product_pipeline, the same
    // production watermark makes the projection fail closed.
    reopened.recordOwnershipVersion({
      responsibility: 'orderImport',
      version: 4,
      owner: 'paused',
      singleWriterVerified: true,
      evidenceDigest: digest('break-glass-pause'),
      effectiveAtUtc: '2026-08-19T18:50:00.000Z',
      recordedAtUtc: '2026-08-19T18:50:00.000Z',
      audit: { eventId: 'ownership:orderImport:v4', occurredAtUtc: '2026-08-19T18:50:00.000Z' },
    });
    const invalid = inspectMigrationStoreReadOnly({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
    });
    expect(invalid.status).toBe('invalid');
    expect(invalid.orders).toMatchObject({ watermarkUtc: null, watermarkEstablished: false });
  });
});

describe('current schema keeps mapping and feedback fully denied', () => {
  it('denies their production intents and ownership records', () => {
    const store = createProductionStore();
    const variant = registerVariant(store, 'PPV3-DENIED-001', '55396000563493');
    const listing = registerEbayIdentity(store, 'listing', '147502608418');

    for (const action of ['update_mapping', 'sync_feedback'] as const) {
      expectMigrationError(() => store.createIdempotencyIntent({
        action,
        sourceIdentityKey: variant.identityKey,
        targetIdentityKey: listing.identityKey,
        desiredStateDigest: digest(`denied:${action}`),
        createdAtUtc: '2026-08-19T18:00:05.000Z',
        audit: { eventId: `intent:denied:${action}`, occurredAtUtc: '2026-08-19T18:00:05.000Z' },
      }), 'OWNERSHIP_DENIED');
    }
    for (const responsibility of ['mapping', 'feedback'] as const) {
      expectMigrationError(() => store.recordOwnershipVersion({
        responsibility,
        version: 1,
        owner: 'marketplace_connect',
        singleWriterVerified: true,
        evidenceDigest: digest(`denied-${responsibility}`),
        effectiveAtUtc: '2026-08-19T18:00:06.000Z',
        recordedAtUtc: '2026-08-19T18:00:06.000Z',
        audit: {
          eventId: `ownership:denied:${responsibility}`,
          occurredAtUtc: '2026-08-19T18:00:06.000Z',
        },
      }), 'OWNERSHIP_DENIED');
    }
    expect(store.getCounts()).toMatchObject({
      idempotency_intents: 0,
      ownership_versions: 0,
    });
  });
});

describe('schema v3 upgrade path', () => {
  function createVersionedStoreFile(
    scope: IntegrationScope,
    createdAtUtc: string,
    throughVersion: number,
  ): string {
    const databasePath = path.join(temporaryDirectory(), 'migration-state.sqlite');
    const database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.pragma('recursive_triggers = ON');
    database.pragma('journal_mode = DELETE');
    initializeSchema(database, createdAtUtc, throughVersion);
    const scopeKey = deriveScopeKey(scope);
    const createdEpochMs = Date.parse(createdAtUtc);
    const establish = database.transaction(() => {
      database
        .prepare(
          `INSERT INTO integration_scope (
            singleton, scope_key, shopify_store_domain, ebay_environment,
            ebay_seller_id, ebay_marketplace_id, created_at_utc, created_epoch_ms
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scopeKey,
          scope.shopifyStoreDomain,
          scope.ebayEnvironment,
          scope.ebaySellerId,
          scope.ebayMarketplaceId,
          createdAtUtc,
          createdEpochMs,
        );
      const payloadDigest = sha256Digest({ scopeKey });
      const eventHash = sha256Digest({
        schemaVersion: 1,
        sequence: 1,
        scopeKey,
        eventId: `scope:${scopeKey}`,
        eventType: 'scope.established',
        occurredAtUtc: createdAtUtc,
        payloadDigest,
        previousHash: 'GENESIS',
      });
      database
        .prepare(
          `INSERT INTO audit_events (
            sequence, scope_key, event_id, event_type, occurred_at_utc,
            occurred_epoch_ms, payload_digest, previous_hash, event_hash
          ) VALUES (1, ?, ?, 'scope.established', ?, ?, ?, 'GENESIS', ?)`,
        )
        .run(scopeKey, `scope:${scopeKey}`, createdAtUtc, createdEpochMs, payloadDigest, eventHash);
    });
    establish.immediate();
    database.close();
    fs.chmodSync(databasePath, 0o600);
    return databasePath;
  }

  it('upgrades a verified v2 store to v3 and leaves it fully operable', () => {
    const databasePath = createVersionedStoreFile(
      PRODUCTION_SCOPE,
      '2026-08-19T17:00:00.000Z',
      2,
    );

    // A v2 store fails every ordinary open until an operator upgrades it.
    expect(() => openMigrationStore({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
    })).toThrow(/does not match required version/);

    expect(upgradeMigrationStore({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
      appliedAtUtc: '2026-08-19T18:00:00.000Z',
    })).toEqual({ fromVersion: 2, toVersion: 4 });

    // Upgrading again is an explicit no-op.
    expect(upgradeMigrationStore({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
      appliedAtUtc: '2026-08-19T18:01:00.000Z',
    })).toEqual({ fromVersion: 4, toVersion: 4 });

    const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
    openStores.push(store);
    expect(store.getCounts()).toMatchObject({
      listing_revise_observations: 0,
      target_effect_observations: 0,
      audit_events: 1,
    });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true, recordCount: 1 });

    // The upgraded store enforces the v3 slice: a paused listingEndRelist
    // genesis is recordable, Marketplace Connect never is.
    store.recordOwnershipVersion({
      responsibility: 'listingEndRelist',
      version: 1,
      owner: 'paused',
      singleWriterVerified: true,
      evidenceDigest: digest('listing-end-relist-genesis'),
      effectiveAtUtc: '2026-08-19T18:02:00.000Z',
      recordedAtUtc: '2026-08-19T18:02:00.000Z',
      audit: { eventId: 'ownership:listingEndRelist:v1', occurredAtUtc: '2026-08-19T18:02:00.000Z' },
    });
    expectMigrationError(() => store.recordOwnershipVersion({
      responsibility: 'listingEndRelist',
      version: 2,
      owner: 'marketplace_connect',
      singleWriterVerified: true,
      evidenceDigest: digest('listing-end-relist-mc-denied'),
      effectiveAtUtc: '2026-08-19T18:03:00.000Z',
      recordedAtUtc: '2026-08-19T18:03:00.000Z',
      audit: { eventId: 'ownership:listingEndRelist:v2', occurredAtUtc: '2026-08-19T18:03:00.000Z' },
    }), 'OWNERSHIP_DENIED');
  });

  it('upgrades a verified v1 store directly to v3', () => {
    const databasePath = createVersionedStoreFile(
      PRODUCTION_SCOPE,
      '2026-08-19T17:00:00.000Z',
      1,
    );
    expect(upgradeMigrationStore({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
      appliedAtUtc: '2026-08-19T18:00:00.000Z',
    })).toEqual({ fromVersion: 1, toVersion: 4 });
    const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
    openStores.push(store);
    expect(store.getCounts()).toMatchObject({ target_effect_observations: 0, audit_events: 1 });
  });
});
