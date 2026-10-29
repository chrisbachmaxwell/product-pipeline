/**
 * Self-healing tier 1+2 (L75/L76): the app already records every failure
 * truthfully — 34 rejected sell-out ends sat in the ledger for 38 hours
 * with zero human-visible alarm. This watchdog turns the known emergency
 * shapes into INCIDENTS a human actually sees (UI banner via
 * /api/incidents), optionally diagnosed by Claude (tier 2, armed by
 * ANTHROPIC_API_KEY) and escalated to a GitHub issue whose `incident`
 * label triggers the fix-proposing workflow (tier 3 — a human always
 * merges).
 *
 * READ-ONLY by construction: it reads the cached catalog snapshot and the
 * migration ledger through the approved projection path, performs zero
 * provider writes, and sends only sanitized, PII-free signal data to the
 * diagnosis model (the ledger stores no PII by design; provider text is
 * token-stripped at the source).
 */
import fs from 'node:fs';
import path from 'node:path';
import { info, warn } from '../utils/logger.js';
import { sendIncidentEmail } from './incident-email.js';
import { getPublishAllStatus, OPERATOR_DATA_SKIP_REASONS } from './publish-all.js';
import { lastOrderImportFailure } from './order-import-trigger.js';
import {
  readIncidentLedgerSignalsFromArgv,
  type IncidentLedgerSignals,
} from './migration-state-reader.js';

const EVALUATION_INTERVAL_MS = 5 * 60_000;
const LEDGER_WINDOW_MS = 24 * 3_600_000;
const UNRESOLVED_CREATE_AGE_MS = 60 * 60_000;
const SNAPSHOT_STALE_MS = 45 * 60_000;
/** A zero-stock live listing must persist across two evaluations before it
 * is an incident — the sweep's normal end takes a few minutes. */
const PERSISTENCE_MS = 8 * 60_000;
const STATE_FILE = '/data/product-pipeline/incidents.json';
const MAX_INCIDENTS = 20;

export type Incident = {
  /** Stable fingerprint: code + subject. */
  id: string;
  severity: 'critical' | 'warning';
  code: 'ORDER_PIPELINE_BLOCKED' | 'OVERSELL_EXPOSURE' | 'END_DISPATCH_REJECTED' | 'PRICE_SYNC_REJECTED' | 'UNRESOLVED_CREATE_AGING' | 'FULFILLMENT_STUCK' | 'PUBLISH_RUN_STOPPED' | 'PUBLISH_ITEM_BLOCKED' | 'SNAPSHOT_STALE';
  sku: string | null;
  title: string;
  detail: string;
  detectedAtUtc: string;
  lastSeenAtUtc: string;
  diagnosisState: 'none' | 'pending' | 'done' | 'failed';
  diagnosis: string | null;
  githubIssueUrl: string | null;
  notifiedAtUtc: string | null;
  /**
   * A publish block whose every item is verified store data only the
   * operator can change (no photos, no title), or a price refusal caused by
   * a listing setting only the operator can change (a price-locking markdown
   * sale). Shown to the operator, never sent to the fix agent: no code change
   * can clear it (incidents #194, #221).
   */
  operatorOnly?: boolean;
};

type SnapshotRow = {
  shopify: { sku: string; title: string; available: number | null; productStatus: string } | null;
  ebay: { listingId: string | null } | null;
  /** Catalog classification; the sell-out sweep scans only 'active' rows. */
  lifecycleStatus?: string;
  audit?: { attentionReasons: readonly string[] };
};

/**
 * Why the sell-out guard may not have acted on an oversell row, from the
 * catalog's own classification (incident #196, L104: the watchdog fires on
 * any lifecycle, the --end-at-zero sweep only on 'active' — say which).
 */
