/**
 * Isolated order-import operator CLI — the new-order-only eBay-to-Shopify
 * import dispatch slice.
 *
 * It is never imported or mounted by the server. Historical eBay orders can
 * NEVER be imported: the schema-v3 store enforces the one-hour production
 * no-backfill clamp on the one immutable watermark, strictly-greater
 * eligibility, one-intent-per-eBay-order natural-key idempotency, and
 * link-based dispatch denial; this CLI additionally starts every eBay poll at
 * the watermark and permanently records anything at-or-before it as
 * watermark-excluded. Every Shopify order creation cascades into Lightspeed
 * POS, so `import` handles exactly one order per invocation, requires the
 * literal `--confirm-lightspeed` acknowledgement, dedup-checks Shopify by the
 * `eBay-<orderId>` tag before any intent exists, and reconciles the outcome
 * immediately after the single bounded orderCreate call. Buyer shipping
 * details pass through to that one provider call only — never persisted,
 * logged, or digested into stored payloads.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  deriveExternalIdentityKey,
  deriveIdempotencyKey,
  deriveScopeKey,
  openMigrationStore,
  MigrationStoreError,
  sha256Digest,
  type Digest as MigrationDigest,
  type ExternalIdentityInput,
  type IntegrationScope,
  type MigrationStore,
} from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import {
  createEbayOrderReadAdapter,
  createProductionOrderReadTokenProvider,
  EbayOrderReadError,
  type EbayOrderReadAdapter,
  type FetchedEbayOrder,
  type PolledEbayOrder,
} from './ebay-order-adapter.js';
import {
  createShopifyOrderAdapter,
  createProductionShopifyOrderTokenProvider,
  ShopifyOrderAdapterError,
  type ShopifyOrderAdapter,
} from './shopify-order-adapter.js';
import { openOrderImportStateReader } from './store-reader.js';

const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_POLL_ORDERS = 50;
const MAX_SHADOW_LOOKBACK_HOURS = 168;
const SAFE_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RAW_SHA256 = /^[a-f0-9]{64}$/;

export type OrderImportAdminIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  setExitCode: (code: number) => void;
};

const defaultIo: OrderImportAdminIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export type OrderImportAdminDependencies = Readonly<{
  openMigration?: typeof openMigrationStore;
  openStateReader?: typeof openOrderImportStateReader;
  createEbayAdapter?: () => EbayOrderReadAdapter;
  createShopifyAdapter?: () => ShopifyOrderAdapter;
  now?: () => Date;
  uuid?: () => string;
  io?: OrderImportAdminIo;
}>;

const MIGRATION_SCOPE: IntegrationScope = Object.freeze({
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});

class OrderImportAdminError extends Error {
  constructor(readonly code: string) {
    super('Order import operation denied');
    this.name = 'OrderImportAdminError';
  }
}

const deny = (code: string): never => {
  throw new OrderImportAdminError(code);
};

function safeErrorCode(error: unknown): string {
  if (error instanceof OrderImportAdminError) return error.code;
  if (error instanceof EbayOrderReadError) return error.code;
  if (error instanceof ShopifyOrderAdapterError) return error.code;
  if (error instanceof MigrationStoreError) return `MIGRATION_STORE_${error.code}`;
  return 'ORDER_IMPORT_DENIED';
}

/**
 * Migration-store error messages are fixed, redacted strings; surfacing them
 * verbatim lets the operator see exactly which durable safeguard denied
 * (e.g. the one-hour no-backfill clamp) without leaking any dynamic value.
 */
function safeErrorMessage(error: unknown): string | null {
  return error instanceof MigrationStoreError ? error.message : null;
}

function normalizedDigest(value: string, code: string): MigrationDigest {
  if (typeof value !== 'string') deny(code);
  const candidate = RAW_SHA256.test(value) ? `sha256:${value}` : value;
  if (!/^sha256:[a-f0-9]{64}$/.test(candidate)) deny(code);
  return candidate as MigrationDigest;
}

function createMonotonicClock(now: () => Date): () => string {
  let lastMs = 0;
  return () => {
    const currentMs = Math.max(now().getTime(), lastMs);
    lastMs = currentMs;
    return new Date(currentMs).toISOString();
  };
}

function ensureIdentity(
  store: MigrationStore,
  input: ExternalIdentityInput,
  occurredAtUtc: string,
): MigrationDigest {
  const identityKey = deriveExternalIdentityKey(input);
  const existing = store.getIdentity(identityKey);
  if (existing) return identityKey;
  store.registerIdentity(input, {
    eventId: `identity:${identityKey.slice(7, 27)}`,
    occurredAtUtc,
  });
  return identityKey;
}

function ebayOrderIdentityInput(orderId: string): ExternalIdentityInput {
  return {
    platform: 'ebay',
    kind: 'order',
    bindingKey: `ebay-order:${orderId}`,
    environment: MIGRATION_SCOPE.ebayEnvironment,
    sellerId: MIGRATION_SCOPE.ebaySellerId,
    marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
    externalId: orderId,
  };
}

function shopifyOrderIdentityInput(orderGid: string): ExternalIdentityInput {
  return {
    platform: 'shopify',
    kind: 'order',
    bindingKey: `shopify-order:${orderGid}`,
    storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
    externalGid: orderGid,
  };
}

function orderTag(orderId: string): string {
  return `eBay-${orderId}`;
}

function requireOrderId(value: string): string {
  if (typeof value !== 'string' || !SAFE_ORDER_ID.test(value)) {
    deny('IMPORT_ORDER_ID_INVALID');
  }
  return value;
}

type PostVerifyResult =
  | { outcome: 'resolved_existing'; runId: string; shopifyOrderGid: string }
  | { outcome: 'confirmed_missing'; runId: string }
  | { outcome: 'unresolved'; runId: string; exceptionCode: string }
  | { outcome: 'verify_failed'; exceptionCode: string };

