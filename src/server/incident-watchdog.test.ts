/**
 * L76: the watchdog's detection logic — the alarm surface L75 proved was
 * missing. Pure-function tests over the emergency shapes plus the runner's
 * persistence rule and diagnosis/escalation wiring, all with injected
 * dependencies (no network, no filesystem outside a temp state file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateIncidentCandidates,
  getIncidents,
  runWatchdogOnce,
  type Incident,
} from './incident-watchdog.js';

const NOW = Date.parse('2026-09-25T20:00:00.000Z');
const FRESH = new Date(NOW - 60_000).toISOString();

function row(sku: string, available: number | null, listingId: string | null) {
  return {
    shopify: { sku, title: sku, available, productStatus: 'ACTIVE' },
    ebay: { listingId },
  };
}

describe('evaluateIncidentCandidates', () => {
  it('flags a zero-stock item whose eBay listing is still live as critical', () => {
    const candidates = evaluateIncidentCandidates({
      snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 0, '147000000001')] },
      signals: { unresolvedCreates: [], repeatedEndFailures: [] },
      nowMs: NOW,
    });
    expect(candidates).toEqual([expect.objectContaining({
      code: 'OVERSELL_EXPOSURE', severity: 'critical', sku: 'LEICA-1',
    })]);
  });

  it('flags repeated end rejections — critical while live, warning once ended (L75)', () => {
    const signals = {
      unresolvedCreates: [],
      repeatedEndFailures: [{ sku: 'LEICA-1', count: 34, lastAtUtc: FRESH }],
    };
    const live = evaluateIncidentCandidates({
      snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 0, '147000000001')] },
      signals, nowMs: NOW,
    });
    expect(live.find((candidate) => candidate.code === 'END_DISPATCH_REJECTED'))
      .toMatchObject({ severity: 'critical' });
    const ended = evaluateIncidentCandidates({
      snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 0, null)] },
      signals, nowMs: NOW,
    });
    expect(ended.find((candidate) => candidate.code === 'END_DISPATCH_REJECTED'))
      .toMatchObject({ severity: 'warning' });
  });

  it('flags aging unresolved creates and stale snapshots as warnings', () => {
    const candidates = evaluateIncidentCandidates({
      snapshot: {
        observedAtUtc: new Date(NOW - 50 * 60_000).toISOString(),
        rows: [row('OK-1', 3, '147000000009')],
      },
      signals: {
        unresolvedCreates: [
          { sku: 'STUCK-1', jobId: 'j1', reservedAtUtc: new Date(NOW - 2 * 3_600_000).toISOString() },
          { sku: 'FRESH-1', jobId: 'j2', reservedAtUtc: new Date(NOW - 5 * 60_000).toISOString() },
        ],
        repeatedEndFailures: [],
      },
      nowMs: NOW,
    });
    expect(candidates.map((candidate) => candidate.code).sort())
      .toEqual(['SNAPSHOT_STALE', 'UNRESOLVED_CREATE_AGING']);
    expect(candidates.find((candidate) => candidate.code === 'UNRESOLVED_CREATE_AGING')?.sku)
      .toBe('STUCK-1');
  });

  it('stays silent on a healthy store', () => {
    expect(evaluateIncidentCandidates({
      snapshot: { observedAtUtc: FRESH, rows: [row('OK-1', 2, '147000000009'), row('OK-2', 1, null)] },
      signals: { unresolvedCreates: [], repeatedEndFailures: [] },
      nowMs: NOW,
    })).toEqual([]);
  });
});

describe('runWatchdogOnce', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  function tempStateFile(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-watchdog-'));
    roots.push(root);
    return path.join(root, 'incidents.json');
  }

  it('requires oversell exposure to persist across two sightings, then diagnoses and escalates', async () => {
    const stateFile = tempStateFile();
    const diagnosed: Incident[] = [];
    const issues: Incident[] = [];
    const dependencies = {
      stateFile,
      getSnapshot: async () => ({ observedAtUtc: FRESH, rows: [row('LEICA-1', 0, '147000000001')] }),
      getLedgerSignals: () => ({ unresolvedCreates: [], repeatedEndFailures: [] }),
      diagnose: async (incident: Incident) => { diagnosed.push(incident); return 'WHAT HAPPENED: test'; },
      openIssue: async (incident: Incident) => { issues.push(incident); return 'https://github.com/x/y/issues/1'; },
      notify: async () => undefined,
      learningsContext: () => 'L75: ...',
    };
    await runWatchdogOnce({ ...dependencies, now: () => NOW });
    expect(getIncidents()).toEqual([]);        // first sighting: pending only
    await runWatchdogOnce({ ...dependencies, now: () => NOW + 9 * 60_000 });
    const incidents = getIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      code: 'OVERSELL_EXPOSURE',
      diagnosisState: 'done',
      diagnosis: 'WHAT HAPPENED: test',
      githubIssueUrl: 'https://github.com/x/y/issues/1',
    });
    expect(diagnosed).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it('clears incidents when the condition resolves and stays quiet unarmed', async () => {
    const stateFile = tempStateFile();
    let rows = [row('LEICA-1', 0, '147000000001')];
    const dependencies = {
      stateFile,
      getSnapshot: async () => ({ observedAtUtc: FRESH, rows }),
      getLedgerSignals: () => ({ unresolvedCreates: [], repeatedEndFailures: [] }),
      diagnose: async () => { throw new Error('unarmed'); },
      openIssue: async () => null,
      notify: async () => undefined,
      learningsContext: () => '',
    };
    await runWatchdogOnce({ ...dependencies, now: () => NOW });
    await runWatchdogOnce({ ...dependencies, now: () => NOW + 9 * 60_000 });
    expect(getIncidents()).toHaveLength(1);
    expect(getIncidents()[0]!.diagnosisState).toBe('none'); // unarmed, not failed
    rows = [row('LEICA-1', 0, null)];                        // listing ended
    await runWatchdogOnce({ ...dependencies, now: () => NOW + 20 * 60_000 });
    expect(getIncidents()).toEqual([]);
  });
});
