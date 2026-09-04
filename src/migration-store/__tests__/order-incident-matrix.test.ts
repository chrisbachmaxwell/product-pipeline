import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INTENT_ACTIONS,
  INTENT_ACTION_RESPONSIBILITY,
  WRITER_RESPONSIBILITIES,
  type IntegrationScope,
  type MigrationStore,
  createMigrationStore,
  deriveIdempotencyKey,
  openMigrationStore,
  sha256Digest,
} from '../index.js';

const SANDBOX_SCOPE: IntegrationScope = {
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'sandbox',
  ebaySellerId: 'usedcam-0',
  ebayMarketplaceId: 'EBAY_US',
};

const temporaryDirectories: string[] = [];
const openStores: MigrationStore[] = [];
const baseEpoch = Date.parse('2026-08-11T10:00:00.000Z');
const at = (seconds: number): string => new Date(baseEpoch + seconds * 1000).toISOString();
const digest = (label: string): string => sha256Digest(`fixture:${label}`);
const audit = (eventId: string, seconds: number) => ({ eventId, occurredAtUtc: at(seconds) });

async function fixtureStore(scope = SANDBOX_SCOPE): Promise<{
  directory: string;
  databasePath: string;
  store: MigrationStore;
}> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pp-order-incident-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'migration-state.sqlite');
  const store = createMigrationStore({ databasePath, scope, createdAtUtc: at(0) });
  openStores.push(store);
  return { directory, databasePath, store };
}

type OrderLane = Awaited<ReturnType<typeof fixtureStore>> & {
  oldOrderKey: string;
  newOrderKey: string;
};

async function orderLane(): Promise<OrderLane> {
  const fixture = await fixtureStore();
  const { store } = fixture;
  const baselineEvidence = digest('mc-order-baseline');
  store.recordOwnershipVersion({
    responsibility: 'orderImport',
    version: 1,
    owner: 'marketplace_connect',
    singleWriterVerified: true,
    evidenceDigest: baselineEvidence,
    effectiveAtUtc: at(1),
    recordedAtUtc: at(1),
    audit: audit('ownership-order-v1', 1),
  });
  store.establishOrderWatermark({
    boundaryExclusiveUtc: at(2),
    ownershipVersion: 1,
    ownershipEvidenceDigest: baselineEvidence,
    acceptedEvidenceDigest: digest('accepted-cutoff'),
    createdAtUtc: at(3),
    audit: audit('watermark-order-import', 3),
  });
  const oldOrder = store.registerIdentity(
    {
      platform: 'ebay',
      kind: 'order',
      bindingKey: 'ebay-order-old',
      environment: 'sandbox',
      sellerId: 'usedcam-0',
      marketplaceId: 'EBAY_US',
      externalId: 'ORDER-OLD',
    },
    audit('identity-order-old', 4),
  );
  const newOrder = store.registerIdentity(
    {
      platform: 'ebay',
      kind: 'order',
      bindingKey: 'ebay-order-new',
      environment: 'sandbox',
      sellerId: 'usedcam-0',
      marketplaceId: 'EBAY_US',
      externalId: 'ORDER-NEW',
    },
    audit('identity-order-new', 5),
  );
  store.recordOrderPage({
    pageId: 'page-1',
    cursorBefore: null,
    cursorAfter: 'cursor-1',
    observedAtUtc: at(10),
    snapshotDigest: digest('page-1'),
    orders: [
      {
        observationId: 'observation-old',
        ebayOrderIdentityKey: oldOrder.identityKey,
        sourceCreationDateUtc: at(2),
      },
      {
        observationId: 'observation-new',
        ebayOrderIdentityKey: newOrder.identityKey,
        sourceCreationDateUtc: at(4),
      },
    ],
    audit: audit('observe-page-1', 10),
  });
  store.resolveOrderObservation({
    resolutionId: 'resolution-old',
    observationId: 'observation-old',
    disposition: 'excluded_by_watermark',
    evidenceDigest: digest('old-excluded'),
    resolvedAtUtc: at(11),
    audit: audit('resolve-old', 11),
  });
  store.recordOwnershipVersion({
    responsibility: 'orderImport',
    version: 2,
    owner: 'paused',
    singleWriterVerified: true,
    evidenceDigest: digest('order-paused'),
    effectiveAtUtc: at(12),
    recordedAtUtc: at(12),
    audit: audit('ownership-order-v2', 12),
  });
  store.recordOwnershipVersion({
    responsibility: 'orderImport',
    version: 3,
    owner: 'product_pipeline',
    singleWriterVerified: true,
    evidenceDigest: digest('order-pp'),
    effectiveAtUtc: at(13),
    recordedAtUtc: at(13),
    audit: audit('ownership-order-v3', 13),
  });
  return {
    ...fixture,
    oldOrderKey: oldOrder.identityKey,
    newOrderKey: newOrder.identityKey,
  };
}

