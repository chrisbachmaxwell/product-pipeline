import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrationStore, sha256Digest } from '../migration-store/index.js';
import type { IntegrationScope } from '../migration-store/index.js';
import { readActivityFeed } from './activity-feed.js';
import { createActivityHandler } from './routes/activity.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

const SCOPE: IntegrationScope = {
  shopifyStoreDomain: 'usedcameragear.myshopify.com',
  ebayEnvironment: 'sandbox',
  ebaySellerId: 'activity-seller',
  ebayMarketplaceId: 'EBAY_US',
};

const BASE_EPOCH = Date.parse('2026-09-01T10:00:00.000Z');
const at = (seconds: number): string => new Date(BASE_EPOCH + seconds * 1000).toISOString();
const digest = (label: string): string => sha256Digest(`activity-fixture:${label}`);
const audit = (eventId: string, seconds: number) => ({ eventId, occurredAtUtc: at(seconds) });

const SKU = 'CAM-XL-42';
const TRACKED_EBAY_ORDER_ID = '11-11111-11111';
const IMPORTED_EBAY_ORDER_ID = '22-22222-22222';
const OBSERVED_EXISTING_EBAY_ORDER_ID = '33-33333-33333';

/**
 * Builds a real migration store containing one provider-confirmed quantity
 * alignment, one confirmed fulfillment tracking sync, one ProductPipeline
 * order import (order link created), and one observed-existing incumbent
 * link that must never surface as an import.
 */
