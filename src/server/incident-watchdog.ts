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
  code: 'ORDER_PIPELINE_BLOCKED' | 'OVERSELL_EXPOSURE' | 'END_DISPATCH_REJECTED' | 'UNRESOLVED_CREATE_AGING' | 'SNAPSHOT_STALE';
  sku: string | null;
  title: string;
  detail: string;
  detectedAtUtc: string;
  lastSeenAtUtc: string;
  diagnosisState: 'none' | 'pending' | 'done' | 'failed';
  diagnosis: string | null;
  githubIssueUrl: string | null;
  notifiedAtUtc: string | null;
};

type SnapshotRow = {
  shopify: { sku: string; title: string; available: number | null; productStatus: string } | null;
  ebay: { listingId: string | null } | null;
};
type Snapshot = { observedAtUtc: string; rows: readonly SnapshotRow[] };

export type WatchdogDependencies = Readonly<{
  getSnapshot?: () => Promise<Snapshot>;
  getLedgerSignals?: (sinceUtc: string) => IncidentLedgerSignals | null;
  now?: () => number;
  stateFile?: string;
  diagnose?: (incident: Incident, context: string) => Promise<string>;
  openIssue?: (incident: Incident) => Promise<string | null>;
  notify?: (incident: Incident) => Promise<void>;
  learningsContext?: () => string;
}>;

/**
 * Pure detection over one observation. Persistence (the two-sighting rule
 * for oversell exposure) is the runner's job.
 */
export function evaluateIncidentCandidates(input: {
  snapshot: Snapshot;
  signals: IncidentLedgerSignals | null;
  nowMs: number;
}): Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail'>> {
  const candidates: Array<Pick<Incident, 'id' | 'severity' | 'code' | 'sku' | 'title' | 'detail'>> = [];
  const { snapshot, signals, nowMs } = input;

  const stuckOrder = signals?.oldestUnresolvedOrder ?? null;
  if (stuckOrder !== null) {
    const ageMs = nowMs - Date.parse(stuckOrder.observedAtUtc);
    if (Number.isFinite(ageMs) && ageMs > 30 * 60_000) {
      const hours = Math.round(ageMs / 3_600_000 * 10) / 10;
      candidates.push({
        id: `ORDER_PIPELINE_BLOCKED:${stuckOrder.orderId}`,
        severity: 'critical',
        code: 'ORDER_PIPELINE_BLOCKED',
        sku: null,
        title: `eBay ORDERS ARE NOT IMPORTING — blocked ${hours}h behind order ${stuckOrder.orderId}`,
        detail: 'The order poll is strictly ordered: one order that cannot import freezes '
          + 'EVERY order behind it — customers are paying and nothing reaches Shopify to '
          + 'ship (L77 was 40 hours and account strikes). Check the server log for '
          + `ORDER_IMPORT_FAILED lines naming ${stuckOrder.orderId}, fix its cause, and `
          + 'the pipeline drains automatically.',
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
          + 'manually and check the sell-out guard.',
      });
    }
  }

  for (const failure of signals?.repeatedEndFailures ?? []) {
    const row = snapshot.rows.find((candidate) => candidate.shopify?.sku === failure.sku);
    const stillLive = row?.ebay?.listingId != null;
    candidates.push({
      id: `END_DISPATCH_REJECTED:${failure.sku}`,
      severity: stillLive ? 'critical' : 'warning',
      code: 'END_DISPATCH_REJECTED',
      sku: failure.sku,
      title: `eBay is rejecting the sell-out end for ${failure.sku} (${failure.count}× in 24h)`,
      detail: stillLive
        ? 'The guard keeps trying to end this listing and eBay keeps refusing — the L75 '
          + 'signature. The listing is STILL LIVE. End it manually on eBay now, then check '
          + 'the server log for EBAY_ENDLIST_REJECTED lines.'
        : 'Repeated end dispatches closed confirmed_missing. The listing is no longer live '
          + '(likely ended manually); the failed-dispatch cause still needs diagnosis.',
    });
  }

  for (const create of signals?.unresolvedCreates ?? []) {
    const ageMs = nowMs - Date.parse(create.reservedAtUtc);
    if (Number.isFinite(ageMs) && ageMs > UNRESOLVED_CREATE_AGE_MS) {
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
  const key = process.env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || key.length === 0) throw new Error('unarmed');
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

async function defaultOpenIssue(incident: Incident): Promise<string | null> {
  const token = process.env.INCIDENT_GITHUB_TOKEN;
  const repo = process.env.INCIDENT_GITHUB_REPO;
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
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
        + 'label triggers the fix-proposal workflow; a human always merges.',
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
  const notify = dependencies.notify ?? defaultNotify;
  const learningsContext = dependencies.learningsContext ?? defaultLearningsContext;

  const nowMs = now();
  const nowUtc = new Date(nowMs).toISOString();
  const snapshot = await getSnapshot();
  const signals = getLedgerSignals(new Date(nowMs - LEDGER_WINDOW_MS).toISOString());
  const candidates = evaluateIncidentCandidates({ snapshot, signals, nowMs });

  const state = loadState(stateFile);
  const nextPending: Record<string, number> = {};
  const active: Incident[] = [];
  for (const candidate of candidates) {
    const existing = state.incidents.find((incident) => incident.id === candidate.id);
    if (existing) {
      active.push({ ...existing, ...candidate, lastSeenAtUtc: nowUtc });
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

  // Diagnose + escalate new criticals (bounded: one per cycle to cap spend).
  const needsDiagnosis = active.find((incident) =>
    incident.severity === 'critical' && incident.diagnosisState === 'none');
  if (needsDiagnosis) {
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
