/**
 * Schema v4 upgrade regression for populated order-import state.
 *
 * Fulfillment widened one responsibility boundary only. Upgrading a live v3
 * store must therefore preserve the order-import ownership chain, immutable
 * one-hour-clamped watermark, cursor progress, observations, resolutions, and
 * durable order-link deduplication state byte-for-byte at the row level.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  deriveScopeKey,
  openMigrationStore,
  sha256Digest,
  upgradeMigrationStore,
  type Digest,
  type ExternalIdentity,
  type IntegrationScope,
  type MigrationStore,
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

function registerEbayIdentity(
  store: MigrationStore,
  kind: 'listing' | 'order',
  externalId: string,
  occurredAtUtc: string,
): ExternalIdentity {
  return store.registerIdentity({
    platform: 'ebay',
    kind,
    bindingKey: `${kind}:${externalId}`,
    environment: PRODUCTION_SCOPE.ebayEnvironment,
    sellerId: PRODUCTION_SCOPE.ebaySellerId,
    marketplaceId: PRODUCTION_SCOPE.ebayMarketplaceId,
    externalId,
  }, { eventId: `identity:${kind}:${externalId}`, occurredAtUtc });
}

function registerShopifyIdentity(
  store: MigrationStore,
  kind: 'variant' | 'order',
  externalId: string,
  occurredAtUtc: string,
): ExternalIdentity {
  return store.registerIdentity({
    platform: 'shopify',
    kind,
    bindingKey: `${kind}:${externalId}`,
    storeDomain: PRODUCTION_SCOPE.shopifyStoreDomain,
    externalGid: kind === 'variant'
      ? `gid://shopify/ProductVariant/${externalId}`
      : `gid://shopify/Order/${externalId}`,
  }, { eventId: `identity:${kind}:${externalId}`, occurredAtUtc });
}

function createPopulatedV3Store(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-v3-v4-order-state-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'migration-state.sqlite');
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('recursive_triggers = ON');
  database.pragma('journal_mode = DELETE');
  initializeSchema(database, '2026-08-25T16:00:00.000Z', 3);

  const scopeKey = deriveScopeKey(PRODUCTION_SCOPE);
  const ebayOrderIdentityKey = digest('ebay-order:ORDER-SAFE-001');
  const shopifyOrderIdentityKey = digest('shopify-order:6000000000001');
  const productPipelineEvidence = digest('order-import-product-pipeline-single-writer');
  const watermarkEpochMs = Date.parse('2026-08-25T16:30:00.000Z');
  const establishEpochMs = Date.parse('2026-08-25T17:00:00.000Z');
  const observedEpochMs = Date.parse('2026-08-25T17:05:00.000Z');

  const populate = database.transaction(() => {
    database.prepare(
      `INSERT INTO integration_scope (
        singleton, scope_key, shopify_store_domain, ebay_environment,
        ebay_seller_id, ebay_marketplace_id, created_at_utc, created_epoch_ms
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scopeKey,
      PRODUCTION_SCOPE.shopifyStoreDomain,
      PRODUCTION_SCOPE.ebayEnvironment,
      PRODUCTION_SCOPE.ebaySellerId,
      PRODUCTION_SCOPE.ebayMarketplaceId,
      '2026-08-25T16:00:00.000Z',
      Date.parse('2026-08-25T16:00:00.000Z'),
    );

    const genesisPayload = sha256Digest({ scopeKey });
    const genesisHash = sha256Digest({
      schemaVersion: 1,
      sequence: 1,
      scopeKey,
      eventId: `scope:${scopeKey}`,
      eventType: 'scope.established',
      occurredAtUtc: '2026-08-25T16:00:00.000Z',
      payloadDigest: genesisPayload,
      previousHash: 'GENESIS',
    });
    database.prepare(
      `INSERT INTO audit_events (
        sequence, scope_key, event_id, event_type, occurred_at_utc,
        occurred_epoch_ms, payload_digest, previous_hash, event_hash
      ) VALUES (1, ?, ?, 'scope.established', ?, ?, ?, 'GENESIS', ?)`,
    ).run(
      scopeKey,
      `scope:${scopeKey}`,
      '2026-08-25T16:00:00.000Z',
      Date.parse('2026-08-25T16:00:00.000Z'),
      genesisPayload,
      genesisHash,
    );

    const insertOwnership = database.prepare(
      `INSERT INTO ownership_versions (
        ownership_id, scope_key, responsibility, version, owner,
        single_writer_verified, evidence_digest, effective_at_utc,
        effective_epoch_ms, recorded_at_utc, recorded_epoch_ms
      ) VALUES (?, ?, 'orderImport', ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    for (const ownership of [
      {
        id: 'ownership:orderImport:v1', version: 1, owner: 'marketplace_connect',
        evidence: digest('order-import-marketplace-connect-baseline'),
        at: '2026-08-25T16:10:00.000Z',
      },
      {
        id: 'ownership:orderImport:v2', version: 2, owner: 'paused',
        evidence: digest('order-import-marketplace-connect-disabled'),
        at: '2026-08-25T16:20:00.000Z',
      },
      {
        id: 'ownership:orderImport:v3', version: 3, owner: 'product_pipeline',
        evidence: productPipelineEvidence,
        at: '2026-08-25T16:25:00.000Z',
      },
    ] as const) {
      insertOwnership.run(
        ownership.id,
        scopeKey,
        ownership.version,
        ownership.owner,
        ownership.evidence,
        ownership.at,
        Date.parse(ownership.at),
        ownership.at,
        Date.parse(ownership.at),
      );
    }

    database.prepare(
      `INSERT INTO order_watermarks (
        watermark_key, scope_key, source_platform, responsibility,
        ownership_version, ownership_evidence_digest, accepted_evidence_digest,
        event_field, boundary_mode, boundary_exclusive_utc,
        boundary_exclusive_epoch_ms, created_at_utc, created_epoch_ms
      ) VALUES (?, ?, 'ebay', 'orderImport', 3, ?, ?, 'creationDate',
        'exclusive', '2026-08-25T16:30:00.000Z', ?,
        '2026-08-25T17:00:00.000Z', ?)`,
    ).run(
      digest('order-import-watermark'),
      scopeKey,
      productPipelineEvidence,
      digest('accepted-watermark-evidence'),
      watermarkEpochMs,
      establishEpochMs,
    );

    const insertIdentity = database.prepare(
      `INSERT INTO external_identities (
        identity_key, scope_key, platform, resource_kind, binding_key,
        external_id, shopify_store_domain, ebay_environment, ebay_seller_id,
        ebay_marketplace_id, created_at_utc, created_epoch_ms
      ) VALUES (?, ?, ?, 'order', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertIdentity.run(
      ebayOrderIdentityKey,
      scopeKey,
      'ebay',
      'order:ORDER-SAFE-001',
      'ORDER-SAFE-001',
      null,
      PRODUCTION_SCOPE.ebayEnvironment,
      PRODUCTION_SCOPE.ebaySellerId,
      PRODUCTION_SCOPE.ebayMarketplaceId,
      '2026-08-25T17:01:00.000Z',
      Date.parse('2026-08-25T17:01:00.000Z'),
    );
    insertIdentity.run(
      shopifyOrderIdentityKey,
      scopeKey,
      'shopify',
      'order:6000000000001',
      'gid://shopify/Order/6000000000001',
      PRODUCTION_SCOPE.shopifyStoreDomain,
      null,
      null,
      null,
      '2026-08-25T17:02:00.000Z',
      Date.parse('2026-08-25T17:02:00.000Z'),
    );

    database.prepare(
      `INSERT INTO order_pages (
        page_id, scope_key, cursor_before, cursor_before_digest, cursor_after,
        cursor_after_digest, observed_at_utc, observed_epoch_ms, snapshot_digest
      ) VALUES ('page:ORDER-SAFE-001', ?, NULL, NULL, 'cursor-safe-001', ?,
        '2026-08-25T17:05:00.000Z', ?, ?)`,
    ).run(scopeKey, digest('cursor-safe-001'), observedEpochMs, digest('order-page-safe-001'));
    database.prepare(
      `INSERT INTO order_observations (
        observation_id, page_id, scope_key, ebay_order_identity_key,
        source_created_at_utc, source_created_epoch_ms, watermark_epoch_ms,
        eligible_after_watermark, observed_at_utc, observed_epoch_ms
      ) VALUES ('observation:ORDER-SAFE-001', 'page:ORDER-SAFE-001', ?, ?,
        '2026-08-25T16:45:00.000Z', ?, ?, 1,
        '2026-08-25T17:05:00.000Z', ?)`,
    ).run(
      scopeKey,
      ebayOrderIdentityKey,
      Date.parse('2026-08-25T16:45:00.000Z'),
      watermarkEpochMs,
      observedEpochMs,
    );
    database.prepare(
      `INSERT INTO order_links (
        link_id, scope_key, ebay_order_identity_key, shopify_order_identity_key,
        link_kind, idempotency_intent_key, evidence_digest, linked_at_utc,
        linked_epoch_ms
      ) VALUES ('link:ORDER-SAFE-001', ?, ?, ?, 'observed_existing', NULL, ?,
        '2026-08-25T17:06:00.000Z', ?)`,
    ).run(
      scopeKey,
      ebayOrderIdentityKey,
      shopifyOrderIdentityKey,
      digest('existing-order-dedup-evidence'),
      Date.parse('2026-08-25T17:06:00.000Z'),
    );
    database.prepare(
      `INSERT INTO order_observation_resolutions (
        resolution_id, observation_id, disposition, reference_key,
        evidence_digest, resolved_at_utc, resolved_epoch_ms
      ) VALUES ('resolution:ORDER-SAFE-001', 'observation:ORDER-SAFE-001',
        'linked_existing', 'link:ORDER-SAFE-001', ?,
        '2026-08-25T17:07:00.000Z', ?)`,
    ).run(digest('linked-existing-resolution'), Date.parse('2026-08-25T17:07:00.000Z'));
  });
  populate.immediate();
  database.close();
  fs.chmodSync(databasePath, 0o600);
  seedCompletedCeremoniesIntoV3(databasePath, directory);
  return databasePath;
}

function seedCompletedCeremoniesIntoV3(databasePath: string, directory: string): void {
  const sourcePath = path.join(directory, 'current-source.sqlite');
  const source = createMigrationStore({
    databasePath: sourcePath,
    scope: PRODUCTION_SCOPE,
    createdAtUtc: '2026-08-25T16:00:00.000Z',
  });
  const orderOwnershipEvidence = digest('order-import-product-pipeline-single-writer');
  for (const ownership of [
    { version: 1, owner: 'marketplace_connect', evidence: digest('order-import-marketplace-connect-baseline'), at: '2026-08-25T16:10:00.000Z' },
    { version: 2, owner: 'paused', evidence: digest('order-import-marketplace-connect-disabled'), at: '2026-08-25T16:20:00.000Z' },
    { version: 3, owner: 'product_pipeline', evidence: orderOwnershipEvidence, at: '2026-08-25T16:25:00.000Z' },
  ] as const) {
    source.recordOwnershipVersion({
      responsibility: 'orderImport',
      version: ownership.version,
      owner: ownership.owner,
      singleWriterVerified: true,
      evidenceDigest: ownership.evidence,
      effectiveAtUtc: ownership.at,
      recordedAtUtc: ownership.at,
      audit: { eventId: `source:ownership:orderImport:v${ownership.version}`, occurredAtUtc: ownership.at },
    });
  }
  source.establishOrderWatermark({
    boundaryExclusiveUtc: '2026-08-25T16:30:00.000Z',
    ownershipVersion: 3,
    ownershipEvidenceDigest: orderOwnershipEvidence,
    acceptedEvidenceDigest: digest('accepted-watermark-evidence'),
    createdAtUtc: '2026-08-25T17:00:00.000Z',
    audit: { eventId: 'source:watermark', occurredAtUtc: '2026-08-25T17:00:00.000Z' },
  });

  const ebayOrder = registerEbayIdentity(source, 'order', 'ORDER-CEREMONY-002', '2026-08-25T17:10:00.000Z');
  const shopifyOrder = registerShopifyIdentity(source, 'order', '6000000000002', '2026-08-25T17:11:00.000Z');
  source.recordOrderPage({
    pageId: 'page:ORDER-CEREMONY-002',
    cursorBefore: null,
    cursorAfter: 'cursor-ceremony-002',
    observedAtUtc: '2026-08-25T17:12:00.000Z',
    snapshotDigest: digest('page:ORDER-CEREMONY-002'),
    orders: [{
      observationId: 'observation:ORDER-CEREMONY-002',
      ebayOrderIdentityKey: ebayOrder.identityKey,
      sourceCreationDateUtc: '2026-08-25T16:45:00.000Z',
    }],
    audit: { eventId: 'source:page:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:12:00.000Z' },
  });
  const orderIntent = source.createIdempotencyIntent({
    action: 'import_shopify_order',
    sourceIdentityKey: ebayOrder.identityKey,
    targetIdentityKey: null,
    desiredStateDigest: digest('order-import-manifest-002'),
    createdAtUtc: '2026-08-25T17:13:00.000Z',
    audit: { eventId: 'source:intent:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:13:00.000Z' },
  });
  const orderApprovalToken = 'order-ceremony-approval-token-002';
  const orderApprovalEvidence = digest('order-ceremony-approval-evidence-002');
  source.issueActionApproval({
    approvalToken: orderApprovalToken,
    intentKey: orderIntent,
    responsibility: 'orderImport',
    targetIdentityKey: ebayOrder.identityKey,
    ownershipVersion: 3,
    issuedAtUtc: '2026-08-25T17:14:00.000Z',
    expiresAtUtc: '2026-08-25T17:29:00.000Z',
    evidenceDigest: orderApprovalEvidence,
    audit: { eventId: 'source:approval:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:14:00.000Z' },
  });
  source.reserveExecutionJob({
    jobId: 'job:ORDER-CEREMONY-002',
    approvalToken: orderApprovalToken,
    intentKey: orderIntent,
    responsibility: 'orderImport',
    targetIdentityKey: ebayOrder.identityKey,
    ownershipVersion: 3,
    approvalEvidenceDigest: orderApprovalEvidence,
    orderObservationId: 'observation:ORDER-CEREMONY-002',
    reservedAtUtc: '2026-08-25T17:15:00.000Z',
    evidenceDigest: digest('order-reserved-002'),
    audit: { eventId: 'source:reserved:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:15:00.000Z' },
  });
  source.markDispatchingOutcomeUnknown({
    jobId: 'job:ORDER-CEREMONY-002',
    attemptId: 'attempt:ORDER-CEREMONY-002',
    approvalToken: orderApprovalToken,
    approvalEvidenceDigest: orderApprovalEvidence,
    occurredAtUtc: '2026-08-25T17:16:00.000Z',
    evidenceDigest: digest('order-dispatch-002'),
    audit: { eventId: 'source:dispatch:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:16:00.000Z' },
  });
  source.requirePostDispatchReconciliation({
    jobId: 'job:ORDER-CEREMONY-002',
    attemptId: 'attempt:ORDER-CEREMONY-002',
    occurredAtUtc: '2026-08-25T17:17:00.000Z',
    evidenceDigest: digest('order-reconciliation-required-002'),
    audit: { eventId: 'source:reconciliation-required:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:17:00.000Z' },
  });
  const orderReconciliationDigest = digest('order-reconciliation-result-002');
  source.recordReconciliationRun({
    runId: 'reconciliation:ORDER-CEREMONY-002',
    responsibility: 'orderImport',
    targetIdentityKey: ebayOrder.identityKey,
    mode: 'production_canary',
    status: 'passed',
    sourceSnapshotDigest: digest('order-source-snapshot-002'),
    targetSnapshotDigest: digest('order-target-snapshot-002'),
    resultDigest: orderReconciliationDigest,
    authoritative: true,
    authorityEvidenceDigest: digest('order-authority-002'),
    externalWritesObserved: 0,
    startedAtUtc: '2026-08-25T17:18:00.000Z',
    completedAtUtc: '2026-08-25T17:19:00.000Z',
    exceptions: [],
    audit: { eventId: 'source:reconciliation:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:19:00.000Z' },
  });
  source.resolveUnknownAttempt({
    jobId: 'job:ORDER-CEREMONY-002',
    attemptId: 'attempt:ORDER-CEREMONY-002',
    resolution: 'resolved_existing',
    reconciliationRunId: 'reconciliation:ORDER-CEREMONY-002',
    reconciliationResultDigest: orderReconciliationDigest,
    shopifyOrderIdentityKey: shopifyOrder.identityKey,
    orderLinkId: 'link:ORDER-CEREMONY-002',
    reconciledAtUtc: '2026-08-25T17:20:00.000Z',
    audit: { eventId: 'source:resolved:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:20:00.000Z' },
  });
  source.advanceOrderCursor({
    cursorAdvanceId: 'cursor-advance:ORDER-CEREMONY-002',
    pageId: 'page:ORDER-CEREMONY-002',
    ordinal: 1,
    cursorValue: 'cursor-ceremony-002',
    advancedAtUtc: '2026-08-25T17:21:00.000Z',
    audit: { eventId: 'source:cursor:ORDER-CEREMONY-002', occurredAtUtc: '2026-08-25T17:21:00.000Z' },
  });

  const variant = registerShopifyIdentity(source, 'variant', '54881767358755', '2026-08-25T17:30:00.000Z');
  const listing = registerEbayIdentity(source, 'listing', '147232036779', '2026-08-25T17:31:00.000Z');
  for (const ownership of [
    { version: 1, owner: 'marketplace_connect', at: '2026-08-25T17:32:00.000Z' },
    { version: 2, owner: 'paused', at: '2026-08-25T17:33:00.000Z' },
    { version: 3, owner: 'product_pipeline', at: '2026-08-25T17:34:00.000Z' },
  ] as const) {
    source.recordOwnershipVersion({
      responsibility: 'price',
      version: ownership.version,
      owner: ownership.owner,
      singleWriterVerified: true,
      evidenceDigest: digest(`price-owner-v${ownership.version}`),
      effectiveAtUtc: ownership.at,
      recordedAtUtc: ownership.at,
      audit: { eventId: `source:ownership:price:v${ownership.version}`, occurredAtUtc: ownership.at },
    });
  }
  const priceIntent = source.createIdempotencyIntent({
    action: 'update_ebay_price',
    sourceIdentityKey: variant.identityKey,
    targetIdentityKey: listing.identityKey,
    desiredStateDigest: digest('price-manifest'),
    createdAtUtc: '2026-08-25T17:35:00.000Z',
    audit: { eventId: 'source:intent:price', occurredAtUtc: '2026-08-25T17:35:00.000Z' },
  });
  const priceToken = 'price-ceremony-approval-token-001';
  const priceApprovalEvidence = digest('price-approval-evidence');
  source.issueActionApproval({
    approvalToken: priceToken,
    intentKey: priceIntent,
    responsibility: 'price',
    targetIdentityKey: listing.identityKey,
    ownershipVersion: 3,
    issuedAtUtc: '2026-08-25T17:36:00.000Z',
    expiresAtUtc: '2026-08-25T17:51:00.000Z',
    evidenceDigest: priceApprovalEvidence,
    audit: { eventId: 'source:approval:price', occurredAtUtc: '2026-08-25T17:36:00.000Z' },
  });
  source.reserveExecutionJob({
    jobId: 'job:price', approvalToken: priceToken, intentKey: priceIntent,
    responsibility: 'price', targetIdentityKey: listing.identityKey,
    ownershipVersion: 3, approvalEvidenceDigest: priceApprovalEvidence,
    reservedAtUtc: '2026-08-25T17:37:00.000Z', evidenceDigest: digest('price-reserved'),
    audit: { eventId: 'source:reserved:price', occurredAtUtc: '2026-08-25T17:37:00.000Z' },
  });
  source.markDispatchingOutcomeUnknown({
    jobId: 'job:price', attemptId: 'attempt:price', approvalToken: priceToken,
    approvalEvidenceDigest: priceApprovalEvidence, occurredAtUtc: '2026-08-25T17:38:00.000Z',
    evidenceDigest: digest('price-dispatch'),
    audit: { eventId: 'source:dispatch:price', occurredAtUtc: '2026-08-25T17:38:00.000Z' },
  });
  source.requirePostDispatchReconciliation({
    jobId: 'job:price', attemptId: 'attempt:price', occurredAtUtc: '2026-08-25T17:39:00.000Z',
    evidenceDigest: digest('price-reconciliation-required'),
    audit: { eventId: 'source:reconciliation-required:price', occurredAtUtc: '2026-08-25T17:39:00.000Z' },
  });
  const priceResult = digest('price-reconciliation-result');
  source.recordReconciliationRun({
    runId: 'reconciliation:price', responsibility: 'price', targetIdentityKey: listing.identityKey,
    mode: 'production_canary', status: 'passed',
    sourceSnapshotDigest: digest('price-source-snapshot'),
    targetSnapshotDigest: digest('price-target-snapshot'), resultDigest: priceResult,
    authoritative: true, authorityEvidenceDigest: digest('price-authority'),
    externalWritesObserved: 0, startedAtUtc: '2026-08-25T17:40:00.000Z',
    completedAtUtc: '2026-08-25T17:41:00.000Z', exceptions: [],
    targetEffectObservation: {
      observationId: 'target-effect:price', intentKey: priceIntent,
      responsibility: 'price', effect: 'effect_observed',
      observedDigest: digest('price-observed-effect'),
    },
    audit: { eventId: 'source:reconciliation:price', occurredAtUtc: '2026-08-25T17:41:00.000Z' },
  });
  source.resolveUnknownAttempt({
    jobId: 'job:price', attemptId: 'attempt:price', resolution: 'resolved_existing',
    reconciliationRunId: 'reconciliation:price', reconciliationResultDigest: priceResult,
    reconciledAtUtc: '2026-08-25T17:42:00.000Z',
    audit: { eventId: 'source:resolved:price', occurredAtUtc: '2026-08-25T17:42:00.000Z' },
  });
  source.close();

  const target = new Database(databasePath);
  target.pragma('foreign_keys = ON');
  target.pragma('recursive_triggers = ON');
  target.exec(`ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS source`);
  const copy = target.transaction(() => {
    target.exec(`
      INSERT INTO external_identities SELECT * FROM source.external_identities;
      INSERT INTO ownership_versions SELECT * FROM source.ownership_versions WHERE responsibility = 'price';
      INSERT INTO order_pages SELECT * FROM source.order_pages;
      INSERT INTO order_observations SELECT * FROM source.order_observations;
      INSERT INTO idempotency_intents SELECT * FROM source.idempotency_intents;
      INSERT INTO action_approvals SELECT * FROM source.action_approvals;
      INSERT INTO approval_consumptions SELECT * FROM source.approval_consumptions;
      INSERT INTO execution_jobs SELECT * FROM source.execution_jobs;
      INSERT INTO job_events SELECT * FROM source.job_events WHERE sequence <= 2;
      INSERT INTO intent_attempts SELECT * FROM source.intent_attempts;
      INSERT INTO job_events SELECT * FROM source.job_events WHERE sequence = 3;
      INSERT INTO order_observation_resolutions SELECT * FROM source.order_observation_resolutions;
      INSERT INTO reconciliation_runs SELECT * FROM source.reconciliation_runs;
      INSERT INTO target_effect_observations SELECT * FROM source.target_effect_observations;
      INSERT INTO order_links SELECT * FROM source.order_links;
      INSERT INTO attempt_resolutions SELECT * FROM source.attempt_resolutions;
      INSERT INTO job_events SELECT * FROM source.job_events WHERE sequence > 3;
      INSERT INTO cursor_advances SELECT * FROM source.cursor_advances;
      INSERT INTO audit_events SELECT * FROM source.audit_events WHERE sequence > 1;
    `);
  });
  copy.immediate();
  target.exec('DETACH DATABASE source');
  target.close();
}

function snapshotOrderSafetyState(databasePath: string): Record<string, unknown[]> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries([
      'ownership_versions',
      'order_watermarks',
      'external_identities',
      'order_pages',
      'order_observations',
      'idempotency_intents',
      'action_approvals',
      'approval_consumptions',
      'execution_jobs',
      'job_events',
      'intent_attempts',
      'reconciliation_runs',
      'target_effect_observations',
      'order_links',
      'attempt_resolutions',
      'order_observation_resolutions',
      'cursor_advances',
      'audit_events',
    ].map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
  } finally {
    database.close();
  }
}

describe('schema v3 to v4 populated order-state upgrade', () => {
  it('preserves order safety, cursor, and dedup rows while retaining permanent clamps', () => {
    const databasePath = createPopulatedV3Store();
    const before = snapshotOrderSafetyState(databasePath);

    expect(upgradeMigrationStore({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
      appliedAtUtc: '2026-08-25T18:00:00.000Z',
    })).toEqual({ fromVersion: 3, toVersion: 4 });

    expect(snapshotOrderSafetyState(databasePath)).toEqual(before);

    const store = openMigrationStore({ databasePath, expectedScope: PRODUCTION_SCOPE });
    openStores.push(store);
    expect(store.verifyAuditChain()).toEqual({ valid: true, recordCount: 28, headHash: expect.any(String) });
    expect(store.getOrderWatermark()).toMatchObject({
      boundaryMode: 'exclusive',
      boundaryExclusiveUtc: '2026-08-25T16:30:00.000Z',
    });
    expect(store.isOrderEligible('2026-08-25T16:29:59.999Z')).toBe(false);
    expect(store.isOrderEligible('2026-08-25T16:30:00.000Z')).toBe(false);
    expect(store.isOrderEligible('2026-08-25T16:30:00.001Z')).toBe(true);
    expect(store.getCounts()).toMatchObject({
      order_watermarks: 1,
      order_pages: 2,
      order_observations: 2,
      order_observation_resolutions: 2,
      cursor_advances: 1,
      order_links: 2,
      idempotency_intents: 2,
      action_approvals: 2,
      approval_consumptions: 2,
      execution_jobs: 2,
      intent_attempts: 2,
      attempt_resolutions: 2,
      reconciliation_runs: 2,
      target_effect_observations: 1,
    });

    const raw = new Database(databasePath);
    try {
      raw.pragma('foreign_keys = ON');
      raw.pragma('recursive_triggers = ON');
      expect(() => raw.prepare(
        `INSERT INTO order_watermarks SELECT * FROM order_watermarks`,
      ).run()).toThrow(/already established/);
      expect(() => raw.prepare(
        `INSERT INTO order_links SELECT
          'link:ORDER-SAFE-001:duplicate', scope_key, ebay_order_identity_key,
          shopify_order_identity_key, link_kind, idempotency_intent_key,
          evidence_digest, linked_at_utc, linked_epoch_ms
         FROM order_links WHERE link_id = 'link:ORDER-SAFE-001'`,
      ).run()).toThrow();
    } finally {
      raw.close();
    }
  });

  it('leaves the populated v3 store untouched when integrity preflight fails', () => {
    const databasePath = createPopulatedV3Store();
    const corrupt = new Database(databasePath);
    try {
      const head = corrupt.prepare(
        'SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1',
      ).get() as { sequence: number; event_hash: string };
      corrupt.prepare(
        `INSERT INTO audit_events (
          sequence, scope_key, event_id, event_type, occurred_at_utc,
          occurred_epoch_ms, payload_digest, previous_hash, event_hash
        ) VALUES (?, ?, 'corrupt-audit', 'test.corruption',
          '2026-08-25T17:30:00.000Z', ?, ?, ?, ?)`,
      ).run(
        head.sequence + 1,
        deriveScopeKey(PRODUCTION_SCOPE),
        Date.parse('2026-08-25T17:30:00.000Z'),
        digest('corrupt-payload'),
        head.event_hash,
        digest('deliberately-wrong-event-hash'),
      );
    } finally {
      corrupt.close();
    }
    const before = snapshotOrderSafetyState(databasePath);

    expect(() => upgradeMigrationStore({
      databasePath,
      expectedScope: PRODUCTION_SCOPE,
      appliedAtUtc: '2026-08-25T18:00:00.000Z',
    })).toThrow(/audit/i);

    expect(snapshotOrderSafetyState(databasePath)).toEqual(before);
    const unchanged = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(3);
      expect(unchanged.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    } finally {
      unchanged.close();
    }
  });
});