function buildFixtureStore(): string {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'activity-feed-'));
  temporaryRoots.push(root);
  const databasePath = path.join(root, 'migration-state.sqlite');
  const store = createMigrationStore({ databasePath, scope: SCOPE, createdAtUtc: at(0) });

  const variant = store.registerIdentity({
    platform: 'shopify', kind: 'variant', bindingKey: 'variant:activity',
    storeDomain: SCOPE.shopifyStoreDomain,
    externalGid: 'gid://shopify/ProductVariant/40000000000001',
  }, audit('identity:variant', 1));
  const skuTarget = store.registerIdentity({
    platform: 'ebay', kind: 'inventory_sku', bindingKey: `ebay-inventory-sku:${SKU}`,
    environment: 'sandbox', sellerId: SCOPE.ebaySellerId,
    marketplaceId: SCOPE.ebayMarketplaceId, externalId: SKU,
  }, audit('identity:sku', 2));
  const shopifyFulfilledOrder = store.registerIdentity({
    platform: 'shopify', kind: 'order', bindingKey: 'shopify-order:fulfilled',
    storeDomain: SCOPE.shopifyStoreDomain,
    externalGid: 'gid://shopify/Order/8001',
  }, audit('identity:shopify-fulfilled', 3));
  const ebayFulfilledOrder = store.registerIdentity({
    platform: 'ebay', kind: 'order', bindingKey: 'ebay-order:tracked',
    environment: 'sandbox', sellerId: SCOPE.ebaySellerId,
    marketplaceId: SCOPE.ebayMarketplaceId, externalId: TRACKED_EBAY_ORDER_ID,
  }, audit('identity:ebay-tracked', 4));
  const ebayImportedOrder = store.registerIdentity({
    platform: 'ebay', kind: 'order', bindingKey: 'ebay-order:imported',
    environment: 'sandbox', sellerId: SCOPE.ebaySellerId,
    marketplaceId: SCOPE.ebayMarketplaceId, externalId: IMPORTED_EBAY_ORDER_ID,
  }, audit('identity:ebay-imported', 5));

  const ownershipChain = (
    responsibility: 'inventory' | 'fulfillment' | 'orderImport',
    firstSecond: number,
  ): string => {
    const baseline = digest(`${responsibility}-baseline`);
    store.recordOwnershipVersion({
      responsibility, version: 1, owner: 'marketplace_connect',
      singleWriterVerified: true, evidenceDigest: baseline,
      effectiveAtUtc: at(firstSecond), recordedAtUtc: at(firstSecond),
      audit: audit(`ownership:${responsibility}:v1`, firstSecond),
    });
    return baseline;
  };
  const finishOwnershipChain = (
    responsibility: 'inventory' | 'fulfillment' | 'orderImport',
    firstSecond: number,
  ): void => {
    store.recordOwnershipVersion({
      responsibility, version: 2, owner: 'paused',
      singleWriterVerified: true, evidenceDigest: digest(`${responsibility}-paused`),
      effectiveAtUtc: at(firstSecond), recordedAtUtc: at(firstSecond),
      audit: audit(`ownership:${responsibility}:v2`, firstSecond),
    });
    store.recordOwnershipVersion({
      responsibility, version: 3, owner: 'product_pipeline',
      singleWriterVerified: true, evidenceDigest: digest(`${responsibility}-pp`),
      effectiveAtUtc: at(firstSecond + 1), recordedAtUtc: at(firstSecond + 1),
      audit: audit(`ownership:${responsibility}:v3`, firstSecond + 1),
    });
  };

  ownershipChain('inventory', 6);
  finishOwnershipChain('inventory', 7);
  ownershipChain('fulfillment', 9);
  finishOwnershipChain('fulfillment', 10);
  const orderBaseline = ownershipChain('orderImport', 12);
  store.establishOrderWatermark({
    boundaryExclusiveUtc: at(12),
    ownershipVersion: 1,
    ownershipEvidenceDigest: orderBaseline,
    acceptedEvidenceDigest: digest('accepted-cutoff'),
    createdAtUtc: at(13),
    audit: audit('watermark:order-import', 13),
  });
  finishOwnershipChain('orderImport', 15);
  store.recordOrderPage({
    pageId: 'page-activity',
    cursorBefore: null,
    cursorAfter: 'cursor-activity',
    observedAtUtc: at(17),
    snapshotDigest: digest('page-activity'),
    orders: [{
      observationId: 'observation:imported',
      ebayOrderIdentityKey: ebayImportedOrder.identityKey,
      sourceCreationDateUtc: at(14),
    }],
    audit: audit('page:activity', 17),
  });

  type CeremonyInput = {
    slug: string;
    action: 'update_ebay_inventory' | 'sync_fulfillment' | 'import_shopify_order';
    responsibility: 'inventory' | 'fulfillment' | 'orderImport';
    sourceIdentityKey: string;
    targetIdentityKey: string;
    startSecond: number;
    orderObservationId?: string;
    resolveExtra?: { shopifyOrderIdentityKey: string; orderLinkId: string };
  };
  const runResolvedCeremony = (input: CeremonyInput): void => {
    const s = input.startSecond;
    const intentKey = store.createIdempotencyIntent({
      action: input.action,
      sourceIdentityKey: input.sourceIdentityKey,
      targetIdentityKey: input.action === 'import_shopify_order'
        ? undefined
        : input.targetIdentityKey,
      desiredStateDigest: digest(`${input.slug}-desired`),
      createdAtUtc: at(s),
      audit: audit(`intent:${input.slug}`, s),
    });
    const approvalToken = `approval-token-${input.slug}-0001`;
    const approvalEvidence = digest(`${input.slug}-approval`);
    store.issueActionApproval({
      approvalToken, intentKey, responsibility: input.responsibility,
      targetIdentityKey: input.targetIdentityKey, ownershipVersion: 3,
      issuedAtUtc: at(s + 1), expiresAtUtc: at(s + 600),
      evidenceDigest: approvalEvidence,
      audit: audit(`approval:${input.slug}`, s + 1),
    });
    store.reserveExecutionJob({
      jobId: `job:${input.slug}`, approvalToken, intentKey,
      responsibility: input.responsibility,
      targetIdentityKey: input.targetIdentityKey, ownershipVersion: 3,
      approvalEvidenceDigest: approvalEvidence,
      ...(input.orderObservationId === undefined
        ? {}
        : { orderObservationId: input.orderObservationId }),
      reservedAtUtc: at(s + 2), evidenceDigest: digest(`${input.slug}-reserved`),
      audit: audit(`job:${input.slug}:reserved`, s + 2),
    });
    store.markDispatchingOutcomeUnknown({
      jobId: `job:${input.slug}`, attemptId: `attempt:${input.slug}`,
      approvalToken, approvalEvidenceDigest: approvalEvidence,
      occurredAtUtc: at(s + 3), evidenceDigest: digest(`${input.slug}-dispatch`),
      audit: audit(`job:${input.slug}:dispatch`, s + 3),
    });
    store.requirePostDispatchReconciliation({
      jobId: `job:${input.slug}`, attemptId: `attempt:${input.slug}`,
      occurredAtUtc: at(s + 4), evidenceDigest: digest(`${input.slug}-required`),
      audit: audit(`job:${input.slug}:required`, s + 4),
    });
    const resultDigest = digest(`${input.slug}-result`);
    store.recordReconciliationRun({
      runId: `reconciliation:${input.slug}`,
      responsibility: input.responsibility,
      targetIdentityKey: input.targetIdentityKey,
      mode: 'test_lane', status: 'passed',
      sourceSnapshotDigest: digest(`${input.slug}-source`),
      targetSnapshotDigest: digest(`${input.slug}-target`),
      resultDigest, authoritative: true,
      authorityEvidenceDigest: digest(`${input.slug}-authority`),
      externalWritesObserved: 0,
      startedAtUtc: at(s + 5), completedAtUtc: at(s + 6),
      exceptions: [],
      ...(input.responsibility === 'orderImport' ? {} : {
        targetEffectObservation: {
          observationId: `effect:${input.slug}`,
          intentKey,
          responsibility: input.responsibility as 'inventory' | 'fulfillment',
          effect: 'effect_observed' as const,
          observedDigest: digest(`${input.slug}-observed`),
        },
      }),
      audit: audit(`reconciliation:${input.slug}`, s + 6),
    });
    store.resolveUnknownAttempt({
      jobId: `job:${input.slug}`, attemptId: `attempt:${input.slug}`,
      resolution: 'resolved_existing',
      reconciliationRunId: `reconciliation:${input.slug}`,
      reconciliationResultDigest: resultDigest,
      reconciledAtUtc: at(s + 7),
      ...(input.resolveExtra ?? {}),
      audit: audit(`resolution:${input.slug}`, s + 7),
    });
  };

  // Quantity alignment resolves at at(25).
  runResolvedCeremony({
    slug: 'quantity',
    action: 'update_ebay_inventory',
    responsibility: 'inventory',
    sourceIdentityKey: variant.identityKey,
    targetIdentityKey: skuTarget.identityKey,
    startSecond: 18,
  });
  // A fulfillment intent requires the durable Shopify/eBay order link first.
  store.linkObservedExistingOrder({
    linkId: 'link:tracked',
    ebayOrderIdentityKey: ebayFulfilledOrder.identityKey,
    shopifyOrderIdentityKey: shopifyFulfilledOrder.identityKey,
    evidenceDigest: digest('tracked-link'),
    linkedAtUtc: at(25.5),
    audit: audit('link:tracked', 25.5),
  });
  // Tracking sync resolves at at(33).
  runResolvedCeremony({
    slug: 'tracking',
    action: 'sync_fulfillment',
    responsibility: 'fulfillment',
    sourceIdentityKey: shopifyFulfilledOrder.identityKey,
    targetIdentityKey: ebayFulfilledOrder.identityKey,
    startSecond: 26,
  });
  // ProductPipeline order import resolves (and links) at at(41).
  const shopifyCreatedOrder = store.registerIdentity({
    platform: 'shopify', kind: 'order', bindingKey: 'shopify-order:created',
    storeDomain: SCOPE.shopifyStoreDomain,
    externalGid: 'gid://shopify/Order/9002',
  }, audit('identity:shopify-created', 33.5));
  runResolvedCeremony({
    slug: 'order-import',
    action: 'import_shopify_order',
    responsibility: 'orderImport',
    sourceIdentityKey: ebayImportedOrder.identityKey,
    targetIdentityKey: ebayImportedOrder.identityKey,
    startSecond: 34,
    orderObservationId: 'observation:imported',
    resolveExtra: {
      shopifyOrderIdentityKey: shopifyCreatedOrder.identityKey,
      orderLinkId: 'link:imported',
    },
  });

  // An incumbent-created order matched during shadow polling: linked, but
  // never a ProductPipeline import story.
  const ebayObservedOrder = store.registerIdentity({
    platform: 'ebay', kind: 'order', bindingKey: 'ebay-order:observed-existing',
    environment: 'sandbox', sellerId: SCOPE.ebaySellerId,
    marketplaceId: SCOPE.ebayMarketplaceId, externalId: OBSERVED_EXISTING_EBAY_ORDER_ID,
  }, audit('identity:ebay-observed', 43));
  const shopifyObservedOrder = store.registerIdentity({
    platform: 'shopify', kind: 'order', bindingKey: 'shopify-order:observed-existing',
    storeDomain: SCOPE.shopifyStoreDomain,
    externalGid: 'gid://shopify/Order/9003',
  }, audit('identity:shopify-observed', 44));
  store.linkObservedExistingOrder({
    linkId: 'link:observed-existing',
    ebayOrderIdentityKey: ebayObservedOrder.identityKey,
    shopifyOrderIdentityKey: shopifyObservedOrder.identityKey,
    evidenceDigest: digest('observed-existing-link'),
    linkedAtUtc: at(45),
    audit: audit('link:observed-existing', 45),
  });

  store.close();
  return databasePath;
}

