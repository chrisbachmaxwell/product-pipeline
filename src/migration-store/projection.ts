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
