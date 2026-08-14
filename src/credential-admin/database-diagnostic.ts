import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  assertShopifyCredentialDatabaseDiagnosticRuntimeBinding,
  PRODUCT_PIPELINE_PRODUCTION_RUNTIME,
} from './config.js';
import {
  inspectCanonicalAuthTokensSchema,
  type AuthTokensSchemaInspection,
} from './database-contract.js';

type Sqlite = InstanceType<typeof Database>;

const MAXIMUM_DATABASE_SNAPSHOT_BYTES = 512 * 1_024 * 1_024;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'binary');
const SQLITE_HEADER_WRITE_VERSION_OFFSET = 18;
const SQLITE_HEADER_READ_VERSION_OFFSET = 19;
const SQLITE_ROLLBACK_JOURNAL_VERSION = 1;
const SQLITE_WAL_VERSION = 2;
const SIDECAR_SUFFIXES = Object.freeze(['-journal', '-wal', '-shm'] as const);

export const SHOPIFY_DATABASE_DIAGNOSTIC_STAGES = Object.freeze([
  'file-missing',
  'file-inspection-denied',
  'file-type-denied',
  'file-link-denied',
  'file-empty-denied',
  'file-size-denied',
  'file-permissions-denied',
  'parent-inspection-denied',
  'parent-type-denied',
  'parent-permissions-denied',
  'sidecar-inspection-denied',
  'sidecar-present',
  'descriptor-open-denied',
  'descriptor-inspection-denied',
  'descriptor-identity-denied',
  'snapshot-read-denied',
  'snapshot-header-denied',
  'sqlite-open-denied',
  'sqlite-memory-denied',
  'sqlite-readonly-denied',
  'sqlite-temp-store-denied',
  'sqlite-query-only-denied',
  'schema-table-definition-denied',
  'schema-table-storage-denied',
  'schema-columns-denied',
  'schema-index-denied',
  'schema-trigger-denied',
  'schema-foreign-key-denied',
  'schema-mutation-denied',
  'integrity-check-denied',
  'shopify-row-cardinality-denied',
  'sqlite-close-denied',
  'descriptor-post-inspection-denied',
  'descriptor-post-identity-denied',
  'snapshot-post-read-denied',
  'snapshot-post-stability-denied',
  'path-post-inspection-denied',
  'path-post-identity-denied',
  'sidecar-post-inspection-denied',
  'sidecar-post-present',
  'descriptor-close-denied',
  'verified',
] as const);

export type ShopifyDatabaseDiagnosticStage =
  (typeof SHOPIFY_DATABASE_DIAGNOSTIC_STAGES)[number];

export type ShopifyDatabaseDiagnosticChecks = Readonly<{
  runtimeBindingVerified: boolean;
  fixedDatabaseTargetVerified: boolean;
  listingWriterAckAbsent: boolean;
  filePresent: boolean;
  fileRegular: boolean;
  fileSymlinkAbsent: boolean;
  fileSingleLink: boolean;
  fileNonEmpty: boolean;
  fileWithinSnapshotLimit: boolean;
  fileMode0600: boolean;
  parentDirectory: boolean;
  parentSymlinkAbsent: boolean;
  parentGroupWorldWritableAbsent: boolean;
  sqliteSidecarsAbsentBeforeSnapshot: boolean;
  descriptorOpenedReadOnly: boolean;
  descriptorInspectedBeforeSnapshot: boolean;
  descriptorIdentityStableBeforeSnapshot: boolean;
  snapshotReadFromDescriptor: boolean;
  snapshotHeaderCanonical: boolean;
  snapshotContentProofCaptured: boolean;
  sqliteOpenedFromPrivateSnapshot: boolean;
  sqlitePrivateMemory: boolean;
  sqliteOpenedReadOnly: boolean;
  sqliteTempStoreMemory: boolean;
  sqliteQueryOnly: boolean;
  authTokensTableDefinitionCanonical: boolean;
  authTokensTableStorageCanonical: boolean;
  authTokensColumnsCanonical: boolean;
  authTokensUniquePlatformIndexCanonical: boolean;
  authTokensTriggersAbsent: boolean;
  authTokensForeignKeysAbsent: boolean;
  authTokensMutationStatementCompiles: boolean;
  sqliteIntegrityOk: boolean;
  shopifyRowCardinalityOne: boolean;
  sqliteClosed: boolean;
  descriptorInspectedAfterSnapshot: boolean;
  descriptorIdentityStableAfterSnapshot: boolean;
  snapshotStableAfterInspection: boolean;
  pathIdentityStableAfterSnapshot: boolean;
  sqliteSidecarsAbsentAfterSnapshot: boolean;
  descriptorClosed: boolean;
}>;