function oversellGuardDetail(row: SnapshotRow): string {
  if (row.lifecycleStatus === undefined) return '';
  if (row.lifecycleStatus !== 'active') {
    const reasons = row.audit?.attentionReasons ?? [];
    return ` The catalog classifies this row '${row.lifecycleStatus}'`
      + (reasons.length > 0 ? ` (reasons: ${reasons.join(', ')})` : '')
      + ' — the --end-at-zero sweep selects only \'active\' rows, so it was never '
      + 'attempted. Find where live-listing-catalog.ts adds those reasons.';
  }
  return ' The catalog classifies this row \'active\', so the sweep selected it: '
    + 'look for this SKU\'s skip code in the "[Inventory Alignment]" summary log line.';
}
type Snapshot = { observedAtUtc: string; rows: readonly SnapshotRow[] };

export type WatchdogDependencies = Readonly<{
  getSnapshot?: () => Promise<Snapshot>;
  getLedgerSignals?: (sinceUtc: string) => IncidentLedgerSignals | null;
  now?: () => number;
  stateFile?: string;
  diagnose?: (incident: Incident, context: string) => Promise<string>;
  openIssue?: (incident: Incident) => Promise<string | null>;
  /** The URL of an already-open GitHub incident issue for this incident, if any. */
  findOpenIssue?: (incident: Incident) => Promise<string | null>;
  notify?: (incident: Incident) => Promise<void>;
  learningsContext?: () => string;
  getPublishStatus?: () => Pick<ReturnType<typeof getPublishAllStatus>, 'state' | 'stopReason' | 'items'>;
  /** Test seam; defaults to the adapter's provider-rejections ring. */
  getProviderRejections?: () => unknown;
}>;

/**
 * Publish-All items the run could not publish, grouped by root cause so one
 * defect hitting ten SKUs is ONE incident (and one fix PR), not ten. The
 * class is the first error code in the reason (CREATE_IDENTITY_MISMATCH,
 * …) or, without one, the reason with SKUs and listed names stripped.
 * Items the operator deliberately holds never reach the run (no-ebay tag,
 * L90). Skips for store data only the operator can fix (no photos, no
 * title) are marked `operatorOnly`; everything else is something the
 * pipeline failed to handle.
 */
export function publishBlockCandidates(
  items: ReadonlyArray<{ sku: string; status: string; reason?: string }>,
): Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail' | 'operatorOnly'>> {
  const groups = new Map<string, Array<{ sku: string; reason: string }>>();
  for (const item of items) {
    if (item.status !== 'failed' && item.status !== 'skipped') continue;
    const reason = (item.reason ?? item.status).slice(0, 400);
    const code = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.exec(reason)?.[0];
    const reasonClass = code ?? reason
      .split(item.sku).join('<sku>')
      .replace(/eBay requires .*? for this category/, 'eBay requires <aspects> for this category')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const group = groups.get(reasonClass) ?? [];
    group.push({ sku: item.sku, reason });
    groups.set(reasonClass, group);
  }
  return [...groups.entries()].map(([reasonClass, group]) => {
    const operatorOnly = group.every((entry) => OPERATOR_DATA_SKIP_REASONS.includes(entry.reason));
    return {
      id: `PUBLISH_ITEM_BLOCKED:${reasonClass}`,
      severity: 'warning' as const,
      code: 'PUBLISH_ITEM_BLOCKED' as const,
      sku: group[0]!.sku,
      title: `Publish All could not publish ${group.length === 1 ? group[0]!.sku : `${group.length} items`}: ${reasonClass}`,
      detail: (operatorOnly
        ? 'The last Publish All run skipped these items because of store data only you can change. '
          + 'Fix it in Shopify and the next run publishes them.\n'
        : 'The last Publish All run skipped or failed these items for the same cause. '
          + 'Find the root cause in the publish path and fix it so the next run publishes them '
          + 'without manual work.\n')
        + group.slice(0, 8).map((entry) => `- ${entry.sku}: ${entry.reason}`).join('\n'),
      operatorOnly,
    };
  });
}

/**
 * Pure detection over one observation. Persistence (the two-sighting rule
 * for oversell exposure) is the runner's job.
 */
