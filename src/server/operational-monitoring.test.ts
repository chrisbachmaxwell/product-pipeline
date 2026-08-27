import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MigrationStateApiProjection } from './migration-state-reader.js';
import {
  buildOperationalMonitoring,
  getCachedOperationalHealth,
  readLatestShadowSummary,
  readOperationalMonitoring,
} from './operational-monitoring.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const migration = (): MigrationStateApiProjection => ({
  status: 'verified', schemaVersion: 5,
  scope: { scopeKey: `sha256:${'1'.repeat(64)}`, shopifyStoreDomain: 'usedcameragear.myshopify.com',
    ebayEnvironment: 'production', ebayMarketplaceId: 'EBAY_US' },
  access: { writable: false, readOnly: true, externallyWired: false,
    externalWritesSupported: false, historicalBackfillAllowed: false },
  counts: {}, ownership: [],
  orders: { watermarkUtc: null, watermarkEstablished: false,
    eligibleForCreation: 0, historicalBackfillAllowed: false },
  audit: { valid: true, recordCount: 1, headHash: `sha256:${'2'.repeat(64)}` },
  monitoring: {
    currentJobs: { reserved: 0, dispatching: 0, reconciliationRequired: 0,
      resolvedExisting: 2, confirmedMissing: 0 },
    previousUtcDay: {
      dateUtc: '2026-08-25', windowStartUtc: '2026-08-25T00:00:00.000Z',
      windowEndUtc: '2026-08-26T00:00:00.000Z',
      writes: { performed: 2, succeeded: 2, failed: 0, unresolved: 0 },
      reconciliations: { passed: 2, blocked: 0, failed: 0 },
      exceptions: { info: 0, warning: 0, critical: 0 },
    },
  },
  readiness: { canaryReady: false, cutoverReady: false, blockers: [] },
});

const catalog = (failure: number | null = null) => ({
  hasSuccessfulSnapshot: true,
  observedAtUtc: '2026-08-26T11:00:00.000Z',
  lastSuccessAtEpochMs: Date.parse('2026-08-26T11:00:00.000Z'),
  lastAttemptAtEpochMs: Date.parse('2026-08-26T11:00:00.000Z'),
  lastFailureAtEpochMs: failure,
  expiresAtEpochMs: Date.parse('2026-08-26T11:01:00.000Z'),
  refreshInFlight: false,
});