export type ShopifyDatabaseDiagnosticReport = Readonly<{
  status: 'database_diagnostic_verified' | 'database_diagnostic_failed_closed';
  stage: ShopifyDatabaseDiagnosticStage;
  checks: ShopifyDatabaseDiagnosticChecks;
  databaseWritesPerformed: 0;
  providerNetworkRequestsPerformed: 0;
  providerCredentialMutationsPerformed: 0;
  externalCommerceWritesPerformed: 0;
}>;

type DiagnosticFilesystem = Pick<
  typeof fs,
  'lstatSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'
>;

export type ShopifyDatabaseDiagnosticDependencies = Readonly<{
  filesystem?: DiagnosticFilesystem;
  openPrivateSnapshotReadOnly?: (snapshot: Buffer) => Sqlite;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

type MutableChecks = { -readonly [Key in keyof ShopifyDatabaseDiagnosticChecks]: boolean };

function initialChecks(): MutableChecks {
  return {
    runtimeBindingVerified: true,
    fixedDatabaseTargetVerified: true,
    listingWriterAckAbsent: true,
    filePresent: false,
    fileRegular: false,
    fileSymlinkAbsent: false,
    fileSingleLink: false,
    fileNonEmpty: false,
    fileWithinSnapshotLimit: false,
    fileMode0600: false,
    parentDirectory: false,
    parentSymlinkAbsent: false,
    parentGroupWorldWritableAbsent: false,
    sqliteSidecarsAbsentBeforeSnapshot: false,
    descriptorOpenedReadOnly: false,
    descriptorInspectedBeforeSnapshot: false,
    descriptorIdentityStableBeforeSnapshot: false,
    snapshotReadFromDescriptor: false,
    snapshotHeaderCanonical: false,
    snapshotContentProofCaptured: false,
    sqliteOpenedFromPrivateSnapshot: false,
    sqlitePrivateMemory: false,
    sqliteOpenedReadOnly: false,
    sqliteTempStoreMemory: false,
    sqliteQueryOnly: false,
    authTokensTableDefinitionCanonical: false,
    authTokensTableStorageCanonical: false,
    authTokensColumnsCanonical: false,
    authTokensUniquePlatformIndexCanonical: false,
    authTokensTriggersAbsent: false,
    authTokensForeignKeysAbsent: false,
    authTokensMutationStatementCompiles: false,
    sqliteIntegrityOk: false,
    shopifyRowCardinalityOne: false,
    sqliteClosed: false,
    descriptorInspectedAfterSnapshot: false,
    descriptorIdentityStableAfterSnapshot: false,
    snapshotStableAfterInspection: false,
    pathIdentityStableAfterSnapshot: false,
    sqliteSidecarsAbsentAfterSnapshot: false,
    descriptorClosed: false,
  };
}

function report(
  stage: ShopifyDatabaseDiagnosticStage,
  checks: MutableChecks,
): ShopifyDatabaseDiagnosticReport {
  return Object.freeze({
    status: stage === 'verified'
      ? 'database_diagnostic_verified'
      : 'database_diagnostic_failed_closed',
    stage,
    checks: Object.freeze({ ...checks }),
    databaseWritesPerformed: 0,
    providerNetworkRequestsPerformed: 0,
    providerCredentialMutationsPerformed: 0,
    externalCommerceWritesPerformed: 0,
  });
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function sameDescriptorIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return right.isFile()
    && right.nlink === 1
    && (right.mode & 0o777) === 0o600
    && right.dev === left.dev
    && right.ino === left.ino
    && right.size === left.size;
}

function sameDescriptorState(left: fs.Stats, right: fs.Stats): boolean {
  return sameDescriptorIdentity(left, right)
    && right.mtimeMs === left.mtimeMs;
}

function inspectSidecars(
  filesystem: DiagnosticFilesystem,
  databasePath: string,
): 'absent' | 'present' | 'denied' {
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      filesystem.lstatSync(`${databasePath}${suffix}`);
      return 'present';
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return 'denied';
    }
  }
  return 'absent';
}

function readExactDescriptor(
  filesystem: DiagnosticFilesystem,
  descriptor: number,
  size: number,
): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  try {
    while (offset < size) {
      const remaining = size - offset;
      const read = filesystem.readSync(descriptor, buffer, offset, remaining, offset);
      if (!Number.isSafeInteger(read) || read <= 0 || read > remaining) {
        throw new Error('snapshot read denied');
      }
      offset += read;
    }
    return buffer;
  } catch (error) {
    buffer.fill(0);
    throw error;
  }
}

