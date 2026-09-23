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
 * - known-benign blockers (missing condition, eBay-illegal SKU, missing
 *   required field, already-listed) are per-item skips with reasons the
 *   UI shows; unknown failure shapes STOP the run loudly (L65)
 * - a failed dispatch runs the residue-recovery chain so nothing wedges
 * - runs are bounded (MAX_ITEMS) and single-flight, sharing the same lock
 *   as the one-item publish route
 */
import { openListingControlStoreReadOnly } from '../listing-control-store/index.js';
import { info, warn } from '../utils/logger.js';
import { LISTING_DRAFT_SCOPE } from './listing-draft-service.js';
import { findUnresolvedListingCreateFromArgv } from './migration-state-reader.js';
import { createProcessStepRunner, substituteArgv, type StepRunner } from './order-import-trigger.js';

const SKU_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_ITEMS = 30;

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
  items: PublishAllItem[];
  stopReason: string | null;
};

const status: MutableStatus = {
  state: 'idle', startedAtUtc: null, finishedAtUtc: null, startedBy: null,
  totalReady: 0, currentSku: null, items: [], stopReason: null,
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
  shopify: { sku: string; title: string } | null;
  audit?: { attentionReasons?: readonly string[] };
};

type DraftServiceLike = {
  get: (catalogId: string) => Promise<{
    revision: null | { revisionDigest: string };
    base: { sourceDigest: string; ebayDigest: string };
    sections: {
      listing: {
        title: { draft: string | null };
        category: { draft: string | null; shopify: string | null };
        conditionDescription: { draft: string | null; shopify: string | null };
      };
      content: { itemSpecifics: { draft: string | null; shopify: string | null } };
    };
  }>;
  save: (request: unknown, actor: string) => Promise<{
    revision: { revisionDigest: string };
  }>;
};

export type PublishAllDependencies = Readonly<{
  getSnapshot?: () => Promise<{ rows: readonly SnapshotRow[] }>;
  draftService?: DraftServiceLike;
  runStep?: StepRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  maxItems?: number;
  getCategoryAspects?: (categoryId: string) => Promise<{
    available: boolean;
    aspects: ReadonlyArray<{ name: string; required: boolean }>;
  }>;
  findUnresolvedCreate?: (sku: string) => Readonly<{
    jobId: string; attemptId: string; intentKey: string; evidenceDigest: string;
  }> | null;
  latestRevisionDigest?: (catalogId: string) => string | null;
}>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