describe('operational monitoring projection', () => {
  it('reads only a consistent aggregate shadow summary and discards order-level data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-monitoring-'));
    roots.push(root);
    const reportPath = path.join(root, 'shadow-2026-08-26.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      command: 'shadow-poll', mode: 'read-only-shadow', windowHours: 24,
      observed: [{ ebayOrderId: 'must-not-escape', lineItemSkus: ['SECRET-SKU'] }],
      summary: { observedCount: 1, matchedCount: 1, unmatchedCount: 0, blockedCount: 0,
        lookupFailedCount: 0, ambiguousCount: 0, unmatchedEbayOrderIds: [] },
      externalWritesPerformed: 0,
    }), { mode: 0o600 });
    const now = fs.statSync(reportPath).mtimeMs + 1_000;
    const result = readLatestShadowSummary({ directoryPath: root, nowEpochMs: now });
    expect(result).toMatchObject({ status: 'clean', observedCount: 1, matchedCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/must-not-escape|SECRET-SKU|ebayOrderId/);
  });

  it('produces a stable digest and warms the bounded health cache on authenticated read', async () => {
    const shadow = { status: 'clean' as const, arrivedAtUtc: '2026-08-26T11:30:00.000Z',
      observedCount: 2, matchedCount: 2, unmatchedCount: 0, blockedCount: 0 };
    const input = { migrationState: migration(), catalogStatus: catalog(), shadowSummary: shadow,
      now: new Date('2026-08-26T12:00:00.000Z') };
    const first = buildOperationalMonitoring(input);
    const second = buildOperationalMonitoring(input);
    expect(first).toMatchObject({
      status: 'green', readOnly: true, externalWritesPerformed: 0,
      providerReadsPerformed: 0, notificationsSent: 0,
      counters: { unresolvedJobs: 0, failedJobs: 0, reconciliationExceptions: 0,
        shadowUnmatchedOrders: 0, shadowBlockedOrders: 0, catalogReadFailures: 0 },
      dailyDigest: { writes: { performed: 2, succeeded: 2, failed: 0,
        unresolved: 0, skipped: null, skippedStatus: 'not-journaled-until-g18' } },
    });
    expect(first.dailyDigest.digest).toBe(second.dailyDigest.digest);
    expect(first.dailyDigest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const refreshed = await readOperationalMonitoring({
      environment: {}, now: () => input.now,
      readMigrationState: async () => migration(),
      getCatalogStatus: () => catalog(),
      readShadowSummary: () => shadow,
    });
    expect(refreshed.dailyDigest.digest).toBe(first.dailyDigest.digest);
    expect(getCachedOperationalHealth(Date.parse('2026-08-26T12:04:59.000Z')))
      .toMatchObject({ snapshotStatus: 'current', ageSeconds: 299 });
    expect(getCachedOperationalHealth(Date.parse('2026-08-26T12:05:01.000Z')))
      .toMatchObject({ snapshotStatus: 'stale', ageSeconds: 301 });
  });

  it('fails visibly on auth breakage, unresolved work, and unmatched shadow orders', () => {
    const state = migration();
    if (state.status !== 'verified') throw new Error('verified fixture required');
    state.monitoring.currentJobs.reconciliationRequired = 1;
    state.monitoring.previousUtcDay.exceptions.critical = 1;
    const result = buildOperationalMonitoring({
      migrationState: state,
      catalogStatus: catalog(Date.parse('2026-08-26T11:59:00.000Z')),
      shadowSummary: { status: 'attention', arrivedAtUtc: '2026-08-26T11:30:00.000Z',
        observedCount: 2, matchedCount: 1, unmatchedCount: 1, blockedCount: 0 },
      now: new Date('2026-08-26T12:00:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'critical',
      counters: { unresolvedJobs: 1, failedJobs: 0, reconciliationExceptions: 1,
        shadowUnmatchedOrders: 1, catalogReadFailures: 1 },
      health: { catalogRead: 'failed', shadowParity: 'attention' },
    });
  });

  it('rejects malformed, inconsistent, stale, symlinked, and oversized reports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-monitoring-denials-'));
    roots.push(root);
    const reportPath = path.join(root, 'bad.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      command: 'shadow-poll', mode: 'read-only-shadow',
      summary: { observedCount: 1, matchedCount: 1, unmatchedCount: 1, blockedCount: 0,
        lookupFailedCount: 0, ambiguousCount: 0 }, externalWritesPerformed: 0,
    }));
    expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
      .toBe('unavailable');
    fs.rmSync(reportPath);
    fs.symlinkSync('/dev/null', reportPath);
    expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
      .toBe('unavailable');
    fs.unlinkSync(reportPath);

    const validReport = JSON.stringify({
      command: 'shadow-poll', mode: 'read-only-shadow', windowHours: 24,
      observed: [{ ebayOrderId: 'discarded', lineItemSkus: [] }],
      summary: { observedCount: 1, matchedCount: 1, unmatchedCount: 0, blockedCount: 0,
        lookupFailedCount: 0, ambiguousCount: 0, unmatchedEbayOrderIds: [] },
      externalWritesPerformed: 0,
    });
    fs.writeFileSync(reportPath, validReport, { mode: 0o600 });
    const staleEpochMs = Date.now() - (37 * 60 * 60 * 1_000);
    fs.utimesSync(reportPath, staleEpochMs / 1_000, staleEpochMs / 1_000);
    expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
      .toBe('stale');

    fs.writeFileSync(reportPath, 'x'.repeat(1_048_577), { mode: 0o600 });
    expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
      .toBe('unavailable');
  });

  it.each([1, 168])('denies a non-parity %s-hour shadow window', (windowHours) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-monitoring-window-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({
      command: 'shadow-poll', mode: 'read-only-shadow', windowHours,
      observed: [],
      summary: { observedCount: 0, matchedCount: 0, unmatchedCount: 0, blockedCount: 0,
        lookupFailedCount: 0, ambiguousCount: 0, unmatchedEbayOrderIds: [] },
      externalWritesPerformed: 0,
    }), { mode: 0o600 });
    expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
      .toBe('unavailable');
  });

  it('denies a non-private or differently owned shadow directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-monitoring-directory-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({
      command: 'shadow-poll', mode: 'read-only-shadow', windowHours: 24, observed: [],
      summary: { observedCount: 0, matchedCount: 0, unmatchedCount: 0, blockedCount: 0,
        lookupFailedCount: 0, ambiguousCount: 0, unmatchedEbayOrderIds: [] },
      externalWritesPerformed: 0,
    }), { mode: 0o600 });
    fs.chmodSync(root, 0o755);
    expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
      .toBe('unavailable');
    fs.chmodSync(root, 0o700);
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined) throw new Error('POSIX effective UID required for this test');
    const spy = vi.spyOn(process, 'geteuid').mockReturnValue(effectiveUid + 1);
    try {
      expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
        .toBe('unavailable');
    } finally {
      spy.mockRestore();
    }
  });

  it('denies a report swapped between discovery and descriptor open', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-monitoring-swap-'));
    roots.push(root);
    const reportPath = path.join(root, 'report.json');
    const replacementPath = path.join(root, 'replacement.tmp');
    const report = JSON.stringify({
      command: 'shadow-poll', mode: 'read-only-shadow', windowHours: 24, observed: [],
      summary: { observedCount: 0, matchedCount: 0, unmatchedCount: 0, blockedCount: 0,
        lookupFailedCount: 0, ambiguousCount: 0, unmatchedEbayOrderIds: [] },
      externalWritesPerformed: 0,
    });
    fs.writeFileSync(reportPath, report, { mode: 0o600 });
    fs.writeFileSync(replacementPath, report, { mode: 0o600 });
    const open = fs.openSync.bind(fs);
    const spy = vi.spyOn(fs, 'openSync').mockImplementationOnce((target, flags) => {
      fs.renameSync(replacementPath, reportPath);
      return open(target, flags);
    });
    try {
      expect(readLatestShadowSummary({ directoryPath: root, nowEpochMs: Date.now() }).status)
        .toBe('unavailable');
    } finally {
      spy.mockRestore();
    }
  });
});
