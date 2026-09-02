/**
 * Isolated price/inventory alignment operator CLI — the Marketplace Connect
 * replacement slice for the `price` and `inventory` responsibilities.
 *
 * It is never imported or mounted by the server. One `dispatch` invocation
 * is the one-action, exact-target operator approval: the operator must name
 * the exact catalog row, SKU, listing id, offer id (the literal `none` for a
 * Trading-model target, which has no offer), the one field (`price` or
 * `quantity`), AND the manifest digest previously printed by `plan`. Any
 * mismatch, moved drift, missing ownership, consumed approval, or foreign
 * target fails closed before a provider write. Every intent, approval, job,
 * attempt, reconciliation run, and resolution is recorded durably in the
 * migration-state store's hash-chained audit before and after the one
 * bounded provider call.
 *
 * OWNERSHIP: Marketplace Connect is the verified production incumbent for
 * price and inventory sync. `establish-ownership` is the transfer ceremony
 * and REQUIRES the operator-supplied Marketplace-Connect-disabled evidence
 * digest — the proof that 'Sync price' / 'Sync inventory' was unchecked in
 * Marketplace Connect BEFORE ProductPipeline may own the responsibility. Two
 * live writers must never coexist. See docs/PRICE_INVENTORY_DISPATCH.md.
 */
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  deriveExternalIdentityKey,
  deriveIdempotencyKey,
  deriveScopeKey,
  openMigrationStore,
  MigrationStoreError,
  type Digest as MigrationDigest,
  type ExternalIdentityInput,
  type IntegrationScope,
  type MigrationStore,
} from '../migration-store/index.js';
import { sha256Digest, type ListingIdentity } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import {
  deriveListingDraftBasis,
  type ListingDraftBasis,
} from '../server/listing-draft-service.js';
import { readListingWorkspace } from '../server/listing-workspace-reader.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';
import { getLiveListingCatalogSnapshot } from '../server/live-listing-catalog-source.js';
import type { LiveListingCatalogSnapshot } from '../server/live-listing-catalog.js';
import {
  openQuantityBeliefStore,
  type QuantityBeliefStore,
} from './quantity-beliefs.js';
import {
  compareAlignedState,
  deriveAlignmentManifest,
  parseAlignmentPrice,
  parseAlignmentQuantity,
  reconstructAlignmentManifest,
  AlignmentManifestError,
  type AlignmentField,
  type DerivedAlignmentManifest,
} from './manifest.js';
import {
  createPriceInventoryDispatchAdapter,
  createProductionDispatchTokenProvider,
  AlignDispatchError,
  type PriceInventoryDispatchAdapter,
} from './dispatch-adapter.js';
import {
  createTradingAlignDispatchAdapter,
  TradingAlignDispatchError,
  type TradingAlignDispatchAdapter,
} from './trading-dispatch-adapter.js';

const APPROVAL_TTL_MS = 10 * 60_000;

export type PriceInventoryAdminIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  setExitCode: (code: number) => void;
};

const defaultIo: PriceInventoryAdminIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export type PriceInventoryAdminDependencies = Readonly<{
  readWorkspace?: (catalogId: string) => Promise<ListingWorkspaceDto>;
  openMigration?: typeof openMigrationStore;
  createAdapter?: () => PriceInventoryDispatchAdapter;
  createTradingAdapter?: () => TradingAlignDispatchAdapter;
  /** Catalog enumeration for `align-sweep`; unused by the one-action path. */
  getSnapshot?: () => Promise<LiveListingCatalogSnapshot>;
  /** Quantity-belief cache for `align-sweep`; unused by the one-action path. */
  openBeliefs?: (databasePath: string) => QuantityBeliefStore;
  now?: () => Date;
  uuid?: () => string;
  io?: PriceInventoryAdminIo;
}>;

/**
 * Hard ceiling on provider writes per sweep, independent of --max-actions.
 * A runaway sweep is the failure mode that matters here: this bounds it even
 * if the flag is set absurdly high.
 */
const SWEEP_HARD_CAP = 50;
const SWEEP_DEFAULT_CAP = 10;

const MIGRATION_SCOPE: IntegrationScope = Object.freeze({
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});

/** field -> migration-store responsibility and intent action. */
const FIELD_RESPONSIBILITY = Object.freeze({
  price: 'price',
  quantity: 'inventory',
} as const);
const FIELD_ACTION = Object.freeze({
  price: 'update_ebay_price',
  quantity: 'update_ebay_inventory',
} as const);
const ESTABLISHABLE_RESPONSIBILITIES = Object.freeze(['price', 'inventory'] as const);
type EstablishableResponsibility = (typeof ESTABLISHABLE_RESPONSIBILITIES)[number];