export function evaluateIncidentCandidates(input: {
  snapshot: Snapshot;
  signals: IncidentLedgerSignals | null;
  nowMs: number;
  /** Test seam; defaults to the adapter's provider-rejections ring. */
  providerRejections?: unknown;
}): Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail' | 'operatorOnly'>> {
  const candidates: Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail' | 'operatorOnly'>> = [];
  const { snapshot, signals, nowMs } = input;

  const stuckOrder = signals?.oldestUnresolvedOrder ?? null;
  if (stuckOrder !== null) {
    const ageMs = nowMs - Date.parse(stuckOrder.observedAtUtc);
    if (Number.isFinite(ageMs) && ageMs > 30 * 60_000) {
      const hours = Math.round(ageMs / 3_600_000 * 10) / 10;
      // The recorded denial code turns this from "go read server logs" into
      // a greppable root-cause lead the fix-proposal agent can act on (L80:
      // on 2026-09-25 that code was SHOPIFY_TARGET_INVALID and lived only
      // in logs nobody reads).
      const failure = lastOrderImportFailure(stuckOrder.orderId);
      candidates.push({
        id: `ORDER_PIPELINE_BLOCKED:${stuckOrder.orderId}`,
        severity: 'critical',
        code: 'ORDER_PIPELINE_BLOCKED',
        sku: null,
        title: `eBay ORDERS ARE NOT IMPORTING — blocked ${hours}h behind order ${stuckOrder.orderId}`,
        detail: 'The order poll is strictly ordered: one order that cannot import freezes '
          + 'EVERY order behind it — customers are paying and nothing reaches Shopify to '
          + 'ship (L77 was 40 hours and account strikes). '
          + (failure !== null
            ? `The import for ${stuckOrder.orderId} last failed with code ${failure.code} `
              + `at ${failure.atUtc} — search the codebase for that code to find every `
              + 'deny site on the import path. '
            : `Check the server log for ORDER_IMPORT_FAILED lines naming ${stuckOrder.orderId}. `)
          + 'Fix the cause and the pipeline drains automatically.',
      });
    }
  }

  for (const row of snapshot.rows) {
    if (!row.shopify || !row.ebay) continue;
    if (row.shopify.available !== null && row.shopify.available <= 0
      && row.ebay.listingId !== null) {
      candidates.push({
        id: `OVERSELL_EXPOSURE:${row.shopify.sku}`,
        severity: 'critical',
        code: 'OVERSELL_EXPOSURE',
        sku: row.shopify.sku,
        title: `SOLD ITEM STILL BUYABLE ON EBAY: ${row.shopify.sku}`,
        detail: `Shopify shows 0 in stock but eBay listing ${row.ebay.listingId} is still live. `
          + 'Every minute risks a second sale. If this persists, end the listing on eBay '
          + 'manually and check the sell-out guard.' + oversellGuardDetail(row),
      });
    }
  }

  for (const failure of signals?.repeatedEndFailures ?? []) {
    const row = snapshot.rows.find((candidate) => candidate.shopify?.sku === failure.sku);
    const stillLive = row?.ebay?.listingId != null;
    // Critical ONLY in true sell-out context (stock <= 0): repeated
    // confirmed_missing on an IN-STOCK listing is alignment churn (the
    // 16437396 chronic-zombie shape), not the L75 emergency — a false
    // critical here would page humans and burn diagnosis spend forever.
    const soldOut = row?.shopify?.available !== null
      && row?.shopify?.available !== undefined && row.shopify.available <= 0;
    candidates.push({
      id: `END_DISPATCH_REJECTED:${failure.sku}`,
      severity: stillLive && soldOut ? 'critical' : 'warning',
      code: 'END_DISPATCH_REJECTED',
      sku: failure.sku,
      title: `eBay is rejecting the sell-out end for ${failure.sku} (${failure.count}× in 24h)`,
      detail: stillLive && soldOut
        ? 'The guard keeps trying to end this listing and eBay keeps refusing — the L75 '
          + 'signature. The listing is STILL LIVE. End it manually on eBay now, then check '
          + 'the server log for EBAY_ENDLIST_REJECTED lines.'
        : 'Repeated end dispatches closed confirmed_missing. The listing is no longer live '
          + '(likely ended manually); the failed-dispatch cause still needs diagnosis.',
    });
  }

  for (const create of signals?.unresolvedCreates ?? []) {
    const ageMs = nowMs - Date.parse(create.reservedAtUtc);
    // A SKU absent from the catalog entirely (sold out, archived, zero
    // eBay artifacts) has nothing to recover and nothing at risk — its
    // orphaned ledger job is bookkeeping, not an incident (L83: the
    // Hektor sold before its stale job could close; the close ceremony
    // itself requires a capture row that no longer exists).
    const rowExists = snapshot.rows.some((row) => row.shopify?.sku === create.sku);
    if (rowExists && Number.isFinite(ageMs) && ageMs > UNRESOLVED_CREATE_AGE_MS) {
      candidates.push({
        id: `UNRESOLVED_CREATE_AGING:${create.sku}`,
        severity: 'warning',
        code: 'UNRESOLVED_CREATE_AGING',
        sku: create.sku,
        title: `A publish for ${create.sku} has been unresolved for over an hour`,
        detail: 'The create dispatched but never verified. Leftover eBay data may be '
          + 'blocking the item; the next Publish All run attempts automatic recovery.',
      });
    }
  }

  for (const failure of signals?.repeatedPriceFailures ?? []) {
    const row = snapshot.rows.find((candidate) => candidate.shopify?.sku === failure.sku
      || `listing ${candidate.ebay?.listingId ?? ''}` === failure.sku);
    const stillLive = row?.ebay?.listingId != null;
    const listingId = row?.ebay?.listingId
      ?? /^listing ([0-9]+)$/u.exec(failure.sku)?.[1] ?? null;
    const reason = providerRejectionFor(
      input.providerRejections ?? readProviderRejections(),
      ['ReviseInventoryStatus', 'ReviseFixedPriceItem'],
      listingId,
    );
    const storeState = reason === null ? null : priceRejectionStoreState(reason);
    if (storeState !== null) {
      candidates.push({
        id: `PRICE_SYNC_REJECTED:${failure.sku}`,
        severity: stillLive ? 'critical' : 'warning',
        code: 'PRICE_SYNC_REJECTED',
        sku: failure.sku,
        title: `eBay is rejecting price updates for ${failure.sku} (${failure.count}× in 24h)`,
        detail: `${storeState} ProductPipeline will align the price automatically after `
          + 'that setting changes. No code change can clear eBay error [21919248].',
        operatorOnly: true,
      });
      continue;
    }
    candidates.push({
      id: `PRICE_SYNC_REJECTED:${failure.sku}`,
      // A live listing showing a WRONG PRICE can sell at that price —
      // that is money, so live = critical (L87; Sept 30 was 55 rejected
      // price revises across five listings with zero alarms).
      severity: stillLive ? 'critical' : 'warning',
      code: 'PRICE_SYNC_REJECTED',
      sku: failure.sku,
      title: `eBay is rejecting price updates for ${failure.sku} (${failure.count}× in 24h)`,
      detail: 'Shopify price changes for this listing are NOT reaching eBay — the live '
        + 'listing may be selling at the old price. Set the price manually on eBay now. '
        + (reason !== null
          ? `eBay's own reason for the most recent rejection: ${reason}`
          : 'eBay\'s reason was not captured for this listing — check the server log for '
            + `EBAY_TRADING_REJECTED lines${listingId === null ? '' : ` naming item=${listingId}`}.`),
    });
  }

  for (const fulfillment of signals?.unresolvedFulfillments ?? []) {
    const ageMs = nowMs - Date.parse(fulfillment.reservedAtUtc);
    if (Number.isFinite(ageMs) && ageMs > 2 * 3_600_000) {
      candidates.push({
        id: `FULFILLMENT_STUCK:${fulfillment.subject}`,
        severity: 'warning',
        code: 'FULFILLMENT_STUCK',
        sku: null,
        title: `A tracking-number push for ${fulfillment.subject} has been unresolved for hours`,
        detail: 'The buyer paid and the shipment may already be moving, but eBay has not '
          + 'been told — late tracking risks defects. Check the server log for '
          + 'FULFILLMENT lines and the order in Seller Hub.',
      });
    }
  }

  const snapshotAgeMs = nowMs - Date.parse(snapshot.observedAtUtc);
  if (Number.isFinite(snapshotAgeMs) && snapshotAgeMs > SNAPSHOT_STALE_MS) {
    candidates.push({
      id: 'SNAPSHOT_STALE',
      severity: 'warning',
      code: 'SNAPSHOT_STALE',
      sku: null,
      title: `The live catalog has not refreshed in ${Math.round(snapshotAgeMs / 60000)} minutes`,
      detail: 'Sweeps and guards act on this snapshot; a stale one means they are flying '
        + 'blind. Check the server logs for capture failures (Shopify throttle or eBay '
        + 'quota exhaustion are the usual causes).',
    });
  }

  return candidates;
}

