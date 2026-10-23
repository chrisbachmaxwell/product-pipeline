/**
 * Publish-everything-ready runner — the in-app version of the operator's
 * proven box script (scripts/publish-ready.mjs, Brain L63/L69/L71).
 *
 * ZERO provider writes happen in this process: every eBay write goes through
 * the standalone listing-lifecycle-admin ceremonies (preflight-create →
 * dispatch-create → reconcile / recover chain), spawned from the SAME
 * operator-armed PUBLISH_*_ARGV templates the one-item publish route uses.
 * The G18 batch-approval precedent applies exactly as it does to the
 * inventory align-sweep: the operator's single action (the Publish-All
 * click, or arming the schedule interval) approves the bounded batch, and
 * every item still runs the full per-target ceremony with its idempotent
 * intent, single-use approval, and post-dispatch reconciliation.
 *
 * Behavior mirrors the script, learned failure by failure:
 * - one item at a time, 40s between preflight and dispatch, 60s between
 *   items (each ceremony captures the whole store — Shopify's rate budget
 *   is a first-class parameter, L63)
 * - missing drafts get a pure-inherit save (auto-defaults fill everything
 *   derivable, including title-marker conditions, L69)
 * - CREATE_BASE_STALE auto-rebases the draft and retries (L69)
 * - a dispatch refused for a reason a fresh preflight can
 *   clear is re-checked and re-dispatched once (L97)
 * - an eBay server error (5xx) gets one more attempt from a refreshed
 *   draft once its leftovers are cleared, and a draft an earlier closed
 *   attempt used is refreshed instead of skipped (L105)
 * - known-benign blockers (missing condition, eBay-illegal SKU, missing
 *   required field, already-listed) are per-item skips with reasons the
 *   UI shows; unknown failure shapes STOP the run loudly (L65)
 * - a failed dispatch runs the residue-recovery chain so nothing wedges
 * - runs are bounded (MAX_ITEMS) and single-flight, sharing the same lock
 *   as the one-item publish route
 */
import { aspectFillerArmed, fillMissingAspects, type AspectFillRequest, type AspectFillResult } from './aspect-filler.js';
import { openListingControlStoreReadOnly } from '../listing-control-store/index.js';
import { info, warn } from '../utils/logger.js';
import { LISTING_DRAFT_SCOPE } from './listing-draft-service.js';
import {
  findUnresolvedListingCreateFromArgv,
  readIncidentLedgerSignalsFromArgv,
} from './migration-state-reader.js';
import { createProcessStepRunner, substituteArgv, type StepRunner } from './order-import-trigger.js';

const SKU_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_ITEMS = 30;
/**
 * dispatch-create refusals a fresh preflight can clear: a transient capture
 * failure, or the item/draft moving between preflight and dispatch. The
 * generic code can also follow a provider write; the open-create ledger
 * check at the retry site excludes that case.
 */
const DISPATCH_RECHECK_CODES: ReadonlySet<string> = new Set([
  'LISTING_LIFECYCLE_DENIED',
  'CREATE_BASE_STALE',
  'CREATE_IDENTITY_MISMATCH',
  'CREATE_DRAFT_REVISION_MISMATCH',
  'CREATE_MANIFEST_DIGEST_MISMATCH',
  'CREATE_DRAFT_STORE_UNAVAILABLE',
  'no code',
]);

/** eBay's generic server-side failure ("A system error has occurred"). */
const EBAY_SYSTEM_ERROR_IDS: ReadonlySet<number> = new Set([25001]);

/**
 * Read a failed dispatch-create summary (incident #212). `transient` is an
 * eBay server error (HTTP 5xx, or eBay's system-error id): eBay's own
 * trouble, not a refusal of the payload, so one more attempt may succeed.
 * `detail` names the stage, HTTP status and eBay error ids (digits only,
 * never provider text) for the log and the item reason.
 */
export function providerFailure(json: Record<string, unknown>): { transient: boolean; detail: string } {
  const stage = typeof json.dispatchFailureStage === 'string' ? json.dispatchFailureStage : 'unknown stage';
  const httpStatus = typeof json.dispatchFailureHttpStatusCode === 'number'
    ? json.dispatchFailureHttpStatusCode : null;
  const errorIds = Array.isArray(json.dispatchFailureEbayErrorIds)
    ? json.dispatchFailureEbayErrorIds.filter((id): id is number => Number.isSafeInteger(id))
    : [];
  const transient = json.dispatchFailureHttpStatusFamily === 'http_5xx'
    || (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599)
    || errorIds.some((id) => EBAY_SYSTEM_ERROR_IDS.has(id));
  const detail = [
    stage,
    httpStatus === null ? null : `HTTP ${httpStatus}`,
    errorIds.length === 0 ? null : `eBay error ${errorIds.join(', ')}`,
  ].filter((part) => part !== null).join(', ');
  return { transient, detail };
}

/** One publish at a time process-wide — shared with the one-item route. */
let publishLockHeld = false;
export function tryAcquirePublishLock(): boolean {
  if (publishLockHeld) return false;
  publishLockHeld = true;
  return true;
}
export function releasePublishLock(): void { publishLockHeld = false; }

export type PublishAllItem = Readonly<{
  sku: string;
  title: string;
  status: 'published' | 'skipped' | 'failed';
  listingId?: string;
  reason?: string;
}>;

export type PublishAllStatus = Readonly<{
  state: 'idle' | 'running' | 'finished' | 'stopped';
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  startedBy: string | null;
  totalReady: number;
  currentSku: string | null;
  /** Plain-language description of what the run is doing right now. */
  currentStep: string | null;
  /** When currentStep began, so the UI can show how long it has taken. */
  stepStartedAtUtc: string | null;
  items: readonly PublishAllItem[];
  /** Set when an unknown failure shape stopped the run. */
  stopReason: string | null;
}>;

type MutableStatus = {
  state: PublishAllStatus['state'];
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  startedBy: string | null;
  totalReady: number;
  currentSku: string | null;
  currentStep: string | null;
  stepStartedAtUtc: string | null;
  items: PublishAllItem[];
  stopReason: string | null;
};

const status: MutableStatus = {
  state: 'idle', startedAtUtc: null, finishedAtUtc: null, startedBy: null,
  totalReady: 0, currentSku: null, currentStep: null, stepStartedAtUtc: null,
  items: [], stopReason: null,
};

export function getPublishAllStatus(): PublishAllStatus {
  return Object.freeze({ ...status, items: [...status.items] });
}