function createOrderIntent(lane: OrderLane): string {
  return lane.store.createIdempotencyIntent({
    action: 'import_shopify_order',
    sourceIdentityKey: lane.newOrderKey,
    desiredStateDigest: digest('order-payload-a'),
    createdAtUtc: at(14),
    audit: audit('intent-order-new', 14),
  });
}

function approveOrder(lane: OrderLane, intentKey: string, expiresAtSeconds = 30): {
  token: string;
  evidence: string;
} {
  const token = 'approval-token-order-new-0001';
  const evidence = digest('approval-order-new');
  lane.store.issueActionApproval({
    approvalToken: token,
    intentKey,
    responsibility: 'orderImport',
    targetIdentityKey: lane.newOrderKey,
    ownershipVersion: 3,
    issuedAtUtc: at(15),
    expiresAtUtc: at(expiresAtSeconds),
    evidenceDigest: evidence,
    audit: audit('approval-order-new', 15),
  });
  return { token, evidence };
}

function reserveOrder(
  lane: OrderLane,
  intentKey: string,
  approval: { token: string; evidence: string },
): void {
  lane.store.reserveExecutionJob({
    jobId: 'job-order-new',
    approvalToken: approval.token,
    approvalEvidenceDigest: approval.evidence,
    intentKey,
    responsibility: 'orderImport',
    targetIdentityKey: lane.newOrderKey,
    ownershipVersion: 3,
    orderObservationId: 'observation-new',
    reservedAtUtc: at(16),
    evidenceDigest: digest('reservation-order-new'),
    audit: audit('reserve-order-new', 16),
  });
}

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by an adversarial raw-connection test.
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fsPromises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('duplicate-order incident safeguards', () => {
  it('uses one exhaustive canonical writer responsibility mapping', () => {
    expect(Object.keys(INTENT_ACTION_RESPONSIBILITY).sort()).toEqual([...INTENT_ACTIONS].sort());
    expect(new Set(Object.values(INTENT_ACTION_RESPONSIBILITY)))
      .toEqual(new Set(WRITER_RESPONSIBILITIES));
    expect(INTENT_ACTION_RESPONSIBILITY.import_shopify_order).toBe('orderImport');
  });

  it('requires the immutable creationDate cutoff and never admits history at or before it', async () => {
    const lane = await orderLane();
    expect(lane.store.getOrderWatermark()).toMatchObject({
      eventField: 'creationDate',
      boundaryMode: 'exclusive',
      boundaryExclusiveUtc: at(2),
    });
    expect(lane.store.isOrderEligible(at(2))).toBe(false);
    expect(lane.store.isOrderEligible(at(2)!.replace('.000Z', '.001Z'))).toBe(true);
    expect(() =>
      lane.store.createIdempotencyIntent({
        action: 'import_shopify_order',
        sourceIdentityKey: lane.oldOrderKey,
        desiredStateDigest: digest('historical'),
        createdAtUtc: at(14),
        audit: audit('intent-historical-denied', 14),
      }),
    ).toThrow(/eligible unresolved post-watermark/i);
    expect(() =>
      lane.store.advanceOrderCursor({
        cursorAdvanceId: 'advance-too-early',
        pageId: 'page-1',
        ordinal: 1,
        cursorValue: 'cursor-1',
        advancedAtUtc: at(14),
        audit: audit('advance-too-early', 14),
      }),
    ).toThrow(/every page observation/i);
  });

  it('makes one order intent natural and reserves approval plus observation exactly once', async () => {
    const lane = await orderLane();
    const keyA = deriveIdempotencyKey({
      scopeKey: lane.store.scopeKey,
      action: 'import_shopify_order',
      sourceIdentityKey: lane.newOrderKey,
      desiredStateDigest: digest('payload-a'),
    });
    const keyB = deriveIdempotencyKey({
      scopeKey: lane.store.scopeKey,
      action: 'import_shopify_order',
      sourceIdentityKey: lane.newOrderKey,
      desiredStateDigest: digest('payload-b'),
    });
    expect(keyA).toBe(keyB);
    // An order import has exactly one occasion, forever. Alignment intents
    // gained an occasion so a repeated price/quantity transition can dispatch
    // again; applying that to an order import would mean a duplicate order,
    // so the derivation refuses it outright rather than trusting callers.
    expect(() => deriveIdempotencyKey({
      scopeKey: lane.store.scopeKey,
      action: 'import_shopify_order',
      sourceIdentityKey: lane.newOrderKey,
      desiredStateDigest: digest('payload-a'),
      occasion: 1,
    })).toThrow(/exactly one occasion/i);
    // Occasion 0 is the historical shape and must hash identically, or every
    // intent key already recorded in the live store would be orphaned.
    expect(deriveIdempotencyKey({
      scopeKey: lane.store.scopeKey,
      action: 'import_shopify_order',
      sourceIdentityKey: lane.newOrderKey,
      desiredStateDigest: digest('payload-a'),
      occasion: 0,
    })).toBe(keyA);
    const intentKey = createOrderIntent(lane);
    expect(intentKey).toBe(keyA);
    expect(() =>
      lane.store.createIdempotencyIntent({
        action: 'import_shopify_order',
        sourceIdentityKey: lane.newOrderKey,
        desiredStateDigest: digest('payload-b'),
        createdAtUtc: at(15),
        audit: audit('intent-order-replay', 15),
      }),
    ).toThrow(/durable constraints/i);

    const approval = approveOrder(lane, intentKey);
    expect(() =>
      lane.store.reserveExecutionJob({
        jobId: 'job-wrong-evidence',
        approvalToken: approval.token,
        approvalEvidenceDigest: digest('wrong-approval-evidence'),
        intentKey,
        responsibility: 'orderImport',
        targetIdentityKey: lane.newOrderKey,
        ownershipVersion: 3,
        orderObservationId: 'observation-new',
        reservedAtUtc: at(16),
        evidenceDigest: digest('wrong-reservation'),
        audit: audit('reserve-wrong-evidence', 16),
      }),
    ).toThrow(/does not exactly match/i);
    reserveOrder(lane, intentKey, approval);
    expect(lane.store.getCounts()).toMatchObject({
      approval_consumptions: 1,
      execution_jobs: 1,
      order_observation_resolutions: 2,
    });
    expect(() => reserveOrder(lane, intentKey, approval)).toThrow(
      /historical, resolved, linked|durable constraints/i,
    );

    const watermarkBefore = lane.store.getOrderWatermark();
    lane.store.advanceOrderCursor({
      cursorAdvanceId: 'advance-page-1',
      pageId: 'page-1',
      ordinal: 1,
      cursorValue: 'cursor-1',
      advancedAtUtc: at(17),
      audit: audit('advance-page-1', 17),
    });
    expect(lane.store.getOrderWatermark()).toEqual(watermarkBefore);
  });

  it('denies dispatch when Marketplace Connect linkage appears after reservation', async () => {
    const lane = await orderLane();
    const intentKey = createOrderIntent(lane);
    const approval = approveOrder(lane, intentKey);
    reserveOrder(lane, intentKey, approval);
    const shopifyOrder = lane.store.registerIdentity(
      {
        platform: 'shopify',
        kind: 'order',
        bindingKey: 'shopify-order-existing',
        storeDomain: 'usedcameragear.myshopify.com',
        externalGid: 'gid://shopify/Order/9001',
      },
      audit('identity-shopify-existing', 17),
    );
    lane.store.linkObservedExistingOrder({
      linkId: 'link-delayed-incumbent',
      ebayOrderIdentityKey: lane.newOrderKey,
      shopifyOrderIdentityKey: shopifyOrder.identityKey,
      evidenceDigest: digest('delayed-incumbent-link'),
      linkedAtUtc: at(18),
      audit: audit('link-delayed-incumbent', 18),
    });
    expect(() =>
      lane.store.markDispatchingOutcomeUnknown({
        jobId: 'job-order-new',
        attemptId: 'attempt-order-new',
        approvalToken: approval.token,
        approvalEvidenceDigest: approval.evidence,
        occurredAtUtc: at(19),
        evidenceDigest: digest('dispatch-denied-link'),
        audit: audit('dispatch-denied-link', 19),
      }),
    ).toThrow(/already linked/i);
    expect(lane.store.getJobStatus('job-order-new')).toMatchObject({ state: 'reserved' });

    lane.store.close();
    const raw = new Database(lane.databasePath);
    try {
      expect(raw.pragma('recursive_triggers', { simple: true })).toBe(0);
      expect(() =>
        raw.prepare(
          `INSERT INTO job_events (
            job_event_id, job_id, sequence, from_state, to_state, evidence_digest,
            occurred_at_utc, occurred_epoch_ms
          ) VALUES (?, 'job-order-new', 2, 'reserved', 'dispatching', ?, ?, ?)`,
        ).run('raw-dispatch', digest('raw-dispatch'), at(19), Date.parse(at(19))),
      ).toThrow(/already linked|dispatch lacks authority/i);
    } finally {
      raw.close();
    }
  });

  it('persists outcome_unknown before dispatch and requires fresh authoritative reconciliation', async () => {
    const lane = await orderLane();
    const intentKey = createOrderIntent(lane);
    const approval = approveOrder(lane, intentKey);
    reserveOrder(lane, intentKey, approval);
    lane.store.markDispatchingOutcomeUnknown({
      jobId: 'job-order-new',
      attemptId: 'attempt-order-new',
      approvalToken: approval.token,
      approvalEvidenceDigest: approval.evidence,
      occurredAtUtc: at(17),
      evidenceDigest: digest('dispatch-marker'),
      audit: audit('dispatch-marker', 17),
    });
    expect(lane.store.getJobStatus('job-order-new')).toMatchObject({
      state: 'dispatching',
      attemptOutcome: 'outcome_unknown',
    });
    lane.store.requirePostDispatchReconciliation({
      jobId: 'job-order-new',
      attemptId: 'attempt-order-new',
      occurredAtUtc: at(18),
      evidenceDigest: digest('reconciliation-required'),
      audit: audit('reconciliation-required', 18),
    });

    const staleResult = digest('stale-reconciliation');
    lane.store.recordReconciliationRun({
      runId: 'recon-stale',
      responsibility: 'orderImport',
      targetIdentityKey: lane.newOrderKey,
      mode: 'test_lane',
      status: 'passed',
      sourceSnapshotDigest: digest('stale-source'),
      targetSnapshotDigest: digest('stale-target'),
      resultDigest: staleResult,
      authoritative: true,
      authorityEvidenceDigest: digest('stale-authority'),
      externalWritesObserved: 0,
      startedAtUtc: at(17),
      completedAtUtc: at(19),
      exceptions: [],
      audit: audit('recon-stale', 19),
    });
    expect(() =>
      lane.store.resolveUnknownAttempt({
        jobId: 'job-order-new',
        attemptId: 'attempt-order-new',
        resolution: 'confirmed_missing',
        reconciliationRunId: 'recon-stale',
        reconciliationResultDigest: staleResult,
        reconciledAtUtc: at(20),
        audit: audit('resolve-stale-denied', 20),
      }),
    ).toThrow(/exact passed authoritative/i);

    const freshResult = digest('fresh-reconciliation');
    lane.store.recordReconciliationRun({
      runId: 'recon-fresh',
      responsibility: 'orderImport',
      targetIdentityKey: lane.newOrderKey,
      mode: 'test_lane',
      status: 'passed',
      sourceSnapshotDigest: digest('fresh-source'),
      targetSnapshotDigest: digest('fresh-target'),
      resultDigest: freshResult,
      authoritative: true,
      authorityEvidenceDigest: digest('fresh-authority'),
      externalWritesObserved: 0,
      startedAtUtc: at(20),
      completedAtUtc: at(21),
      exceptions: [],
      audit: audit('recon-fresh', 21),
    });
    lane.store.resolveUnknownAttempt({
      jobId: 'job-order-new',
      attemptId: 'attempt-order-new',
      resolution: 'confirmed_missing',
      reconciliationRunId: 'recon-fresh',
      reconciliationResultDigest: freshResult,
      reconciledAtUtc: at(22),
      audit: audit('resolve-fresh', 22),
    });
    expect(lane.store.getJobStatus('job-order-new')).toMatchObject({
      state: 'confirmed_missing',
      attemptOutcome: 'outcome_unknown',
    });
    expect(() =>
      lane.store.markDispatchingOutcomeUnknown({
        jobId: 'job-order-new',
        attemptId: 'attempt-retry-denied',
        approvalToken: approval.token,
        approvalEvidenceDigest: approval.evidence,
        occurredAtUtc: at(23),
        evidenceDigest: digest('retry-denied'),
        audit: audit('retry-denied', 23),
      }),
    ).toThrow(/reserved job/i);
  });

  it('blocks raw replacement on alternate unique order identity and natural intent keys', async () => {
    const lane = await orderLane();
    const intentKey = createOrderIntent(lane);
    const shopifyOrder = lane.store.registerIdentity(
      {
        platform: 'shopify',
        kind: 'order',
        bindingKey: 'shopify-order-one',
        storeDomain: 'usedcameragear.myshopify.com',
        externalGid: 'gid://shopify/Order/9101',
      },
      audit('identity-shopify-one', 15),
    );
    lane.store.linkObservedExistingOrder({
      linkId: 'link-one',
      ebayOrderIdentityKey: lane.oldOrderKey,
      shopifyOrderIdentityKey: shopifyOrder.identityKey,
      evidenceDigest: digest('link-one'),
      linkedAtUtc: at(16),
      audit: audit('link-one', 16),
    });
    lane.store.close();
    const raw = new Database(lane.databasePath);
    try {
      expect(raw.pragma('recursive_triggers', { simple: true })).toBe(0);
      expect(() =>
        raw.prepare(
          `INSERT OR REPLACE INTO order_links (
            link_id, scope_key, ebay_order_identity_key, shopify_order_identity_key,
            link_kind, idempotency_intent_key, evidence_digest, linked_at_utc, linked_epoch_ms
          ) SELECT ?, scope_key, ?, shopify_order_identity_key, link_kind,
              idempotency_intent_key, evidence_digest, linked_at_utc, linked_epoch_ms
            FROM order_links WHERE link_id = 'link-one'`,
        ).run('link-two', lane.newOrderKey),
      ).toThrow(/replacement denied/i);
      expect(() =>
        raw.prepare(
          `INSERT OR REPLACE INTO idempotency_intents (
            intent_key, scope_key, responsibility, action, source_identity_key,
            target_identity_key, approval_target_identity_key, desired_state_digest,
            created_at_utc, created_epoch_ms
          ) SELECT ?, scope_key, responsibility, action, source_identity_key,
              target_identity_key, approval_target_identity_key, ?, created_at_utc, created_epoch_ms
            FROM idempotency_intents WHERE intent_key = ?`,
        ).run(digest('alternate-intent-key'), digest('alternate-state'), intentKey),
      ).toThrow(/replacement denied/i);
      expect(() =>
        raw.prepare('INSERT OR REPLACE INTO audit_events SELECT * FROM audit_events WHERE sequence = 1')
          .run(),
      ).toThrow(/replacement denied/i);
    } finally {
      raw.close();
    }
    expect(fs.statSync(lane.databasePath).mode & 0o777).toBe(0o600);
  });
});