/**
 * The authoritative zero-write post-dispatch verification: re-query Shopify
 * by the durable `eBay-<orderId>` tag, record one production_canary
 * reconciliation run whose target is the intent's approval target (the eBay
 * order identity), and resolve the outcome-unknown attempt only on exact
 * evidence. `confirmed_missing` is a terminal claim and is recorded only
 * under the explicit `--accept-absent` operator acknowledgement — never
 * automatically — so propagation delay or a misleading provider error can
 * never terminalize a job whose order actually exists (mirrors the
 * listing-revise resolveAbsent policy with the strictest setting for orders).
 */
async function runOrderPostVerify(input: {
  store: MigrationStore;
  shopify: ShopifyOrderAdapter;
  orderId: string;
  ebayOrderIdentityKey: MigrationDigest;
  jobId: string;
  attemptId: string;
  createdOrderGid: string | null;
  acceptAbsent: boolean;
  clock: () => string;
  uuid: () => string;
}): Promise<PostVerifyResult> {
  const tag = orderTag(input.orderId);
  const startedAtUtc = input.clock();
  let foundGids: string[];
  try {
    foundGids = await input.shopify.findOrderGidsByTag(tag);
  } catch {
    return { outcome: 'verify_failed', exceptionCode: 'ORDER_IMPORT_POST_VERIFY_READ_FAILED' };
  }
  const completedAtUtc = input.clock();
  let matchedGid: string | null = null;
  let ambiguous = false;
  if (input.createdOrderGid !== null && foundGids.includes(input.createdOrderGid)) {
    matchedGid = input.createdOrderGid;
  } else if (foundGids.length === 1) {
    matchedGid = foundGids[0]!;
  } else if (foundGids.length > 1) {
    ambiguous = true;
  }
  const sortedGids = [...foundGids].sort();
  const resultDigest = sha256Digest({
    schemaVersion: 1,
    type: 'order_import_post_verify',
    orderId: input.orderId,
    tag,
    foundOrderGids: sortedGids,
    matchedOrderGid: matchedGid,
  });
  const runId = `order-import-run:${input.uuid()}`;
  const resolvable = matchedGid !== null || (foundGids.length === 0 && input.acceptAbsent);
  const exceptionCode = ambiguous
    ? 'ORDER_IMPORT_AMBIGUOUS_TAG_MATCHES'
    : 'ORDER_IMPORT_STATE_NOT_YET_OBSERVED';
  const exceptions = resolvable ? [] : [{
    exceptionId: `order-import-exception:${input.uuid()}`,
    code: exceptionCode,
    severity: 'critical' as const,
    subjectIdentityKey: input.ebayOrderIdentityKey,
    detailsDigest: resultDigest,
  }];
  input.store.recordReconciliationRun({
    runId,
    responsibility: 'orderImport',
    targetIdentityKey: input.ebayOrderIdentityKey,
    mode: 'production_canary',
    status: 'passed',
    sourceSnapshotDigest: sha256Digest({
      schemaVersion: 1,
      type: 'ebay_order_source',
      orderId: input.orderId,
    }),
    targetSnapshotDigest: sha256Digest({
      schemaVersion: 1,
      type: 'shopify_tag_query',
      tag,
      foundOrderGids: sortedGids,
    }),
    resultDigest,
    authoritative: resolvable,
    authorityEvidenceDigest: sha256Digest({
      schemaVersion: 1,
      type: 'shopify_admin_tag_query_authority',
      storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
      tag,
    }),
    externalWritesObserved: 0,
    startedAtUtc,
    completedAtUtc,
    exceptions,
    audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: completedAtUtc },
  });
  if (!resolvable) {
    return { outcome: 'unresolved', runId, exceptionCode };
  }
  if (matchedGid !== null) {
    const shopifyOrderIdentityKey = ensureIdentity(
      input.store,
      shopifyOrderIdentityInput(matchedGid),
      input.clock(),
    );
    const reconciledAtUtc = input.clock();
    input.store.resolveUnknownAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      resolution: 'resolved_existing',
      reconciliationRunId: runId,
      reconciliationResultDigest: resultDigest,
      shopifyOrderIdentityKey,
      orderLinkId: `link:${input.orderId}`,
      reconciledAtUtc,
      audit: { eventId: `resolution:${runId}`, occurredAtUtc: reconciledAtUtc },
    });
    return { outcome: 'resolved_existing', runId, shopifyOrderGid: matchedGid };
  }
  const reconciledAtUtc = input.clock();
  input.store.resolveUnknownAttempt({
    jobId: input.jobId,
    attemptId: input.attemptId,
    resolution: 'confirmed_missing',
    reconciliationRunId: runId,
    reconciliationResultDigest: resultDigest,
    reconciledAtUtc,
    audit: { eventId: `resolution:${runId}`, occurredAtUtc: reconciledAtUtc },
  });
  return { outcome: 'confirmed_missing', runId };
}