function parseArgvEnv(name: string): readonly string[] | null {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64
      || !parsed.every((entry) => typeof entry === 'string' && entry.length <= 512)) {
      return null;
    }
    return Object.freeze(parsed as string[]);
  } catch {
    return null;
  }
}

type SnapshotRow = {
  id: string;
  readyToList?: boolean;
  readyToListGaps?: readonly string[];
  shopify: { sku: string; title: string; imageCount?: number } | null;
  audit?: { attentionReasons?: readonly string[] };
};

/** An operator override leaf the Publish-All saves must carry, not drop. */
type OverrideLeaf = { draft: string | null } | undefined;

type DraftServiceLike = {
  get: (catalogId: string) => Promise<{
    revision: null | { revisionDigest: string };
    base: { sourceDigest: string; ebayDigest: string };
    sections: {
      listing: {
        title: { draft: string | null; shopify?: string | null };
        category: { draft: string | null; shopify: string | null };
        condition?: OverrideLeaf;
        conditionDescription: { draft: string | null; shopify: string | null };
      };
      content: {
        itemSpecifics: { draft: string | null; shopify: string | null };
        description?: { draft: string | null; shopify: string | null };
        images?: { draft: string | null; shopify?: string | null };
      };
      delivery?: {
        fulfillmentPolicyId?: OverrideLeaf;
        paymentPolicyId?: OverrideLeaf;
        returnPolicyId?: OverrideLeaf;
        merchantLocation?: OverrideLeaf;
      };
    };
  }>;
  save: (request: unknown, actor: string) => Promise<{
    revision: { revisionDigest: string };
  }>;
};

export type PublishAllDependencies = Readonly<{
  /** Read the newest usable snapshot; production reuses a still-fresh cache entry. */
  getSnapshot?: () => Promise<{ rows: readonly SnapshotRow[] }>;
  /** Force a provider census after a recovery write or a catalog-gated refusal. */
  refreshSnapshot?: () => Promise<{ rows: readonly SnapshotRow[] }>;
  draftService?: DraftServiceLike;
  runStep?: StepRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  maxItems?: number;
  getCategoryAspects?: (categoryId: string) => Promise<{
    available: boolean;
    aspects: ReadonlyArray<{
      name: string;
      required: boolean;
      mode?: 'FREE_TEXT' | 'SELECTION_ONLY';
      values?: readonly string[];
    }>;
  }>;
  /** Item-specifics agent; null disables it. Default: armed when a Claude key is connected. */
  fillAspects?: ((request: AspectFillRequest) => Promise<AspectFillResult>) | null;
  findUnresolvedCreate?: (sku: string) => Readonly<{
    jobId: string; attemptId: string; intentKey: string; evidenceDigest: string;
  }> | null;
  latestRevisionDigest?: (catalogId: string) => string | null;
  /** SKUs whose create dispatched but never resolved, older than an hour. */
  agingUnresolvedCreateSkus?: () => ReadonlySet<string>;
}>;

/** A create unresolved this long is stuck, not in flight (watchdog L76). */
const UNRESOLVED_CREATE_STUCK_MS = 60 * 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/** Operator per-deploy exclusions: never publish these SKUs (comma-separated). */
function excludedSkus(): ReadonlySet<string> {
  return new Set((process.env.PUBLISH_EXCLUDE_SKUS ?? '')
    .split(',').map((sku) => sku.trim()).filter((sku) => sku.length > 0));
}

/** eBay's hard title limit; the create manifest denies anything longer. */
const EBAY_TITLE_MAX = 80;
const NO_SHOPIFY_PHOTOS = 'The item has no photos in Shopify — add at least one there and it will publish next run.';
const NO_SHOPIFY_TITLE = 'The item has no title in Shopify — add one there and it will publish next run.';

/**
 * Skip reasons that are verified store data only the operator can change
 * (incident #194). No code change can publish these items, so the watchdog
 * shows them to the operator but does not send them to the fix agent.
 */
export const OPERATOR_DATA_SKIP_REASONS: readonly string[] = Object.freeze([NO_SHOPIFY_PHOTOS, NO_SHOPIFY_TITLE]);

/**
 * Fit a store title into eBay's 80 characters (incident #180). The create
 * manifest refuses a longer title as `CREATE_REQUIRED_FIELD_MISSING: title`,
 * and the draft inherits the Shopify title verbatim, so every long store
 * title skipped on every run. A title that already fits is returned
 * unchanged. A longer one first loses the store-only markers (`(#123)`
 * inventory suffixes, `*USED*`-style banners; condition is its own eBay
 * field), then is cut at the last whole word. Returns null when there is no
 * usable text at all.
 */
