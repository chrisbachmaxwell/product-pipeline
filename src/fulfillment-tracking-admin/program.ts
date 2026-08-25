import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  deriveExternalIdentityKey,
  deriveIdempotencyKey,
  deriveScopeKey,
  openMigrationStore,
  MigrationStoreError,
  sha256Digest,
  type Digest,
  type ExternalIdentityInput,
  type IntegrationScope,
  type MigrationStore,
} from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import {
  compareFulfillmentEffect,
  deriveFulfillmentManifest,
  FulfillmentManifestError,
  type DerivedFulfillmentManifest,
} from './manifest.js';
import {
  createProductionShopifyFulfillmentReader,
  ShopifyFulfillmentReadError,
  type ShopifyFulfillmentReader,
} from './shopify-fulfillment-reader.js';
import {
  createProductionEbayFulfillmentAdapter,
  EbayFulfillmentAdapterError,
  type EbayFulfillmentAdapter,
} from './ebay-fulfillment-adapter.js';

const APPROVAL_TTL_MS = 10 * 60_000;
const RAW_SHA256 = /^[a-f0-9]{64}$/;

const MIGRATION_SCOPE: IntegrationScope = Object.freeze({
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});

export type FulfillmentTrackingAdminIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  setExitCode: (code: number) => void;
};

export type FulfillmentTrackingAdminDependencies = Readonly<{
  openMigration?: typeof openMigrationStore;
  shopifyReader?: ShopifyFulfillmentReader;
  ebayAdapter?: EbayFulfillmentAdapter;
  now?: () => Date;
  uuid?: () => string;
  io?: FulfillmentTrackingAdminIo;
}>;

const defaultIo: FulfillmentTrackingAdminIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  setExitCode: (code) => { process.exitCode = code; },
};

class FulfillmentTrackingAdminError extends Error {
  constructor(readonly code: string) {
    super('Fulfillment tracking operation denied');
    this.name = 'FulfillmentTrackingAdminError';
  }
}

const deny = (code: string): never => {
  throw new FulfillmentTrackingAdminError(code);
};

function safeErrorCode(error: unknown): string {
  if (error instanceof FulfillmentTrackingAdminError) return error.code;
  if (error instanceof FulfillmentManifestError) return error.code;
  if (error instanceof ShopifyFulfillmentReadError) return error.code;
  if (error instanceof EbayFulfillmentAdapterError) return error.code;
  if (error instanceof MigrationStoreError) return `MIGRATION_STORE_${error.code}`;
  return 'FULFILLMENT_TRACKING_DENIED';
}

function digest(value: string, code: string): Digest {
  const candidate = RAW_SHA256.test(value) ? `sha256:${value}` : value;
  if (!/^sha256:[a-f0-9]{64}$/.test(candidate)) deny(code);
  return candidate as Digest;
}

function clockFrom(now: () => Date): () => string {
  let last = 0;
  return () => {
    last = Math.max(last, now().getTime());
    return new Date(last).toISOString();
  };
}

function ensureIdentity(
  store: MigrationStore,
  input: ExternalIdentityInput,
  occurredAtUtc: string,
): Digest {
  const key = deriveExternalIdentityKey(input);
  if (store.getIdentity(key) === null) {
    store.registerIdentity(input, {
      eventId: `identity:${key.slice(7, 27)}`,
      occurredAtUtc,
    });
  }
  return key;
}

function identityInputs(shopifyOrderGid: string, ebayOrderId: string): {
  source: ExternalIdentityInput;
  target: ExternalIdentityInput;
} {
  return {
    source: {
      platform: 'shopify',
      kind: 'order',
      bindingKey: `shopify-order:${shopifyOrderGid}`,
      storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
      externalGid: shopifyOrderGid,
    },
    target: {
      platform: 'ebay',
      kind: 'order',
      bindingKey: `ebay-order:${ebayOrderId}`,
      environment: MIGRATION_SCOPE.ebayEnvironment,
      sellerId: MIGRATION_SCOPE.ebaySellerId,
      marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
      externalId: ebayOrderId,
    },
  };
}