/**
 * eBay price refusals caused by a listing setting only the operator can
 * change, keyed by eBay error code (incident #221: 21919248, the listing is
 * in a Seller Hub markdown sale that locks its price). The pipeline cannot
 * and must not undo an operator's promotion, so these go to the operator
 * with the exact step, never to the fix agent. Returns that step, or null.
 */
const STORE_STATE_PRICE_REJECTIONS: ReadonlyArray<readonly [code: string, step: string]> = [
  ['21919248', 'This listing is in an eBay markdown sale whose settings lock its price, '
    + 'so eBay refuses every price change, including one made by hand on eBay. In Seller Hub, '
    + 'open Marketing > Promotions, edit the markdown sale and choose the setting that always '
    + 'allows price updates, or remove this listing from the sale.'],
];

export function priceRejectionStoreState(reason: string): string | null {
  for (const [code, step] of STORE_STATE_PRICE_REJECTIONS) {
    if (reason.includes(`[${code}]`)) return step;
  }
  return null;
}

/** The sanitized provider rejections ring written by the Trading adapter
 * (L87) — eBay's own words, safe for incidents and the fix agent. */
function readProviderRejections(): unknown {
  try {
    return JSON.parse(fs.readFileSync(
      '/data/product-pipeline/provider-rejections.json', 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * The latest non-empty rejection of `call` for this listing (#209: the
 * incident quoted the ring's LAST entry, whatever its call or listing, and
 * printed an empty reason verbatim). Entries written before the adapter
 * recorded `listingId` match on call alone.
 */
export function providerRejectionFor(
  entries: unknown,
  call: string | readonly string[],
  listingId: string | null,
): string | null {
  if (!Array.isArray(entries)) return null;
  const calls = new Set(Array.isArray(call) ? call : [call]);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { call?: unknown; listingId?: unknown; reason?: unknown } | null;
    if (entry === null || typeof entry !== 'object'
      || typeof entry.call !== 'string' || !calls.has(entry.call)) continue;
    if (typeof entry.listingId === 'string' && entry.listingId !== listingId) continue;
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') continue;
    return entry.reason.trim().slice(0, 300);
  }
  return null;
}

/* ------------------------------------------------------------------ */

function parseArgvEnv(name: string): readonly string[] | null {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed as string[] : null;
  } catch {
    return null;
  }
}

type PersistedState = {
  incidents: Incident[];
  /** candidate id -> first-seen ms, for the two-sighting persistence rule. */
  pendingSince: Record<string, number>;
};

function loadState(stateFile: string): PersistedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as PersistedState;
    if (Array.isArray(parsed.incidents) && parsed.pendingSince) return parsed;
  } catch { /* fresh */ }
  return { incidents: [], pendingSince: {} };
}