export function buildOrderImportAdminProgram(
  dependencies: OrderImportAdminDependencies = {},
): Command {
  const io = dependencies.io ?? defaultIo;
  const openMigration = dependencies.openMigration ?? openMigrationStore;
  const openStateReader = dependencies.openStateReader ?? openOrderImportStateReader;
  const createEbayAdapter = dependencies.createEbayAdapter ?? (() =>
    createEbayOrderReadAdapter({
      getAccessToken: createProductionOrderReadTokenProvider(),
    }));
  const createShopifyAdapter = dependencies.createShopifyAdapter ?? (() =>
    createShopifyOrderAdapter({
      getAccessToken: createProductionShopifyOrderTokenProvider(),
    }));
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const scopeKey = deriveScopeKey(MIGRATION_SCOPE);

  const fail = (command: string, error: unknown): void => {
    const message = safeErrorMessage(error);
    io.stderr(JSON.stringify({
      command,
      status: 'denied',
      code: safeErrorCode(error),
      ...(message === null ? {} : { storeMessage: message }),
    }));
    io.setExitCode(1);
  };

  const program = new Command();
  program
    .name('order-import-admin')
    .description(
      'Isolated new-order-only eBay-to-Shopify order import: ownership, immutable watermark, '
      + 'read-only poll, zero-write shadow parity poll, and one-order-per-invocation import '
      + 'with immediate reconciliation',
    )
    .showHelpAfterError();

  program
    .command('establish-ownership')
    .description(
      'Record the orderImport ownership chain once: marketplace_connect genesis, '
      + 'marketplace_connect->paused (Marketplace Connect order import disabled, with evidence), '
      + 'then paused->product_pipeline',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
    .requiredOption(
      '--baseline-evidence <sha256>',
      'Digest of the verified Marketplace Connect incumbent baseline evidence',
    )
    .requiredOption(
      '--mc-disabled-evidence <sha256>',
      'Digest of the captured proof that Marketplace Connect order import is OFF',
    )
    .action((options: {
      migrationStore: string;
      confirmScope: string;
      baselineEvidence: string;
      mcDisabledEvidence: string;
    }) => {
      try {
        if (normalizedDigest(options.confirmScope, 'OWNERSHIP_SCOPE_CONFIRMATION_MISMATCH')
          !== scopeKey) {
          deny('OWNERSHIP_SCOPE_CONFIRMATION_MISMATCH');
        }
        const baselineEvidence = normalizedDigest(
          options.baselineEvidence,
          'OWNERSHIP_EVIDENCE_DIGEST_INVALID',
        );
        const mcDisabledEvidence = normalizedDigest(
          options.mcDisabledEvidence,
          'OWNERSHIP_EVIDENCE_DIGEST_INVALID',
        );
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          let current = store.getCurrentOwnership('orderImport');
          if (current && current.owner === 'product_pipeline') {
            io.stdout(JSON.stringify({
              command: 'establish-ownership',
              status: 'already-established',
              version: current.version,
              externalWritesPerformed: 0,
            }));
            return;
          }
          if (!current) {
            const genesisAt = clock();
            store.recordOwnershipVersion({
              responsibility: 'orderImport',
              version: 1,
              owner: 'marketplace_connect',
              singleWriterVerified: true,
              evidenceDigest: baselineEvidence,
              effectiveAtUtc: genesisAt,
              recordedAtUtc: genesisAt,
              audit: { eventId: `ownership:order-import:v1:${uuid()}`, occurredAtUtc: genesisAt },
            });
            current = store.getCurrentOwnership('orderImport');
          }
          if (current && current.owner === 'marketplace_connect') {
            const pausedAt = clock();
            store.recordOwnershipVersion({
              responsibility: 'orderImport',
              version: current.version + 1,
              owner: 'paused',
              singleWriterVerified: true,
              evidenceDigest: mcDisabledEvidence,
              effectiveAtUtc: pausedAt,
              recordedAtUtc: pausedAt,
              audit: {
                eventId: `ownership:order-import:v${current.version + 1}:${uuid()}`,
                occurredAtUtc: pausedAt,
              },
            });
            current = store.getCurrentOwnership('orderImport');
          }
          if (!current || current.owner !== 'paused') {
            throw new OrderImportAdminError('OWNERSHIP_CHAIN_INVALID');
          }
          const transferAt = clock();
          store.recordOwnershipVersion({
            responsibility: 'orderImport',
            version: current.version + 1,
            owner: 'product_pipeline',
            singleWriterVerified: true,
            evidenceDigest: mcDisabledEvidence,
            effectiveAtUtc: transferAt,
            recordedAtUtc: transferAt,
            audit: {
              eventId: `ownership:order-import:v${current.version + 1}:${uuid()}`,
              occurredAtUtc: transferAt,
            },
          });
          io.stdout(JSON.stringify({
            command: 'establish-ownership',
            status: 'established',
            version: current.version + 1,
            externalWritesPerformed: 0,
          }));
        } finally {
          store.close();
        }
      } catch (error) {
        fail('establish-ownership', error);
      }
    });

  program
    .command('establish-watermark')
    .description(
      'Establish the one immutable production order watermark (one per scope, forever). '
      + 'The store enforces ProductPipeline single-writer orderImport ownership and the '
      + 'one-hour no-backfill clamp; orders at or before the boundary are permanently ineligible',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
    .requiredOption(
      '--boundary <iso8601-utc>',
      'Exclusive boundary instant, canonical UTC (e.g. 2026-08-19T18:00:00.000Z)',
    )
    .requiredOption(
      '--accepted-evidence <sha256>',
      'Digest of the reviewed and accepted watermark packet',
    )
    .action((options: {
      migrationStore: string;
      confirmScope: string;
      boundary: string;
      acceptedEvidence: string;
    }) => {
      try {
        if (normalizedDigest(options.confirmScope, 'WATERMARK_SCOPE_CONFIRMATION_MISMATCH')
          !== scopeKey) {
          deny('WATERMARK_SCOPE_CONFIRMATION_MISMATCH');
        }
        const acceptedEvidence = normalizedDigest(
          options.acceptedEvidence,
          'WATERMARK_EVIDENCE_DIGEST_INVALID',
        );
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          const ownership = store.getCurrentOwnership('orderImport');
          if (!ownership || ownership.owner !== 'product_pipeline'
            || !ownership.singleWriterVerified) {
            deny('WATERMARK_OWNERSHIP_NOT_ESTABLISHED');
          }
          const current = ownership as NonNullable<typeof ownership>;
          const createdAtUtc = clock();
          const established = store.establishOrderWatermark({
            boundaryExclusiveUtc: options.boundary,
            ownershipVersion: current.version,
            ownershipEvidenceDigest: current.evidenceDigest,
            acceptedEvidenceDigest: acceptedEvidence,
            createdAtUtc,
            audit: { eventId: `watermark:order-import:${uuid()}`, occurredAtUtc: createdAtUtc },
          });
          io.stdout(JSON.stringify({
            command: 'establish-watermark',
            status: 'established',
            eventField: established.eventField,
            boundaryMode: 'exclusive',
            boundaryExclusiveUtc: established.boundaryExclusiveUtc,
            ownershipVersion: current.version,
            externalWritesPerformed: 0,
          }));
        } finally {
          store.close();
        }
      } catch (error) {
        fail('establish-watermark', error);
      }
    });

  program
    .command('poll')
    .description(
      'READ-ONLY eBay poll starting exactly at the immutable watermark: record new order '
      + 'observations durably (the store derives eligibility) and permanently exclude anything '
      + 'at or before the boundary. No Shopify call, no provider write, no PII',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--max-orders <n>', 'Maximum orders to fetch this poll (1-50)')
    .action(async (options: { migrationStore: string; maxOrders: string }) => {
      try {
        const maxOrders = Number(options.maxOrders);
        if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_POLL_ORDERS) {
          deny('POLL_MAX_ORDERS_INVALID');
        }
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const reader = openStateReader({
          databasePath: options.migrationStore,
          scopeKey,
        });
        const clock = createMonotonicClock(now);
        try {
          const watermark = store.getOrderWatermark();
          if (!watermark) deny('POLL_WATERMARK_REQUIRED');
          const boundary = (watermark as NonNullable<typeof watermark>);

          const ebay = createEbayAdapter();
          const fetched = await ebay.listOrdersCreatedSince(
            boundary.boundaryExclusiveUtc,
            maxOrders,
          );

          const skipped: Array<Record<string, unknown>> = [];
          const fresh: Array<{
            orderId: string;
            creationDateUtc: string;
            identityKey: MigrationDigest;
          }> = [];
          for (const order of fetched) {
            const identityKey = deriveExternalIdentityKey(ebayOrderIdentityInput(order.orderId));
            const observed = reader.getObservationByIdentity(identityKey);
            if (observed) {
              skipped.push({
                orderId: order.orderId,
                status: 'SKIPPED_ALREADY_OBSERVED',
                eligibleAfterWatermark: observed.eligibleAfterWatermark,
                resolved: observed.resolved,
              });
            } else {
              fresh.push({
                orderId: order.orderId,
                creationDateUtc: order.creationDateUtc,
                identityKey,
              });
            }
          }

          // Housekeeping: a fully resolved previous page advances the durable
          // cursor; an unresolved one blocks new pages fail-closed.
          const pendingPage = reader.getUnadvancedPage();
          if (pendingPage) {
            if (pendingPage.observedCount === pendingPage.resolvedCount) {
              const cursor = reader.getCurrentCursor();
              const advancedAtUtc = clock();
              store.advanceOrderCursor({
                cursorAdvanceId: `cursor-advance:${uuid()}`,
                pageId: pendingPage.pageId,
                ordinal: (cursor?.ordinal ?? 0) + 1,
                cursorValue: pendingPage.cursorAfter,
                advancedAtUtc,
                audit: { eventId: `cursor:${uuid()}`, occurredAtUtc: advancedAtUtc },
              });
            } else if (fresh.length > 0) {
              io.stdout(JSON.stringify({
                command: 'poll',
                status: 'blocked',
                code: 'POLL_PREVIOUS_PAGE_UNRESOLVED',
                pendingPageId: pendingPage.pageId,
                pendingUnresolvedObservations:
                  pendingPage.observedCount - pendingPage.resolvedCount,
                skippedAlreadyObserved: skipped.length,
                newOrdersNotRecorded: fresh.map((order) => ({
                  orderId: order.orderId,
                  creationDateUtc: order.creationDateUtc,
                })),
                externalCommerceWritesAttempted: 0,
              }));
              io.setExitCode(1);
              return;
            }
          }

          const eligible: Array<{ orderId: string; creationDateUtc: string }> = [];
          const permanentlyIneligible: Array<{ orderId: string; creationDateUtc: string }> = [];
          if (fresh.length > 0) {
            for (const order of fresh) {
              ensureIdentity(store, ebayOrderIdentityInput(order.orderId), clock());
            }
            const observedAtUtc = clock();
            const pageId = `order-page:${uuid()}`;
            const cursorAfter = `order-poll:${uuid()}`;
            const cursorBefore = reader.getCurrentCursor()?.cursorValue ?? null;
            store.recordOrderPage({
              pageId,
              cursorBefore,
              cursorAfter,
              observedAtUtc,
              snapshotDigest: sha256Digest({
                schemaVersion: 1,
                type: 'order_poll_page',
                orders: fresh.map((order) => ({
                  orderId: order.orderId,
                  creationDateUtc: order.creationDateUtc,
                })),
              }),
              orders: fresh.map((order) => ({
                observationId: `observation:${order.orderId}`,
                ebayOrderIdentityKey: order.identityKey,
                sourceCreationDateUtc: order.creationDateUtc,
              })),
              audit: { eventId: `page:${pageId}`, occurredAtUtc: observedAtUtc },
            });
            for (const order of fresh) {
              const isEligible = store.isOrderEligible(order.creationDateUtc);
              if (isEligible) {
                eligible.push({
                  orderId: order.orderId,
                  creationDateUtc: order.creationDateUtc,
                });
              } else {
                // Permanent: an at-or-before-watermark order is durably
                // excluded and can never receive an import intent.
                const resolvedAtUtc = clock();
                store.resolveOrderObservation({
                  resolutionId: `observation:${order.orderId}:excluded`,
                  observationId: `observation:${order.orderId}`,
                  disposition: 'excluded_by_watermark',
                  evidenceDigest: sha256Digest({
                    schemaVersion: 1,
                    type: 'watermark_exclusion',
                    orderId: order.orderId,
                    creationDateUtc: order.creationDateUtc,
                    boundaryExclusiveUtc: boundary.boundaryExclusiveUtc,
                  }),
                  resolvedAtUtc,
                  audit: {
                    eventId: `exclusion:${order.orderId}:${uuid()}`,
                    occurredAtUtc: resolvedAtUtc,
                  },
                });
                permanentlyIneligible.push({
                  orderId: order.orderId,
                  creationDateUtc: order.creationDateUtc,
                });
              }
            }
            if (eligible.length === 0) {
              // Every observation on this page is already resolved, so the
              // cursor can advance immediately.
              const cursor = reader.getCurrentCursor();
              const advancedAtUtc = clock();
              store.advanceOrderCursor({
                cursorAdvanceId: `cursor-advance:${uuid()}`,
                pageId,
                ordinal: (cursor?.ordinal ?? 0) + 1,
                cursorValue: cursorAfter,
                advancedAtUtc,
                audit: { eventId: `cursor:${uuid()}`, occurredAtUtc: advancedAtUtc },
              });
            }
          }

          io.stdout(JSON.stringify({
            command: 'poll',
            status: 'polled',
            watermarkBoundaryExclusiveUtc: boundary.boundaryExclusiveUtc,
            counts: {
              fetched: fetched.length,
              recordedEligible: eligible.length,
              recordedPermanentlyIneligible: permanentlyIneligible.length,
              skippedAlreadyObserved: skipped.length,
            },
            eligibleOrders: eligible,
            permanentlyIneligibleOrders: permanentlyIneligible,
            skipped,
            externalCommerceWritesAttempted: 0,
          }));
        } finally {
          reader.close();
          store.close();
        }
      } catch (error) {
        fail('poll', error);
      }
    });

  program
    .command('shadow-poll')
    .description(
      'READ-ONLY shadow parity check for the period while Marketplace Connect still owns '
      + 'order import: fetch eBay orders created in a bounded lookback window and check each '
      + 'for a Shopify order tagged eBay-<orderId>. No migration-store access (the store is '
      + 'never even opened), no eBay or Shopify write, no ceremony required, no PII. The only '
      + 'write this command can ever perform is the optional operator-named local --report-file',
    )
    .requiredOption('--max-orders <n>', 'Maximum orders to fetch this run (1-50)')
    .requiredOption(
      '--lookback-hours <n>',
      'Observe eBay orders created within the last N hours (1-168)',
    )
    .option(
      '--report-file <path>',
      'Absolute path for a JSON copy of the report (parent must exist, created 0600, '
      + 'never overwrites, never follows a symlink)',
    )
    .action(async (options: {
      maxOrders: string;
      lookbackHours: string;
      reportFile?: string;
    }) => {
      try {
        const maxOrders = Number(options.maxOrders);
        if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_POLL_ORDERS) {
          deny('SHADOW_POLL_MAX_ORDERS_INVALID');
        }
        const lookbackHours = Number(options.lookbackHours);
        if (!Number.isInteger(lookbackHours) || lookbackHours < 1
          || lookbackHours > MAX_SHADOW_LOOKBACK_HOURS) {
          deny('SHADOW_POLL_LOOKBACK_INVALID');
        }
        // Report-target prechecks run BEFORE any provider read so an invalid
        // destination never costs (or leaks the result of) a live fetch. The
        // O_EXCL open below re-enforces every one of them at write time.
        const reportFile = options.reportFile ?? null;
        if (reportFile !== null) {
          if (typeof reportFile !== 'string' || !path.isAbsolute(reportFile)) {
            deny('SHADOW_POLL_REPORT_PATH_INVALID');
          }
          let pathOccupied = true;
          try {
            fs.lstatSync(reportFile);
          } catch {
            pathOccupied = false;
          }
          // lstat: an existing symlink (even dangling) counts as occupied.
          if (pathOccupied) deny('SHADOW_POLL_REPORT_EXISTS');
          let parentIsDirectory = false;
          try {
            parentIsDirectory = fs.statSync(path.dirname(reportFile)).isDirectory();
          } catch {
            parentIsDirectory = false;
          }
          if (!parentIsDirectory) deny('SHADOW_POLL_REPORT_PARENT_MISSING');
        }

        // The lookback window replaces the watermark: this mode needs no
        // ceremony because it records nothing durably anywhere.
        const sinceUtc = new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
        const ebay = createEbayAdapter();
        let fetched: readonly PolledEbayOrder[];
        try {
          fetched = await ebay.listOrdersCreatedSince(sinceUtc, maxOrders);
        } catch {
          return deny('SHADOW_POLL_EBAY_READ_FAILED');
        }

        const shopify = createShopifyAdapter();
        const observed: Array<{
          ebayOrderId: string;
          createdAtUtc: string;
          lineItemSkus: Array<string | null>;
          shopifyMatch: { found: boolean; orderName: string | null; lookupFailed?: true };
        }> = [];
        const unmatchedEbayOrderIds: string[] = [];
        let matchedCount = 0;
        for (const order of fetched) {
          // Chosen partial-failure behavior: a failed per-order Shopify
          // lookup is reported on that order as lookupFailed (and counted
          // unmatched) instead of discarding the rest of the run.
          let shopifyMatch: { found: boolean; orderName: string | null; lookupFailed?: true };
          try {
            const gids = await shopify.findOrderGidsByTag(orderTag(order.orderId));
            shopifyMatch = gids.length > 0
              ? { found: true, orderName: gids[0]! }
              : { found: false, orderName: null };
          } catch {
            shopifyMatch = { found: false, orderName: null, lookupFailed: true };
          }
          if (shopifyMatch.found) {
            matchedCount += 1;
          } else {
            unmatchedEbayOrderIds.push(order.orderId);
          }
          // Allowed fields ONLY: order id, creation timestamp, line-item
          // SKUs, match info. Nothing else from the provider payload — and
          // never a buyer byte — reaches this object.
          observed.push({
            ebayOrderId: order.orderId,
            createdAtUtc: order.creationDateUtc,
            lineItemSkus: order.lineItems.map((line) => line.sku),
            shopifyMatch,
          });
        }

        const serialized = JSON.stringify({
          command: 'shadow-poll',
          mode: 'read-only-shadow',
          windowHours: lookbackHours,
          observed,
          summary: {
            observedCount: observed.length,
            matchedCount,
            unmatchedCount: unmatchedEbayOrderIds.length,
            unmatchedEbayOrderIds,
          },
          externalWritesPerformed: 0,
        });

        if (reportFile !== null) {
          // O_CREAT|O_EXCL ('wx'): fails on any existing path INCLUDING a
          // symlink, so the report can neither overwrite nor be redirected.
          let fd = -1;
          try {
            fd = fs.openSync(reportFile, 'wx', 0o600);
          } catch (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            deny(errno === 'EEXIST'
              ? 'SHADOW_POLL_REPORT_EXISTS'
              : errno === 'ENOENT'
                ? 'SHADOW_POLL_REPORT_PARENT_MISSING'
                : 'SHADOW_POLL_REPORT_WRITE_FAILED');
          }
          try {
            fs.writeFileSync(fd, `${serialized}\n`);
          } catch {
            deny('SHADOW_POLL_REPORT_WRITE_FAILED');
          } finally {
            fs.closeSync(fd);
          }
        }
        io.stdout(serialized);
      } catch (error) {
        fail('shadow-poll', error);
      }
    });

  program
    .command('import')
    .description(
      'Import EXACTLY ONE eligible post-watermark eBay order into Shopify: dedup pre-check by '
      + 'tag, write-scope preflight, durable one-intent/one-approval/one-job ceremony, one '
      + 'bounded orderCreate, then immediate authoritative post-verification. Every created '
      + 'Shopify order is a real Lightspeed POS event',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--order-id <id>', 'Exact eBay order id of the one order to import')
    .requiredOption(
      '--confirm-lightspeed',
      'Literal acknowledgement that this Shopify order creation cascades into Lightspeed POS',
    )
    .action(async (options: {
      migrationStore: string;
      orderId: string;
      confirmLightspeed?: boolean;
    }) => {
      try {
        if (options.confirmLightspeed !== true) deny('IMPORT_LIGHTSPEED_NOT_CONFIRMED');
        const orderId = requireOrderId(options.orderId);
        const tag = orderTag(orderId);
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const reader = openStateReader({
          databasePath: options.migrationStore,
          scopeKey,
        });
        const clock = createMonotonicClock(now);
        try {
          // (a) exactly one eligible, unresolved, unlinked observation.
          const ownership = store.getCurrentOwnership('orderImport');
          if (!ownership || ownership.owner !== 'product_pipeline'
            || !ownership.singleWriterVerified) {
            deny('IMPORT_OWNERSHIP_NOT_ESTABLISHED');
          }
          const currentOwnership = ownership as NonNullable<typeof ownership>;
          const ebayOrderIdentityKey = deriveExternalIdentityKey(ebayOrderIdentityInput(orderId));
          const observation = reader.getObservationByIdentity(ebayOrderIdentityKey);
          if (!observation) deny('IMPORT_OBSERVATION_NOT_FOUND');
          const observed = observation as NonNullable<typeof observation>;
          if (!observed.eligibleAfterWatermark
            || !store.isOrderEligible(observed.sourceCreationDateUtc)) {
            deny('IMPORT_ORDER_NOT_ELIGIBLE');
          }
          if (reader.getOrderLinkByIdentity(ebayOrderIdentityKey)) {
            deny('IMPORT_ALREADY_LINKED');
          }
          if (observed.resolved) deny('IMPORT_ALREADY_RESOLVED');

          // (b) Shopify dedup pre-check by durable tag — before any intent.
          const shopify = createShopifyAdapter();
          const existingGids = await shopify.findOrderGidsByTag(tag);
          if (existingGids.length > 0) {
            const existingGid = existingGids[0]!;
            const dedupEvidence = sha256Digest({
              schemaVersion: 1,
              type: 'order_import_dedup',
              orderId,
              tag,
              foundOrderGids: [...existingGids].sort(),
            });
            const shopifyOrderIdentityKey = ensureIdentity(
              store,
              shopifyOrderIdentityInput(existingGid),
              clock(),
            );
            const linkId = `link:${orderId}`;
            const linkedAtUtc = clock();
            store.linkObservedExistingOrder({
              linkId,
              ebayOrderIdentityKey,
              shopifyOrderIdentityKey,
              evidenceDigest: dedupEvidence,
              linkedAtUtc,
              audit: { eventId: `link:${orderId}:${uuid()}`, occurredAtUtc: linkedAtUtc },
            });
            const resolvedAtUtc = clock();
            store.resolveOrderObservation({
              resolutionId: `${observed.observationId}:linked`,
              observationId: observed.observationId,
              disposition: 'linked_existing',
              referenceKey: linkId,
              evidenceDigest: dedupEvidence,
              resolvedAtUtc,
              audit: { eventId: `linked:${orderId}:${uuid()}`, occurredAtUtc: resolvedAtUtc },
            });
            io.stdout(JSON.stringify({
              command: 'import',
              status: 'DEDUP_LINKED_EXISTING',
              orderId,
              linkId,
              shopifyOrderGid: existingGid,
              externalCommerceWritesAttempted: 0,
            }));
            return;
          }

          // (c) one fresh single-order read for current line items/shipping.
          const ebay = createEbayAdapter();
          const fresh: FetchedEbayOrder = await ebay.getOrder(orderId);
          if (!store.isOrderEligible(fresh.creationDateUtc)) deny('IMPORT_ORDER_NOT_ELIGIBLE');

          // (d) resolve every line by exact SKU; any unresolvable SKU denies
          // before any write. Shipping details stay pass-through only.
          const resolvedLines: Array<{
            sku: string;
            variantGid: string;
            quantity: number;
            cost: { value: string; currency: string } | null;
          }> = [];
          for (const line of fresh.lineItems) {
            if (line.sku === null) deny('IMPORT_SKU_UNRESOLVED');
            const variantGid = await shopify.findVariantGidBySku(line.sku as string);
            if (variantGid === null) deny('IMPORT_SKU_UNRESOLVED');
            resolvedLines.push({
              sku: line.sku as string,
              variantGid: variantGid as string,
              quantity: line.quantity,
              cost: line.cost === null ? null : { ...line.cost },
            });
          }
          const financialStatus = fresh.paymentStatus === 'PAID' ? 'PAID' : 'PENDING';
          const orderInput: Record<string, unknown> = {
            lineItems: resolvedLines.map((line) => ({
              variantId: line.variantGid,
              quantity: line.quantity,
              ...(line.cost === null ? {} : {
                priceSet: {
                  shopMoney: { amount: line.cost.value, currencyCode: line.cost.currency },
                },
              }),
            })),
            tags: ['eBay', tag],
            note: `Imported from eBay order ${orderId} by ProductPipeline order-import-admin`,
            sourceName: 'ebay',
            financialStatus,
          };
          const shipping = fresh.shippingPassthrough;
          if (shipping !== null) {
            // Pass-through ONLY: these values enter the one provider call and
            // are never persisted, logged, digested, or printed.
            const nameParts = (shipping.fullName ?? '').trim().split(/\s+/).filter(Boolean);
            orderInput.shippingAddress = {
              ...(nameParts.length > 1 ? { firstName: nameParts.slice(0, -1).join(' ') } : {}),
              ...(nameParts.length > 0 ? { lastName: nameParts[nameParts.length - 1] } : {}),
              ...(shipping.addressLine1 === null ? {} : { address1: shipping.addressLine1 }),
              ...(shipping.addressLine2 === null ? {} : { address2: shipping.addressLine2 }),
              ...(shipping.city === null ? {} : { city: shipping.city }),
              ...(shipping.stateOrProvince === null
                ? {}
                : { provinceCode: shipping.stateOrProvince }),
              ...(shipping.postalCode === null ? {} : { zip: shipping.postalCode }),
              ...(shipping.countryCode === null ? {} : { countryCode: shipping.countryCode }),
              ...(shipping.phone === null ? {} : { phone: shipping.phone }),
            };
            if (shipping.email !== null) orderInput.email = shipping.email;
          }
          // The desired-state evidence digest deliberately covers only the
          // non-PII manifest: order id, tag, resolved lines, status, totals.
          const manifestDigest = sha256Digest({
            schemaVersion: 1,
            type: 'order_import_manifest',
            orderId,
            tag,
            financialStatus,
            sourceName: 'ebay',
            total: fresh.total,
            lineItems: resolvedLines.map((line) => ({
              sku: line.sku,
              variantGid: line.variantGid,
              quantity: line.quantity,
              cost: line.cost,
            })),
          });

          // (e) write-scope preflight — fail closed BEFORE any intent exists.
          const scopes = await shopify.getInstallationScopes();
          if (!scopes.includes('write_orders')) deny('IMPORT_SHOPIFY_WRITE_SCOPE_MISSING');

          // (f) durable ceremony: one intent, one expiring approval, one
          // reserved job bound to the exact observation, one attempt.
          ensureIdentity(store, ebayOrderIdentityInput(orderId), clock());
          const intentKey = deriveIdempotencyKey({
            scopeKey,
            action: 'import_shopify_order',
            sourceIdentityKey: ebayOrderIdentityKey,
            targetIdentityKey: null,
            desiredStateDigest: manifestDigest,
          });
          if (store.getIntent(intentKey) !== null) deny('IMPORT_INTENT_ALREADY_RECORDED');
          const createdAtUtc = clock();
          store.createIdempotencyIntent({
            action: 'import_shopify_order',
            sourceIdentityKey: ebayOrderIdentityKey,
            targetIdentityKey: null,
            desiredStateDigest: manifestDigest,
            createdAtUtc,
            audit: { eventId: `intent:${intentKey.slice(7, 27)}`, occurredAtUtc: createdAtUtc },
          });
          const approvalToken = `order-import-approval:${uuid()}`;
          const issuedAtUtc = clock();
          const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + APPROVAL_TTL_MS).toISOString();
          store.issueActionApproval({
            approvalToken,
            intentKey,
            responsibility: 'orderImport',
            targetIdentityKey: ebayOrderIdentityKey,
            ownershipVersion: currentOwnership.version,
            issuedAtUtc,
            expiresAtUtc,
            evidenceDigest: manifestDigest,
            audit: { eventId: `approval:${uuid()}`, occurredAtUtc: issuedAtUtc },
          });
          const jobId = `order-import-job:${uuid()}`;
          const attemptId = `order-import-attempt:${uuid()}`;
          const reservedAtUtc = clock();
          store.reserveExecutionJob({
            jobId,
            approvalToken,
            intentKey,
            responsibility: 'orderImport',
            targetIdentityKey: ebayOrderIdentityKey,
            ownershipVersion: currentOwnership.version,
            approvalEvidenceDigest: manifestDigest,
            orderObservationId: observed.observationId,
            reservedAtUtc,
            evidenceDigest: manifestDigest,
            audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reservedAtUtc },
          });
          const dispatchAtUtc = clock();
          store.markDispatchingOutcomeUnknown({
            jobId,
            attemptId,
            approvalToken,
            approvalEvidenceDigest: manifestDigest,
            occurredAtUtc: dispatchAtUtc,
            evidenceDigest: manifestDigest,
            audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: dispatchAtUtc },
          });

          // The ONE bounded provider mutation of this invocation.
          let createdOrderGid: string | null = null;
          let userErrorsReported = false;
          let providerDispatchReported = false;
          try {
            const created = await shopify.createOrder(orderInput);
            createdOrderGid = created.orderGid;
            userErrorsReported = created.userErrorsPresent;
            providerDispatchReported = created.orderGid !== null && !created.userErrorsPresent;
          } catch {
            // Outcome unknown past the dispatch boundary: never retried
            // automatically; reconciliation decides.
          }

          // (g) reconciliation is mandatory before any terminal claim.
          const requiredAtUtc = clock();
          store.requirePostDispatchReconciliation({
            jobId,
            attemptId,
            occurredAtUtc: requiredAtUtc,
            evidenceDigest: manifestDigest,
            audit: {
              eventId: `job:${jobId}:reconciliation-required`,
              occurredAtUtc: requiredAtUtc,
            },
          });
          const verification = await runOrderPostVerify({
            store,
            shopify,
            orderId,
            ebayOrderIdentityKey,
            jobId,
            attemptId,
            createdOrderGid,
            // Never auto-terminalize an order job: `confirmed_missing`
            // requires the explicit `reconcile --accept-absent` ceremony.
            acceptAbsent: false,
            clock,
            uuid,
          });
          const resolvedExisting = verification.outcome === 'resolved_existing';
          io.stdout(JSON.stringify({
            command: 'import',
            status: resolvedExisting ? 'imported-and-reconciled' : 'dispatched-unresolved',
            orderId,
            jobId,
            attemptId,
            intentKey,
            manifestDigest,
            providerDispatchReported,
            userErrorsReported,
            outcome: verification.outcome,
            ...(resolvedExisting
              ? {
                  shopifyOrderGid: (verification as { shopifyOrderGid: string }).shopifyOrderGid,
                  orderLinkId: `link:${orderId}`,
                }
              : {}),
            ...(verification.outcome === 'unresolved' || verification.outcome === 'verify_failed'
              ? {
                  exceptionCode: (verification as { exceptionCode: string }).exceptionCode,
                  nextAction: 'run reconcile --order-id --job-id --attempt-id',
                }
              : {}),
            externalCommerceWritesAttempted: 1,
          }));
          if (!resolvedExisting) io.setExitCode(1);
        } finally {
          reader.close();
          store.close();
        }
      } catch (error) {
        fail('import', error);
      }
    });

  program
    .command('reconcile')
    .description(
      'Re-run the zero-write post-dispatch verification for an outstanding '
      + 'reconciliation_required order-import job; --accept-absent is the only way an absent '
      + 'order becomes the terminal confirmed_missing outcome',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--order-id <id>', 'Exact eBay order id printed by import')
    .requiredOption('--job-id <id>', 'Exact job id printed by import')
    .requiredOption('--attempt-id <id>', 'Exact attempt id printed by import')
    .option(
      '--accept-absent',
      'Explicitly accept a still-absent Shopify order as the terminal confirmed_missing outcome',
    )
    .action(async (options: {
      migrationStore: string;
      orderId: string;
      jobId: string;
      attemptId: string;
      acceptAbsent?: boolean;
    }) => {
      try {
        const orderId = requireOrderId(options.orderId);
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          const ebayOrderIdentityKey = deriveExternalIdentityKey(ebayOrderIdentityInput(orderId));
          const job = store.getJobStatus(options.jobId);
          if (!job) deny('RECONCILE_JOB_NOT_FOUND');
          const jobStatus = job as NonNullable<typeof job>;
          const intent = store.getIntent(jobStatus.intentKey);
          if (!intent
            || intent.action !== 'import_shopify_order'
            || intent.source_identity_key !== ebayOrderIdentityKey) {
            deny('RECONCILE_ORDER_MISMATCH');
          }
          if (jobStatus.state !== 'reconciliation_required') {
            deny('RECONCILE_JOB_NOT_AWAITING_RECONCILIATION');
          }
          const shopify = createShopifyAdapter();
          const verification = await runOrderPostVerify({
            store,
            shopify,
            orderId,
            ebayOrderIdentityKey,
            jobId: options.jobId,
            attemptId: options.attemptId,
            createdOrderGid: null,
            acceptAbsent: options.acceptAbsent === true,
            clock,
            uuid,
          });
          if (verification.outcome === 'verify_failed') {
            deny(verification.exceptionCode);
          }
          const terminal = verification.outcome === 'resolved_existing'
            || verification.outcome === 'confirmed_missing';
          io.stdout(JSON.stringify({
            command: 'reconcile',
            status: terminal ? 'reconciled' : 'unresolved',
            orderId,
            jobId: options.jobId,
            attemptId: options.attemptId,
            outcome: verification.outcome,
            reconciliationRunId: (verification as { runId: string }).runId,
            ...(verification.outcome === 'resolved_existing'
              ? {
                  shopifyOrderGid: (verification as { shopifyOrderGid: string }).shopifyOrderGid,
                  orderLinkId: `link:${orderId}`,
                }
              : {}),
            externalWritesPerformed: 0,
          }));
          if (!terminal) io.setExitCode(1);
        } finally {
          store.close();
        }
      } catch (error) {
        fail('reconcile', error);
      }
    });

  return program;
}