class PriceInventoryAdminError extends Error {
  constructor(readonly code: string) {
    super('Price/inventory alignment operation denied');
    this.name = 'PriceInventoryAdminError';
  }
}

const deny = (code: string): never => {
  throw new PriceInventoryAdminError(code);
};

function safeErrorCode(error: unknown): string {
  if (error instanceof PriceInventoryAdminError) return error.code;
  if (error instanceof AlignmentManifestError) return error.code;
  if (error instanceof AlignDispatchError) return error.code;
  if (error instanceof TradingAlignDispatchError) return error.code;
  if (error instanceof MigrationStoreError) return `MIGRATION_STORE_${error.code}`;
  return 'PRICE_INVENTORY_DENIED';
}

type ExactTargetOptions = {
  catalogId: string;
  sku: string;
  listingId: string;
  offerId: string;
  field: string;
};

type DerivedTarget = {
  basis: ListingDraftBasis;
  field: AlignmentField;
  derived: DerivedAlignmentManifest;
};

/**
 * Exact-target offer-id acceptance: an inventory-model target must be named
 * by its exact offer id, while a Trading-model target (which has no offer)
 * must be named with the literal `none` — any other combination is a
 * mismatch, so `none` can never select an inventory-managed listing.
 */
function exactOfferIdMatches(ebayOfferId: string | null, optionValue: string): boolean {
  return ebayOfferId === null ? optionValue === 'none' : ebayOfferId === optionValue;
}

function exactField(value: string): AlignmentField {
  if (value !== 'price' && value !== 'quantity') deny('PLAN_FIELD_INVALID');
  return value as AlignmentField;
}

function createMonotonicClock(now: () => Date): () => string {
  let lastMs = 0;
  return () => {
    const currentMs = Math.max(now().getTime(), lastMs);
    lastMs = currentMs;
    return new Date(currentMs).toISOString();
  };
}

function assertExactTarget(basis: ListingDraftBasis, options: ExactTargetOptions): void {
  const identity = basis.identity;
  if (identity.rawSku !== options.sku
    || identity.ebayListingId !== options.listingId
    || !exactOfferIdMatches(identity.ebayOfferId, options.offerId)) {
    deny('REALIGN_EXACT_TARGET_MISMATCH');
  }
}

async function deriveExactTarget(
  readWorkspace: (catalogId: string) => Promise<ListingWorkspaceDto>,
  options: ExactTargetOptions,
): Promise<DerivedTarget> {
  const field = exactField(options.field);
  const workspaceDto = await readWorkspace(options.catalogId);
  const basis = deriveListingDraftBasis(workspaceDto);
  assertExactTarget(basis, options);
  const derived = deriveAlignmentManifest({ basis, field });
  return { basis, field, derived };
}

/**
 * The Quantity value to send in a Trading `ReviseInventoryStatus`.
 *
 * Shopify tracks AVAILABLE stock. eBay Trading tracks TOTAL listed quantity
 * and derives available as `total - sold` — the workspace reports exactly
 * that, with `availableQuantityBasis: 'total_minus_sold'`. Drift is detected
 * on available (correctly), but writing the Shopify available figure straight
 * into `Quantity` sets the TOTAL, so on a listing with sales the result is
 * always short by the sold count and the drift can never close.
 *
 * Observed in Production on SKU 16437396: Shopify available 106, eBay total
 * 102 / sold 2 / available 100. Writing 106 would leave available at 104, so
 * the identical manifest re-derives on the next sweep — and because the
 * intent key is the manifest digest, idempotency then blocks the listing from
 * ever being re-aligned (REALIGN_INTENT_ALREADY_RECORDED).
 *
 * Adding the sold count makes AVAILABLE converge, which is the quantity that
 * actually matters to a buyer. Inventory-API offers are unaffected: that path
 * sets availableQuantity directly and needs no adjustment.
 */