function saveState(stateFile: string, state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch { /* best effort */ }
}

function defaultLearningsContext(): string {
  try {
    const brain = fs.readFileSync(path.resolve(process.cwd(), 'PROJECT_BRAIN.md'), 'utf8');
    const learnings = brain.split('\n').filter((line) => line.startsWith('- **L'));
    return learnings.slice(-15).join('\n').slice(0, 24_000);
  } catch {
    return '';
  }
}

async function defaultDiagnose(incident: Incident, context: string): Promise<string> {
  const resolved = (await import('./connections.js')).readAnthropicKey();
  if (resolved === null) throw new Error('unarmed');
  const key = resolved.key;
  const model = process.env.INCIDENT_DIAGNOSIS_MODEL ?? 'claude-sonnet-5';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system: 'You are the on-call engineer for ProductPipeline, a Shopify→eBay sync app. '
        + 'Every eBay write goes through audited ceremony CLIs; the ledger records every '
        + 'dispatch truthfully. You are given one detected incident and the project\'s '
        + 'recent operational learnings. Respond in plain language for a store operator, '
        + 'under 250 words, with exactly these sections: WHAT HAPPENED, MOST LIKELY CAUSE '
        + '(cite a matching learning by its L-number if one fits), EXPOSURE RIGHT NOW, DO '
        + 'THIS NOW (operator actions), CODE FIX OUTLINE (for the engineer/agent).',
      messages: [{
        role: 'user',
        content: `INCIDENT\ncode: ${incident.code}\nsku: ${incident.sku ?? 'n/a'}\n`
          + `title: ${incident.title}\ndetail: ${incident.detail}\n`
          + `detected: ${incident.detectedAtUtc}\n\nRECENT LEARNINGS\n${context}`,
      }],
    }),
  });
  if (response.status !== 200) throw new Error(`diagnosis http ${response.status}`);
  const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
  if (text.length === 0) throw new Error('empty diagnosis');
  return text.slice(0, 6_000);
}

