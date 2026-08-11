import { Command } from 'commander';
import {
  createMigrationStore,
  type MigrationStore,
} from '../migration-store/index.js';
import {
  inspectMigrationStoreReadOnly,
  type MigrationStoreProjection,
} from '../migration-store/projection.js';
import {
  assertMigrationDatabaseParentForInit,
  assertMigrationDatabaseTargetAbsent,
  loadMigrationAdminConfig,
  MigrationAdminConfigError,
  requireCanonicalCreationTime,
  type LoadedMigrationAdminConfig,
} from './config.js';

export type MigrationAdminIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  setExitCode: (code: number) => void;
};

const defaultIo: MigrationAdminIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

type SafeScopeSummary = {
  scopeDigest: string;
  shopifyStoreDomain: string;
  ebayEnvironment: string;
  ebayMarketplaceId: string;
};

export type MigrationAdminResult = {
  command: 'init' | 'verify';
  status: 'preview' | 'initialized-inert' | 'verified';
  scope: SafeScopeSummary;
  databaseRelativePath: string;
  projection: MigrationStoreProjection | null;
  safety: {
    externalPlatformAccess: false;
    externalWrites: false;
    historicalBackfill: false;
    cutoverWatermarkUtc: null;
    ownershipTransferAllowed: false;
    credentialsAllowed: false;
    canaryReady: false;
    cutoverReady: false;
  };
};

class MigrationAdminPostconditionError extends Error {
  constructor() {
    super(
      'Migration state may have been created but did not pass verification; do not retry init and run verify before any further action',
    );
    this.name = 'MigrationAdminPostconditionError';
  }
}

function scopeSummary(loaded: LoadedMigrationAdminConfig): SafeScopeSummary {
  return {
    scopeDigest: loaded.scopeDigest,
    shopifyStoreDomain: loaded.config.scope.shopifyStoreDomain,
    ebayEnvironment: loaded.config.scope.ebayEnvironment,
    ebayMarketplaceId: loaded.config.scope.ebayMarketplaceId,
  };
}

function safetySummary(): MigrationAdminResult['safety'] {
  return {
    externalPlatformAccess: false,
    externalWrites: false,
    historicalBackfill: false,
    cutoverWatermarkUtc: null,
    ownershipTransferAllowed: false,
    credentialsAllowed: false,
    canaryReady: false,
    cutoverReady: false,
  };
}

function assertInertInitialization(projection: MigrationStoreProjection): void {
  const counts = projection.counts;
  if (
    projection.status !== 'verified'
    || projection.audit.valid !== true
    || projection.audit.recordCount !== 1
    || !counts
    || counts.auditEvents !== 1
    || Object.entries(counts).some(([key, value]) => key !== 'auditEvents' && value !== 0)
    || projection.ownership.some((entry) => entry.configured)
    || projection.orders.watermarkEstablished !== false
    || projection.orders.eligibleForCreation !== 0
    || projection.readiness.canaryReady !== false
    || projection.readiness.cutoverReady !== false
    || projection.access.writable !== false
    || projection.access.externallyWired !== false
    || projection.access.externalWritesSupported !== false
  ) {
    throw new MigrationAdminPostconditionError();
  }
}