function draftPayload(dto: Awaited<ReturnType<DraftServiceLike['get']>>, overrides: {
  conditionDescription?: string | null;
}): Record<string, unknown> {
  let specifics: string | null = null;
  const raw = dto.sections.content.itemSpecifics.draft;
  if (raw) {
    // The create manifest demands alphabetically sorted specifics keys.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) sorted[key] = parsed[key];
    specifics = JSON.stringify(sorted);
  }
  return {
    schemaVersion: 1,
    action: 'save_local_draft',
    catalogId: undefined as unknown, // filled by caller
    expectedRevisionDigest: dto.revision?.revisionDigest ?? null,
    base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest },
    draft: {
      title: dto.sections.listing.title.draft,
      category: null,
      condition: null,
      conditionDescription: overrides.conditionDescription !== undefined
        ? overrides.conditionDescription
        : dto.sections.listing.conditionDescription.draft,
      description: null,
      images: null,
      itemSpecifics: specifics,
      fulfillmentPolicyId: null,
      paymentPolicyId: null,
      returnPolicyId: null,
      merchantLocation: null,
    },
  };
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
      .getLiveListingCatalogSnapshot.refresh() as Promise<{ rows: readonly SnapshotRow[] }>);
  const draftServicePromise: Promise<DraftServiceLike> = dependencies.draftService
    ? Promise.resolve(dependencies.draftService)
    : import('./listing-draft-service.js')
      .then((module) => module.createListingDraftService() as unknown as DraftServiceLike);
  const getCategoryAspects = dependencies.getCategoryAspects
    ?? (async (categoryId: string) => (await import('./ebay-category-aspects.js'))
      .getEbayCategoryAspects(categoryId));
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
  status.items = [];
  status.stopReason = null;

  const record = (item: PublishAllItem): void => { status.items.push(item); };

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
      const wedged = snapshot.rows.filter(
        (row): row is SnapshotRow & { shopify: { sku: string; title: string } } =>
          row.shopify !== null
          && row.audit?.attentionReasons?.includes('ebay_unpublished_artifact') === true);
      for (const row of wedged.slice(0, 10)) {
        status.currentSku = row.shopify.sku;
        await sweepResidue(row);
      }
      const freshSnapshot = wedged.length > 0 ? await getSnapshot() : snapshot;
      const ready = freshSnapshot.rows
        .filter((row): row is SnapshotRow & { shopify: { sku: string; title: string } } =>
          row.readyToList === true && row.shopify !== null
          && !row.shopify.sku.startsWith('PIPELINE-TEST'))
        .slice(0, maxItems);
      status.totalReady = ready.length;
      info(`[Publish All] ${startedBy}: ${ready.length} ready`
        + (wedged.length > 0 ? ` (${wedged.length} residue recoveries attempted)` : ''));

      let consecutiveUnknown = 0;
      for (const row of ready) {
        const sku = row.shopify.sku;
        const title = row.shopify.title;
        status.currentSku = sku;
        if (!SKU_GRAMMAR.test(sku)) {
          record({ sku, title, status: 'skipped', reason: 'The SKU contains characters eBay refuses — rename it in Shopify (no slashes or spaces).' });
          continue;
        }
        if (row.readyToListGaps?.includes('condition')) {
          record({ sku, title, status: 'skipped', reason: 'No condition could be determined — add a condition- tag in Shopify or a *USED* / *NEW OLD STOCK* title marker.' });
          continue;
        }

        // Ensure a draft revision exists (pure-inherit save when missing).
        let revisionDigest: string;
        try {
          const dto = await draftService.get(row.id);
          if (dto.revision) {
            revisionDigest = dto.revision.revisionDigest;
          } else {
            const chart = dto.sections.listing.conditionDescription.shopify;
            const note = ((chart ? `${chart} ` : '')
              + 'The photographs show the exact item for sale.').slice(0, 1000);
            const payload = draftPayload(dto, { conditionDescription: note });
            (payload as { catalogId: unknown }).catalogId = row.id;
            const saved = await draftService.save(payload, 'publish-all');
            revisionDigest = saved.revision.revisionDigest;
          }
        } catch (error) {
          record({ sku, title, status: 'skipped', reason: `The draft could not be prepared (${error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'unavailable'}) — open the item and save it once.` });
          await sleep(45_000);
          continue;
        }

        // REQUIRED-ASPECT GATE (L73): eBay reveals missing aspects one
        // 25002 refusal at a time, and each refusal burns an intent and
        // strands an unpublished offer. Check the category's complete
        // required list BEFORE any ceremony and skip with every missing
        // name in ONE message an employee can act on.
        try {
          const dto = await draftService.get(row.id);
          const categoryId = dto.sections.listing.category.draft
            ?? dto.sections.listing.category.shopify;
          const specificsRaw = dto.sections.content.itemSpecifics.draft
            ?? dto.sections.content.itemSpecifics.shopify;
          if (categoryId !== null) {
            const taxonomy = await getCategoryAspects(categoryId);
            if (taxonomy.available) {
              const present = new Set(Object.keys(
                specificsRaw ? JSON.parse(specificsRaw) as Record<string, unknown> : {},
              ).map((name) => name.toLowerCase()));
              const missing = taxonomy.aspects
                .filter((aspect) => aspect.required && !present.has(aspect.name.toLowerCase()))
                .map((aspect) => aspect.name);
              if (missing.length > 0) {
                record({ sku, title, status: 'skipped',
                  reason: `eBay requires ${missing.join(', ')} for this category — open the item, use the one-click Add buttons in Item specifics, and it will publish next run.` });
                await sleep(15_000);
                continue;
              }
            }
          }
        } catch {
          // The gate is advisory; preflight remains the authority.
        }

        // Preflight with auto-rebase + transient retry (3 attempts).
        let manifestDigest: string | null = null;
        let skipReason: string | null = null;
        let stop: string | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0) await sleep(90_000);
          const values = { catalogId: row.id, sku, revisionDigest };
          const preflight = await runStep(substituteArgv(preflightArgv, values));
          const code = typeof preflight.json?.code === 'string' ? preflight.json.code : null;
          const digest = preflight.json?.manifestDigest;
          if (typeof digest === 'string' && DIGEST.test(digest)) {
            manifestDigest = digest;
            break;
          }
          if (code === 'CREATE_BASE_STALE' && attempt === 0) {
            try {
              const dto = await draftService.get(row.id);
              const payload = draftPayload(dto, {});
              (payload as { catalogId: unknown }).catalogId = row.id;
              const saved = await draftService.save(payload, 'publish-all-rebase');
              revisionDigest = saved.revision.revisionDigest;
              continue;
            } catch {
              skipReason = 'Shopify changed under the draft and it could not be refreshed — open the item and use “Update draft & publish again”.';
              break;
            }
          }
          if (code === 'CREATE_REQUIRED_FIELD_MISSING') {
            const field = typeof preflight.json?.field === 'string' ? preflight.json.field : 'a field';
            skipReason = `eBay requires ${field} and the item does not have it yet — open the item to fill it.`;
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
        if (skipReason !== null) {
          record({ sku, title, status: 'skipped', reason: skipReason });
          await sleep(20_000);
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
          await sleep(45_000);
          continue;
        }
        consecutiveUnknown = 0;

        await sleep(40_000);
        const values = { catalogId: row.id, sku, revisionDigest, manifestDigest };
        const dispatched = await runStep(substituteArgv(dispatchArgv, values));
        const dispatchStatus = typeof dispatched.json?.status === 'string'
          ? dispatched.json.status : 'no-summary';
        const listingId = typeof dispatched.json?.listingId === 'string'
          ? dispatched.json.listingId : null;
        if (dispatchStatus === 'created-and-reconciled' && listingId !== null) {
          record({ sku, title, status: 'published', listingId });
          info(`[Publish All] ${sku} live as ${listingId}`);
        } else if (dispatched.json?.code === 'CREATE_INTENT_ALREADY_RECORDED') {
          record({ sku, title, status: 'skipped', reason: 'A previous attempt already used this draft — open the item and publish from there.' });
        } else {
          const rawMessages = dispatched.json?.dispatchFailureEbayErrorMessages;
          const providerMessage = Array.isArray(rawMessages) && typeof rawMessages[0] === 'string'
            ? rawMessages[0] : null;
          if (dispatched.json !== null) {
            await cleanupFailedCreate({
              catalogId: row.id, sku, revisionDigest,
              dispatchJson: { ...dispatched.json, manifestDigest },
            });
          }
          record({
            sku, title, status: 'failed',
            reason: providerMessage
              ? `eBay refused the listing: ${providerMessage}`
              : `The publish did not complete (${dispatchStatus}).`,
          });
        }
        await sleep(60_000);
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