type TargetOptions = { shopifyOrderGid: string; ebayOrderId: string };

async function deriveTarget(
  shopify: ShopifyFulfillmentReader,
  ebay: EbayFulfillmentAdapter,
  options: TargetOptions,
  allowAlreadyRecorded = false,
): Promise<DerivedFulfillmentManifest> {
  const [shopifyOrder, ebayOrder] = await Promise.all([
    shopify.getOrder(options.shopifyOrderGid),
    ebay.getOrder(options.ebayOrderId),
  ]);
  return deriveFulfillmentManifest({
    shopify: shopifyOrder,
    ebay: ebayOrder,
    expectedShopifyOrderGid: options.shopifyOrderGid,
    expectedEbayOrderId: options.ebayOrderId,
    allowAlreadyRecorded,
  });
}

async function reconcile(input: {
  store: MigrationStore;
  shopify: ShopifyFulfillmentReader;
  ebay: EbayFulfillmentAdapter;
  target: TargetOptions;
  expectedManifestDigest: Digest;
  intentKey: Digest;
  targetIdentityKey: Digest;
  jobId: string;
  attemptId: string;
  acceptAbsent: boolean;
  clock: () => string;
  uuid: () => string;
}): Promise<{ effect: string; resolution: string | null; runId: string }> {
  const startedAtUtc = input.clock();
  const [shopifyOrder, ebayOrder] = await Promise.all([
    input.shopify.getOrder(input.target.shopifyOrderGid),
    input.ebay.getOrder(input.target.ebayOrderId),
  ]);
  const derived = deriveFulfillmentManifest({
    shopify: shopifyOrder,
    ebay: ebayOrder,
    expectedShopifyOrderGid: input.target.shopifyOrderGid,
    expectedEbayOrderId: input.target.ebayOrderId,
    allowAlreadyRecorded: true,
  });
  if (derived.manifestDigest !== input.expectedManifestDigest) {
    deny('FULFILLMENT_MANIFEST_DIGEST_MISMATCH');
  }
  const effect = compareFulfillmentEffect({ manifest: derived.manifest, ebay: ebayOrder });
  const completedAtUtc = input.clock();
  const runId = `fulfillment-run:${input.uuid()}`;
  const targetSnapshotDigest = sha256Digest({
    ebayOrderId: input.target.ebayOrderId,
    effect,
    fulfillmentCount: ebayOrder.shippingFulfillments.length,
  });
  const resultDigest = sha256Digest({
    schemaVersion: 1,
    manifestDigest: derived.manifestDigest,
    effect,
    targetSnapshotDigest,
  });
  const resolvable = effect === 'effect_observed' || input.acceptAbsent;
  input.store.recordReconciliationRun({
    runId,
    responsibility: 'fulfillment',
    targetIdentityKey: input.targetIdentityKey,
    mode: 'production_canary',
    status: 'passed',
    sourceSnapshotDigest: derived.manifestDigest,
    targetSnapshotDigest,
    resultDigest,
    authoritative: resolvable,
    authorityEvidenceDigest: derived.manifestDigest,
    externalWritesObserved: 0,
    startedAtUtc,
    completedAtUtc,
    exceptions: resolvable ? [] : [{
      exceptionId: `fulfillment-exception:${input.uuid()}`,
      code: 'FULFILLMENT_EFFECT_NOT_YET_OBSERVED',
      severity: 'critical',
      subjectIdentityKey: input.targetIdentityKey,
      detailsDigest: resultDigest,
    }],
    targetEffectObservation: {
      observationId: `fulfillment-observation:${input.uuid()}`,
      intentKey: input.intentKey,
      responsibility: 'fulfillment',
      effect,
      observedDigest: targetSnapshotDigest,
    },
    audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: completedAtUtc },
  });
  if (!resolvable) return { effect, resolution: null, runId };
  const resolution = effect === 'effect_observed' ? 'resolved_existing' : 'confirmed_missing';
  const reconciledAtUtc = input.clock();
  input.store.resolveUnknownAttempt({
    jobId: input.jobId,
    attemptId: input.attemptId,
    resolution,
    reconciliationRunId: runId,
    reconciliationResultDigest: resultDigest,
    reconciledAtUtc,
    audit: { eventId: `resolution:${runId}`, occurredAtUtc: reconciledAtUtc },
  });
  return { effect, resolution, runId };
}

