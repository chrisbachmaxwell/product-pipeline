import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationStore,
  MigrationStoreError,
  openMigrationStoreReadOnly,
  sha256Digest,
  type Digest,
  type ExternalIdentity,
  type IntegrationScope,
  type MigrationStore,
} from '../index.js';

const SCOPE: IntegrationScope = {
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'sandbox',
  ebaySellerId: 'usedcam-0',
  ebayMarketplaceId: 'EBAY_US',
};

const WATERMARK_UTC = '2026-08-11T20:00:00.000Z';
const temporaryDirectories: string[] = [];

function temporaryStorePath(): { directory: string; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-store-integrity-'));
  temporaryDirectories.push(directory);
  return { directory, databasePath: path.join(directory, 'migration-state.sqlite') };
}

function fileDigest(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createStore(databasePath: string): MigrationStore {
  return createMigrationStore({
    databasePath,
    scope: SCOPE,
    createdAtUtc: WATERMARK_UTC,
  });
}

function recordMarketplaceConnectBaseline(store: MigrationStore): Digest {
  const evidenceDigest = sha256Digest('accepted-marketplace-connect-order-baseline');
  store.recordOwnershipVersion({
    responsibility: 'orderImport',
    version: 1,
    owner: 'marketplace_connect',
    singleWriterVerified: true,
    evidenceDigest,
    effectiveAtUtc: '2026-08-11T20:00:01.000Z',
    recordedAtUtc: '2026-08-11T20:00:01.000Z',
    audit: { eventId: 'ownership-order-v1', occurredAtUtc: '2026-08-11T20:00:01.000Z' },
  });
  return evidenceDigest;
}

function establishWatermark(store: MigrationStore, ownershipEvidenceDigest: Digest): void {
  store.establishOrderWatermark({
    boundaryExclusiveUtc: WATERMARK_UTC,
    ownershipVersion: 1,
    ownershipEvidenceDigest,
    acceptedEvidenceDigest: sha256Digest('accepted-fixed-creation-date-cutover'),
    createdAtUtc: '2026-08-11T20:00:02.000Z',
    audit: { eventId: 'watermark-fixed', occurredAtUtc: '2026-08-11T20:00:02.000Z' },
  });
}

function registerEbayOrder(
  store: MigrationStore,
  suffix: string,
  occurredAtUtc: string,
): ExternalIdentity {
  return store.registerIdentity({
    platform: 'ebay',
    kind: 'order',
    bindingKey: `ebay-order-${suffix}`,
    environment: 'sandbox',
    sellerId: SCOPE.ebaySellerId,
    marketplaceId: SCOPE.ebayMarketplaceId,
    externalId: `EBAY-ORDER-${suffix}`,
  }, { eventId: `identity-ebay-${suffix}`, occurredAtUtc });
}

function registerShopifyOrder(
  store: MigrationStore,
  suffix: string,
  occurredAtUtc: string,
): ExternalIdentity {
  return store.registerIdentity({
    platform: 'shopify',
    kind: 'order',
    bindingKey: `shopify-order-${suffix}`,
    storeDomain: SCOPE.shopifyStoreDomain,
    externalGid: `gid://shopify/Order/${suffix}`,
  }, { eventId: `identity-shopify-${suffix}`, occurredAtUtc });
}

function seedEligibleOrderIntent(store: MigrationStore): {
  source: ExternalIdentity;
  observationId: string;
  intentKey: Digest;
} {
  const source = registerEbayOrder(store, 'ELIGIBLE', '2026-08-11T20:00:03.000Z');
  store.recordOrderPage({
    pageId: 'page-eligible-1',
    cursorBefore: null,
    cursorAfter: 'cursor-after-eligible',
    observedAtUtc: '2026-08-11T20:00:04.000Z',
    snapshotDigest: sha256Digest('eligible-page-snapshot'),
    orders: [{
      observationId: 'observation-eligible-1',
      ebayOrderIdentityKey: source.identityKey,
      sourceCreationDateUtc: '2026-08-11T20:00:00.001Z',
    }],
    audit: { eventId: 'page-eligible-observed', occurredAtUtc: '2026-08-11T20:00:04.000Z' },
  });
  const intentKey = store.createIdempotencyIntent({
    action: 'import_shopify_order',
    sourceIdentityKey: source.identityKey,
    desiredStateDigest: sha256Digest('desired-shopify-order-v1'),
    createdAtUtc: '2026-08-11T20:00:05.000Z',
    audit: { eventId: 'intent-order-eligible', occurredAtUtc: '2026-08-11T20:00:05.000Z' },
  });
  return { source, observationId: 'observation-eligible-1', intentKey };
}

function transferOrderOwnershipToProductPipeline(store: MigrationStore): Digest {
  store.recordOwnershipVersion({
    responsibility: 'orderImport',
    version: 2,
    owner: 'paused',
    singleWriterVerified: true,
    evidenceDigest: sha256Digest('order-writers-paused'),
    effectiveAtUtc: '2026-08-11T20:00:06.000Z',
    recordedAtUtc: '2026-08-11T20:00:06.000Z',
    audit: { eventId: 'ownership-order-v2', occurredAtUtc: '2026-08-11T20:00:06.000Z' },
  });
  const evidenceDigest = sha256Digest('product-pipeline-only-order-writer');
  store.recordOwnershipVersion({
    responsibility: 'orderImport',
    version: 3,
    owner: 'product_pipeline',
    singleWriterVerified: true,
    evidenceDigest,
    effectiveAtUtc: '2026-08-11T20:00:07.000Z',
    recordedAtUtc: '2026-08-11T20:00:07.000Z',
    audit: { eventId: 'ownership-order-v3', occurredAtUtc: '2026-08-11T20:00:07.000Z' },
  });
  return evidenceDigest;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('migration-store direct SQL and integrity regressions', () => {
  it('keeps the fixed watermark immutable and treats boundary equality as permanently ineligible', () => {
    const { databasePath } = temporaryStorePath();
    const store = createStore(databasePath);
    const baselineEvidence = recordMarketplaceConnectBaseline(store);
    establishWatermark(store, baselineEvidence);

    const equalOrder = registerEbayOrder(store, 'EQUAL', '2026-08-11T20:00:03.000Z');
    const laterOrder = registerEbayOrder(store, 'LATER', '2026-08-11T20:00:04.000Z');
    store.recordOrderPage({
      pageId: 'page-watermark-boundary',
      cursorBefore: null,
      cursorAfter: 'cursor-watermark-boundary',
      observedAtUtc: '2026-08-11T20:00:05.000Z',
      snapshotDigest: sha256Digest('watermark-boundary-page'),
      orders: [
        {
          observationId: 'observation-watermark-equal',
          ebayOrderIdentityKey: equalOrder.identityKey,
          sourceCreationDateUtc: WATERMARK_UTC,
        },
        {
          observationId: 'observation-watermark-later',
          ebayOrderIdentityKey: laterOrder.identityKey,
          sourceCreationDateUtc: '2026-08-11T20:00:00.001Z',
        },
      ],
      audit: { eventId: 'page-watermark-boundary', occurredAtUtc: '2026-08-11T20:00:05.000Z' },
    });

    expect(store.isOrderEligible(WATERMARK_UTC)).toBe(false);
    expect(store.isOrderEligible('2026-08-11T20:00:00.001Z')).toBe(true);
    expect(() => store.createIdempotencyIntent({
      action: 'import_shopify_order',
      sourceIdentityKey: equalOrder.identityKey,
      desiredStateDigest: sha256Digest('must-never-import-equality'),
      createdAtUtc: '2026-08-11T20:00:06.000Z',
      audit: { eventId: 'intent-watermark-equal-denied', occurredAtUtc: '2026-08-11T20:00:06.000Z' },
    })).toThrow(/eligible unresolved post-watermark observation/);
    expect(store.createIdempotencyIntent({
      action: 'import_shopify_order',
      sourceIdentityKey: laterOrder.identityKey,
      desiredStateDigest: sha256Digest('strictly-later-order'),
      createdAtUtc: '2026-08-11T20:00:06.000Z',
      audit: { eventId: 'intent-watermark-later', occurredAtUtc: '2026-08-11T20:00:06.000Z' },
    })).toMatch(/^sha256:[0-9a-f]{64}$/);
    store.close();

    const raw = new Database(databasePath);
    try {
      raw.pragma('recursive_triggers = OFF');
      const before = raw.prepare('SELECT * FROM order_watermarks').get();
      expect(() => raw.prepare(
        'UPDATE order_watermarks SET boundary_exclusive_epoch_ms = boundary_exclusive_epoch_ms + 1',
      ).run()).toThrow(/append-only/);
      expect(() => raw.prepare('DELETE FROM order_watermarks').run()).toThrow(/append-only/);
      expect(() => raw.prepare(
        'INSERT OR REPLACE INTO order_watermarks SELECT * FROM order_watermarks',
      ).run()).toThrow(/already established|replacement denied/);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM order_watermarks').get()).toEqual({ count: 1 });
      expect(raw.prepare('SELECT * FROM order_watermarks').get()).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it('rejects replace-style collisions on alternate identity, link, intent, job, and audit keys', () => {
    const { databasePath } = temporaryStorePath();
    const store = createStore(databasePath);
    const baselineEvidence = recordMarketplaceConnectBaseline(store);
    establishWatermark(store, baselineEvidence);
    const { source, observationId, intentKey } = seedEligibleOrderIntent(store);
    transferOrderOwnershipToProductPipeline(store);
    const otherEbayOrder = registerEbayOrder(store, 'OTHER', '2026-08-11T20:00:08.000Z');
    const shopifyOrder = registerShopifyOrder(store, '1001', '2026-08-11T20:00:09.000Z');
    const approvalToken = 'one-action-order-approval-token';
    const approvalEvidenceDigest = sha256Digest('reviewed-order-approval-evidence');
    store.issueActionApproval({
      approvalToken,
      intentKey,
      responsibility: 'orderImport',
      targetIdentityKey: source.identityKey,
      ownershipVersion: 3,
      issuedAtUtc: '2026-08-11T20:00:10.000Z',
      expiresAtUtc: '2026-08-11T20:10:10.000Z',
      evidenceDigest: approvalEvidenceDigest,
      audit: { eventId: 'approval-order-one-action', occurredAtUtc: '2026-08-11T20:00:10.000Z' },
    });
    store.reserveExecutionJob({
      jobId: 'job-order-one',
      approvalToken,
      intentKey,
      responsibility: 'orderImport',
      targetIdentityKey: source.identityKey,
      ownershipVersion: 3,
      approvalEvidenceDigest,
      orderObservationId: observationId,
      reservedAtUtc: '2026-08-11T20:00:11.000Z',
      evidenceDigest: sha256Digest('order-job-reservation'),
      audit: { eventId: 'job-order-one-reserved', occurredAtUtc: '2026-08-11T20:00:11.000Z' },
    });
    store.linkObservedExistingOrder({
      linkId: 'observed-link-one',
      ebayOrderIdentityKey: otherEbayOrder.identityKey,
      shopifyOrderIdentityKey: shopifyOrder.identityKey,
      evidenceDigest: sha256Digest('authoritative-existing-order-link'),
      linkedAtUtc: '2026-08-11T20:00:12.000Z',
      audit: { eventId: 'link-existing-one', occurredAtUtc: '2026-08-11T20:00:12.000Z' },
    });
    store.close();

    const raw = new Database(databasePath);
    try {
      raw.pragma('recursive_triggers = OFF');
      raw.pragma('foreign_keys = OFF');
      const countsBefore = {
        identities: (raw.prepare('SELECT COUNT(*) AS count FROM external_identities').get() as { count: number }).count,
        links: (raw.prepare('SELECT COUNT(*) AS count FROM order_links').get() as { count: number }).count,
        intents: (raw.prepare('SELECT COUNT(*) AS count FROM idempotency_intents').get() as { count: number }).count,
        jobs: (raw.prepare('SELECT COUNT(*) AS count FROM execution_jobs').get() as { count: number }).count,
        audit: (raw.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count,
      };

      expect(() => raw.prepare(
        `INSERT OR REPLACE INTO external_identities
         SELECT ?, scope_key, platform, resource_kind, binding_key, external_id,
           shopify_store_domain, ebay_environment, ebay_seller_id, ebay_marketplace_id,
           created_at_utc, created_epoch_ms
         FROM external_identities WHERE identity_key = ?`,
      ).run(sha256Digest('replacement-external-identity'), otherEbayOrder.identityKey))
        .toThrow(/replacement denied/);

      expect(() => raw.prepare(
        `INSERT OR REPLACE INTO order_links (
           link_id, scope_key, ebay_order_identity_key, shopify_order_identity_key,
           link_kind, idempotency_intent_key, evidence_digest, linked_at_utc, linked_epoch_ms
         ) SELECT 'replacement-link', scope_key, ?, shopify_order_identity_key,
           'observed_existing', NULL, evidence_digest, linked_at_utc, linked_epoch_ms
         FROM order_links WHERE link_id = 'observed-link-one'`,
      ).run(source.identityKey)).toThrow(/replacement denied/);

      raw.prepare(
        `INSERT INTO order_pages (
           page_id, scope_key, cursor_before, cursor_before_digest, cursor_after,
           cursor_after_digest, observed_at_utc, observed_epoch_ms, snapshot_digest
         ) VALUES ('raw-repeat-page', ?, NULL, NULL, 'raw-repeat-cursor', ?, ?, ?, ?)`,
      ).run(
        source.scopeKey,
        sha256Digest('raw-repeat-cursor'),
        '2026-08-11T20:00:13.000Z',
        Date.parse('2026-08-11T20:00:13.000Z'),
        sha256Digest('raw-repeat-page'),
      );
      raw.prepare(
        `INSERT INTO order_observations (
           observation_id, page_id, scope_key, ebay_order_identity_key,
           source_created_at_utc, source_created_epoch_ms, watermark_epoch_ms,
           eligible_after_watermark, observed_at_utc, observed_epoch_ms
         ) VALUES ('raw-repeat-observation', 'raw-repeat-page', ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        source.scopeKey,
        source.identityKey,
        '2026-08-11T20:00:00.001Z',
        Date.parse('2026-08-11T20:00:00.001Z'),
        Date.parse(WATERMARK_UTC),
        '2026-08-11T20:00:13.000Z',
        Date.parse('2026-08-11T20:00:13.000Z'),
      );
      expect(() => raw.prepare(
        `INSERT OR REPLACE INTO idempotency_intents (
           intent_key, scope_key, responsibility, action, source_identity_key,
           target_identity_key, approval_target_identity_key, desired_state_digest,
           created_at_utc, created_epoch_ms
         ) SELECT ?, scope_key, responsibility, action, source_identity_key,
           target_identity_key, approval_target_identity_key, ?, created_at_utc, created_epoch_ms
         FROM idempotency_intents WHERE intent_key = ?`,
      ).run(
        sha256Digest('replacement-order-intent'),
        sha256Digest('different-order-payload-must-not-create-new-intent'),
        intentKey,
      )).toThrow(/replacement denied/);

      expect(() => raw.prepare(
        `INSERT OR REPLACE INTO execution_jobs (
           job_id, scope_key, intent_key, approval_digest, responsibility,
           target_identity_key, ownership_version, approval_evidence_digest,
           order_observation_id, reserved_at_utc, reserved_epoch_ms
         ) SELECT 'replacement-job', scope_key, intent_key, approval_digest, responsibility,
           target_identity_key, ownership_version, approval_evidence_digest,
           order_observation_id, reserved_at_utc, reserved_epoch_ms
         FROM execution_jobs WHERE job_id = 'job-order-one'`,
      ).run()).toThrow(/replacement denied/);

      const auditHead = raw.prepare(
        'SELECT sequence, scope_key, event_hash, occurred_at_utc, occurred_epoch_ms FROM audit_events ORDER BY sequence DESC LIMIT 1',
      ).get() as {
        sequence: number;
        scope_key: string;
        event_hash: string;
        occurred_at_utc: string;
        occurred_epoch_ms: number;
      };
      expect(() => raw.prepare(
        `INSERT OR REPLACE INTO audit_events (
           sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
           payload_digest, previous_hash, event_hash
         ) VALUES (?, ?, 'raw-audit-replacement', 'raw.test', ?, ?, ?, ?, ?)`,
      ).run(
        auditHead.sequence + 1,
        auditHead.scope_key,
        auditHead.occurred_at_utc,
        auditHead.occurred_epoch_ms,
        sha256Digest('raw-audit-payload'),
        auditHead.event_hash,
        auditHead.event_hash,
      )).toThrow(/replacement denied/);

      expect({
        identities: (raw.prepare('SELECT COUNT(*) AS count FROM external_identities').get() as { count: number }).count,
        links: (raw.prepare('SELECT COUNT(*) AS count FROM order_links').get() as { count: number }).count,
        intents: (raw.prepare('SELECT COUNT(*) AS count FROM idempotency_intents').get() as { count: number }).count,
        jobs: (raw.prepare('SELECT COUNT(*) AS count FROM execution_jobs').get() as { count: number }).count,
        audit: (raw.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count,
      }).toEqual({ ...countsBefore, identities: countsBefore.identities, links: countsBefore.links,
        intents: countsBefore.intents, jobs: countsBefore.jobs, audit: countsBefore.audit });
    } finally {
      raw.close();
    }
  });

  it('rejects malformed sha256 values at the SQL boundary', () => {
    const { databasePath } = temporaryStorePath();
    const store = createStore(databasePath);
    store.close();
    const raw = new Database(databasePath);
    try {
      const head = raw.prepare(
        'SELECT sequence, scope_key, event_hash, occurred_at_utc, occurred_epoch_ms FROM audit_events',
      ).get() as {
        sequence: number;
        scope_key: string;
        event_hash: string;
        occurred_at_utc: string;
        occurred_epoch_ms: number;
      };
      expect(() => raw.prepare(
        `INSERT INTO audit_events (
           sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
           payload_digest, previous_hash, event_hash
         ) VALUES (?, ?, 'malformed-digest', 'raw.test', ?, ?, ?, ?, ?)`,
      ).run(
        head.sequence + 1,
        head.scope_key,
        head.occurred_at_utc,
        head.occurred_epoch_ms,
        `sha256:${'g'.repeat(64)}`,
        head.event_hash,
        sha256Digest('otherwise-valid-event-hash'),
      )).toThrow(/CHECK constraint failed/);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({ count: 1 });
    } finally {
      raw.close();
    }
  });

  it('recomputes the audit chain on reopen even when the catalog is restored after tampering', () => {
    const { databasePath } = temporaryStorePath();
    const store = createStore(databasePath);
    store.close();
    const raw = new Database(databasePath);
    try {
      raw.exec('DROP TRIGGER audit_events_deny_update');
      raw.prepare("UPDATE audit_events SET event_type = 'tampered.event'").run();
      raw.exec(`
        CREATE TRIGGER audit_events_deny_update
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit_events is append-only');
        END;
      `);
    } finally {
      raw.close();
    }

    expect(() => openMigrationStoreReadOnly({ databasePath, expectedScope: SCOPE }))
      .toThrow(/Audit chain/);
  });

  it('rejects a store whose safety-trigger catalog was altered', () => {
    const { databasePath } = temporaryStorePath();
    const store = createStore(databasePath);
    store.close();
    const raw = new Database(databasePath);
    try {
      raw.exec('DROP TRIGGER idempotency_intents_enforce_order_eligibility');
    } finally {
      raw.close();
    }
    expect(() => openMigrationStoreReadOnly({ databasePath, expectedScope: SCOPE }))
      .toThrow(/catalog does not match/);
  });

  it('rejects a legacy database without changing its bytes, mtime, or directory entries', () => {
    const { directory, databasePath } = temporaryStorePath();
    const legacy = new Database(databasePath);
    legacy.exec('CREATE TABLE legacy_orders (id INTEGER PRIMARY KEY, ebay_order_id TEXT)');
    legacy.close();
    fs.chmodSync(databasePath, 0o600);
    const before = fs.statSync(databasePath);
    const beforeDigest = fileDigest(databasePath);
    const beforeEntries = fs.readdirSync(directory).sort();

    expect(() => openMigrationStoreReadOnly({ databasePath, expectedScope: SCOPE }))
      .toThrow(MigrationStoreError);

    const after = fs.statSync(databasePath);
    expect(fs.readdirSync(directory).sort()).toEqual(beforeEntries);
    expect(fileDigest(databasePath)).toBe(beforeDigest);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('denies order-creation relationship forgery even if a raw client disables foreign keys', () => {
    const { databasePath } = temporaryStorePath();
    const store = createStore(databasePath);
    const baselineEvidence = recordMarketplaceConnectBaseline(store);
    establishWatermark(store, baselineEvidence);
    const { source, intentKey } = seedEligibleOrderIntent(store);
    const wrongTarget = registerShopifyOrder(store, 'WRONG-TARGET', '2026-08-11T20:00:06.000Z');
    transferOrderOwnershipToProductPipeline(store);
    store.close();

    const raw = new Database(databasePath);
    try {
      raw.pragma('foreign_keys = OFF');
      const approvalDigest = sha256Digest('forged-wrong-target-approval');
      expect(() => raw.prepare(
        `INSERT INTO action_approvals (
           approval_digest, scope_key, intent_key, responsibility, target_identity_key,
           ownership_version, issued_at_utc, issued_epoch_ms, expires_at_utc,
           expires_epoch_ms, evidence_digest
         ) VALUES (?, ?, ?, 'orderImport', ?, 3, ?, ?, ?, ?, ?)`,
      ).run(
        approvalDigest,
        source.scopeKey,
        intentKey,
        wrongTarget.identityKey,
        '2026-08-11T20:00:08.000Z',
        Date.parse('2026-08-11T20:00:08.000Z'),
        '2026-08-11T20:10:08.000Z',
        Date.parse('2026-08-11T20:10:08.000Z'),
        sha256Digest('forged-approval-evidence'),
      )).toThrow(/intent|target|binding/i);

      expect(() => raw.prepare(
        `INSERT INTO order_links (
           link_id, scope_key, ebay_order_identity_key, shopify_order_identity_key,
           link_kind, idempotency_intent_key, evidence_digest, linked_at_utc, linked_epoch_ms
         ) VALUES ('forged-created-link', ?, ?, ?, 'product_pipeline_created', ?, ?, ?, ?)`,
      ).run(
        source.scopeKey,
        source.identityKey,
        wrongTarget.identityKey,
        sha256Digest('nonexistent-order-intent'),
        sha256Digest('forged-link-evidence'),
        '2026-08-11T20:00:08.000Z',
        Date.parse('2026-08-11T20:00:08.000Z'),
      )).toThrow(/intent mismatch/);
    } finally {
      raw.close();
    }
  });
});