function digestDescriptor(
  filesystem: DiagnosticFilesystem,
  descriptor: number,
  size: number,
): Buffer {
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(chunk.length, size - offset);
      const read = filesystem.readSync(descriptor, chunk, 0, length, offset);
      if (!Number.isSafeInteger(read) || read <= 0 || read > length) {
        throw new Error('snapshot read denied');
      }
      digest.update(chunk.subarray(0, read));
      offset += read;
    }
    return digest.digest();
  } finally {
    chunk.fill(0);
  }
}

function privateSqliteSnapshot(snapshot: Buffer): Buffer | null {
  if (snapshot.length < SQLITE_HEADER_BYTES
    || !snapshot.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return null;
  const writeVersion = snapshot[SQLITE_HEADER_WRITE_VERSION_OFFSET];
  const readVersion = snapshot[SQLITE_HEADER_READ_VERSION_OFFSET];
  if (writeVersion !== readVersion
    || (writeVersion !== SQLITE_ROLLBACK_JOURNAL_VERSION
      && writeVersion !== SQLITE_WAL_VERSION)) return null;
  const privateSnapshot = Buffer.from(snapshot);
  if (writeVersion === SQLITE_WAL_VERSION) {
    // A clean main database can retain WAL header mode after checkpoint. A
    // private deserialize has no filesystem sidecars, so only the private copy
    // is presented as rollback-journal mode. The source bytes remain untouched
    // and integrity/schema checks still run against the copied pages.
    privateSnapshot[SQLITE_HEADER_WRITE_VERSION_OFFSET] = SQLITE_ROLLBACK_JOURNAL_VERSION;
    privateSnapshot[SQLITE_HEADER_READ_VERSION_OFFSET] = SQLITE_ROLLBACK_JOURNAL_VERSION;
  }
  return privateSnapshot;
}

function schemaFailureStage(
  inspection: AuthTokensSchemaInspection,
): ShopifyDatabaseDiagnosticStage | null {
  switch (inspection.stage) {
    case 'table-definition': return 'schema-table-definition-denied';
    case 'table-storage': return 'schema-table-storage-denied';
    case 'columns': return 'schema-columns-denied';
    case 'index': return 'schema-index-denied';
    case 'triggers': return 'schema-trigger-denied';
    case 'foreign-keys': return 'schema-foreign-key-denied';
    case 'mutation-statement': return 'schema-mutation-denied';
    case 'verified': return null;
  }
}

function applySchemaChecks(
  checks: MutableChecks,
  inspection: AuthTokensSchemaInspection,
): void {
  checks.authTokensTableDefinitionCanonical = inspection.tableDefinitionCanonical;
  checks.authTokensTableStorageCanonical = inspection.tableStorageCanonical;
  checks.authTokensColumnsCanonical = inspection.columnsCanonical;
  checks.authTokensUniquePlatformIndexCanonical = inspection.uniquePlatformIndexCanonical;
  checks.authTokensTriggersAbsent = inspection.triggersAbsent;
  checks.authTokensForeignKeysAbsent = inspection.foreignKeysAbsent;
  checks.authTokensMutationStatementCompiles = inspection.mutationStatementCompiles;
}

/**
 * Inspects only the fixed Production legacy database. SQLite never receives a
 * filesystem path: it opens a bounded private copy read from the verified
 * O_RDONLY/O_NOFOLLOW descriptor, which remains open through SQLite close and
 * post-inspection identity/content/sidecar checks.
 */
export function diagnoseFixedProductionShopifyDatabase(
  environment: Environment = process.env,
  dependencies: ShopifyDatabaseDiagnosticDependencies = {},
): ShopifyDatabaseDiagnosticReport {
  assertShopifyCredentialDatabaseDiagnosticRuntimeBinding(environment);
  const databasePath = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
  const filesystem = dependencies.filesystem ?? fs;
  const openPrivateSnapshotReadOnly = dependencies.openPrivateSnapshotReadOnly
    ?? ((snapshot: Buffer) => new Database(snapshot, { readonly: true }));
  const checks = initialChecks();

  let entry: fs.Stats;
  try {
    entry = filesystem.lstatSync(databasePath);
    checks.filePresent = true;
  } catch (error) {
    return report(errorCode(error) === 'ENOENT' ? 'file-missing' : 'file-inspection-denied', checks);
  }
  checks.fileRegular = entry.isFile();
  checks.fileSymlinkAbsent = !entry.isSymbolicLink();
  checks.fileSingleLink = entry.nlink === 1;
  checks.fileNonEmpty = entry.size > 0;
  checks.fileWithinSnapshotLimit = Number.isSafeInteger(entry.size)
    && entry.size <= MAXIMUM_DATABASE_SNAPSHOT_BYTES;
  checks.fileMode0600 = (entry.mode & 0o777) === 0o600;
  if (!checks.fileRegular) return report('file-type-denied', checks);
  if (!checks.fileSymlinkAbsent || !checks.fileSingleLink) {
    return report('file-link-denied', checks);
  }
  if (!checks.fileNonEmpty) return report('file-empty-denied', checks);
  if (!checks.fileWithinSnapshotLimit) return report('file-size-denied', checks);
  if (!checks.fileMode0600) return report('file-permissions-denied', checks);

  try {
    const parent = filesystem.lstatSync(path.dirname(databasePath));
    checks.parentDirectory = parent.isDirectory();
    checks.parentSymlinkAbsent = !parent.isSymbolicLink();
    checks.parentGroupWorldWritableAbsent = (parent.mode & 0o022) === 0;
  } catch {
    return report('parent-inspection-denied', checks);
  }
  if (!checks.parentDirectory || !checks.parentSymlinkAbsent) {
    return report('parent-type-denied', checks);
  }
  if (!checks.parentGroupWorldWritableAbsent) {
    return report('parent-permissions-denied', checks);
  }

  const sidecarsBefore = inspectSidecars(filesystem, databasePath);
  if (sidecarsBefore === 'denied') return report('sidecar-inspection-denied', checks);
  if (sidecarsBefore === 'present') return report('sidecar-present', checks);
  checks.sqliteSidecarsAbsentBeforeSnapshot = true;

  let failure: ShopifyDatabaseDiagnosticStage | null = null;
  let descriptor: number | null = null;
  let openedBefore: fs.Stats | null = null;
  let snapshot: Buffer | null = null;
  let snapshotDigest: Buffer | null = null;
  let sqliteSnapshot: Buffer | null = null;
  let database: Sqlite | null = null;

  try {
    try {
      descriptor = filesystem.openSync(
        databasePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      checks.descriptorOpenedReadOnly = true;
    } catch {
      failure = 'descriptor-open-denied';
    }

    if (failure === null && descriptor !== null) {
      try {
        openedBefore = filesystem.fstatSync(descriptor);
        checks.descriptorInspectedBeforeSnapshot = true;
      } catch {
        failure = 'descriptor-inspection-denied';
      }
    }

    if (failure === null && openedBefore !== null) {
      checks.descriptorIdentityStableBeforeSnapshot = sameDescriptorIdentity(entry, openedBefore);
      if (!checks.descriptorIdentityStableBeforeSnapshot) failure = 'descriptor-identity-denied';
    }

    if (failure === null && descriptor !== null && openedBefore !== null) {
      try {
        snapshot = readExactDescriptor(filesystem, descriptor, openedBefore.size);
        snapshotDigest = createHash('sha256').update(snapshot).digest();
        checks.snapshotReadFromDescriptor = true;
        checks.snapshotContentProofCaptured = true;
      } catch {
        failure = 'snapshot-read-denied';
      }
    }

    if (failure === null && snapshot !== null) {
      sqliteSnapshot = privateSqliteSnapshot(snapshot);
      checks.snapshotHeaderCanonical = sqliteSnapshot !== null;
      if (!checks.snapshotHeaderCanonical) failure = 'snapshot-header-denied';
    }

    if (failure === null && sqliteSnapshot !== null) {
      try {
        database = openPrivateSnapshotReadOnly(sqliteSnapshot);
        checks.sqliteOpenedFromPrivateSnapshot = true;
      } catch {
        failure = 'sqlite-open-denied';
      }
    }

    if (failure === null && database !== null) {
      checks.sqlitePrivateMemory = database.memory === true;
      if (!checks.sqlitePrivateMemory) failure = 'sqlite-memory-denied';
    }

    if (failure === null && database !== null) {
      checks.sqliteOpenedReadOnly = database.readonly === true;
      if (!checks.sqliteOpenedReadOnly) failure = 'sqlite-readonly-denied';
    }

    if (failure === null && database !== null) {
      try {
        database.pragma('temp_store = MEMORY');
        checks.sqliteTempStoreMemory = database.pragma('temp_store', { simple: true }) === 2;
      } catch {
        failure = 'sqlite-temp-store-denied';
      }
      if (failure === null && !checks.sqliteTempStoreMemory) {
        failure = 'sqlite-temp-store-denied';
      }
    }

    if (failure === null && database !== null) {
      try {
        database.pragma('query_only = ON');
        checks.sqliteQueryOnly = database.pragma('query_only', { simple: true }) === 1;
      } catch {
        failure = 'sqlite-query-only-denied';
      }
      if (failure === null && !checks.sqliteQueryOnly) failure = 'sqlite-query-only-denied';
    }

    if (failure === null && database !== null) {
      const inspection = inspectCanonicalAuthTokensSchema(database);
      applySchemaChecks(checks, inspection);
      failure = schemaFailureStage(inspection);
    }

    if (failure === null && database !== null) {
      try {
        checks.sqliteIntegrityOk = database.pragma('integrity_check', { simple: true }) === 'ok';
      } catch {
        failure = 'integrity-check-denied';
      }
      if (failure === null && !checks.sqliteIntegrityOk) failure = 'integrity-check-denied';
    }

    if (failure === null && database !== null) {
      try {
        const cardinality = database.prepare(
          `SELECT COUNT(*) AS count FROM auth_tokens WHERE platform = 'shopify'`,
        ).get() as { count: number } | undefined;
        checks.shopifyRowCardinalityOne = cardinality?.count === 1;
      } catch {
        failure = 'shopify-row-cardinality-denied';
      }
      if (failure === null && !checks.shopifyRowCardinalityOne) {
        failure = 'shopify-row-cardinality-denied';
      }
    }
  } finally {
    if (database !== null) {
      try {
        database.close();
        checks.sqliteClosed = true;
      } catch {
        if (failure === null) failure = 'sqlite-close-denied';
      }
    }

    if (descriptor !== null && openedBefore !== null) {
      let afterDigest: Buffer | null = null;
      if (snapshotDigest !== null) {
        try {
          afterDigest = digestDescriptor(filesystem, descriptor, openedBefore.size);
        } catch {
          if (failure === null) failure = 'snapshot-post-read-denied';
        }
      }

      let afterInspection: fs.Stats | null = null;
      try {
        afterInspection = filesystem.fstatSync(descriptor);
        checks.descriptorInspectedAfterSnapshot = true;
        checks.descriptorIdentityStableAfterSnapshot = sameDescriptorIdentity(
          openedBefore,
          afterInspection,
        );
      } catch {
        if (failure === null) failure = 'descriptor-post-inspection-denied';
      }
      if (afterInspection !== null
        && !checks.descriptorIdentityStableAfterSnapshot
        && failure === null) failure = 'descriptor-post-identity-denied';

      if (snapshotDigest !== null && afterDigest !== null && afterInspection !== null) {
        checks.snapshotStableAfterInspection = afterDigest.length === snapshotDigest.length
          && timingSafeEqual(afterDigest, snapshotDigest)
          && sameDescriptorState(openedBefore, afterInspection);
        if (!checks.snapshotStableAfterInspection && failure === null) {
          failure = 'snapshot-post-stability-denied';
        }
      }
      afterDigest?.fill(0);

      try {
        const pathAfter = filesystem.lstatSync(databasePath);
        checks.pathIdentityStableAfterSnapshot = sameDescriptorIdentity(openedBefore, pathAfter);
      } catch {
        if (failure === null) failure = 'path-post-inspection-denied';
      }
      if (!checks.pathIdentityStableAfterSnapshot && failure === null) {
        failure = 'path-post-identity-denied';
      }

      const sidecarsAfter = inspectSidecars(filesystem, databasePath);
      checks.sqliteSidecarsAbsentAfterSnapshot = sidecarsAfter === 'absent';
      if (sidecarsAfter === 'denied' && failure === null) {
        failure = 'sidecar-post-inspection-denied';
      } else if (sidecarsAfter === 'present' && failure === null) {
        failure = 'sidecar-post-present';
      }
    }

    if (descriptor !== null) {
      try {
        filesystem.closeSync(descriptor);
        checks.descriptorClosed = true;
      } catch {
        if (failure === null) failure = 'descriptor-close-denied';
      }
    }

    snapshot?.fill(0);
    snapshotDigest?.fill(0);
    sqliteSnapshot?.fill(0);
  }

  return report(failure ?? 'verified', checks);
}
