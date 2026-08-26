import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  readConfiguredMigrationState,
  type MigrationStateApiProjection,
} from './migration-state-reader.js';
import {
  getLiveListingCatalogSnapshot,
  type LiveListingCatalogCacheStatus,
} from './live-listing-catalog-source.js';

const MAX_REPORT_BYTES = 1_048_576;
const MAX_DIRECTORY_ENTRIES = 100;
const SHADOW_REPORT_FRESH_MS = 36 * 60 * 60 * 1_000;
const HEALTH_CACHE_FRESH_MS = 5 * 60 * 1_000;

type ShadowSummary = Readonly<{
  status: 'clean' | 'attention' | 'stale' | 'not-configured' | 'unavailable';
  arrivedAtUtc: string | null;
  observedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  blockedCount: number;
}>;

export type OperationalMonitoringProjection = Readonly<{
  schemaVersion: 1;
  status: 'green' | 'attention' | 'critical';
  generatedAtUtc: string;
  readOnly: true;
  externalWritesPerformed: 0;
  providerReadsPerformed: 0;
  notificationsSent: 0;
  health: Readonly<{
    migrationStore: 'verified' | 'unavailable';
    auditChain: 'verified' | 'unavailable';
    catalogRead: 'current' | 'pending' | 'failed';
    shadowParity: ShadowSummary['status'];
  }>;
  counters: Readonly<{
    unresolvedJobs: number;
    failedJobs: number;
    reconciliationExceptions: number;
    shadowUnmatchedOrders: number;
    shadowBlockedOrders: number;
    catalogReadFailures: number;
  }>;
  dailyDigest: Readonly<{
    dateUtc: string | null;
    windowStartUtc: string | null;
    windowEndUtc: string | null;
    digest: `sha256:${string}`;
    writes: Readonly<{
      performed: number;
      succeeded: number;
      failed: number;
      unresolved: number;
      skipped: null;
      skippedStatus: 'not-journaled-until-g18';
    }>;
    reconciliations: Readonly<{ passed: number; blocked: number; failed: number }>;
    exceptions: Readonly<{ info: number; warning: number; critical: number }>;
    shadow: ShadowSummary;
    automationObserved: false;
  }>;
}>;

export type CachedOperationalHealthProjection = Readonly<{
  snapshotStatus: 'current' | 'stale' | 'unavailable';
  ageSeconds: number | null;
  status: OperationalMonitoringProjection['status'] | 'unavailable';
  health: OperationalMonitoringProjection['health'] | null;
  counters: OperationalMonitoringProjection['counters'] | null;
  dailyDigest: Readonly<{
    dateUtc: string | null;
    digest: `sha256:${string}`;
  }> | null;
  readOnly: true;
  externalWritesPerformed: 0;
  providerReadsPerformed: 0;
  notificationsSent: 0;
}>;

let cachedHealth: {
  projection: OperationalMonitoringProjection;
  cachedAtEpochMs: number;
} | null = null;

export function cacheOperationalMonitoringSnapshot(
  projection: OperationalMonitoringProjection,
  cachedAtEpochMs: number,
): void {
  if (!Number.isFinite(cachedAtEpochMs)) return;
  cachedHealth = { projection, cachedAtEpochMs };
}

