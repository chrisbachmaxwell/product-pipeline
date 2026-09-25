import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import {
  openMigrationStoreReadOnly,
  PRODUCTION_ENABLED_RESPONSIBILITIES,
} from './store.js';
import {
  MIGRATION_RESPONSIBILITIES,
  type Digest,
  type IntegrationScope,
  type OwnershipOwner,
  type OperationalStoreMonitoring,
  type Responsibility,
} from './types.js';

export type MigrationStoreProjectionCounts = {
  externalIdentities: number;
  orderWatermarks: number;
  orderLinks: number;
  orderPages: number;
  orderObservations: number;
  orderObservationResolutions: number;
  cursorAdvances: number;
  ownershipVersions: number;
  idempotencyIntents: number;
  actionApprovals: number;
  approvalConsumptions: number;
  executionJobs: number;
  intentAttempts: number;
  attemptResolutions: number;
  reconciliationRuns: number;
  reconciliationExceptions: number;
  listingReviseObservations: number;
  targetEffectObservations: number;
  auditEvents: number;
};

export type MigrationStoreOwnershipProjection = {
  responsibility: Responsibility;
  configured: boolean;
  version: number | null;
  owner: OwnershipOwner | null;
  singleWriterVerified: boolean;
};

export type MigrationStoreProjection = {
  status: 'verified' | 'unavailable' | 'invalid';
  schemaVersion: typeof CURRENT_SCHEMA_VERSION | null;
  scope: {
    scopeKey: Digest;
    shopifyStoreDomain: string;
    ebayEnvironment: IntegrationScope['ebayEnvironment'];
    ebayMarketplaceId: string;
  } | null;
  access: {
    writable: false;
    readOnly: true;
    externallyWired: false;
    externalWritesSupported: false;
    historicalBackfillAllowed: false;
  };
  counts: MigrationStoreProjectionCounts | null;
  ownership: MigrationStoreOwnershipProjection[];
  orders: {
    watermarkUtc: string | null;
    watermarkEstablished: boolean;
    eligibleForCreation: 0;
    historicalBackfillAllowed: false;
  };
  audit: {
    valid: boolean;
    recordCount: number;
    headHash: string | null;
  };
  monitoring: OperationalStoreMonitoring | null;
  readiness: {
    canaryReady: false;
    cutoverReady: false;
    blockers: string[];
  };
};

const ACCESS = Object.freeze({
  writable: false,
  readOnly: true,
  externallyWired: false,
  externalWritesSupported: false,
  historicalBackfillAllowed: false,
} as const);

const RESPONSIBILITY_BLOCKER_SLUG = {
  orderImport: 'order-import',
  price: 'price',
  inventory: 'inventory',
  listingCreate: 'listing-create',
  listingRevise: 'listing-revise',
  listingEndRelist: 'listing-end-relist',
  mapping: 'mapping',
  fulfillment: 'fulfillment',
  feedback: 'feedback',
  reconciliation: 'reconciliation',
} as const satisfies Record<Responsibility, string>;

function deniedProjection(status: 'unavailable' | 'invalid'): MigrationStoreProjection {
  return {
    status,
    schemaVersion: null,
    scope: null,
    access: ACCESS,
    counts: null,
    ownership: [],
    orders: {
      watermarkUtc: null,
      watermarkEstablished: false,
      eligibleForCreation: 0,
      historicalBackfillAllowed: false,
    },
    audit: { valid: false, recordCount: 0, headHash: null },
    monitoring: null,
    readiness: {
      canaryReady: false,
      cutoverReady: false,
      blockers: [
        status === 'unavailable'
          ? 'migration-store-unavailable'
          : 'migration-store-integrity-invalid',
        'external-writes-not-supported',
        'operator-cutover-approval-required',
      ],
    },
  };
}