/** Hidden body marker so a re-sighted incident finds the issue it already filed. */
export function incidentIssueMarker(incident: Pick<Incident, 'id'>): string {
  return `<!-- incident-id: ${encodeURIComponent(incident.id)} -->`;
}

/**
 * An open `incident` issue that already covers this incident: the body
 * carries its id marker, or (issues filed before the marker existed) the
 * title is identical. #236, #239 and #241 were the same slash-SKU block
 * filed once per Publish All run.
 */
export function matchOpenIncidentIssue(
  incident: Pick<Incident, 'id' | 'title'>,
  issues: ReadonlyArray<{ title?: unknown; body?: unknown; html_url?: unknown; pull_request?: unknown }>,
): string | null {
  const marker = incidentIssueMarker(incident);
  const title = `[incident] ${incident.title}`.trim();
  const match = issues.find((issue) => issue.pull_request === undefined
    && typeof issue.html_url === 'string'
    && ((typeof issue.body === 'string' && issue.body.includes(marker))
      || (typeof issue.title === 'string' && issue.title.trim() === title)));
  return match ? match.html_url as string : null;
}

async function defaultFindOpenIssue(incident: Incident): Promise<string | null> {
  const connections = await import('./connections.js');
  const resolved = connections.readGithubToken();
  if (resolved === null) return null;
  const repo = connections.incidentGithubRepo();
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=incident&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (response.status !== 200) return null;
  const body = await response.json() as unknown;
  return Array.isArray(body) ? matchOpenIncidentIssue(incident, body) : null;
}

async function defaultOpenIssue(incident: Incident): Promise<string | null> {
  const connections = await import('./connections.js');
  const resolved = connections.readGithubToken();
  if (resolved === null) return null;
  const token = resolved.token;
  const repo = connections.incidentGithubRepo();
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: `[incident] ${incident.title}`,
      labels: ['incident'],
      body: `**Code:** ${incident.code}\n**SKU:** ${incident.sku ?? 'n/a'}\n`
        + `**Detected:** ${incident.detectedAtUtc}\n\n${incident.detail}\n\n`
        + `## Diagnosis\n\n${incident.diagnosis ?? '_diagnosis unavailable_'}\n\n`
        + '---\nOpened automatically by the incident watchdog (L76). The `incident` '
        + 'label triggers the fix workflow; its PR auto-merges when CI passes and no '
        + 'protected path changed (L94), otherwise a human merges.\n'
        + incidentIssueMarker(incident),
    }),
  });
  if (response.status !== 201) return null;
  const body = await response.json() as { html_url?: string };
  return typeof body.html_url === 'string' ? body.html_url : null;
}