export function tradingQuantityToWrite(
  target: DerivedTarget,
  availableAfter: number,
): number {
  const commerce = target.basis.workspace?.ebayDetail?.actual.commerce;
  const sold = commerce?.soldQuantity;
  // Only adjust when eBay actually reported available as total-minus-sold.
  // If eBay reported available directly, Quantity already means available.
  if (commerce?.availableQuantityBasis !== 'total_minus_sold') return availableAfter;
  if (!Number.isSafeInteger(sold) || (sold as number) < 0) return availableAfter;
  return availableAfter + (sold as number);
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

/**
 * Store identities exactly as `assertActionIdentityShape` requires:
 * `update_ebay_price` is keyed Shopify variant -> eBay offer (inventory
 * model) or eBay listing (Trading model); `update_ebay_inventory` is keyed
 * Shopify variant -> eBay inventory SKU for both models.
 */
function alignmentIdentityInputs(identity: ListingIdentity, field: AlignmentField): {
  source: ExternalIdentityInput;
  target: ExternalIdentityInput;
} {
  const source: ExternalIdentityInput = {
    platform: 'shopify',
    kind: 'variant',
    bindingKey: `shopify-variant:${identity.shopifyVariantGid}`,
    storeDomain: MIGRATION_SCOPE.shopifyStoreDomain,
    externalGid: identity.shopifyVariantGid,
  };
  const ebayBase = {
    platform: 'ebay' as const,
    environment: MIGRATION_SCOPE.ebayEnvironment,
    sellerId: MIGRATION_SCOPE.ebaySellerId,
    marketplaceId: MIGRATION_SCOPE.ebayMarketplaceId,
  };
  if (field === 'quantity') {
    return {
      source,
      target: {
        ...ebayBase,
        kind: 'inventory_sku',
        bindingKey: `ebay-inventory-sku:${identity.rawSku}`,
        externalId: identity.rawSku,
      },
    };
  }
  return {
    source,
    target: identity.ebayOfferId !== null
      ? {
        ...ebayBase,
        kind: 'offer',
        bindingKey: `ebay-offer:${identity.ebayOfferId}`,
        externalId: identity.ebayOfferId,
      }
      : {
        ...ebayBase,
        kind: 'listing',
        bindingKey: `ebay-listing:${identity.ebayListingId}`,
        externalId: identity.ebayListingId as string,
      },
  };
}

function manifestSummary(target: DerivedTarget): Record<string, unknown> {
  const { manifest, manifestDigest } = target.derived;
  return {
    manifestDigest,
    field: manifest.field,
    responsibility: FIELD_RESPONSIBILITY[manifest.field],
    identity: manifest.identity,
    drift: { before: manifest.before, after: manifest.after },
    manifest,
    externalWritesPerformed: 0,
  };
}

async function runReconciliation(input: {
  store: MigrationStore;
  derived: DerivedAlignmentManifest;
  field: AlignmentField;
  intentKey: MigrationDigest;
  targetIdentityKey: MigrationDigest;
  jobId: string;
  attemptId: string;
  readWorkspace: (catalogId: string) => Promise<ListingWorkspaceDto>;
  catalogId: string;
  clock: () => string;
  uuid: () => string;
  /**
   * `confirmed_missing` is a terminal claim. It may be recorded only when
   * the provider itself reported the dispatch failed (immediate
   * post-dispatch path) or when the operator explicitly accepts absence
   * after the observation window (`reconcile --accept-absent`). An absent
   * state without that authority stays unresolved so propagation delay can
   * never terminalize a job prematurely.
   */
  resolveAbsent: boolean;
}): Promise<{ effect: string; resolution: string | null; runId: string }> {
  const responsibility = FIELD_RESPONSIBILITY[input.field];
  const startedAtUtc = input.clock();
  const freshDto = await input.readWorkspace(input.catalogId);
  const freshBasis = deriveListingDraftBasis(freshDto);
  const comparison = compareAlignedState({
    manifest: input.derived.manifest,
    freshBasis,
  });
  const completedAtUtc = input.clock();
  const runId = `price-inventory-run:${input.uuid()}`;
  const resultDigest = sha256Digest({
    schemaVersion: 1,
    manifestDigest: input.derived.manifestDigest,
    field: input.field,
    effect: comparison.effect,
    observedValue: comparison.observedValue,
    freshEbayDigest: freshBasis.ebayDigest,
  });
  const resolvable = comparison.effect === 'effect_observed'
    || (comparison.effect === 'effect_absent' && input.resolveAbsent);
  const exceptions = [];
  if (!resolvable) {
    exceptions.push({
      exceptionId: `price-inventory-exception:${input.uuid()}`,
      code: 'ALIGNED_STATE_NOT_YET_OBSERVED',
      severity: 'critical' as const,
      subjectIdentityKey: input.targetIdentityKey,
      detailsDigest: resultDigest,
    });
  }
  input.store.recordReconciliationRun({
    runId,
    responsibility,
    targetIdentityKey: input.targetIdentityKey,
    mode: 'production_canary',
    status: 'passed',
    sourceSnapshotDigest: input.derived.manifestDigest,
    targetSnapshotDigest: freshBasis.ebayDigest,
    resultDigest,
    authoritative: resolvable,
    authorityEvidenceDigest: input.derived.manifestDigest,
    externalWritesObserved: 0,
    startedAtUtc,
    completedAtUtc,
    exceptions,
    targetEffectObservation: {
      observationId: `price-inventory-observation:${input.uuid()}`,
      intentKey: input.intentKey,
      responsibility,
      effect: comparison.effect,
      observedDigest: freshBasis.ebayDigest,
    },
    audit: { eventId: `reconciliation:${runId}`, occurredAtUtc: completedAtUtc },
  });
  if (!resolvable) {
    return { effect: comparison.effect, resolution: null, runId };
  }
  const resolution = comparison.effect === 'effect_observed'
    ? 'resolved_existing' as const
    : 'confirmed_missing' as const;
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
  return { effect: comparison.effect, resolution, runId };
}

export function buildPriceInventoryAdminProgram(
  dependencies: PriceInventoryAdminDependencies = {},
): Command {
  const io = dependencies.io ?? defaultIo;
  const readWorkspace = dependencies.readWorkspace ?? readListingWorkspace;
  const openMigration = dependencies.openMigration ?? openMigrationStore;
  const createAdapter = dependencies.createAdapter ?? (() =>
    createPriceInventoryDispatchAdapter({
      getAccessToken: createProductionDispatchTokenProvider(),
    }));
  const createTradingAdapter = dependencies.createTradingAdapter ?? (() =>
    createTradingAlignDispatchAdapter({
      getAccessToken: createProductionDispatchTokenProvider(),
    }));
  const getSnapshot = dependencies.getSnapshot ?? getLiveListingCatalogSnapshot;
  const openBeliefs = dependencies.openBeliefs ?? openQuantityBeliefStore;
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;

  /**
   * THE single alignment write path. Both the one-action `dispatch` ceremony
   * and the batched `align-sweep` call exactly this, so automation can never
   * become a second, divergent writer with weaker checks: the ownership
   * precheck, the idempotent intent, the single-use approval, the job
   * reservation, the one bounded provider call, and the post-dispatch
   * reconciliation are identical either way, and every action lands in the
   * audit chain individually.
   *
   * The caller owns the store handle so a sweep can run many actions against
   * one open store without reopening it per target.
   */
  async function dispatchOneAlignment(input: {
    store: ReturnType<typeof openMigration>;
    target: Awaited<ReturnType<typeof deriveExactTarget>>;
    catalogId: string;
    clock: () => string;
  }): Promise<Record<string, unknown>> {
    const { store, target, clock } = input;
    const responsibility = FIELD_RESPONSIBILITY[target.field];
    const action = FIELD_ACTION[target.field];
    const ownership = store.getCurrentOwnership(responsibility);
    if (!ownership || ownership.owner !== 'product_pipeline'
      || !ownership.singleWriterVerified) {
      deny('REALIGN_OWNERSHIP_NOT_ESTABLISHED');
    }
    const identityInputs = alignmentIdentityInputs(target.basis.identity, target.field);
    const sourceIdentityKey = ensureIdentity(store, identityInputs.source, clock());
    const targetIdentityKey = ensureIdentity(store, identityInputs.target, clock());
    const intentKey = deriveIdempotencyKey({
      scopeKey: deriveScopeKey(MIGRATION_SCOPE),
      action,
      sourceIdentityKey,
      targetIdentityKey,
      desiredStateDigest: target.derived.manifestDigest,
    });
    if (store.getIntent(intentKey) !== null) {
      deny('REALIGN_INTENT_ALREADY_RECORDED');
    }
    const createdAtUtc = clock();
    store.createIdempotencyIntent({
      action,
      sourceIdentityKey,
      targetIdentityKey,
      desiredStateDigest: target.derived.manifestDigest,
      createdAtUtc,
      audit: { eventId: `intent:${intentKey.slice(7, 27)}`, occurredAtUtc: createdAtUtc },
    });
    const approvalToken = `price-inventory-approval:${uuid()}`;
    const issuedAtUtc = clock();
    const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + APPROVAL_TTL_MS).toISOString();
    const ownershipVersion = (ownership as NonNullable<typeof ownership>).version;
    store.issueActionApproval({
      approvalToken,
      intentKey,
      responsibility,
      targetIdentityKey,
      ownershipVersion,
      issuedAtUtc,
      expiresAtUtc,
      evidenceDigest: target.derived.manifestDigest,
      audit: { eventId: `approval:${uuid()}`, occurredAtUtc: issuedAtUtc },
    });
    const jobId = `price-inventory-job:${uuid()}`;
    const attemptId = `price-inventory-attempt:${uuid()}`;
    const reservedAtUtc = clock();
    store.reserveExecutionJob({
      jobId,
      approvalToken,
      intentKey,
      responsibility,
      targetIdentityKey,
      ownershipVersion,
      approvalEvidenceDigest: target.derived.manifestDigest,
      reservedAtUtc,
      evidenceDigest: target.derived.manifestDigest,
      audit: { eventId: `job:${jobId}:reserved`, occurredAtUtc: reservedAtUtc },
    });

    const dispatchAtUtc = clock();
    store.markDispatchingOutcomeUnknown({
      jobId,
      attemptId,
      approvalToken,
      approvalEvidenceDigest: target.derived.manifestDigest,
      occurredAtUtc: dispatchAtUtc,
      evidenceDigest: target.derived.manifestDigest,
      audit: { eventId: `job:${jobId}:dispatching`, occurredAtUtc: dispatchAtUtc },
    });

    // Exactly ONE bounded provider call per dispatch, chosen by the
    // target's management model.
    let dispatchFailed = false;
    const identity = target.basis.identity;
    const after = target.derived.manifest.after;
    try {
      if (identity.managementModel === 'inventory_api') {
        const adapter = createAdapter();
        if (target.field === 'price') {
          await adapter.updateOfferPrice({
            sku: identity.ebayInventorySku as string,
            offerId: identity.ebayOfferId as string,
            price: parseAlignmentPrice(after),
          });
        } else {
          await adapter.updateOfferQuantity({
            sku: identity.ebayInventorySku as string,
            offerId: identity.ebayOfferId as string,
            quantity: parseAlignmentQuantity(after),
          });
        }
      } else {
        const tradingAdapter = createTradingAdapter();
        await tradingAdapter.reviseInventoryStatus(target.field === 'price'
          ? {
            listingId: identity.ebayListingId as string,
            field: 'price',
            price: parseAlignmentPrice(after),
          }
          : {
            listingId: identity.ebayListingId as string,
            field: 'quantity',
            quantity: tradingQuantityToWrite(target, parseAlignmentQuantity(after)),
          });
      }
    } catch {
      dispatchFailed = true;
    }

    const requiredAtUtc = clock();
    store.requirePostDispatchReconciliation({
      jobId,
      attemptId,
      occurredAtUtc: requiredAtUtc,
      evidenceDigest: target.derived.manifestDigest,
      audit: {
        eventId: `job:${jobId}:reconciliation-required`,
        occurredAtUtc: requiredAtUtc,
      },
    });

    const reconciliation = await runReconciliation({
      store,
      derived: target.derived,
      field: target.field,
      intentKey,
      targetIdentityKey,
      jobId,
      attemptId,
      readWorkspace,
      catalogId: input.catalogId,
      clock,
      uuid,
      resolveAbsent: dispatchFailed,
    });
    return {
      status: reconciliation.resolution === 'resolved_existing'
        ? 'dispatched-and-reconciled'
        : 'dispatched-unresolved',
      jobId,
      attemptId,
      intentKey,
      field: target.field,
      responsibility,
      manifestDigest: target.derived.manifestDigest,
      providerDispatchReported: !dispatchFailed,
      effect: reconciliation.effect,
      resolution: reconciliation.resolution,
      reconciliationRunId: reconciliation.runId,
      externalCommerceWritesAttempted: 1,
    };
  }

  const program = new Command();
  program
    .name('price-inventory-admin')
    .description(
      'Isolated one-action price/inventory alignment dispatch for exactly one eBay listing',
    )
    .showHelpAfterError();

  const withTargetOptions = (command: Command): Command => command
    .requiredOption('--catalog-id <id>', 'Exact listings catalog row id')
    .requiredOption('--sku <sku>', 'Exact raw SKU of the one target')
    .requiredOption('--listing-id <id>', 'Exact eBay listing id of the one target')
    .requiredOption(
      '--offer-id <id>',
      'Exact eBay offer id of the one target, or the literal "none" for a Trading-model target',
    )
    .requiredOption('--field <field>', 'Exactly one aligned field: "price" or "quantity"');

  program
    .command('establish-ownership')
    .description(
      'Record the staged marketplace_connect -> paused -> product_pipeline ownership chain for '
      + 'one responsibility, requiring Marketplace-Connect-disabled evidence',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
    .requiredOption(
      '--responsibility <responsibility>',
      'Exactly one responsibility to transfer: "price" or "inventory"',
    )
    .requiredOption(
      '--baseline-evidence <sha256>',
      'Digest of the reviewed Marketplace Connect incumbent baseline evidence',
    )
    .requiredOption(
      '--mc-disabled-evidence <sha256>',
      'Digest of the recorded proof that the Marketplace Connect sync toggle for this '
      + 'responsibility is unchecked (REQUIRED before any transfer)',
    )
    .action((options: {
      migrationStore: string;
      confirmScope: string;
      responsibility: string;
      baselineEvidence: string;
      mcDisabledEvidence: string;
    }) => {
      try {
        if (!ESTABLISHABLE_RESPONSIBILITIES.includes(
          options.responsibility as EstablishableResponsibility,
        )) {
          deny('REALIGN_RESPONSIBILITY_INVALID');
        }
        const responsibility = options.responsibility as EstablishableResponsibility;
        if (options.confirmScope !== deriveScopeKey(MIGRATION_SCOPE)) {
          deny('REALIGN_SCOPE_CONFIRMATION_MISMATCH');
        }
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          let current = store.getCurrentOwnership(responsibility);
          if (current && current.owner === 'product_pipeline') {
            io.stdout(JSON.stringify({
              command: 'establish-ownership', status: 'already-established',
              responsibility, version: current.version, externalWritesPerformed: 0,
            }));
            return;
          }
          if (!current) {
            // Truthful v1 genesis: Marketplace Connect is the verified
            // production incumbent for price and inventory.
            const genesisAt = clock();
            store.recordOwnershipVersion({
              responsibility,
              version: 1,
              owner: 'marketplace_connect',
              singleWriterVerified: true,
              evidenceDigest: options.baselineEvidence,
              effectiveAtUtc: genesisAt,
              recordedAtUtc: genesisAt,
              audit: {
                eventId: `ownership:${responsibility}:v1:${uuid()}`,
                occurredAtUtc: genesisAt,
              },
            });
            current = store.getCurrentOwnership(responsibility);
          }
          if (current && current.owner === 'marketplace_connect') {
            // The staged pause requires the Marketplace-Connect-disabled
            // proof: the operator unchecked the sync toggle first.
            const pauseAt = clock();
            store.recordOwnershipVersion({
              responsibility,
              version: current.version + 1,
              owner: 'paused',
              singleWriterVerified: true,
              evidenceDigest: options.mcDisabledEvidence,
              effectiveAtUtc: pauseAt,
              recordedAtUtc: pauseAt,
              audit: {
                eventId: `ownership:${responsibility}:v${current.version + 1}:${uuid()}`,
                occurredAtUtc: pauseAt,
              },
            });
            current = store.getCurrentOwnership(responsibility);
          }
          if (!current || current.owner !== 'paused') {
            throw new PriceInventoryAdminError('REALIGN_OWNERSHIP_CHAIN_INVALID');
          }
          const transferAt = clock();
          store.recordOwnershipVersion({
            responsibility,
            version: current.version + 1,
            owner: 'product_pipeline',
            singleWriterVerified: true,
            evidenceDigest: options.mcDisabledEvidence,
            effectiveAtUtc: transferAt,
            recordedAtUtc: transferAt,
            audit: {
              eventId: `ownership:${responsibility}:v${current.version + 1}:${uuid()}`,
              occurredAtUtc: transferAt,
            },
          });
          io.stdout(JSON.stringify({
            command: 'establish-ownership', status: 'established',
            responsibility, version: current.version + 1, externalWritesPerformed: 0,
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

  withTargetOptions(program
    .command('plan')
    .description(
      'Derive and print the exact drift and alignment manifest without any store or provider '
      + 'write',
    ))
    .action(async (options: ExactTargetOptions) => {
      try {
        const target = await deriveExactTarget(readWorkspace, options);
        io.stdout(JSON.stringify({
          command: 'plan',
          status: 'preview',
          ...manifestSummary(target),
        }));
        io.setExitCode(2);
      } catch (error) {
        io.stderr(JSON.stringify({
          command: 'plan', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    });

  withTargetOptions(program
    .command('dispatch')
    .description(
      'One-action exact-target alignment of one field to eBay, with durable idempotent job '
      + 'state and immediate post-action reconciliation',
    ))
    .requiredOption('--manifest-digest <sha256>', 'Exact manifest digest printed by plan')
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .action(async (options: ExactTargetOptions & {
      manifestDigest: string;
      migrationStore: string;
    }) => {
      try {
        const target = await deriveExactTarget(readWorkspace, options);
        if (target.derived.manifestDigest !== options.manifestDigest) {
          deny('REALIGN_MANIFEST_DIGEST_MISMATCH');
        }
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          const result = await dispatchOneAlignment({
            store, target, catalogId: options.catalogId, clock,
          });
          io.stdout(JSON.stringify({ command: 'dispatch', ...result }));
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
    });


  program
    .command('align-sweep')
    .description(
      'Batched delta-only alignment of ONE field across every drifting listing, using the '
      + 'identical per-target write path as dispatch. Bounded, kill-switchable, journaled.',
    )
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the one store')
    .requiredOption('--field <field>', 'Exactly one aligned field: "price" or "quantity"')
    .requiredOption(
      '--confirm-sweep',
      'Literal acknowledgement that this batch replaces per-action approval (G18 policy)',
    )
    .option('--max-actions <n>', `Provider writes to attempt, max ${SWEEP_HARD_CAP}`)
    .option(
      '--belief-store <path>',
      'Quantity-belief cache path. Beliefs are recorded whenever eBay state is '
      + 'observed, and with --suspected-only they also select which listings are read.',
    )
    .option(
      '--suspected-only',
      'Read eBay only for listings whose live Shopify quantity disagrees with the '
      + 'remembered eBay quantity (or that have no belief yet). Requires --belief-store '
      + 'and --field quantity.',
    )
    .action(async (options: {
      migrationStore: string;
      confirmScope: string;
      field: string;
      maxActions?: string;
      beliefStore?: string;
      suspectedOnly?: boolean;
    }) => {
      const started = new Date().toISOString();
      try {
        const field = exactField(options.field);
        if (options.confirmScope !== deriveScopeKey(MIGRATION_SCOPE)) {
          deny('REALIGN_SCOPE_CONFIRMATION_MISMATCH');
        }
        const requested = options.maxActions === undefined
          ? SWEEP_DEFAULT_CAP
          : Number(options.maxActions);
        if (!Number.isSafeInteger(requested) || requested < 1) deny('SWEEP_MAX_ACTIONS_INVALID');
        const cap = Math.min(requested, SWEEP_HARD_CAP);
        if (options.suspectedOnly) {
          // Beliefs are about quantity only: eBay price does not move on its
          // own the way quantity does when an order consumes stock.
          if (field !== 'quantity') deny('SWEEP_SUSPECTED_REQUIRES_QUANTITY');
          if (!options.beliefStore) deny('SWEEP_BELIEF_STORE_REQUIRED');
        }
        const beliefs = options.beliefStore
          ? openBeliefs(options.beliefStore)
          : null;

        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          // Kill switch: ownership. Recording the responsibility back to
          // `paused` stops every sweep immediately and needs no code change.
          const responsibility = FIELD_RESPONSIBILITY[field];
          const ownership = store.getCurrentOwnership(responsibility);
          if (!ownership || ownership.owner !== 'product_pipeline'
            || !ownership.singleWriterVerified) {
            deny('REALIGN_OWNERSHIP_NOT_ESTABLISHED');
          }

          const snapshot = await getSnapshot();
          const active = (snapshot.rows ?? []).filter((row) =>
            row.lifecycleStatus === 'active'
            && row.ebay.listingId !== null
            && row.ebay.sku !== null
            && row.ebay.sku !== ''
            && row.shopify !== null);

          // Belief-gated selection. The remembered eBay quantity decides which
          // listings are WORTH an eBay read; it never decides what is written.
          // Every selected listing still goes through the real plan, which
          // reads eBay for the true `before`. A stale belief can only cost an
          // extra check or defer one to the scheduled full sweep.
          const remembered = beliefs?.all() ?? new Map();
          const candidates = options.suspectedOnly
            ? active.filter((row) => {
              const belief = remembered.get(row.ebay.sku as string);
              if (!belief) return true; // never observed — must look
              if (belief.listingId !== row.ebay.listingId) return true; // relisted
              return belief.quantity !== (row.shopify?.available ?? null);
            })
            : active;

          const results: Array<Record<string, unknown>> = [];
          let scanned = 0;
          let aligned = 0;
          let skippedNoDrift = 0;
          let failed = 0;

          for (const row of candidates) {
            if (aligned >= cap) break;
            scanned += 1;
            const targetOptions = {
              catalogId: row.id,
              sku: row.ebay.sku as string,
              listingId: row.ebay.listingId as string,
              offerId: row.ebay.offerId ?? 'none',
              field,
            };
            let target: Awaited<ReturnType<typeof deriveExactTarget>>;
            try {
              target = await deriveExactTarget(readWorkspace, targetOptions);
            } catch (error) {
              // PLAN_NO_DRIFT is the overwhelmingly common case and is not a
              // failure: delta-only means an aligned listing is simply skipped.
              const code = safeErrorCode(error);
              if (code === 'PLAN_NO_DRIFT') {
                skippedNoDrift += 1;
                // A real eBay read just proved eBay agrees with Shopify, so
                // this is a genuine observation of eBay state, not a guess.
                if (beliefs && field === 'quantity' && row.shopify?.available != null) {
                  beliefs.record({
                    sku: targetOptions.sku,
                    listingId: targetOptions.listingId,
                    quantity: row.shopify.available,
                    source: 'observed_no_drift',
                    observedAtUtc: new Date().toISOString(),
                  });
                }
              } else {
                failed += 1;
                results.push({ sku: targetOptions.sku, status: 'skipped', code });
              }
              continue;
            }
            try {
              const result = await dispatchOneAlignment({
                store, target, catalogId: row.id, clock,
              });
              aligned += 1;
              results.push({ sku: targetOptions.sku, ...result });
              // Only remember a value reconciliation confirmed landed. An
              // unresolved dispatch leaves the belief absent, so the next
              // sweep re-reads this listing rather than trusting a write we
              // could not verify.
              if (beliefs && field === 'quantity') {
                if (result.resolution === 'resolved_existing'
                  && row.shopify?.available != null) {
                  beliefs.record({
                    sku: targetOptions.sku,
                    listingId: targetOptions.listingId,
                    quantity: row.shopify.available,
                    source: 'aligned',
                    observedAtUtc: new Date().toISOString(),
                  });
                } else {
                  beliefs.forget(targetOptions.sku);
                }
              }
            } catch (error) {
              failed += 1;
              results.push({
                sku: targetOptions.sku, status: 'denied', code: safeErrorCode(error),
              });
              // A failed action leaves eBay in an unknown state for this SKU.
              if (beliefs && field === 'quantity') beliefs.forget(targetOptions.sku);
            }
          }

          io.stdout(JSON.stringify({
            command: 'align-sweep',
            status: failed === 0 ? 'swept' : 'swept-with-failures',
            field,
            responsibility,
            startedAtUtc: started,
            completedAtUtc: new Date().toISOString(),
            mode: options.suspectedOnly ? 'suspected-only' : 'full',
            activeListings: active.length,
            candidates: candidates.length,
            ebayReadsAvoided: active.length - candidates.length,
            scanned,
            aligned,
            skippedNoDrift,
            failed,
            cap,
            externalCommerceWritesAttempted: aligned,
            results,
          }));
          if (failed > 0) io.setExitCode(1);
        } finally {
          beliefs?.close();
          store.close();
        }
      } catch (error) {
        io.stderr(JSON.stringify({
          command: 'align-sweep', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    });

  withTargetOptions(program
    .command('reconcile')
    .description(
      'Re-run post-dispatch reconciliation for an outstanding reconciliation_required job. '
      + '--before/--after must reproduce the exact dispatched manifest digest',
    ))
    .requiredOption('--manifest-digest <sha256>', 'Exact manifest digest printed by plan')
    .requiredOption(
      '--before <value>',
      'Exact before-value from the dispatched manifest, or the literal "none" for null',
    )
    .requiredOption('--after <value>', 'Exact after-value from the dispatched manifest')
    .requiredOption('--migration-store <path>', 'Absolute migration-state database path')
    .requiredOption('--job-id <id>', 'Exact job id printed by dispatch')
    .requiredOption('--attempt-id <id>', 'Exact attempt id printed by dispatch')
    .option(
      '--accept-absent',
      'Explicitly accept a still-absent aligned effect as the terminal confirmed_missing outcome',
    )
    .action(async (options: ExactTargetOptions & {
      manifestDigest: string;
      before: string;
      after: string;
      migrationStore: string;
      jobId: string;
      attemptId: string;
      acceptAbsent?: boolean;
    }) => {
      try {
        const field = exactField(options.field);
        const workspaceDto = await readWorkspace(options.catalogId);
        const freshBasis = deriveListingDraftBasis(workspaceDto);
        assertExactTarget(freshBasis, options);
        const derived = reconstructAlignmentManifest({
          identity: freshBasis.identity,
          field,
          before: options.before === 'none' ? null : options.before,
          after: options.after,
        });
        if (derived.manifestDigest !== options.manifestDigest) {
          deny('REALIGN_MANIFEST_DIGEST_MISMATCH');
        }
        const store = openMigration({
          databasePath: options.migrationStore,
          expectedScope: MIGRATION_SCOPE,
        });
        const clock = createMonotonicClock(now);
        try {
          const identityInputs = alignmentIdentityInputs(freshBasis.identity, field);
          const sourceIdentityKey = deriveExternalIdentityKey(identityInputs.source);
          const targetIdentityKey = deriveExternalIdentityKey(identityInputs.target);
          const intentKey = deriveIdempotencyKey({
            scopeKey: deriveScopeKey(MIGRATION_SCOPE),
            action: FIELD_ACTION[field],
            sourceIdentityKey,
            targetIdentityKey,
            desiredStateDigest: derived.manifestDigest,
          });
          if (store.getIntent(intentKey) === null) deny('REALIGN_INTENT_NOT_FOUND');
          const reconciliation = await runReconciliation({
            store,
            derived,
            field,
            intentKey,
            targetIdentityKey,
            jobId: options.jobId,
            attemptId: options.attemptId,
            readWorkspace,
            catalogId: options.catalogId,
            clock,
            uuid,
            resolveAbsent: options.acceptAbsent === true,
          });
          io.stdout(JSON.stringify({
            command: 'reconcile',
            status: reconciliation.resolution === null ? 'unresolved' : 'reconciled',
            jobId: options.jobId,
            attemptId: options.attemptId,
            field,
            effect: reconciliation.effect,
            resolution: reconciliation.resolution,
            reconciliationRunId: reconciliation.runId,
            externalWritesPerformed: 0,
          }));
          if (reconciliation.resolution === null) io.setExitCode(1);
        } finally {
          store.close();
        }
      } catch (error) {
        io.stderr(JSON.stringify({
          command: 'reconcile', status: 'denied', code: safeErrorCode(error),
        }));
        io.setExitCode(1);
      }
    });

  return program;
}