/** Cheap public-health projection. It never opens a database or filesystem report. */
export function getCachedOperationalHealth(
  nowEpochMs = Date.now(),
): CachedOperationalHealthProjection {
  if (cachedHealth === null) {
    return Object.freeze({
      snapshotStatus: 'unavailable',
      ageSeconds: null,
      status: 'unavailable',
      health: null,
      counters: null,
      dailyDigest: null,
      readOnly: true,
      externalWritesPerformed: 0,
      providerReadsPerformed: 0,
      notificationsSent: 0,
    });
  }
  const ageMs = Math.max(0, nowEpochMs - cachedHealth.cachedAtEpochMs);
  const projection = cachedHealth.projection;
  return Object.freeze({
    snapshotStatus: ageMs <= HEALTH_CACHE_FRESH_MS ? 'current' : 'stale',
    ageSeconds: Math.floor(ageMs / 1_000),
    status: projection.status,
    health: projection.health,
    counters: projection.counters,
    dailyDigest: Object.freeze({
      dateUtc: projection.dailyDigest.dateUtc,
      digest: projection.dailyDigest.digest,
    }),
    readOnly: true,
    externalWritesPerformed: 0,
    providerReadsPerformed: 0,
    notificationsSent: 0,
  });
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function unavailableShadow(status: ShadowSummary['status']): ShadowSummary {
  return Object.freeze({
    status,
    arrivedAtUtc: null,
    observedCount: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    blockedCount: 0,
  });
}

/**
 * Reads only the aggregate summary from the newest operator-created shadow
 * report. Raw order IDs, SKUs, and observed rows are discarded and never
 * enter the returned projection or digest.
 */
export function readLatestShadowSummary(input: {
  directoryPath?: string;
  nowEpochMs: number;
}): ShadowSummary {
  const directoryPath = input.directoryPath;
  if (typeof directoryPath !== 'string' || directoryPath.trim() === '') {
    return unavailableShadow('not-configured');
  }
  try {
    if (!path.isAbsolute(directoryPath) || path.resolve(directoryPath) !== directoryPath) {
      return unavailableShadow('unavailable');
    }
    const directory = fs.lstatSync(directoryPath);
    const effectiveUid = process.geteuid?.();
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || effectiveUid === undefined || directory.uid !== effectiveUid
      || (directory.mode & 0o777) !== 0o700) {
      return unavailableShadow('unavailable');
    }
    const entries = fs.readdirSync(directoryPath);
    if (entries.length > MAX_DIRECTORY_ENTRIES) return unavailableShadow('unavailable');
    let latest: { path: string; stat: fs.Stats } | null = null;
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(entry)) continue;
      const candidatePath = path.join(directoryPath, entry);
      const stat = fs.lstatSync(candidatePath);
      if (latest === null || stat.mtimeMs > latest.stat.mtimeMs) {
        latest = { path: candidatePath, stat };
      }
    }
    if (latest === null) return unavailableShadow('unavailable');
    if (!latest.stat.isFile() || latest.stat.isSymbolicLink() || latest.stat.nlink !== 1
      || (latest.stat.mode & 0o777) !== 0o600
      || latest.stat.size <= 0 || latest.stat.size > MAX_REPORT_BYTES) {
      return unavailableShadow('unavailable');
    }
    let descriptor = -1;
    let raw: string;
    try {
      descriptor = fs.openSync(latest.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
        || before.dev !== latest.stat.dev || before.ino !== latest.stat.ino
        || before.size !== latest.stat.size || before.mtimeMs !== latest.stat.mtimeMs
        || before.size <= 0 || before.size > MAX_REPORT_BYTES) {
        return unavailableShadow('unavailable');
      }
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read <= 0) return unavailableShadow('unavailable');
        offset += read;
      }
      const after = fs.fstatSync(descriptor);
      if (after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return unavailableShadow('unavailable');
      }
      raw = bytes.toString('utf8');
    } finally {
      if (descriptor >= 0) fs.closeSync(descriptor);
    }
    const report = JSON.parse(raw) as Record<string, unknown>;
    const summary = report.summary as Record<string, unknown> | null;
    if (report.command !== 'shadow-poll' || report.mode !== 'read-only-shadow'
      || report.windowHours !== 24 || report.externalWritesPerformed !== 0
      || !Array.isArray(report.observed) || summary === null
      || typeof summary !== 'object') return unavailableShadow('unavailable');
    const observedCount = summary.observedCount;
    const matchedCount = summary.matchedCount;
    const unmatchedCount = summary.unmatchedCount;
    const blockedCount = summary.blockedCount;
    const lookupFailedCount = summary.lookupFailedCount;
    const ambiguousCount = summary.ambiguousCount;
    const unmatchedEbayOrderIds = summary.unmatchedEbayOrderIds;
    if (![observedCount, matchedCount, unmatchedCount, blockedCount,
      lookupFailedCount, ambiguousCount].every(nonnegative)
      || report.observed.length !== observedCount
      || !Array.isArray(unmatchedEbayOrderIds)
      || unmatchedEbayOrderIds.length !== unmatchedCount
      || !unmatchedEbayOrderIds.every((value) => typeof value === 'string')
      || matchedCount as number + (unmatchedCount as number) !== observedCount
      || lookupFailedCount as number + (ambiguousCount as number) !== blockedCount
      || (blockedCount as number) > (unmatchedCount as number)) {
      return unavailableShadow('unavailable');
    }
    const arrivedAtUtc = new Date(latest.stat.mtimeMs).toISOString();
    const stale = input.nowEpochMs - latest.stat.mtimeMs > SHADOW_REPORT_FRESH_MS
      || latest.stat.mtimeMs > input.nowEpochMs + 60_000;
    const status = stale
      ? 'stale'
      : (unmatchedCount as number) === 0 && (blockedCount as number) === 0
        ? 'clean'
        : 'attention';
    return Object.freeze({
      status,
      arrivedAtUtc,
      observedCount: observedCount as number,
      matchedCount: matchedCount as number,
      unmatchedCount: unmatchedCount as number,
      blockedCount: blockedCount as number,
    });
  } catch {
    return unavailableShadow('unavailable');
  }
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function buildOperationalMonitoring(input: {
  migrationState: MigrationStateApiProjection;
  catalogStatus: LiveListingCatalogCacheStatus;
  shadowSummary: ShadowSummary;
  now: Date;
}): OperationalMonitoringProjection {
  const generatedAtUtc = input.now.toISOString();
  const store = input.migrationState.status === 'verified'
    ? input.migrationState.monitoring
    : null;
  const catalogRead = input.catalogStatus.lastFailureAtEpochMs !== null
    ? 'failed' as const
    : input.catalogStatus.hasSuccessfulSnapshot
      ? 'current' as const
      : 'pending' as const;
  const unresolvedJobs = store === null
    ? 0
    : store.currentJobs.reserved
      + store.currentJobs.dispatching
      + store.currentJobs.reconciliationRequired;
  const failedJobs = store?.currentJobs.confirmedMissing ?? 0;
  const exceptions = store?.previousUtcDay.exceptions
    ?? { info: 0, warning: 0, critical: 0 };
  const reconciliationExceptionCount = input.migrationState.status === 'verified'
    && nonnegative(input.migrationState.counts.reconciliationExceptions)
    ? input.migrationState.counts.reconciliationExceptions
    : exceptions.info + exceptions.warning + exceptions.critical;
  const writes = store?.previousUtcDay.writes
    ?? { performed: 0, succeeded: 0, failed: 0, unresolved: 0 };
  const reconciliations = store?.previousUtcDay.reconciliations
    ?? { passed: 0, blocked: 0, failed: 0 };
  const critical = store === null
    || catalogRead === 'failed'
    || unresolvedJobs > 0
    || failedJobs > 0
    || writes.failed > 0
    || writes.unresolved > 0
    || reconciliations.blocked > 0
    || reconciliations.failed > 0
    || exceptions.warning > 0
    || exceptions.critical > 0
    || input.shadowSummary.status === 'attention';
  const attention = catalogRead === 'pending'
    || ['stale', 'not-configured', 'unavailable'].includes(input.shadowSummary.status);
  const digestBody = {
    schemaVersion: 1,
    dateUtc: store?.previousUtcDay.dateUtc ?? null,
    windowStartUtc: store?.previousUtcDay.windowStartUtc ?? null,
    windowEndUtc: store?.previousUtcDay.windowEndUtc ?? null,
    writes: { ...writes, skipped: null, skippedStatus: 'not-journaled-until-g18' },
    reconciliations,
    exceptions,
    shadow: input.shadowSummary,
    catalogRead,
    auditValid: input.migrationState.status === 'verified'
      && input.migrationState.audit.valid === true,
    unresolvedJobs,
    failedJobs,
    automationObserved: false,
  };
  return Object.freeze({
    schemaVersion: 1,
    status: critical ? 'critical' : attention ? 'attention' : 'green',
    generatedAtUtc,
    readOnly: true,
    externalWritesPerformed: 0,
    providerReadsPerformed: 0,
    notificationsSent: 0,
    health: Object.freeze({
      migrationStore: store === null ? 'unavailable' : 'verified',
      auditChain: input.migrationState.status === 'verified'
        && input.migrationState.audit.valid === true ? 'verified' : 'unavailable',
      catalogRead,
      shadowParity: input.shadowSummary.status,
    }),
    counters: Object.freeze({
      unresolvedJobs,
      failedJobs,
      reconciliationExceptions: reconciliationExceptionCount,
      shadowUnmatchedOrders: input.shadowSummary.unmatchedCount,
      shadowBlockedOrders: input.shadowSummary.blockedCount,
      catalogReadFailures: catalogRead === 'failed' ? 1 : 0,
    }),
    dailyDigest: Object.freeze({
      dateUtc: store?.previousUtcDay.dateUtc ?? null,
      windowStartUtc: store?.previousUtcDay.windowStartUtc ?? null,
      windowEndUtc: store?.previousUtcDay.windowEndUtc ?? null,
      digest: digest(digestBody),
      writes: Object.freeze({
        ...writes,
        skipped: null,
        skippedStatus: 'not-journaled-until-g18' as const,
      }),
      reconciliations: Object.freeze({ ...reconciliations }),
      exceptions: Object.freeze({ ...exceptions }),
      shadow: input.shadowSummary,
      automationObserved: false,
    }),
  });
}

/** Request-time read-only assembly. No refresh or provider call is triggered. */
export async function readOperationalMonitoring(options: {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  readMigrationState?: typeof readConfiguredMigrationState;
  getCatalogStatus?: () => LiveListingCatalogCacheStatus;
  readShadowSummary?: typeof readLatestShadowSummary;
} = {}): Promise<OperationalMonitoringProjection> {
  const environment = options.environment ?? process.env;
  const now = (options.now ?? (() => new Date()))();
  const migrationState = await (options.readMigrationState ?? readConfiguredMigrationState)({
    environment,
    now: () => now,
  });
  const shadowSummary = (options.readShadowSummary ?? readLatestShadowSummary)({
    directoryPath: environment.SHADOW_REPORT_DIRECTORY,
    nowEpochMs: now.getTime(),
  });
  const projection = buildOperationalMonitoring({
    migrationState,
    catalogStatus: (options.getCatalogStatus ?? getLiveListingCatalogSnapshot.status)(),
    shadowSummary,
    now,
  });
  cacheOperationalMonitoringSnapshot(projection, now.getTime());
  return projection;
}