function safeProjection(projection: MigrationStoreProjection): MigrationStoreProjection {
  const counts = projection.counts
    ? {
        externalIdentities: projection.counts.externalIdentities,
        orderWatermarks: projection.counts.orderWatermarks,
        orderLinks: projection.counts.orderLinks,
        orderPages: projection.counts.orderPages,
        orderObservations: projection.counts.orderObservations,
        orderObservationResolutions: projection.counts.orderObservationResolutions,
        cursorAdvances: projection.counts.cursorAdvances,
        ownershipVersions: projection.counts.ownershipVersions,
        idempotencyIntents: projection.counts.idempotencyIntents,
        actionApprovals: projection.counts.actionApprovals,
        approvalConsumptions: projection.counts.approvalConsumptions,
        executionJobs: projection.counts.executionJobs,
        intentAttempts: projection.counts.intentAttempts,
        attemptResolutions: projection.counts.attemptResolutions,
        reconciliationRuns: projection.counts.reconciliationRuns,
        reconciliationExceptions: projection.counts.reconciliationExceptions,
        auditEvents: projection.counts.auditEvents,
      }
    : null;
  const safeHeadHash =
    typeof projection.audit.headHash === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(projection.audit.headHash)
      ? projection.audit.headHash
      : null;
  return {
    status: projection.status,
    schemaVersion: projection.schemaVersion,
    scope: projection.scope
      ? {
          scopeKey: projection.scope.scopeKey,
          shopifyStoreDomain: projection.scope.shopifyStoreDomain,
          ebayEnvironment: projection.scope.ebayEnvironment,
          ebayMarketplaceId: projection.scope.ebayMarketplaceId,
        }
      : null,
    access: {
      writable: false,
      readOnly: true,
      externallyWired: false,
      externalWritesSupported: false,
      historicalBackfillAllowed: false,
    },
    counts,
    ownership: projection.ownership.map((entry) => ({
      responsibility: entry.responsibility,
      configured: entry.configured,
      version: entry.version,
      owner: entry.owner,
      singleWriterVerified: entry.singleWriterVerified,
    })),
    orders: {
      watermarkUtc: projection.orders.watermarkUtc,
      watermarkEstablished: projection.orders.watermarkEstablished,
      eligibleForCreation: 0,
      historicalBackfillAllowed: false,
    },
    audit: {
      valid: projection.audit.valid,
      recordCount: projection.audit.recordCount,
      headHash: safeHeadHash,
    },
    readiness: {
      canaryReady: false,
      cutoverReady: false,
      blockers: projection.readiness.blockers.filter((entry) =>
        /^[A-Za-z0-9-]{1,96}$/.test(entry)),
    },
  };
}

export function previewMigrationStoreInitialization(input: {
  repoRoot: string;
  configPath: string;
  createdAtUtc: string;
  now?: number;
}): { loaded: LoadedMigrationAdminConfig; result: MigrationAdminResult } {
  const loaded = loadMigrationAdminConfig({
    repoRoot: input.repoRoot,
    requestedConfigPath: input.configPath,
  });
  requireCanonicalCreationTime(input.createdAtUtc, input.now);
  assertMigrationDatabaseTargetAbsent(loaded);
  return {
    loaded,
    result: {
      command: 'init',
      status: 'preview',
      scope: scopeSummary(loaded),
      databaseRelativePath: loaded.config.databasePath,
      projection: null,
      safety: safetySummary(),
    },
  };
}

export function initializeMigrationStore(input: {
  repoRoot: string;
  configPath: string;
  createdAtUtc: string;
  confirmScope: string;
  now?: number;
}): MigrationAdminResult {
  const { loaded } = previewMigrationStoreInitialization(input);
  if (input.confirmScope !== loaded.scopeDigest) {
    throw new MigrationAdminConfigError(['scope confirmation digest does not match']);
  }
  assertMigrationDatabaseParentForInit(loaded);

  let created: MigrationStore | null = null;
  try {
    created = createMigrationStore({
      databasePath: loaded.databaseAbsolutePath,
      scope: loaded.config.scope,
      createdAtUtc: input.createdAtUtc,
    });
  } finally {
    created?.close();
  }

  const projection = inspectMigrationStoreReadOnly({
    databasePath: loaded.databaseAbsolutePath,
    expectedScope: loaded.config.scope,
  });
  assertInertInitialization(projection);
  return {
    command: 'init',
    status: 'initialized-inert',
    scope: scopeSummary(loaded),
    databaseRelativePath: loaded.config.databasePath,
    projection: safeProjection(projection),
    safety: safetySummary(),
  };
}

export function verifyMigrationStore(input: {
  repoRoot: string;
  configPath: string;
}): MigrationAdminResult {
  const loaded = loadMigrationAdminConfig({
    repoRoot: input.repoRoot,
    requestedConfigPath: input.configPath,
  });
  const projection = inspectMigrationStoreReadOnly({
    databasePath: loaded.databaseAbsolutePath,
    expectedScope: loaded.config.scope,
  });
  if (projection.status !== 'verified') {
    throw new Error('Migration state is unavailable or failed integrity verification');
  }
  return {
    command: 'verify',
    status: 'verified',
    scope: scopeSummary(loaded),
    databaseRelativePath: loaded.config.databasePath,
    projection: safeProjection(projection),
    safety: safetySummary(),
  };
}