function fixedCounts(counts: Record<string, number>): MigrationStoreProjectionCounts {
  return {
    externalIdentities: counts.external_identities,
    orderWatermarks: counts.order_watermarks,
    orderLinks: counts.order_links,
    orderPages: counts.order_pages,
    orderObservations: counts.order_observations,
    orderObservationResolutions: counts.order_observation_resolutions,
    cursorAdvances: counts.cursor_advances,
    ownershipVersions: counts.ownership_versions,
    idempotencyIntents: counts.idempotency_intents,
    actionApprovals: counts.action_approvals,
    approvalConsumptions: counts.approval_consumptions,
    executionJobs: counts.execution_jobs,
    intentAttempts: counts.intent_attempts,
    attemptResolutions: counts.attempt_resolutions,
    reconciliationRuns: counts.reconciliation_runs,
    reconciliationExceptions: counts.reconciliation_exceptions,
    listingReviseObservations: counts.listing_revise_observations,
    targetEffectObservations: counts.target_effect_observations,
    auditEvents: counts.audit_events,
  };
}

/**
 * Returns a fixed, redacted, non-authorizing view of a migration store. This
 * facade never returns the underlying handle, database path, raw rows,
 * approval identifiers, or verification error details.
 */
export function inspectMigrationStoreReadOnly(input: {
  databasePath: string;
  expectedScope: IntegrationScope;
  nowUtc?: string;
}): MigrationStoreProjection {
  try {
    if (
      typeof input.databasePath !== 'string'
      || input.databasePath.length === 0
      || input.databasePath.includes('\u0000')
      || input.databasePath.startsWith('file:')
      || input.databasePath === ':memory:'
      || !path.isAbsolute(input.databasePath)
      || path.resolve(input.databasePath) !== input.databasePath
    ) {
      return deniedProjection('invalid');
    }

    try {
      fs.lstatSync(input.databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return deniedProjection('unavailable');
      }
      return deniedProjection('invalid');
    }

    const store = openMigrationStoreReadOnly(input);
    try {
      const counts = fixedCounts(store.getCounts());
      const ownership = MIGRATION_RESPONSIBILITIES.map((responsibility) => {
        const current = store.getCurrentOwnership(responsibility);
        return {
          responsibility,
          configured: current !== null,
          version: current?.version ?? null,
          owner: current?.owner ?? null,
          singleWriterVerified: current?.singleWriterVerified ?? false,
        } satisfies MigrationStoreOwnershipProjection;
      });
      const storedWatermark = store.getOrderWatermark();
      if (
        store.writable !== false
        || store.externallyWired !== false
        || store.externalWritesSupported !== false
      ) {
        throw new Error('Read-only projection received a writable or externally wired store');
      }
      if (store.scope.ebayEnvironment === 'production') {
        // A production watermark is valid only once the operator has recorded
        // the ProductPipeline single-writer orderImport ownership chain (the
        // Marketplace Connect disable evidence); otherwise it is forbidden.
        const orderImportOwnership = ownership.find(
          (entry) => entry.responsibility === 'orderImport',
        );
        if (
          storedWatermark !== null
          && !(
            orderImportOwnership?.configured === true
            && orderImportOwnership.owner === 'product_pipeline'
            && orderImportOwnership.singleWriterVerified === true
          )
        ) {
          throw new Error('Production migration state contains a forbidden watermark');
        }
        const noIncumbentResponsibilities = new Set([
          'listingCreate',
          'listingRevise',
          'listingEndRelist',
        ]);
        const verifiedIncumbentResponsibilities = new Set([
          'orderImport',
          'price',
          'inventory',
          'fulfillment',
        ]);
        const stagedOwners = new Set(['marketplace_connect', 'paused', 'product_pipeline']);
        // Production execution authority is valid only for the reviewed
        // replacement slice: Class A chains that never name Marketplace
        // Connect, Class B chains staged from the v1 Marketplace Connect
        // baseline, and execution rows scoped exclusively to the seven enabled
        // writer responsibilities. Any other configured writer state
        // (mapping or feedback) is forbidden.
        const ownershipValid = ownership.every((entry) => {
          if (!entry.configured) return true;
          if (noIncumbentResponsibilities.has(entry.responsibility)) {
            return entry.owner !== 'marketplace_connect'
              && entry.singleWriterVerified === true;
          }
          return verifiedIncumbentResponsibilities.has(entry.responsibility)
            && entry.owner !== null
            && stagedOwners.has(entry.owner)
            && entry.singleWriterVerified === true;
        });
        if (
          !ownershipValid
          || store.countExecutionRowsOutsideResponsibilities(
            PRODUCTION_ENABLED_RESPONSIBILITIES,
          ) !== 0
        ) {
          throw new Error('Production migration state contains forbidden execution authority');
        }
      }
      const watermark = storedWatermark;
      const audit = store.verifyAuditChain();
      const monitoring = store.getOperationalMonitoring(
        input.nowUtc ?? new Date().toISOString(),
      );
      const blockers = [
        ...ownership
          .filter((entry) => !entry.configured)
          .map((entry) => `ownership-${RESPONSIBILITY_BLOCKER_SLUG[entry.responsibility]}-unrecorded`),
        ...(watermark ? [] : ['order-watermark-not-established']),
        'external-writes-not-supported',
        'operator-cutover-approval-required',
      ];

      return {
        status: 'verified',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        scope: {
          scopeKey: store.scopeKey,
          shopifyStoreDomain: store.scope.shopifyStoreDomain,
          ebayEnvironment: store.scope.ebayEnvironment,
          ebayMarketplaceId: store.scope.ebayMarketplaceId,
        },
        access: ACCESS,
        counts,
        ownership,
        orders: {
          watermarkUtc: watermark?.boundaryExclusiveUtc ?? null,
          watermarkEstablished: watermark !== null,
          eligibleForCreation: 0,
          historicalBackfillAllowed: false,
        },
        audit: {
          valid: audit.valid,
          recordCount: audit.recordCount,
          headHash: audit.headHash,
        },
        monitoring,
        readiness: {
          canaryReady: false,
          cutoverReady: false,
          blockers,
        },
      };
    } finally {
      store.close();
    }
  } catch {
    return deniedProjection('invalid');
  }
}