async function defaultNotify(incident: Incident): Promise<void> {
  // Email first (operator ask 2026-09-26: chrism@/nick@pictureline.com);
  // webhook second. Both best-effort and independently armed by env.
  await sendIncidentEmail({
    severity: incident.severity,
    title: incident.title,
    detail: incident.detail,
    diagnosis: incident.diagnosis,
    githubIssueUrl: incident.githubIssueUrl,
    detectedAtUtc: incident.detectedAtUtc,
  }).catch(() => false);
  const url = process.env.INCIDENT_WEBHOOK_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 ${incident.severity.toUpperCase()}: ${incident.title}\n${incident.detail}`
        + (incident.githubIssueUrl ? `\n${incident.githubIssueUrl}` : ''),
    }),
  }).catch(() => undefined);
}

/* ------------------------------------------------------------------ */

let currentIncidents: Incident[] = [];
export function getIncidents(): readonly Incident[] {
  return currentIncidents;
}

export async function runWatchdogOnce(dependencies: WatchdogDependencies = {}): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const stateFile = dependencies.stateFile ?? STATE_FILE;
  const getSnapshot = dependencies.getSnapshot
    ?? (async () => (await import('./live-listing-catalog-source.js'))
      .getLiveListingCatalogSnapshot() as Promise<Snapshot>);
  const getLedgerSignals = dependencies.getLedgerSignals
    ?? ((sinceUtc: string) => readIncidentLedgerSignalsFromArgv(
      parseArgvEnv('PUBLISH_RECONCILE_ARGV') ?? parseArgvEnv('INVENTORY_SWEEP_ARGV'), sinceUtc));
  const diagnose = dependencies.diagnose ?? defaultDiagnose;
  const openIssue = dependencies.openIssue ?? defaultOpenIssue;
  // An injected openIssue (tests) never pairs with the live GitHub lookup.
  const findOpenIssue = dependencies.findOpenIssue
    ?? (dependencies.openIssue ? async () => null : defaultFindOpenIssue);
  const notify = dependencies.notify ?? defaultNotify;
  const learningsContext = dependencies.learningsContext ?? defaultLearningsContext;

  const nowMs = now();
  const nowUtc = new Date(nowMs).toISOString();
  const snapshot = await getSnapshot();
  const signals = getLedgerSignals(new Date(nowMs - LEDGER_WINDOW_MS).toISOString());
  const candidates = evaluateIncidentCandidates({
    snapshot, signals, nowMs, providerRejections: dependencies.getProviderRejections?.(),
  });
  const publishRun = (dependencies.getPublishStatus ?? getPublishAllStatus)();
  if (publishRun.state === 'stopped') {
    candidates.push({
      id: 'PUBLISH_RUN_STOPPED',
      severity: 'warning',
      code: 'PUBLISH_RUN_STOPPED',
      sku: null,
      title: 'The last Publish All run stopped early',
      detail: `It stopped after repeated failures${publishRun.stopReason
        ? `: ${publishRun.stopReason}` : ''}. Items after the stop were not attempted; `
        + 'the next scheduled run retries, but a repeat points at something systemic.',
    });
  }
  if (publishRun.state === 'finished' || publishRun.state === 'stopped') {
    candidates.push(...publishBlockCandidates(publishRun.items));
  }

  const state = loadState(stateFile);
  const nextPending: Record<string, number> = {};
  const active: Incident[] = [];
  for (const candidate of candidates) {
    const existing = state.incidents.find((incident) => incident.id === candidate.id);
    if (existing) {
      // operatorOnly follows the CURRENT cause: a listing whose sale lock
      // was lifted but that eBay now refuses for another reason must reach
      // the fix agent again (#221).
      active.push({ ...existing, ...candidate, operatorOnly: candidate.operatorOnly, lastSeenAtUtc: nowUtc });
      continue;
    }
    // Oversell exposure must persist across two sightings; everything else
    // is already time-gated by its own definition.
    if (candidate.code === 'OVERSELL_EXPOSURE') {
      const firstSeen = state.pendingSince[candidate.id];
      if (firstSeen === undefined) {
        nextPending[candidate.id] = nowMs;
        continue;
      }
      if (nowMs - firstSeen < PERSISTENCE_MS) {
        nextPending[candidate.id] = firstSeen;
        continue;
      }
    }
    active.push({
      ...candidate,
      detectedAtUtc: nowUtc,
      lastSeenAtUtc: nowUtc,
      diagnosisState: 'none',
      diagnosis: null,
      githubIssueUrl: null,
      notifiedAtUtc: null,
    });
    warn(`[Incidents] NEW ${candidate.severity} ${candidate.id}`);
  }

  // Diagnose + escalate new criticals and self-heal publish blocks
  // (bounded: one per cycle to cap spend). A publish block is a warning for
  // the operator (no email, no red banner) but still goes to the fix agent.
  // An operator-only incident (store data or a listing setting no code can
  // change, #194/#221) is shown and alerted, never sent to the fix agent.
  const escalates = (incident: Incident): boolean => incident.operatorOnly !== true
    && (incident.severity === 'critical' || incident.code === 'PUBLISH_ITEM_BLOCKED');
  const needsDiagnosis = active.find((incident) =>
    escalates(incident) && incident.diagnosisState === 'none');
  // A publish block leaves state while the next run is in progress and comes
  // back as "new" when it finishes, so the same unresolved block was
  // re-diagnosed and re-filed once per run (#236, #239, #241 — one fix PR
  // each). Reuse the open issue instead: no diagnosis spend, no new issue.
  let alreadyFiled: string | null = null;
  if (needsDiagnosis) {
    alreadyFiled = await findOpenIssue(needsDiagnosis).catch(() => null);
    if (alreadyFiled !== null) {
      needsDiagnosis.githubIssueUrl = alreadyFiled;
      needsDiagnosis.diagnosisState = 'done';
      info(`[Incidents] ${needsDiagnosis.id} already has an open issue`);
    }
  }
  if (needsDiagnosis && alreadyFiled === null) {
    needsDiagnosis.diagnosisState = 'pending';
    try {
      needsDiagnosis.diagnosis = await diagnose(needsDiagnosis, learningsContext());
      needsDiagnosis.diagnosisState = 'done';
      info(`[Incidents] diagnosed ${needsDiagnosis.id}`);
    } catch (error) {
      needsDiagnosis.diagnosisState = error instanceof Error && error.message === 'unarmed'
        ? 'none' : 'failed';
      if (needsDiagnosis.diagnosisState === 'failed') {
        warn(`[Incidents] diagnosis failed for ${needsDiagnosis.id}`);
      }
    }
    if (needsDiagnosis.diagnosisState === 'done' && needsDiagnosis.githubIssueUrl === null) {
      try {
        needsDiagnosis.githubIssueUrl = await openIssue(needsDiagnosis);
      } catch { /* escalation is best-effort */ }
    }
  }

  // Alerting is independent of diagnosis arming (L78): a critical with no
  // API key still emails/webhooks immediately — the L77 freeze must never
  // again depend on someone reading server logs. One alert per incident.
  for (const incident of active) {
    if (incident.severity !== 'critical' || incident.notifiedAtUtc !== null) continue;
    if (incident.diagnosisState === 'pending') continue;
    await notify(incident).catch(() => undefined);
    incident.notifiedAtUtc = nowUtc;
  }

  currentIncidents = active.slice(0, MAX_INCIDENTS);
  saveState(stateFile, { incidents: currentIncidents, pendingSince: nextPending });
}

export function initIncidentWatchdog(dependencies: WatchdogDependencies = {}): NodeJS.Timeout {
  const state = loadState(dependencies.stateFile ?? STATE_FILE);
  currentIncidents = state.incidents;
  info('[Incidents] watchdog armed (5-minute cadence)');
  const timer = setInterval(() => {
    runWatchdogOnce(dependencies).catch((error) => {
      warn(`[Incidents] evaluation failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }, EVALUATION_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