function printResult(result: MigrationAdminResult, json: boolean, io: MigrationAdminIo): void {
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }
  io.stdout(`Migration state ${result.command}: ${result.status.toUpperCase()}`);
  io.stdout(
    'Safety: local-only; no credentials, platform access, external writes, historical backfill, ownership transfer, canary, or cutover',
  );
  io.stdout(
    `Scope: ${result.scope.shopifyStoreDomain} / ${result.scope.ebayEnvironment}:${result.scope.ebayMarketplaceId}`,
  );
  io.stdout(`Scope confirmation digest: ${result.scope.scopeDigest}`);
  io.stdout(`Database: ${result.databaseRelativePath}`);
  if (result.status === 'preview') {
    io.stdout('Preview only: no directory or database was created.');
    io.stdout('Repeat with --confirm-scope set to the exact digest above to initialize once.');
  } else if (result.projection) {
    io.stdout(
      `Local audit: ${result.projection.audit.valid ? 'valid' : 'invalid'} (${result.projection.audit.recordCount} record(s))`,
    );
    io.stdout('Production execution: disabled');
  }
}

function safeError(error: unknown): string {
  return error instanceof MigrationAdminConfigError || error instanceof MigrationAdminPostconditionError
    ? error.message
    : 'Migration-state operation denied';
}

export function buildMigrationAdminProgram(io: MigrationAdminIo = defaultIo): Command {
  const program = new Command();
  program
    .name('product-pipeline-migration-admin')
    .description(
      'Local migration-state initialization and verification only; no platform or commerce adapter exists.',
    )
    .version('0.1.0')
    .showHelpAfterError();

  program
    .command('init')
    .description('Preview or initialize one inert repository-local migration-state database')
    .requiredOption('--config <path>', 'Strict nonsecret repository-local configuration')
    .requiredOption('--created-at <utc>', 'Canonical UTC scope creation instant')
    .option('--repo-root <path>', 'ProductPipeline repository root', '.')
    .option('--confirm-scope <sha256>', 'Exact preview digest required for one-time initialization')
    .option('--json', 'Emit one JSON object')
    .action((options: {
      config: string;
      createdAt: string;
      repoRoot: string;
      confirmScope?: string;
      json?: boolean;
    }) => {
      try {
        if (!options.confirmScope) {
          const { result } = previewMigrationStoreInitialization({
            repoRoot: options.repoRoot,
            configPath: options.config,
            createdAtUtc: options.createdAt,
          });
          printResult(result, Boolean(options.json), io);
          io.setExitCode(2);
          return;
        }
        const result = initializeMigrationStore({
          repoRoot: options.repoRoot,
          configPath: options.config,
          createdAtUtc: options.createdAt,
          confirmScope: options.confirmScope,
        });
        printResult(result, Boolean(options.json), io);
      } catch (error) {
        const message = safeError(error);
        io.stderr(
          options.json
            ? JSON.stringify({ command: 'init', status: 'denied', error: message })
            : message,
        );
        io.setExitCode(1);
      }
    });

  program
    .command('verify')
    .description('Verify an existing migration-state database without modifying it')
    .requiredOption('--config <path>', 'Strict nonsecret repository-local configuration')
    .option('--repo-root <path>', 'ProductPipeline repository root', '.')
    .option('--json', 'Emit one JSON object')
    .action((options: { config: string; repoRoot: string; json?: boolean }) => {
      try {
        const result = verifyMigrationStore({
          repoRoot: options.repoRoot,
          configPath: options.config,
        });
        printResult(result, Boolean(options.json), io);
      } catch (error) {
        const message = safeError(error);
        io.stderr(
          options.json
            ? JSON.stringify({ command: 'verify', status: 'denied', error: message })
            : message,
        );
        io.setExitCode(1);
      }
    });

  return program;
}