export type UnresolvedListingCreateProjection = Readonly<{
  jobId: string;
  attemptId: string;
  intentKey: string;
  evidenceDigest: string;
}>;

/**
 * READ-ONLY lookup for the operator's publish-recovery retry: the most
 * recent listing-create job targeting the SKU whose attempt has no recorded
 * resolution. Same database-path discipline as inspectMigrationStoreReadOnly;
 * opens read-only, runs one SELECT, writes nothing. The identifiers returned
 * are re-verified by the recovery ceremonies before any provider action.
 */
export function findUnresolvedListingCreateReadOnly(input: {
  databasePath: string;
  sku: string;
}): UnresolvedListingCreateProjection | null {
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
  const SHA256 = /^sha256:[0-9a-f]{64}$/;
  if (
    typeof input.databasePath !== 'string'
    || input.databasePath.length === 0
    || input.databasePath.startsWith('file:')
    || input.databasePath === ':memory:'
    || !path.isAbsolute(input.databasePath)
    || path.resolve(input.databasePath) !== input.databasePath
    || typeof input.sku !== 'string'
    || input.sku.length === 0
    || input.sku.length > 128
  ) {
    return null;
  }
  try {
    const database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    try {
      const row = database.prepare(
        'SELECT j.job_id AS jobId, a.attempt_id AS attemptId, j.intent_key AS intentKey, '
        + 'j.approval_evidence_digest AS evidenceDigest '
        + 'FROM execution_jobs j '
        + 'JOIN external_identities e ON e.identity_key = j.target_identity_key '
        + 'JOIN intent_attempts a ON a.job_id = j.job_id '
        + 'LEFT JOIN attempt_resolutions r ON r.attempt_id = a.attempt_id '
        + "WHERE e.binding_key = ? AND j.job_id LIKE 'listing-create-job:%' "
        + 'AND r.resolution_id IS NULL '
        + 'ORDER BY j.reserved_at_utc DESC LIMIT 1',
      ).get(`ebay-inventory-sku:${input.sku}`) as Record<string, unknown> | undefined;
      if (!row) return null;
      const { jobId, attemptId, intentKey, evidenceDigest } = row;
      if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)
        || typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)
        || typeof intentKey !== 'string' || !SHA256.test(intentKey)
        || typeof evidenceDigest !== 'string' || !SHA256.test(evidenceDigest)) {
        return null;
      }
      return Object.freeze({ jobId, attemptId, intentKey, evidenceDigest });
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