/**
 * Alignment is a RECURRING action, unlike an order import. Keying its intent
 * on the desired state alone let the first 2 -> 3 consume that transition
 * forever, so the listing silently stopped syncing the next time stock
 * repeated a value -- the normal pattern for used stock that sells and comes
 * back. These pin the key algebra that fix depends on.
 */
describe('alignment intent occasions', () => {
  const scopeKey = digest('scope');
  const sourceIdentityKey = digest('source');
  const targetIdentityKey = digest('target');
  const desiredStateDigest = digest('desired');
  const keyFor = (occasion?: number) => deriveIdempotencyKey({
    scopeKey,
    action: 'update_ebay_inventory',
    sourceIdentityKey,
    targetIdentityKey,
    desiredStateDigest,
    occasion,
  });

  it('leaves occasion 0 byte-identical to the historical key', () => {
    expect(keyFor(0)).toBe(keyFor(undefined));
  });

  it('gives each later occasion of one transition a distinct key', () => {
    const keys = [keyFor(0), keyFor(1), keyFor(2), keyFor(3)];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses an occasion that is not a whole count', () => {
    expect(() => keyFor(-1)).toThrow(/occasion/i);
    expect(() => keyFor(1.5)).toThrow(/occasion/i);
    expect(() => keyFor(Number.NaN)).toThrow(/occasion/i);
  });
});