export function buildFulfillmentTrackingAdminProgram(
  dependencies: FulfillmentTrackingAdminDependencies = {},
): Command {
  const io = dependencies.io ?? defaultIo;
  const openMigration = dependencies.openMigration ?? openMigrationStore;
  const shopify = dependencies.shopifyReader ?? createProductionShopifyFulfillmentReader();
  const ebay = dependencies.ebayAdapter ?? createProductionEbayFulfillmentAdapter();
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const program = new Command()
    .name('fulfillment-tracking-admin')
    .description('Isolated one-action full-order Shopify fulfillment to eBay tracking ceremony')
    .showHelpAfterError();

  const withTarget = (command: Command): Command => command
    .requiredOption('--shopify-order-gid <gid>', 'Exact Shopify order GID')
    .requiredOption('--ebay-order-id <id>', 'Exact eBay order ID');

  program.command('establish-ownership')
    .description('Record MC incumbent -> paused -> ProductPipeline fulfillment ownership')
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key')
    .requiredOption('--baseline-evidence <sha256>', 'Digest of MC fulfillment baseline evidence')
    .requiredOption(
      '--mc-disabled-evidence <sha256>',
      'Digest proving Marketplace Connect fulfillment behavior is off',
    )
    .action((options: {
      migrationStore: string;
      confirmScope: string;
      baselineEvidence: string;
      mcDisabledEvidence: string;
    }) => {
      try {
        if (options.confirmScope !== deriveScopeKey(MIGRATION_SCOPE)) {
          deny('FULFILLMENT_SCOPE_CONFIRMATION_MISMATCH');
        }
        const baselineEvidence = digest(options.baselineEvidence, 'FULFILLMENT_EVIDENCE_INVALID');
        const disabledEvidence = digest(
          options.mcDisabledEvidence,
          'FULFILLMENT_EVIDENCE_INVALID',
        );
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = clockFrom(now);
        try {
          let current = store.getCurrentOwnership('fulfillment');
          if (current?.owner === 'product_pipeline') {
            io.stdout(JSON.stringify({
              command: 'establish-ownership',
              status: 'already-established',
              version: current.version,
              externalWritesPerformed: 0,
            }));
            return;
          }
          if (!current) {
            const at = clock();
            store.recordOwnershipVersion({
              responsibility: 'fulfillment',
              version: 1,
              owner: 'marketplace_connect',
              singleWriterVerified: true,
              evidenceDigest: baselineEvidence,
              effectiveAtUtc: at,
              recordedAtUtc: at,
              audit: { eventId: `ownership:fulfillment:v1:${uuid()}`, occurredAtUtc: at },
            });
            current = store.getCurrentOwnership('fulfillment');
          }
          if (current?.owner === 'marketplace_connect') {
            const at = clock();
            store.recordOwnershipVersion({
              responsibility: 'fulfillment',
              version: current.version + 1,
              owner: 'paused',
              singleWriterVerified: true,
              evidenceDigest: disabledEvidence,
              effectiveAtUtc: at,
              recordedAtUtc: at,
              audit: {
                eventId: `ownership:fulfillment:v${current.version + 1}:${uuid()}`,
                occurredAtUtc: at,
              },
            });
            current = store.getCurrentOwnership('fulfillment');
          }
          if (current?.owner !== 'paused') deny('FULFILLMENT_OWNERSHIP_CHAIN_INVALID');
          const at = clock();
          store.recordOwnershipVersion({
            responsibility: 'fulfillment',
            version: current.version + 1,
            owner: 'product_pipeline',
            singleWriterVerified: true,
            evidenceDigest: disabledEvidence,
            effectiveAtUtc: at,
            recordedAtUtc: at,
            audit: {
              eventId: `ownership:fulfillment:v${current.version + 1}:${uuid()}`,
              occurredAtUtc: at,
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
        io.stderr(JSON.stringify({
          command: 'establish-ownership', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    });

  withTarget(program.command('preflight')
    .description('Read both orders and print a redacted deterministic full-order manifest preview'))
    .action(async (options: TargetOptions) => {
      try {
        const derived = await deriveTarget(shopify, ebay, options);
        io.stdout(JSON.stringify({
          command: 'preflight',
          status: 'preview',
          manifestDigest: derived.manifestDigest,
          shopifyOrderGid: derived.manifest.shopifyOrderGid,
          ebayOrderId: derived.manifest.ebayOrderId,
          shopifyFulfillmentGid: derived.manifest.shopifyFulfillmentGid,
          shippedDate: derived.manifest.shippedDate,
          shippingCarrierCode: derived.manifest.shippingCarrierCode,
          trackingPresent: true,
          lineItemCount: derived.manifest.lineItems.length,
          externalWritesPerformed: 0,
        }));
        io.setExitCode(2);
      } catch (error) {
        io.stderr(JSON.stringify({
          command: 'preflight', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    }));

  withTarget(program.command('dispatch')
    .description('One-action exact-order dispatch with durable approval and reconciliation'))
    .requiredOption('--manifest-digest <sha256>', 'Exact digest printed by preflight')
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .action(async (options: TargetOptions & { manifestDigest: string; migrationStore: string }) => {
      try {
        const expectedDigest = digest(
          options.manifestDigest,
          'FULFILLMENT_MANIFEST_DIGEST_INVALID',
        );
        const derived = await deriveTarget(shopify, ebay, options);
        if (derived.manifestDigest !== expectedDigest) {
          deny('FULFILLMENT_MANIFEST_DIGEST_MISMATCH');
        }
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = clockFrom(now);
        try {
          const ownership = store.getCurrentOwnership('fulfillment');
          if (ownership?.owner !== 'product_pipeline' || !ownership.singleWriterVerified) {
            deny('FULFILLMENT_OWNERSHIP_NOT_ESTABLISHED');
          }
          const identities = identityInputs(options.shopifyOrderGid, options.ebayOrderId);
          const sourceIdentityKey = ensureIdentity(store, identities.source, clock());
          const targetIdentityKey = ensureIdentity(store, identities.target, clock());
          const intentKey = deriveIdempotencyKey({
            scopeKey: deriveScopeKey(MIGRATION_SCOPE),
            action: 'sync_fulfillment',
            sourceIdentityKey,
            targetIdentityKey,
            desiredStateDigest: expectedDigest,
          });
          if (store.getIntent(intentKey) !== null) deny('FULFILLMENT_INTENT_ALREADY_RECORDED');
          const createdAtUtc = clock();
          store.createIdempotencyIntent({
            action: 'sync_fulfillment',
            sourceIdentityKey,
            targetIdentityKey,
            desiredStateDigest: expectedDigest,
            createdAtUtc,
            audit: { eventId: `intent:${intentKey.slice(7, 27)}`, occurredAtUtc: createdAtUtc },
          });
          const approvalToken = `fulfillment-approval:${uuid()}`;
          const issuedAtUtc = clock();
          const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + APPROVAL_TTL_MS).toISOString();
          store.issueActionApproval({
            approvalToken,
            intentKey,
            responsibility: 'fulfillment',
            targetIdentityKey,
            ownershipVersion: ownership.version,
            issuedAtUtc,
            expiresAtUtc,
            evidenceDigest: expectedDigest,
            audit: { eventId: `approval:${uuid()}`, occurredAtUtc: issuedAtUtc },
          });
          const jobId = `fulfillment-job:${uuid()}`;
          const attemptId = `fulfillment-attempt:${uuid()}`;
          const reservedAtUtc = clock();
          store.reserveExecutionJob({
            jobId,
            approvalToken,
            intentKey,
            responsibility: 'fulfillment',
            targetIdentityKey,
            ownershipVersion: ownership.version,
            approvalEvidenceDigest: expectedDigest,
            reservedAtUtc,
            evidenceDigest: expectedDigest,
            audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reservedAtUtc },
          });
          const dispatchAtUtc = clock();
          store.markDispatchingOutcomeUnknown({
            jobId,
            attemptId,
            approvalToken,
            approvalEvidenceDigest: expectedDigest,
            occurredAtUtc: dispatchAtUtc,
            evidenceDigest: expectedDigest,
            audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: dispatchAtUtc },
          });
          let providerDispatchReported = true;
          try {
            await ebay.createShippingFulfillment(derived.manifest);
          } catch {
            providerDispatchReported = false;
          }
          const requiredAtUtc = clock();
          store.requirePostDispatchReconciliation({
            jobId,
            attemptId,
            occurredAtUtc: requiredAtUtc,
            evidenceDigest: expectedDigest,
            audit: {
              eventId: `job:${jobId}:reconciliation-required`,
              occurredAtUtc: requiredAtUtc,
            },
          });
          const result = await reconcile({
            store,
            shopify,
            ebay,
            target: options,
            expectedManifestDigest: expectedDigest,
            intentKey,
            targetIdentityKey,
            jobId,
            attemptId,
            acceptAbsent: false,
            clock,
            uuid,
          });
          io.stdout(JSON.stringify({
            command: 'dispatch',
            status: result.resolution === 'resolved_existing'
              ? 'dispatched-and-reconciled'
              : 'dispatched-unresolved',
            jobId,
            attemptId,
            intentKey,
            manifestDigest: expectedDigest,
            providerDispatchReported,
            effect: result.effect,
            resolution: result.resolution,
            reconciliationRunId: result.runId,
            externalCommerceWritesAttempted: 1,
          }));
          if (result.resolution !== 'resolved_existing') io.setExitCode(1);
        } finally {
          store.close();
        }
      } catch (error) {
        io.stderr(JSON.stringify({
          command: 'dispatch', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    }));

  withTarget(program.command('reconcile')
    .description('Re-read eBay for one outstanding job; never writes to either provider')
    .requiredOption('--manifest-digest <sha256>', 'Exact digest printed by preflight')
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--job-id <id>', 'Exact job ID printed by dispatch')
    .requiredOption('--attempt-id <id>', 'Exact attempt ID printed by dispatch')
    .option('--accept-absent', 'Explicitly terminalize a still-absent effect as confirmed_missing')
    .action(async (options: TargetOptions & {
      manifestDigest: string;
      migrationStore: string;
      jobId: string;
      attemptId: string;
      acceptAbsent?: boolean;
    }) => {
      try {
        const expectedDigest = digest(
          options.manifestDigest,
          'FULFILLMENT_MANIFEST_DIGEST_INVALID',
        );
        const identities = identityInputs(options.shopifyOrderGid, options.ebayOrderId);
        const sourceIdentityKey = deriveExternalIdentityKey(identities.source);
        const targetIdentityKey = deriveExternalIdentityKey(identities.target);
        const intentKey = deriveIdempotencyKey({
          scopeKey: deriveScopeKey(MIGRATION_SCOPE),
          action: 'sync_fulfillment',
          sourceIdentityKey,
          targetIdentityKey,
          desiredStateDigest: expectedDigest,
        });
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = clockFrom(now);
        try {
          if (store.getIntent(intentKey) === null) deny('FULFILLMENT_INTENT_NOT_FOUND');
          const result = await reconcile({
            store,
            shopify,
            ebay,
            target: options,
            expectedManifestDigest: expectedDigest,
            intentKey,
            targetIdentityKey,
            jobId: options.jobId,
            attemptId: options.attemptId,
            acceptAbsent: options.acceptAbsent === true,
            clock,
            uuid,
          });
          io.stdout(JSON.stringify({
            command: 'reconcile',
            status: result.resolution === null ? 'unresolved' : 'reconciled',
            jobId: options.jobId,
            attemptId: options.attemptId,
            effect: result.effect,
            resolution: result.resolution,
            reconciliationRunId: result.runId,
            externalWritesPerformed: 0,
          }));
          if (result.resolution === null) io.setExitCode(1);
        } finally {
          store.close();
        }
      } catch (error) {
        io.stderr(JSON.stringify({
          command: 'reconcile', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    }));

  return program;
}