export function fitEbayTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= EBAY_TITLE_MAX) return collapsed;
  const stripped = collapsed
    .replace(/\(#\s*\d{1,12}\s*\)/gu, ' ')
    .replace(/\*[^*\n]{1,40}\*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const text = stripped.length > 0 ? stripped : collapsed;
  if (text.length <= EBAY_TITLE_MAX) return text;
  const cut = text.slice(0, EBAY_TITLE_MAX + 1);
  const boundary = cut.lastIndexOf(' ');
  const words = boundary >= EBAY_TITLE_MAX / 2 ? cut.slice(0, boundary) : text.slice(0, EBAY_TITLE_MAX);
  const tidy = words.replace(/[\s,;:/&+(\-–—]+$/u, '').trim();
  return tidy.length > 0 ? tidy : text.slice(0, EBAY_TITLE_MAX).trim();
}

/**
 * The shortened title Publish-All must carry in ANY draft save it makes, or
 * null when none is needed (an operator title exists, or the store title
 * already fits). Incident #182: the fit lived only in one dedicated save
 * whose refusal was swallowed, and every other Publish-All save (first
 * draft, stale rebase, aspect agent) wrote the title back to "inherit", so
 * a single refused save left the item skipping on every run.
 */
function fittedTitleOverride(dto: Awaited<ReturnType<DraftServiceLike['get']>>): string | null {
  const title = dto.sections.listing.title;
  if (title.draft !== null) return null;
  const inherited = title.shopify;
  if (typeof inherited !== 'string' || inherited.length <= EBAY_TITLE_MAX) return null;
  return fitEbayTitle(inherited);
}

function draftPayload(dto: Awaited<ReturnType<DraftServiceLike['get']>>, overrides: {
  conditionDescription?: string | null;
  itemSpecifics?: string;
  title?: string;
}): Record<string, unknown> {
  let specifics: string | null = null;
  const raw = overrides.itemSpecifics ?? dto.sections.content.itemSpecifics.draft;
  if (raw) {
    // The create manifest demands alphabetically sorted specifics keys.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) sorted[key] = parsed[key];
    specifics = JSON.stringify(sorted);
  }
  // Incident #186 (L102): these used to be written as `null` (inherit), so
  // every Publish-All save (first draft, rebase, title fit, aspect agent,
  // refresh) silently dropped an operator's photo, description, category,
  // condition or policy override — an image override added to fix "eBay
  // requires images" was undone by the next run's save.
  const { listing, content, delivery } = dto.sections;
  return {
    schemaVersion: 1,
    action: 'save_local_draft',
    catalogId: undefined as unknown, // filled by caller
    expectedRevisionDigest: dto.revision?.revisionDigest ?? null,
    base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest },
    draft: {
      title: overrides.title ?? dto.sections.listing.title.draft ?? fittedTitleOverride(dto),
      category: listing.category.draft ?? null,
      condition: listing.condition?.draft ?? null,
      conditionDescription: overrides.conditionDescription !== undefined
        ? overrides.conditionDescription
        : dto.sections.listing.conditionDescription.draft,
      description: content.description?.draft ?? null,
      images: content.images?.draft ?? null,
      itemSpecifics: specifics,
      fulfillmentPolicyId: delivery?.fulfillmentPolicyId?.draft ?? null,
      paymentPolicyId: delivery?.paymentPolicyId?.draft ?? null,
      returnPolicyId: delivery?.returnPolicyId?.draft ?? null,
      merchantLocation: delivery?.merchantLocation?.draft ?? null,
    },
  };
}

type DraftFailure = { code: string; detail: string | null };

function draftFailure(error: unknown): DraftFailure {
  const fields = error instanceof Error ? error as { code?: unknown; detail?: unknown } : {};
  return {
    code: typeof fields.code === 'string' ? fields.code : 'unavailable',
    detail: typeof fields.detail === 'string' ? fields.detail : null,
  };
}

/**
 * A draft refusal caused by the shared catalog read (fail-closed after a
 * failed refresh, a stale or unreadable snapshot), not by this item: a
 * fresh refresh can clear it (incident #213).
 */
function catalogMayRecover(failure: DraftFailure): boolean {
  return failure.code === 'LISTING_DRAFT_UNAVAILABLE'
    && failure.detail !== null && failure.detail.startsWith('workspace_');
}

/**
 * The skip reason for a draft that could not be prepared. Saving the item
 * by hand goes through the same gates, so "open the item and save it once"
 * is advice only for a stale or refused save, never for an unavailable one.
 */
function draftSkipReason(failure: DraftFailure | null, catalogDown: boolean): string {
  const code = failure?.code ?? 'unavailable';
  const detail = failure?.detail ? `: ${failure.detail}` : '';
  if (code !== 'LISTING_DRAFT_UNAVAILABLE') {
    return `The draft could not be prepared (${code}${detail}) — open the item and save it once.`;
  }
  if (failure !== null && catalogMayRecover(failure)) {
    return `The store and eBay catalog could not be read (${code}${detail})`
      + (catalogDown ? ' and a fresh read failed too' : ' even after a fresh read')
      + ' — the next run retries it.';
  }
  return `The draft could not be prepared (${code}${detail}) — the item is not eligible for a local draft.`;
}

/**
 * Start a publish-all run in the background. Returns false when another
 * publish (single or batch) is already holding the lock. The returned
 * promise settles when the run ends but callers normally fire-and-forget.
 */
export function startPublishAllRun(
  startedBy: string,
  dependencies: PublishAllDependencies = {},
): { started: boolean; run?: Promise<void> } {
  const preflightArgv = parseArgvEnv('PUBLISH_PREFLIGHT_ARGV');
  const dispatchArgv = parseArgvEnv('PUBLISH_DISPATCH_ARGV');
  const reconcileArgv = parseArgvEnv('PUBLISH_RECONCILE_ARGV');
  const recoverArgv = parseArgvEnv('PUBLISH_RECOVER_ARGV');
  const recoverReconcileArgv = parseArgvEnv('PUBLISH_RECOVER_RECONCILE_ARGV');
  if (!preflightArgv || !dispatchArgv) return { started: false };
  if (!tryAcquirePublishLock()) return { started: false };

  const runStep = dependencies.runStep ?? createProcessStepRunner();
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const maxItems = dependencies.maxItems ?? MAX_ITEMS;
  const getSnapshot = dependencies.getSnapshot
    ?? (async () => (await import('./live-listing-catalog-source.js'))
      .getLiveListingCatalogSnapshot() as Promise<{ rows: readonly SnapshotRow[] }>);
  // Tests and other explicit callers historically supplied one reader for
  // both paths, so retain that contract unless they opt into the split.
  const refreshSnapshot = dependencies.refreshSnapshot ?? dependencies.getSnapshot
    ?? (async () => (await import('./live-listing-catalog-source.js'))
      .getLiveListingCatalogSnapshot.refresh() as Promise<{ rows: readonly SnapshotRow[] }>);
  const draftServicePromise: Promise<DraftServiceLike> = dependencies.draftService
    ? Promise.resolve(dependencies.draftService)
    : import('./listing-draft-service.js')
      .then((module) => module.createListingDraftService() as unknown as DraftServiceLike);
  const getCategoryAspects = dependencies.getCategoryAspects
    ?? (async (categoryId: string) => (await import('./ebay-category-aspects.js'))
      .getEbayCategoryAspects(categoryId));
  const fillAspects = dependencies.fillAspects !== undefined
    ? dependencies.fillAspects
    : async (request: AspectFillRequest): Promise<AspectFillResult> => (await aspectFillerArmed()
      ? fillMissingAspects(request)
      : { filled: {}, unresolved: request.missing.map((aspect) => aspect.name) });
  const excluded = excludedSkus();
  const agingUnresolvedCreateSkus = dependencies.agingUnresolvedCreateSkus ?? (() => {
    const signals = readIncidentLedgerSignalsFromArgv(
      reconcileArgv, new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const cutoff = Date.now() - UNRESOLVED_CREATE_STUCK_MS;
    return new Set((signals?.unresolvedCreates ?? [])
      .filter((create) => Date.parse(create.reservedAtUtc) < cutoff)
      .map((create) => create.sku));
  });
  const findUnresolvedCreate = dependencies.findUnresolvedCreate
    ?? ((sku: string) => findUnresolvedListingCreateFromArgv(reconcileArgv, sku));
  const latestRevisionDigest = dependencies.latestRevisionDigest ?? ((catalogId: string) => {
    const databasePath = process.env.LISTING_CONTROL_DATABASE_PATH;
    if (typeof databasePath !== 'string' || databasePath.length === 0) return null;
    try {
      const store = openListingControlStoreReadOnly({ databasePath, expectedScope: LISTING_DRAFT_SCOPE });
      try {
        return store.getLatestRevision(catalogId.replace(/^shopify-variant:/, ''))?.revisionDigest ?? null;
      } finally {
        store.close();
      }
    } catch {
      return null;
    }
  });

  status.state = 'running';
  status.startedAtUtc = now();
  status.finishedAtUtc = null;
  status.startedBy = startedBy;
  status.totalReady = 0;
  status.currentSku = null;
  status.currentStep = 'Loading your store';
  status.stepStartedAtUtc = now();
  status.items = [];
  status.stopReason = null;

  const step = (label: string | null): void => {
    status.currentStep = label;
    status.stepStartedAtUtc = label === null ? null : now();
  };
  // Recording an item ends it: the banner must not keep showing a finished
  // SKU as "current" during the pause before the next one.
  const record = (item: PublishAllItem): void => {
    status.items.push(item);
    status.currentSku = null;
    step('Pausing before the next item (Shopify rate limit)');
  };

  const cleanupFailedCreate = async (input: {
    catalogId: string; sku: string; revisionDigest: string;
    dispatchJson: Record<string, unknown>;
  }): Promise<void> => {
    if (!reconcileArgv || !recoverArgv || !recoverReconcileArgv) return;
    const { jobId, attemptId, intentKey, offerId } = input.dispatchJson;
    const manifestDigest = input.dispatchJson.manifestDigest;
    if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)
      || typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)
      || typeof intentKey !== 'string' || !DIGEST.test(intentKey)
      || typeof manifestDigest !== 'string' || !DIGEST.test(manifestDigest)
      || typeof offerId !== 'string' || !/^[0-9]{1,19}$/.test(offerId)) return;
    const values: Record<string, string> = {
      catalogId: input.catalogId, sku: input.sku,
      revisionDigest: input.revisionDigest, manifestDigest,
      jobId, attemptId, intentKey, evidenceDigest: manifestDigest, offerId,
    };
    try {
      const reconciled = await runStep(substituteArgv(reconcileArgv, values));
      if (reconciled.json?.unresolvedCode !== 'CREATE_OFFER_UNPUBLISHED') return;
      const recovered = await runStep(substituteArgv(recoverArgv, values));
      const recoveryJobId = recovered.json?.recoveryJobId;
      const recoveryAttemptId = recovered.json?.recoveryAttemptId;
      if (typeof recoveryJobId !== 'string' || !SAFE_ID.test(recoveryJobId)
        || typeof recoveryAttemptId !== 'string' || !SAFE_ID.test(recoveryAttemptId)) return;
      await runStep(substituteArgv(recoverReconcileArgv, {
        ...values, recoveryJobId, recoveryAttemptId,
      }));
    } catch {
      // Best-effort: the item shows Fix needed and the UI recovery button
      // (or the next run) can retry.
    }
  };

  /**
   * Startup residue sweep (L73): an unresolved create whose cleanup failed
   * leaves an artifact that blocks the draft service and hides the row from
   * every later run — the starvation that stalled the queue for five days.
   * Reconcile re-verifies live state; only the recorded unpublished-offer
   * shape proceeds to removal ('none' = item-only residue).
   */
  const sweepResidue = async (row: SnapshotRow & { shopify: { sku: string } }): Promise<void> => {
    if (!reconcileArgv || !recoverArgv || !recoverReconcileArgv) return;
    const sku = row.shopify.sku;
    const source = findUnresolvedCreate(sku);
    if (source === null) return;
    const revisionDigest = latestRevisionDigest(row.id);
    if (revisionDigest === null) return;
    const values: Record<string, string> = {
      catalogId: row.id, sku, revisionDigest,
      jobId: source.jobId, attemptId: source.attemptId,
      intentKey: source.intentKey, evidenceDigest: source.evidenceDigest,
    };
    try {
      const reconciled = await runStep(substituteArgv(reconcileArgv, values));
      if (reconciled.json?.unresolvedCode !== 'CREATE_OFFER_UNPUBLISHED') return;
      const observed = reconciled.json?.offerId;
      const offerId = typeof observed === 'string' && /^[0-9]{1,19}$/.test(observed)
        ? observed : 'none';
      await sleep(10_000);
      const recovered = await runStep(substituteArgv(recoverArgv, { ...values, offerId }));
      const recoveryJobId = recovered.json?.recoveryJobId;
      const recoveryAttemptId = recovered.json?.recoveryAttemptId;
      if (typeof recoveryJobId !== 'string' || !SAFE_ID.test(recoveryJobId)
        || typeof recoveryAttemptId !== 'string' || !SAFE_ID.test(recoveryAttemptId)) return;
      await runStep(substituteArgv(recoverReconcileArgv, {
        ...values, offerId, recoveryJobId, recoveryAttemptId,
      }));
      info(`[Publish All] recovered leftover eBay data for ${sku}`);
      await sleep(30_000);
    } catch {
      // Best-effort; the item stays visible as blocked in the UI.
    }
  };

  const run = (async (): Promise<void> => {
    try {
      const draftService = await draftServicePromise;
      const snapshot = await getSnapshot();
      // Sweep (a) rows carrying leftover eBay data and (b) rows whose create
      // has sat unresolved over an hour with NO leftover data: nothing else
      // ever reconciles those, so their watchdog warning would never clear.
      // The reconcile ceremony is zero-write; it closes the job as missing
      // or existing, and an unpublished offer goes through the recovery chain.
      let stuckSkus: ReadonlySet<string> = new Set();
      try {
        stuckSkus = agingUnresolvedCreateSkus();
      } catch {
        // Best-effort; the watchdog keeps showing the warning.
      }
      const wedged = snapshot.rows.filter(
        (row): row is SnapshotRow & { shopify: { sku: string; title: string } } =>
          row.shopify !== null
          && (row.audit?.attentionReasons?.includes('ebay_unpublished_artifact') === true
            || stuckSkus.has(row.shopify.sku)));
      for (const row of wedged.slice(0, 10)) {
        status.currentSku = row.shopify.sku;
        step('Re-checking an earlier publish attempt that never finished');
        await sweepResidue(row);
      }
      status.currentSku = null;
      if (wedged.length > 0) step('Reloading your store');
      const freshSnapshot = wedged.length > 0 ? await refreshSnapshot() : snapshot;
      const ready = freshSnapshot.rows
        .filter((row): row is SnapshotRow & { shopify: { sku: string; title: string } } =>
          row.readyToList === true && row.shopify !== null
          && !row.shopify.sku.startsWith('PIPELINE-TEST')
          && !excluded.has(row.shopify.sku))
        .slice(0, maxItems);
      status.totalReady = ready.length;
      info(`[Publish All] ${startedBy}: ${ready.length} ready`
        + (wedged.length > 0
          ? ` (${Math.min(wedged.length, 10)} residue sweeps of ${wedged.length} flagged rows)`
          : ''));

      let consecutiveUnknown = 0;
      let catalogDown = false;
      for (const [index, row] of ready.entries()) {
        const sku = row.shopify.sku;
        const title = row.shopify.title;
        const isLast = index === ready.length - 1;
        status.currentSku = sku;
        step('Preparing the draft');
        if (!SKU_GRAMMAR.test(sku)) {
          record({ sku, title, status: 'skipped', reason: 'The SKU contains characters eBay refuses — rename it in Shopify (no slashes or spaces).' });
          continue;
        }
        if (row.readyToListGaps?.includes('condition')) {
          record({ sku, title, status: 'skipped', reason: 'No condition could be determined — add a condition- tag in Shopify or a *USED* / *NEW OLD STOCK* title marker.' });
          continue;
        }

        // Ensure a draft revision exists (pure-inherit save when missing).
        // Incident #213: the draft workspace fails closed while the catalog
        // cache holds an unresolved refresh failure, and the cache does not
        // retry while its snapshot is younger than its TTL. One failed
        // background or webhook refresh therefore skipped every item of the
        // run for up to five minutes. A catalog-side refusal now forces one
        // refresh (a success clears the failure) and prepares the draft again.
        let prepared: string | null = null;
        let prepareFailure: DraftFailure | null = null;
        for (let attempt = 0; attempt < 2 && prepared === null; attempt += 1) {
          try {
            const dto = await draftService.get(row.id);
            if (dto.revision) {
              prepared = dto.revision.revisionDigest;
            } else {
              const chart = dto.sections.listing.conditionDescription.shopify;
              const note = ((chart ? `${chart} ` : '')
                + 'The photographs show the exact item for sale.').slice(0, 1000);
              const payload = draftPayload(dto, { conditionDescription: note });
              (payload as { catalogId: unknown }).catalogId = row.id;
              const saved = await draftService.save(payload, 'publish-all');
              prepared = saved.revision.revisionDigest;
            }
          } catch (error) {
            prepareFailure = draftFailure(error);
            warn(`[Publish All] draft for ${sku} was refused (${prepareFailure.code}`
              + `${prepareFailure.detail ? `: ${prepareFailure.detail}` : ''})`);
            if (attempt > 0 || catalogDown || !catalogMayRecover(prepareFailure)) break;
            step('Re-reading your store before retrying the draft');
            try {
              await refreshSnapshot();
            } catch {
              // The catalog itself cannot be read: stop spending census
              // reads on every remaining item this run.
              catalogDown = true;
              break;
            }
          }
        }
        if (prepared === null) {
          record({ sku, title, status: 'skipped', reason: draftSkipReason(prepareFailure, catalogDown) });
          if (!isLast) await sleep(45_000);
          continue;
        }
        let revisionDigest: string = prepared;

        // TITLE FIT (incident #180): the draft inherits the Shopify title,
        // and the create manifest refuses one over 80 characters. A long
        // store title is shortened into a local draft override (the
        // operator's own override, if any, always fits and is kept). A
        // title-less item skips with a reason that names the real fix.
        // Incident #182: one refused save (e.g. LISTING_DRAFT_STALE when the
        // store basis moved between read and save) used to be swallowed, so
        // the fit never landed. The save is tried twice from a fresh read,
        // and every later Publish-All save carries the fit as well.
        let titleless = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const dto = await draftService.get(row.id);
            if (dto.sections.listing.title.draft !== null) break;
            const inherited = dto.sections.listing.title.shopify ?? title;
            const fitted = fitEbayTitle(inherited);
            if (fitted === null) { titleless = true; break; }
            if (inherited.length <= EBAY_TITLE_MAX) break;
            const payload = draftPayload(dto, { title: fitted });
            (payload as { catalogId: unknown }).catalogId = row.id;
            const saved = await draftService.save(payload, 'publish-all-title-fit');
            revisionDigest = saved.revision.revisionDigest;
            info(`[Publish All] shortened the ${inherited.length}-character title for ${sku} to fit eBay`);
            break;
          } catch (error) {
            const code = error instanceof Error && 'code' in error
              ? String((error as { code: unknown }).code) : 'unavailable';
            warn(`[Publish All] title fit for ${sku} was refused (${code})${attempt === 0 ? '; retrying' : ''}`);
          }
        }
        if (titleless) {
          record({ sku, title, status: 'skipped', reason: NO_SHOPIFY_TITLE });
          if (!isLast) await sleep(15_000);
          continue;
        }
        // eBay requires at least one photo. The store sweep counts each
        // product's media, so a product with none skips here, before any
        // ceremony, with the one fix that works (an operator photo override
        // in the draft still publishes). That count is captured once when
        // the run starts, and a long run takes up to an hour, so photos
        // added since then are missed (incident #194). The draft read is
        // fresh for each item, so its store photos win over the count.
        let photosKnownMissing = false;
        if (row.shopify.imageCount === 0) {
          const dto = await draftService.get(row.id).catch(() => null);
          const images = dto?.sections.content.images;
          photosKnownMissing = !images?.draft && !images?.shopify;
          if (photosKnownMissing) {
            record({ sku, title, status: 'skipped', reason: NO_SHOPIFY_PHOTOS });
            if (!isLast) await sleep(15_000);
            continue;
          }
        }

        // REQUIRED-ASPECT GATE (L73): eBay reveals missing aspects one
        // 25002 refusal at a time, and each refusal burns an intent and
        // strands an unpublished offer. Check the category's complete
        // required list BEFORE any ceremony. The item-specifics agent
        // (aspect-filler.ts) writes what it is confident of into the local
        // draft; whatever is still missing skips with every name in ONE
        // message an employee can act on.
        let agentNote: string | null = null;
        try {
          const dto = await draftService.get(row.id);
          const categoryId = dto.sections.listing.category.draft
            ?? dto.sections.listing.category.shopify;
          const specificsRaw = dto.sections.content.itemSpecifics.draft
            ?? dto.sections.content.itemSpecifics.shopify;
          if (categoryId !== null) {
            const taxonomy = await getCategoryAspects(categoryId);
            if (taxonomy.available) {
              const existing = specificsRaw
                ? JSON.parse(specificsRaw) as Record<string, string[]> : {};
              const present = new Set(Object.keys(existing).map((name) => name.toLowerCase()));
              const missingAspects = taxonomy.aspects
                .filter((aspect) => aspect.required && !present.has(aspect.name.toLowerCase()));
              let missing = missingAspects.map((aspect) => aspect.name);
              if (missing.length > 0 && fillAspects !== null) {
                const description = dto.sections.content.description;
                step(`Agent is writing missing item specifics (${missing.join(', ')})`);
                const result = await fillAspects({
                  title: dto.sections.listing.title.draft ?? title,
                  description: description?.draft ?? description?.shopify ?? null,
                  categoryId,
                  existing,
                  missing: missingAspects.map((aspect) => ({
                    name: aspect.name,
                    mode: aspect.mode ?? 'FREE_TEXT',
                    values: aspect.values ?? [],
                  })),
                });
                const written = Object.entries(result.filled);
                if (written.length > 0) {
                  try {
                    const payload = draftPayload(dto, {
                      itemSpecifics: JSON.stringify({ ...existing, ...result.filled }),
                    });
                    (payload as { catalogId: unknown }).catalogId = row.id;
                    const saved = await draftService.save(payload, 'publish-all-aspect-agent');
                    revisionDigest = saved.revision.revisionDigest;
                    missing = result.unresolved;
                    agentNote = `Item specifics written by the agent: ${written
                      .map(([name, values]) => `${name} = ${values.join(', ')}`).join('; ')}.`;
                    info(`[Publish All] aspect agent filled ${written.length} for ${sku}`);
                  } catch {
                    // Save refused: fall through and skip with the full list.
                  }
                }
              }
              if (missing.length > 0) {
                record({ sku, title, status: 'skipped',
                  reason: `eBay requires ${missing.join(', ')} for this category${agentNote ? ` (${agentNote.replace(/\.$/, '')}; the rest were not certain)` : ''} — open the item, use the one-click Add buttons in Item specifics, and it will publish next run.` });
                if (!isLast) await sleep(15_000);
                continue;
              }
            }
          }
        } catch {
          // The gate is advisory; preflight remains the authority.
        }

        // Preflight with auto-rebase + transient retry (3 attempts).
        const runPreflight = async (): Promise<{
          manifestDigest: string | null; skipReason: string | null; stop: string | null;
        }> => {
          let manifestDigest: string | null = null;
          let skipReason: string | null = null;
          let stop: string | null = null;
          let refreshed = false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) {
              step('eBay check hit a temporary error — retrying in 90s');
              await sleep(90_000);
            }
            step('Checking the listing with eBay (preflight)');
            const values = { catalogId: row.id, sku, revisionDigest };
            const preflight = await runStep(substituteArgv(preflightArgv, values));
            const code = typeof preflight.json?.code === 'string' ? preflight.json.code : null;
            const digest = preflight.json?.manifestDigest;
            if (typeof digest === 'string' && DIGEST.test(digest)) {
              manifestDigest = digest;
              break;
            }
            // Both codes mean the stored draft predates the item's current
            // state. CREATE_IDENTITY_MISMATCH is the identity half (incident
            // #169): a draft saved before the Shopify SKU was renamed keeps
            // the old SKU forever, and the ceremony checks identity before
            // values, so without this rebase the item could never publish.
            // The rebase keeps the operator's overrides and re-binds them to
            // the item's current identity; preflight then re-checks everything.
            if ((code === 'CREATE_BASE_STALE' || code === 'CREATE_IDENTITY_MISMATCH') && attempt === 0) {
              try {
                const dto = await draftService.get(row.id);
                const payload = draftPayload(dto, {});
                (payload as { catalogId: unknown }).catalogId = row.id;
                const saved = await draftService.save(payload, 'publish-all-rebase');
                revisionDigest = saved.revision.revisionDigest;
                continue;
              } catch {
                skipReason = code === 'CREATE_IDENTITY_MISMATCH'
                  ? 'The saved draft belongs to an older SKU for this item and could not be refreshed — check the SKU is not used by another product, then open the item and save it once.'
                  : 'Shopify changed under the draft and it could not be refreshed — open the item and use “Update draft & publish again”.';
                break;
              }
            }
            // A title refusal means the STORED revision's title is not one
            // eBay accepts (incident #182: the fit had not landed). Incident
            // #184: the manifest checks the title BEFORE base freshness, so
            // a revision that inherited a long store title which has since
            // been shortened in Shopify reports `title`, never
            // CREATE_BASE_STALE. The fresh read then shows a title that
            // fits, so a fit-only repair saved nothing and the item skipped
            // forever. The repair is therefore a refresh save: from a fresh
            // read it re-inherits the current store title (or carries the
            // fit), tried twice, and preflight checks again.
            // Incident #186: the same ordering hides staleness behind EVERY
            // required field, not only the title. A draft saved while the
            // store's photos could not be read (the per-product content read
            // is best-effort) or before the photos were uploaded holds no
            // images forever and reports `images`, never CREATE_BASE_STALE.
            // So any missing-field refusal gets this one refresh; a true
            // no-op refresh is refused by the draft service's duplicate guard.
            const missingField = typeof preflight.json?.field === 'string' ? preflight.json.field : 'field';
            if (code === 'CREATE_REQUIRED_FIELD_MISSING' && !refreshed) {
              refreshed = true;
              let repaired = false;
              for (let repair = 0; repair < 2 && !repaired; repair += 1) {
                try {
                  const dto = await draftService.get(row.id);
                  const payload = draftPayload(dto, {});
                  (payload as { catalogId: unknown }).catalogId = row.id;
                  const saved = await draftService.save(payload,
                    missingField === 'title' ? 'publish-all-title-fit' : 'publish-all-refresh');
                  revisionDigest = saved.revision.revisionDigest;
                  repaired = true;
                } catch (error) {
                  const refused = error instanceof Error && 'code' in error
                    ? String((error as { code: unknown }).code) : 'unavailable';
                  warn(`[Publish All] ${missingField} repair for ${sku} was refused (${refused})${repair === 0 ? '; retrying' : ''}`);
                }
              }
              if (repaired) continue;
            }
            if (code === 'CREATE_REQUIRED_FIELD_MISSING') {
              const field = typeof preflight.json?.field === 'string' ? preflight.json.field : 'a field';
              skipReason = field === 'title'
                ? 'eBay needs a title of 1–80 characters and the draft title could not be shortened automatically — open the item and edit the eBay title.'
                : field === 'images'
                  ? photosKnownMissing
                    ? NO_SHOPIFY_PHOTOS
                    : 'eBay needs 1–24 photos and the store\'s photos could not be read into the draft (only https://cdn.shopify.com images are used) — it retries next run; if this repeats, open the item and check Photos.'
                  : `eBay requires ${field} and the item does not have it yet — open the item to fill it.`;
              break;
            }
            if (code === 'CREATE_TARGET_ALREADY_LISTED') {
              skipReason = 'Already listed on eBay.';
              break;
            }
            if ((preflight.json === null || code === 'LISTING_LIFECYCLE_DENIED') && attempt < 2) {
              continue;
            }
            stop = `Preflight refused ${sku}: ${code ?? 'no summary'}`;
            break;
          }
          return { manifestDigest, skipReason, stop };
        };
        let { manifestDigest, skipReason, stop } = await runPreflight();
        if (skipReason !== null) {
          record({ sku, title, status: 'skipped', reason: skipReason });
          if (!isLast) await sleep(20_000);
          continue;
        }
        if (stop !== null || manifestDigest === null) {
          // One unknown refusal must not starve the queue behind it
          // (2026-09-23: five days of runs stalled on repeat halts). The
          // item records failed and the run continues; three consecutive
          // unknowns signal something systemic and stop the run.
          consecutiveUnknown += 1;
          record({ sku, title, status: 'failed',
            reason: stop ?? `Preflight for ${sku} never produced a manifest` });
          if (consecutiveUnknown >= 3) {
            status.stopReason = `Three consecutive preflight failures (last: ${stop ?? sku})`;
            status.state = 'stopped';
            warn(`[Publish All] stopped: ${status.stopReason}`);
            return;
          }
          if (!isLast) await sleep(45_000);
          continue;
        }
        consecutiveUnknown = 0;

        // Dispatch re-derives the whole target from a FRESH store capture, so
        // it can refuse what preflight accepted 40s earlier: a throttled or
        // failed capture (LISTING_LIFECYCLE_DENIED) or Shopify changing in
        // the gap (CREATE_BASE_STALE …). Incident #172: two items failed as
        // "denied" with no retry and no code. A refusal from this set is
        // re-checked once from preflight (which rebases a stale draft) and
        // dispatched again. That is safe: one manifest is one intent forever,
        // so an unchanged draft can only replay-deny, and a create that left
        // a job open on the ledger is never retried here.
        // A refresh save binds the item to a NEW revision, and so to a new
        // manifest and a new intent (one manifest digest is one intent
        // forever). It keeps every override (draftPayload carries them).
        const refreshRevision = async (actor: string): Promise<boolean> => {
          try {
            const dto = await draftService.get(row.id);
            const payload = draftPayload(dto, {});
            (payload as { catalogId: unknown }).catalogId = row.id;
            const saved = await draftService.save(payload, actor);
            revisionDigest = saved.revision.revisionDigest;
            return true;
          } catch (error) {
            const refused = error instanceof Error && 'code' in error
              ? String((error as { code: unknown }).code) : 'unavailable';
            warn(`[Publish All] draft refresh for ${sku} was refused (${refused})`);
            return false;
          }
        };
        let dispatched: Awaited<ReturnType<StepRunner>> = { json: null };
        let deniedCode: string | null = null;
        let dispatchStatus = 'no-summary';
        let listingId: string | null = null;
        let published = false;
        let providerFailureNote: string | null = null;
        let cleanedDispatch: Record<string, unknown> | null = null;
        // Incident #212: eBay answered a create with a 5xx ("A system error
        // has occurred"). That is eBay's own trouble, not a refusal of the
        // payload, but the item failed for the run, and its draft's intent
        // was spent: every later run was replay-denied
        // (CREATE_INTENT_ALREADY_RECORDED) and skipped until the operator
        // saved the draft by hand. A transient provider failure whose
        // leftovers are cleared gets ONE more attempt after a pause, from a
        // refreshed revision; a replay denial with nothing open on the
        // ledger is refreshed the same way (below).
        for (let providerTry = 0; providerTry < 2; providerTry += 1) {
          for (let pass = 0; pass < 2; pass += 1) {
            step('Pausing 40s before publishing (Shopify rate limit)');
            await sleep(40_000);
            step('Publishing to eBay');
            dispatched = await runStep(substituteArgv(dispatchArgv, {
              catalogId: row.id, sku, revisionDigest, manifestDigest,
            }));
            deniedCode = dispatched.json?.status === 'denied'
              ? (typeof dispatched.json.code === 'string' ? dispatched.json.code : 'no code')
              : null;
            if (pass > 0 || deniedCode === null) break;
            if (deniedCode === 'CREATE_INTENT_ALREADY_RECORDED') {
              // An earlier attempt used this exact draft. Dispatch reached
              // the intent check, so its fresh capture found nothing of the
              // item on eBay; with no open create on the ledger the earlier
              // attempt is fully closed, and only a new revision can
              // publish (incident #212).
              if (findUnresolvedCreate(sku) !== null) break;
              warn(`[Publish All] ${sku}: an earlier attempt used this draft; refreshing it once`);
              step('An earlier attempt used this draft — refreshing it');
              if (!await refreshRevision('publish-all-intent-refresh')) break;
            } else {
              if (!DISPATCH_RECHECK_CODES.has(deniedCode) || findUnresolvedCreate(sku) !== null) break;
              warn(`[Publish All] dispatch refused ${sku}: ${deniedCode}; re-checking once`);
              step(`eBay publish was refused (${deniedCode}) — re-checking in 60s`);
              await sleep(60_000);
            }
            const again = await runPreflight();
            if (again.manifestDigest === null) {
              ({ skipReason, stop } = again);
              break;
            }
            manifestDigest = again.manifestDigest;
          }
          if (deniedCode !== null && (skipReason !== null || stop !== null)) break;
          dispatchStatus = typeof dispatched.json?.status === 'string'
            ? dispatched.json.status : 'no-summary';
          listingId = typeof dispatched.json?.listingId === 'string'
            ? dispatched.json.listingId : null;
          // The ceremony reports 'dispatched-and-reconciled'; older box-script
          // runners said 'created-and-reconciled'. Accept both.
          published = (dispatchStatus === 'dispatched-and-reconciled'
            || dispatchStatus === 'created-and-reconciled') && listingId !== null;
          // eBay read-lag (L63): a create can take 10-60s to appear in a fresh
          // capture. With a listing id in hand, reconcile patiently before
          // declaring failure — the first proving run marked 11 LIVE listings
          // failed for want of this loop (2026-09-23).
          if (!published && listingId !== null && reconcileArgv
            && typeof dispatched.json?.jobId === 'string'
            && typeof dispatched.json?.attemptId === 'string') {
            for (let attempt = 0; attempt < 4 && !published; attempt += 1) {
              step('Confirming the listing is live on eBay');
              await sleep(10_000 + attempt * 10_000);
              const reconciled = await runStep(substituteArgv(reconcileArgv, {
                catalogId: row.id, sku, revisionDigest,
                jobId: dispatched.json.jobId, attemptId: dispatched.json.attemptId,
              }));
              published = reconciled.json?.resolution === 'resolved_existing';
            }
          }
          if (published || deniedCode !== null || dispatched.json === null) break;
          const failure = providerFailure(dispatched.json);
          warn(`[Publish All] create for ${sku} failed at ${failure.detail}`);
          if (!failure.transient) break;
          providerFailureNote = failure.detail;
          if (providerTry > 0) break;
          // Clear what the failed attempt left on eBay first. A retry needs
          // proof the attempt is closed: the ceremony confirmed nothing was
          // created, or the reconcile chain is armed and the ledger holds no
          // open create for the SKU. The fresh preflight then re-proves the
          // item is not on eBay before anything is sent again.
          await cleanupFailedCreate({
            catalogId: row.id, sku, revisionDigest,
            dispatchJson: { ...dispatched.json, manifestDigest },
          });
          cleanedDispatch = dispatched.json;
          if (findUnresolvedCreate(sku) !== null) await sweepResidue(row);
          if ((dispatchStatus !== 'dispatch-failed-confirmed-missing' && !reconcileArgv)
            || findUnresolvedCreate(sku) !== null) {
            break;
          }
          step('eBay had a temporary server error — retrying in 2 minutes');
          await sleep(120_000);
          if (!await refreshRevision('publish-all-provider-retry')) break;
          const again = await runPreflight();
          if (again.manifestDigest === null) {
            ({ skipReason, stop } = again);
            break;
          }
          manifestDigest = again.manifestDigest;
          dispatched = { json: null };
        }
        if (dispatched.json === null && (skipReason !== null || stop !== null)) {
          // The provider retry's preflight refused; the failed attempt was
          // already cleaned up.
          record({ sku, title, status: skipReason !== null ? 'skipped' : 'failed',
            reason: skipReason ?? `${stop} (after eBay's server error: ${providerFailureNote})` });
          if (!isLast) await sleep(20_000);
          continue;
        }
        if (deniedCode !== null && (skipReason !== null || stop !== null)) {
          record({ sku, title, status: skipReason !== null ? 'skipped' : 'failed',
            reason: skipReason ?? `${stop} (after dispatch refused: ${deniedCode})` });
          if (!isLast) await sleep(20_000);
          continue;
        }
        if (published && listingId !== null) {
          record({ sku, title, status: 'published', listingId, ...(agentNote ? { reason: agentNote } : {}) });
          info(`[Publish All] ${sku} live as ${listingId}`);
        } else if (dispatched.json?.code === 'CREATE_INTENT_ALREADY_RECORDED') {
          record({ sku, title, status: 'skipped', reason: 'A previous attempt already used this draft — open the item and publish from there.' });
        } else if (deniedCode === 'CREATE_TARGET_ALREADY_LISTED') {
          record({ sku, title, status: 'skipped', reason: 'Already listed on eBay.' });
        } else {
          const rawMessages = dispatched.json?.dispatchFailureEbayErrorMessages;
          const providerMessage = Array.isArray(rawMessages) && typeof rawMessages[0] === 'string'
            ? rawMessages[0] : null;
          if (dispatched.json !== null && dispatched.json !== cleanedDispatch) {
            await cleanupFailedCreate({
              catalogId: row.id, sku, revisionDigest,
              dispatchJson: { ...dispatched.json, manifestDigest },
            });
          }
          record({
            sku, title, status: 'failed',
            reason: providerMessage
              ? `eBay refused the listing: ${providerMessage}${providerFailureNote
                ? ` (${providerFailureNote}; it retries next run)` : ''}`
              : deniedCode !== null
                // Carry the ceremony's code: it names the gate that refused
                // and is what the watchdog groups incidents by.
                ? `The publish did not complete (denied: ${deniedCode}).`
                : `The publish did not complete (${dispatchStatus}).`,
          });
        }
        if (!isLast) await sleep(60_000);
      }
      status.state = 'finished';
      const published = status.items.filter((item) => item.status === 'published').length;
      info(`[Publish All] finished: ${published} published, `
        + `${status.items.length - published} skipped/failed of ${status.totalReady}`);
    } catch (error) {
      status.stopReason = error instanceof Error ? error.message : 'unexpected failure';
      status.state = 'stopped';
      warn(`[Publish All] crashed: ${status.stopReason}`);
    } finally {
      status.currentSku = null;
      step(null);
      status.finishedAtUtc = now();
      releasePublishLock();
    }
  })();

  return { started: true, run };
}

/**
 * Operator-armed schedule: PUBLISH_ALL_INTERVAL_MINUTES (min 60). Arming the
 * variable is the operator's standing batch approval, exactly like the
 * armed inventory sweep. Off by default; absent or invalid = no schedule.
 */
export function initPublishAllSchedule(
  dependencies: PublishAllDependencies = {},
): NodeJS.Timeout | null {
  const raw = process.env.PUBLISH_ALL_INTERVAL_MINUTES;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 60 || minutes > 10_080) {
    warn('[Publish All] PUBLISH_ALL_INTERVAL_MINUTES invalid; schedule not armed');
    return null;
  }
  info(`[Publish All] scheduled every ${minutes} minutes`);
  const timer = setInterval(() => {
    const result = startPublishAllRun('schedule', dependencies);
    if (!result.started) info('[Publish All] scheduled run skipped (busy or unarmed)');
  }, minutes * 60_000);
  timer.unref?.();
  return timer;
}