function feedOptions(databasePath: string, overrides: {
  now?: () => Date;
  limit?: number;
  windowHours?: number;
} = {}) {
  return {
    environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
    loadConfig: vi.fn(async () => ({
      config: { scope: SCOPE },
      databaseAbsolutePath: databasePath,
    })) as never,
    now: overrides.now ?? (() => new Date(at(100))),
    ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
    ...(overrides.windowHours === undefined ? {} : { windowHours: overrides.windowHours }),
  };
}

describe('activity feed', () => {
  it('returns classified, PII-free events, newest first', async () => {
    const databasePath = buildFixtureStore();
    const feed = await readActivityFeed(feedOptions(databasePath));

    expect(feed.available).toBe(true);
    expect(feed.windowHours).toBe(24);
    expect(feed.events).toEqual([
      {
        atUtc: at(41),
        kind: 'order_imported',
        label: 'eBay order imported',
        ebayOrderId: IMPORTED_EBAY_ORDER_ID,
      },
      {
        atUtc: at(33),
        kind: 'tracking_sent',
        label: 'Tracking sent to eBay',
        ebayOrderId: TRACKED_EBAY_ORDER_ID,
      },
      {
        atUtc: at(25),
        kind: 'quantity_updated',
        label: 'Quantity updated',
        sku: SKU,
      },
    ]);

    const serialized = JSON.stringify(feed);
    // No PII, credentials, digests, internal identifiers, or raw payloads.
    expect(serialized).not.toMatch(/gid:|shopify\/Order|sha256:|approval|token|Bearer|buyer|@|myshopify/i);
    // The observed-existing incumbent link is never reported as an import.
    expect(serialized).not.toContain(OBSERVED_EXISTING_EBAY_ORDER_ID);
  });

  it('caps the event count and clamps out-of-range limits', async () => {
    const databasePath = buildFixtureStore();
    const capped = await readActivityFeed(feedOptions(databasePath, { limit: 2 }));
    expect(capped.events.map((event) => event.kind)).toEqual([
      'order_imported',
      'tracking_sent',
    ]);
    const clamped = await readActivityFeed(feedOptions(databasePath, {
      limit: 10_000,
      windowHours: 10_000,
    }));
    expect(clamped.windowHours).toBe(168);
    expect(clamped.events).toHaveLength(3);
  });

  it('bounds events to the lookback window', async () => {
    const databasePath = buildFixtureStore();
    // now = at(3630); a one-hour window starts at at(30): the quantity event
    // at at(25) falls outside while tracking and the import remain.
    const feed = await readActivityFeed(feedOptions(databasePath, {
      windowHours: 1,
      now: () => new Date(at(3630)),
    }));
    expect(feed.windowHours).toBe(1);
    expect(feed.events.map((event) => event.kind)).toEqual([
      'order_imported',
      'tracking_sent',
    ]);
  });

  it('degrades to an unavailable empty feed without a configured store', async () => {
    const notConfigured = await readActivityFeed({ environment: {} });
    expect(notConfigured).toEqual({ available: false, windowHours: 24, events: [] });

    const configRejected = await readActivityFeed({
      environment: { MIGRATION_STATE_CONFIG_PATH: 'config/migration-state.json' },
      loadConfig: vi.fn(async () => { throw new Error('denied'); }) as never,
    });
    expect(configRejected).toEqual({ available: false, windowHours: 24, events: [] });

    const missingDatabase = await readActivityFeed(
      feedOptions(path.join(os.tmpdir(), 'activity-feed-missing', 'no-such.sqlite')),
    );
    expect(missingDatabase).toEqual({ available: false, windowHours: 24, events: [] });
  });

  it('serves the unavailable path over HTTP without a 500', async () => {
    const recorded: { statusCode: number; headers: Record<string, string>; body: unknown } = {
      statusCode: 200,
      headers: {},
      body: null,
    };
    const res = {
      setHeader(name: string, value: string) { recorded.headers[name] = value; },
      status(code: number) { recorded.statusCode = code; return res; },
      json(body: unknown) { recorded.body = body; },
    };

    const unavailableHandler = createActivityHandler({
      readFeed: async () => ({ available: false, windowHours: 24, events: [] }),
    });
    await unavailableHandler(
      { query: {} } as never,
      res as unknown as Response,
    );
    expect(recorded.statusCode).toBe(200);
    expect(recorded.headers['Cache-Control']).toBe('no-store');
    expect(recorded.body).toMatchObject({
      schemaVersion: 1,
      available: false,
      events: [],
      externalWritesPerformed: 0,
    });

    const throwingHandler = createActivityHandler({
      readFeed: async () => { throw new Error('unexpected'); },
    });
    await throwingHandler({ query: {} } as never, res as unknown as Response);
    expect(recorded.statusCode).toBe(200);
    expect(recorded.body).toMatchObject({
      schemaVersion: 1,
      available: false,
      events: [],
    });
  });
});