export type IncidentLedgerSignals = Readonly<{
  /** Unresolved listing-create jobs (no attempt resolution yet). */
  unresolvedCreates: ReadonlyArray<{ sku: string; jobId: string; reservedAtUtc: string }>;
  /**
   * SKUs whose recent inventory dispatches keep closing confirmed_missing —
   * the L75 signature of a provider-rejected sell-out end. Grouped since
   * `sinceUtc`, only groups of three or more.
   */
  repeatedEndFailures: ReadonlyArray<{ sku: string; count: number; lastAtUtc: string }>;
}>;

/**
 * READ-ONLY incident signals for the watchdog (L75): the ledger records
 * every failure truthfully; this surfaces the shapes that demand a human.
 * Same database-path discipline as the other read-only projections.
 */
export function readIncidentLedgerSignalsReadOnly(input: {
  databasePath: string;
  sinceUtc: string;
}): IncidentLedgerSignals | null {
  if (
    typeof input.databasePath !== 'string'
    || input.databasePath.length === 0
    || input.databasePath.startsWith('file:')
    || input.databasePath === ':memory:'
    || !path.isAbsolute(input.databasePath)
    || path.resolve(input.databasePath) !== input.databasePath
    || typeof input.sinceUtc !== 'string'
    || Number.isNaN(Date.parse(input.sinceUtc))
  ) {
    return null;
  }
  try {
    const database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    try {
      const unresolved = database.prepare(
        'SELECT e.binding_key AS binding, j.job_id AS jobId, j.reserved_at_utc AS reservedAtUtc '
        + 'FROM execution_jobs j '
        + 'JOIN external_identities e ON e.identity_key = j.target_identity_key '
        + 'JOIN intent_attempts a ON a.job_id = j.job_id '
        + 'LEFT JOIN attempt_resolutions r ON r.attempt_id = a.attempt_id '
        + "WHERE j.job_id LIKE 'listing-create-job:%' AND r.resolution_id IS NULL "
        + 'ORDER BY j.reserved_at_utc DESC LIMIT 20',
      ).all() as Array<{ binding: string; jobId: string; reservedAtUtc: string }>;
      const failures = database.prepare(
        'SELECT e.binding_key AS binding, COUNT(*) AS count, MAX(j.reserved_at_utc) AS lastAtUtc '
        + 'FROM execution_jobs j '
        + 'JOIN external_identities e ON e.identity_key = j.target_identity_key '
        + 'JOIN intent_attempts a ON a.job_id = j.job_id '
        + 'JOIN attempt_resolutions r ON r.attempt_id = a.attempt_id '
        + "WHERE j.responsibility = 'inventory' AND r.resolution = 'confirmed_missing' "
        + 'AND j.reserved_at_utc > ? '
        + 'GROUP BY e.binding_key HAVING COUNT(*) >= 3 '
        + 'ORDER BY lastAtUtc DESC LIMIT 20',
      ).all(input.sinceUtc) as Array<{ binding: string; count: number; lastAtUtc: string }>;
      const sku = (binding: string): string => binding.replace(/^ebay-inventory-sku:/, '')
        .replace(/^ebay-listing:/, 'listing ');
      return Object.freeze({
        unresolvedCreates: unresolved.map((row) => Object.freeze({
          sku: sku(row.binding), jobId: row.jobId, reservedAtUtc: row.reservedAtUtc,
        })),
        repeatedEndFailures: failures.map((row) => Object.freeze({
          sku: sku(row.binding), count: row.count, lastAtUtc: row.lastAtUtc,
        })),
      });
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}
