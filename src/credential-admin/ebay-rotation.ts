import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseStringPromise } from 'xml2js';

export const EBAY_PRODUCTION_SCOPES = Object.freeze([
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
] as const);

export const EBAY_ROTATION_ENVIRONMENT = 'production' as const;
export const EBAY_ROTATION_SELLER = 'usedcameragear' as const;
export const EBAY_ROTATION_MARKETPLACE = 'EBAY_US' as const;
export const EBAY_REVOKE_CONFIRMATION = 'revoke-productpipeline-ebay-grant' as const;
export const EBAY_RECONCILIATION_RESET_CONFIRMATION = 'provider-reconciled-reset-ebay-consent' as const;
export const EBAY_STALE_LOCK_RECOVERY_CONFIRMATION = 'recover-stale-ebay-credential-lock' as const;
export const EBAY_PRODUCTION_DATABASE_PATH = '/data/ebaysync.db' as const;
export const EBAY_PRODUCTION_WORK_DIRECTORY = '/data/product-pipeline/credential-maintenance/ebay' as const;
export const EBAY_PRODUCTION_BACKUP_DIRECTORY = '/data/product-pipeline/credential-backups/ebay' as const;
export const EBAY_PRODUCTION_EVIDENCE_ARCHIVE_DIRECTORY = '/data/product-pipeline/credential-maintenance/evidence-archive' as const;
export const EBAY_PRODUCTION_LOCK_ARCHIVE_DIRECTORY = '/data/product-pipeline/credential-maintenance/lock-archive' as const;

const CONSENT_URL = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const INTROSPECTION_URL = `${TOKEN_URL}/introspect`;
const REVOCATION_URL = `${TOKEN_URL}/revoke`;
const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const INVENTORY_PROBE_URL = 'https://api.ebay.com/sell/inventory/v1/inventory_item?limit=1&offset=0';
const CONSENT_STATE_TTL_MS = 15 * 60 * 1_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_LIMIT = 256 * 1_024;
const STATE_FILE = 'consent-state.json';
const CONSENT_FILE = 'consent-url.txt';
const LOCK_FILE = '.ebay-credential-operation.lock';
const OPERATION_LOCK_TTL_MS = 5 * 60 * 1_000;
const OPERATION_LOCK_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const EBAY_ROTATION_ERROR_CODES = Object.freeze([
  'EBAY_ROTATION_ARGUMENT_DENIED',
  'EBAY_ROTATION_CONFIGURATION_DENIED',
  'EBAY_ROTATION_FILE_BOUNDARY_DENIED',
  'EBAY_ROTATION_LOCKED',
  'EBAY_ROTATION_STATE_INVALID',
  'EBAY_ROTATION_STATE_EXPIRED',
  'EBAY_ROTATION_STATE_ALREADY_USED',
  'EBAY_ROTATION_AUTH_RESULT_INVALID',
  'EBAY_ROTATION_AUTH_RESULT_MISMATCH',
  'EBAY_ROTATION_PROVIDER_EXCHANGE_FAILED',
  'EBAY_ROTATION_PROVIDER_RESPONSE_INVALID',
  'EBAY_ROTATION_PROVIDER_SCOPE_MISMATCH',
  'EBAY_ROTATION_PROVIDER_IDENTITY_MISMATCH',
  'EBAY_ROTATION_PROVIDER_ENVIRONMENT_MISMATCH',
  'EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED',
  'EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED',
  'EBAY_ROTATION_DATABASE_BACKUP_FAILED',
  'EBAY_ROTATION_DATABASE_CAS_FAILED',
  'EBAY_ROTATION_DATABASE_READBACK_FAILED',
  'EBAY_ROTATION_GRANT_BINDING_MISMATCH',
  'EBAY_ROTATION_REVOCATION_DENIED',
  'EBAY_ROTATION_REVOCATION_FAILED',
  'EBAY_ROTATION_RECONCILIATION_DENIED',
  'EBAY_ROTATION_LOCK_RECOVERY_DENIED',
  'EBAY_ROTATION_CLEANUP_REQUIRED',
  'EBAY_ROTATION_FAILED_CLOSED',
] as const);

export type EbayRotationErrorCode = (typeof EBAY_ROTATION_ERROR_CODES)[number];

export type EbayRotationFailureEffects = Readonly<{
  databaseRowsChanged: 0 | 1 | 'unknown';
  credentialProviderMutation: boolean;
  reconciliationRequired: boolean;
}>;

const NO_FAILURE_EFFECTS: EbayRotationFailureEffects = Object.freeze({
  databaseRowsChanged: 0,
  credentialProviderMutation: false,
  reconciliationRequired: false,
});

export class EbayRotationError extends Error {
  readonly code: EbayRotationErrorCode;
  readonly effects: EbayRotationFailureEffects;

  constructor(
    code: EbayRotationErrorCode,
    effects: EbayRotationFailureEffects = NO_FAILURE_EFFECTS,
  ) {
    super(code);
    this.name = 'EbayRotationError';
    this.code = code;
    this.effects = Object.freeze({ ...effects });
  }
}

type ConsentStatus =
  | 'pending'
  | 'consumed'
  | 'installing'
  | 'installed'
  | 'revoked'
  | 'failed-no-provider-effect'
  | 'failed-revoked'
  | 'failed-cleanup-required'
  | 'commit-outcome-reconciliation-required'
  | 'committed-reconciliation-required';

type DatabaseEffect = 'none' | 'commit-pending' | 'committed';

type InstallationBinding = Readonly<{
  databasePath: string;
  expectedUpdatedAt: number;
  rowId: number | null;
  accessTokenDigest: string | null;
  refreshTokenDigest: string | null;
  backupFileName: string;
  committedAtUtc: string | null;
}>;

type ConsentRecord = Readonly<{
  schemaVersion: 2;
  kind: 'product-pipeline-ebay-production-consent';
  environment: 'production';
  seller: 'usedcameragear';
  marketplaceId: 'EBAY_US';
  scopes: readonly string[];
  scopesDigest: string;
  stateDigest: string;
  requestDigest: string;
  consentArtifact: 'co-located' | 'external';
  createdAtUtc: string;
  expiresAtUtc: string;
  status: ConsentStatus;
  databaseEffect: DatabaseEffect;
  consumedAtUtc: string | null;
  installation: InstallationBinding | null;
  terminalCode: string | null;
}>;

export type EbayRotationCredentials = Readonly<{
  appId: string;
  ruName: string;
  newCertId?: string;
}>;

export type EbayProviderRequest = Readonly<{
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}>;

export type EbayProviderResponse = Readonly<{
  status: number;
  bodyText: string;
}>;

export type EbayProviderTransport = (
  request: EbayProviderRequest,
) => Promise<EbayProviderResponse>;

export type EbayDirectorySyncPhase =
  | 'directory-create'
  | 'new-private-file'
  | 'state-temporary-create'
  | 'state-replace'
  | 'lock-create'
  | 'lock-release'
  | 'backup-finalize'
  | 'evidence-archive-target'
  | 'evidence-archive-source'
  | 'reset-publish'
  | 'stale-lock-archive-target'
  | 'stale-lock-archive-source';

export type EbayRotationDependencies = Readonly<{
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  transport?: EbayProviderTransport;
  beforeLedgerCas?: () => void | Promise<void>;
  afterCommitAppliedBeforeResult?: () => void | Promise<void>;
  beforeCommittedStateWrite?: () => void | Promise<void>;
  beforeLockRelease?: () => void | Promise<void>;
  isLockOwnerAlive?: (pid: number) => boolean;
  beforeDirectorySync?: (
    directory: string,
    phase: EbayDirectorySyncPhase,
  ) => void | Promise<void>;
  afterDirectorySync?: (
    directory: string,
    phase: EbayDirectorySyncPhase,
  ) => void | Promise<void>;
}>;

export type EbayRotationResult = Readonly<{
  ok: true;
  code:
    | 'EBAY_CONSENT_PREPARED'
    | 'EBAY_CONSENT_REGISTERED'
    | 'EBAY_GRANT_INSTALLED'
    | 'EBAY_GRANT_VERIFIED'
    | 'EBAY_GRANT_REVOKED'
    | 'EBAY_GRANT_ALREADY_REVOKED'
    | 'EBAY_CONSENT_RESET_AFTER_RECONCILIATION'
    | 'EBAY_STALE_LOCK_ARCHIVED';
  environment: 'production';
  sellerVerified: boolean;
  scopesVerified: boolean;
  backupCreated: boolean;
  databaseRowsChanged: 0 | 1;
  credentialProviderMutation: boolean;
  commerceWritesPerformed: 0;
  historicalOrdersTouched: 0;
}>;

type Grant = Readonly<{
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  scope: string;
}>;

type AuthTokenRow = Readonly<{
  id: number;
  platform: string;
  access_token: string;
  refresh_token: string | null;
  scope: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}>;

type LedgerPreparation = Readonly<{
  databasePath: string;
  databaseDevice: number;
  databaseInode: number;
  backupFileName: string;
  backupPath: string;
  expectedUpdatedAt: number;
  baselineRows: readonly AuthTokenRow[];
}>;

type LedgerCommitResult =
  | Readonly<{ outcome: 'committed'; rowId: number }>
  | Readonly<{ outcome: 'commit-error-committed'; rowId: number }>
  | Readonly<{ outcome: 'commit-error-baseline' }>
  | Readonly<{ outcome: 'commit-error-unknown' }>;

type OperationLockRecord = Readonly<{
  schemaVersion: 1;
  kind: 'product-pipeline-ebay-credential-operation-lock';
  ownerId: string;
  pid: number;
  createdAtUtc: string;
  expiresAtUtc: string;
}>;

const CONSENT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'environment', 'seller', 'marketplaceId', 'scopes',
  'scopesDigest', 'stateDigest', 'requestDigest', 'consentArtifact', 'createdAtUtc',
  'expiresAtUtc', 'status', 'databaseEffect', 'consumedAtUtc', 'installation', 'terminalCode',
]);
const INSTALLATION_KEYS = Object.freeze([
  'databasePath', 'expectedUpdatedAt', 'rowId', 'accessTokenDigest',
  'refreshTokenDigest', 'backupFileName', 'committedAtUtc',
]);
const STATUSES = new Set<ConsentStatus>([
  'pending', 'consumed', 'installing', 'installed', 'revoked',
  'failed-no-provider-effect', 'failed-revoked', 'failed-cleanup-required',
  'commit-outcome-reconciliation-required', 'committed-reconciliation-required',
]);
const LOCK_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'ownerId', 'pid', 'createdAtUtc', 'expiresAtUtc',
]);

function fail(code: EbayRotationErrorCode): never {
  throw new EbayRotationError(code);
}

function failWithEffects(
  code: EbayRotationErrorCode,
  effects: EbayRotationFailureEffects,
): never {
  throw new EbayRotationError(code, effects);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
  }
  return value;
}

function requireConfiguredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
    fail('EBAY_ROTATION_CONFIGURATION_DENIED');
  }
  return value;
}

function canonicalTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  return value.toISOString();
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function tokenDigest(kind: 'access' | 'refresh', value: string): string {
  return sha256(`product-pipeline-ebay-${kind}-token-v1\u0000${value}`);
}

function digestMatchesToken(
  kind: 'access' | 'refresh',
  value: string,
  expectedDigest: string,
): boolean {
  const actual = Buffer.from(tokenDigest(kind, value).slice('sha256:'.length), 'hex');
  const expected = Buffer.from(expectedDigest.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function consentRequestDigest(
  credentials: Pick<EbayRotationCredentials, 'appId' | 'ruName'>,
  stateDigest: string,
): string {
  return sha256(JSON.stringify({
    environment: EBAY_ROTATION_ENVIRONMENT,
    appId: credentials.appId,
    ruName: credentials.ruName,
    scopes: [...EBAY_PRODUCTION_SCOPES],
    stateDigest,
  }));
}

function canonicalScopeString(scopes: readonly string[]): string {
  return [...scopes].sort().join(' ');
}

function exactScopeSet(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 4_096) return false;
  const supplied = value.split(/\s+/u).filter(Boolean).sort();
  const expected = [...EBAY_PRODUCTION_SCOPES].sort();
  return supplied.length === expected.length
    && new Set(supplied).size === supplied.length
    && supplied.every((scope, index) => scope === expected[index]);
}

function fixedResult(
  code: EbayRotationResult['code'],
  input: Partial<Omit<EbayRotationResult, 'ok' | 'code' | 'environment'
    | 'commerceWritesPerformed' | 'historicalOrdersTouched'>> = {},
): EbayRotationResult {
  return Object.freeze({
    ok: true,
    code,
    environment: EBAY_ROTATION_ENVIRONMENT,
    sellerVerified: input.sellerVerified ?? false,
    scopesVerified: input.scopesVerified ?? false,
    backupCreated: input.backupCreated ?? false,
    databaseRowsChanged: input.databaseRowsChanged ?? 0,
    credentialProviderMutation: input.credentialProviderMutation ?? false,
    commerceWritesPerformed: 0,
    historicalOrdersTouched: 0,
  });
}

function assertCredentials(
  credentials: EbayRotationCredentials,
  requireCert: boolean,
): Required<EbayRotationCredentials> | EbayRotationCredentials {
  requireConfiguredText(credentials.appId, 512);
  requireConfiguredText(credentials.ruName, 512);
  if (requireCert) requireConfiguredText(credentials.newCertId, 512);
  return credentials;
}

function assertAbsolute(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096
    || !path.isAbsolute(value) || value !== path.normalize(value)
    || value === path.parse(value).root || value.includes('\u0000')) {
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  return value;
}

function mode(stat: { mode: number }): number {
  return stat.mode & 0o777;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const exact = assertAbsolute(directory);
  let stat;
  try {
    stat = await fs.lstat(exact);
  } catch {
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700) {
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  const resolved = await fs.realpath(exact).catch(() => '');
  if (resolved !== exact) fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
}

async function syncPrivateDirectory(
  directory: string,
  dependencies: EbayRotationDependencies | undefined,
  phase: EbayDirectorySyncPhase,
): Promise<void> {
  const exact = assertAbsolute(directory);
  await assertPrivateDirectory(exact);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    await dependencies?.beforeDirectorySync?.(exact, phase);
    handle = await fs.open(exact, 'r');
    await handle.sync();
    await handle.close();
    handle = null;
    await dependencies?.afterDirectorySync?.(exact, phase);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
}

async function syncPrivateRegularFile(filePath: string): Promise<void> {
  const exact = assertAbsolute(filePath);
  await assertPrivateRegularFile(exact);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(exact, 'r+');
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
}

async function createPrivateDirectory(
  directory: string,
  dependencies?: EbayRotationDependencies,
): Promise<void> {
  const exact = assertAbsolute(directory);
  const parent = path.dirname(exact);
  await assertPrivateDirectory(parent);
  try {
    await fs.mkdir(exact, { mode: 0o700 });
  } catch {
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  await assertPrivateDirectory(exact);
  await syncPrivateDirectory(parent, dependencies, 'directory-create');
}

async function ensurePrivateDirectory(
  directory: string,
  dependencies?: EbayRotationDependencies,
): Promise<void> {
  const exact = assertAbsolute(directory);
  try {
    await assertPrivateDirectory(exact);
  } catch (error) {
    if (!(error instanceof EbayRotationError)) throw error;
    const parent = path.dirname(exact);
    await assertPrivateDirectory(parent);
    try {
      await fs.mkdir(exact, { mode: 0o700 });
    } catch {
      return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
    }
    await assertPrivateDirectory(exact);
    await syncPrivateDirectory(parent, dependencies, 'directory-create');
  }
}

async function assertPrivateRegularFile(filePath: string): Promise<void> {
  const exact = assertAbsolute(filePath);
  let stat;
  try {
    stat = await fs.lstat(exact);
  } catch {
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || mode(stat) !== 0o600) {
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  const resolved = await fs.realpath(exact).catch(() => '');
  if (resolved !== exact) fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
}

async function writeNewPrivateFile(
  filePath: string,
  value: string,
  dependencies?: EbayRotationDependencies,
  phase: EbayDirectorySyncPhase = 'new-private-file',
): Promise<void> {
  const handle = await fs.open(filePath, 'wx', 0o600).catch(() => null);
  if (!handle) fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  try {
    await handle.writeFile(value, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
  await syncPrivateRegularFile(filePath);
  await assertPrivateRegularFile(filePath);
  await syncPrivateDirectory(path.dirname(filePath), dependencies, phase);
}

async function replacePrivateFile(
  filePath: string,
  value: string,
  dependencies?: EbayRotationDependencies,
): Promise<void> {
  await assertPrivateRegularFile(filePath);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.state-${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeNewPrivateFile(
      temporaryPath,
      value,
      dependencies,
      'state-temporary-create',
    );
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
    await syncPrivateRegularFile(filePath);
    await assertPrivateRegularFile(filePath);
    await syncPrivateDirectory(directory, dependencies, 'state-replace');
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    if (error instanceof EbayRotationError) throw error;
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
}

async function durableRename(
  sourcePath: string,
  targetPath: string,
  dependencies: EbayRotationDependencies | undefined,
  targetPhase: EbayDirectorySyncPhase,
  sourcePhase: EbayDirectorySyncPhase = targetPhase,
): Promise<void> {
  const source = assertAbsolute(sourcePath);
  const target = assertAbsolute(targetPath);
  const sourceDirectory = path.dirname(source);
  const targetDirectory = path.dirname(target);
  await assertPrivateDirectory(sourceDirectory);
  await assertPrivateDirectory(targetDirectory);
  try {
    await fs.rename(source, target);
    // Persist the evidence-bearing destination first. If a crash occurs between
    // the two syncs, duplicate namespace evidence is safer than losing it.
    await syncPrivateDirectory(targetDirectory, dependencies, targetPhase);
    if (sourceDirectory !== targetDirectory) {
      await syncPrivateDirectory(sourceDirectory, dependencies, sourcePhase);
    }
  } catch (error) {
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
}

function parseInstallation(value: unknown): InstallationBinding | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, INSTALLATION_KEYS)) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  const rowId = value.rowId;
  const accessTokenDigest = value.accessTokenDigest;
  const refreshTokenDigest = value.refreshTokenDigest;
  if (!Number.isInteger(value.expectedUpdatedAt) || (value.expectedUpdatedAt as number) <= 0
    || !(rowId === null || (Number.isInteger(rowId) && (rowId as number) > 0))
    || !((accessTokenDigest === null && refreshTokenDigest === null)
      || (typeof accessTokenDigest === 'string'
        && /^sha256:[0-9a-f]{64}$/u.test(accessTokenDigest)
        && typeof refreshTokenDigest === 'string'
        && /^sha256:[0-9a-f]{64}$/u.test(refreshTokenDigest)))
    || typeof value.databasePath !== 'string' || !path.isAbsolute(value.databasePath)
    || typeof value.backupFileName !== 'string'
    || !/^ebaysync-before-ebay-grant-[0-9TZ-]+-[0-9a-f]{12}\.sqlite$/u.test(value.backupFileName)
    || !(value.committedAtUtc === null
      || (typeof value.committedAtUtc === 'string'
        && new Date(value.committedAtUtc).toISOString() === value.committedAtUtc))) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  return Object.freeze({
    databasePath: assertAbsolute(value.databasePath),
    expectedUpdatedAt: value.expectedUpdatedAt as number,
    rowId: rowId as number | null,
    accessTokenDigest: accessTokenDigest as string | null,
    refreshTokenDigest: refreshTokenDigest as string | null,
    backupFileName: value.backupFileName,
    committedAtUtc: value.committedAtUtc as string | null,
  });
}

function parseConsentRecord(value: unknown): ConsentRecord {
  if (!isRecord(value) || !hasExactKeys(value, CONSENT_KEYS)) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  if (value.schemaVersion !== 2
    || value.kind !== 'product-pipeline-ebay-production-consent'
    || value.environment !== EBAY_ROTATION_ENVIRONMENT
    || value.seller !== EBAY_ROTATION_SELLER
    || value.marketplaceId !== EBAY_ROTATION_MARKETPLACE
    || !Array.isArray(value.scopes)
    || value.scopes.length !== EBAY_PRODUCTION_SCOPES.length
    || value.scopes.some((entry, index) => entry !== EBAY_PRODUCTION_SCOPES[index])
    || value.scopesDigest !== sha256(canonicalScopeString(EBAY_PRODUCTION_SCOPES))
    || typeof value.stateDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value.stateDigest)
    || typeof value.requestDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value.requestDigest)
    || !['co-located', 'external'].includes(value.consentArtifact as string)
    || typeof value.createdAtUtc !== 'string'
    || typeof value.expiresAtUtc !== 'string'
    || new Date(value.createdAtUtc).toISOString() !== value.createdAtUtc
    || new Date(value.expiresAtUtc).toISOString() !== value.expiresAtUtc
    || typeof value.status !== 'string'
    || !STATUSES.has(value.status as ConsentStatus)
    || !['none', 'commit-pending', 'committed'].includes(value.databaseEffect as string)
    || !(value.consumedAtUtc === null
      || (typeof value.consumedAtUtc === 'string'
        && new Date(value.consumedAtUtc).toISOString() === value.consumedAtUtc))
    || !(value.terminalCode === null
      || (typeof value.terminalCode === 'string'
        && /^[A-Z0-9_-]{1,96}$/u.test(value.terminalCode)))) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  const installation = parseInstallation(value.installation);
  const status = value.status as ConsentStatus;
  const databaseEffect = value.databaseEffect as DatabaseEffect;
  const hasTokenBinding = installation?.accessTokenDigest !== null
    && installation?.accessTokenDigest !== undefined
    && installation.refreshTokenDigest !== null;
  const hasCommittedBinding = hasTokenBinding
    && installation?.rowId !== null
    && installation?.rowId !== undefined
    && installation.committedAtUtc !== null;
  if ((databaseEffect === 'commit-pending' && !hasTokenBinding)
    || (databaseEffect === 'committed' && !hasCommittedBinding)
    || (['installed', 'revoked', 'committed-reconciliation-required'].includes(status)
      && databaseEffect !== 'committed')
    || (status === 'commit-outcome-reconciliation-required'
      && databaseEffect !== 'commit-pending')
    || (status === 'commit-outcome-reconciliation-required'
      && value.terminalCode !== 'EBAY_ROTATION_CLEANUP_REQUIRED')
    || (['pending', 'consumed', 'failed-no-provider-effect', 'failed-revoked',
      'failed-cleanup-required'].includes(status) && databaseEffect !== 'none')
    || (status === 'pending' && installation !== null)) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  return Object.freeze({
    schemaVersion: 2,
    kind: 'product-pipeline-ebay-production-consent',
    environment: EBAY_ROTATION_ENVIRONMENT,
    seller: EBAY_ROTATION_SELLER,
    marketplaceId: EBAY_ROTATION_MARKETPLACE,
    scopes: Object.freeze([...EBAY_PRODUCTION_SCOPES]),
    scopesDigest: value.scopesDigest,
    stateDigest: value.stateDigest,
    requestDigest: value.requestDigest,
    consentArtifact: value.consentArtifact as 'co-located' | 'external',
    createdAtUtc: value.createdAtUtc,
    expiresAtUtc: value.expiresAtUtc,
    status,
    databaseEffect,
    consumedAtUtc: value.consumedAtUtc as string | null,
    installation,
    terminalCode: value.terminalCode as string | null,
  });
}

async function readConsentRecord(workDirectory: string): Promise<ConsentRecord> {
  await assertPrivateDirectory(workDirectory);
  const filePath = path.join(workDirectory, STATE_FILE);
  await assertPrivateRegularFile(filePath);
  let textValue: string;
  try {
    textValue = await fs.readFile(filePath, 'utf8');
  } catch {
    return fail('EBAY_ROTATION_STATE_INVALID');
  }
  if (Buffer.byteLength(textValue, 'utf8') > 32_768) fail('EBAY_ROTATION_STATE_INVALID');
  try {
    return parseConsentRecord(JSON.parse(textValue));
  } catch (error) {
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_STATE_INVALID');
  }
}

async function writeConsentRecord(
  workDirectory: string,
  record: ConsentRecord,
  dependencies?: EbayRotationDependencies,
): Promise<void> {
  const filePath = path.join(workDirectory, STATE_FILE);
  await replacePrivateFile(filePath, `${JSON.stringify(record)}\n`, dependencies);
}

function parseOperationLock(value: unknown): OperationLockRecord {
  if (!isRecord(value) || !hasExactKeys(value, LOCK_KEYS)
    || value.schemaVersion !== 1
    || value.kind !== 'product-pipeline-ebay-credential-operation-lock'
    || typeof value.ownerId !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.ownerId)
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.createdAtUtc !== 'string'
    || typeof value.expiresAtUtc !== 'string') {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  let created: number;
  let expires: number;
  try {
    created = new Date(value.createdAtUtc).getTime();
    expires = new Date(value.expiresAtUtc).getTime();
    if (new Date(created).toISOString() !== value.createdAtUtc
      || new Date(expires).toISOString() !== value.expiresAtUtc) {
      fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
    }
  } catch (error) {
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  if (expires - created !== OPERATION_LOCK_TTL_MS) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'product-pipeline-ebay-credential-operation-lock',
    ownerId: value.ownerId,
    pid: value.pid as number,
    createdAtUtc: value.createdAtUtc,
    expiresAtUtc: value.expiresAtUtc,
  });
}

async function readOperationLock(lockPath: string): Promise<OperationLockRecord> {
  await assertPrivateRegularFile(lockPath);
  const body = await fs.readFile(lockPath, 'utf8').catch(() => '');
  if (Buffer.byteLength(body, 'utf8') > 4_096) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  try {
    return parseOperationLock(JSON.parse(body));
  } catch (error) {
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
}

function exactOpaqueValue(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

async function withOperationLock<T extends EbayRotationResult>(
  workDirectory: string,
  dependencies: EbayRotationDependencies | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  await assertPrivateDirectory(workDirectory);
  const lockDirectory = path.dirname(workDirectory);
  await assertPrivateDirectory(lockDirectory);
  const lockPath = path.join(lockDirectory, LOCK_FILE);
  const now = (dependencies?.now ?? (() => new Date()))();
  const createdAtUtc = canonicalTime(now);
  const ownerId = randomBytes(32).toString('base64url');
  const lockRecord: OperationLockRecord = Object.freeze({
    schemaVersion: 1,
    kind: 'product-pipeline-ebay-credential-operation-lock',
    ownerId,
    pid: process.pid,
    createdAtUtc,
    expiresAtUtc: canonicalTime(new Date(now.getTime() + OPERATION_LOCK_TTL_MS)),
  });
  const lock = await fs.open(lockPath, 'wx', 0o600).catch(() => null);
  if (!lock) fail('EBAY_ROTATION_LOCKED');
  try {
    await lock.writeFile(`${JSON.stringify(lockRecord)}\n`, { encoding: 'utf8' });
    await lock.sync();
    await lock.close();
    await fs.chmod(lockPath, 0o600);
    await syncPrivateRegularFile(lockPath);
    await assertPrivateRegularFile(lockPath);
    await syncPrivateDirectory(lockDirectory, dependencies, 'lock-create');
  } catch (error) {
    await lock.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseFailed = false;
  try {
    await dependencies?.beforeLockRelease?.();
    const current = await readOperationLock(lockPath);
    if (!exactOpaqueValue(current.ownerId, ownerId)
      || current.pid !== process.pid
      || current.createdAtUtc !== createdAtUtc) {
      fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
    }
    await fs.unlink(lockPath);
    await syncPrivateDirectory(lockDirectory, dependencies, 'lock-release');
  } catch {
    releaseFailed = true;
  }

  if (releaseFailed) {
    const priorEffects = result
      ? Object.freeze({
          databaseRowsChanged: result.databaseRowsChanged,
          credentialProviderMutation: result.credentialProviderMutation,
          reconciliationRequired: true,
        })
      : operationError instanceof EbayRotationError
        ? Object.freeze({ ...operationError.effects, reconciliationRequired: true })
        : Object.freeze({ ...NO_FAILURE_EFFECTS, reconciliationRequired: true });
    return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', priorEffects);
  }
  if (operationError !== undefined) throw operationError;
  return result!;
}

function callbackResult(secretInput: string): { code: string; state: string } {
  if (typeof secretInput !== 'string' || secretInput.length === 0 || secretInput.length > 8_192
    || /[\u0000\r\n]/u.test(secretInput)) {
    fail('EBAY_ROTATION_AUTH_RESULT_INVALID');
  }
  let callback: URL;
  try {
    callback = new URL(secretInput);
  } catch {
    return fail('EBAY_ROTATION_AUTH_RESULT_INVALID');
  }
  if (callback.protocol !== 'https:' || callback.username !== '' || callback.password !== ''
    || callback.hash !== '') {
    fail('EBAY_ROTATION_AUTH_RESULT_INVALID');
  }
  const entries = [...callback.searchParams.entries()];
  const allowed = new Set(['code', 'state', 'expires_in']);
  if (entries.length !== 3 || entries.some(([key]) => !allowed.has(key))
    || [...allowed].some((key) => callback.searchParams.getAll(key).length !== 1)) {
    fail('EBAY_ROTATION_AUTH_RESULT_INVALID');
  }
  const code = callback.searchParams.get('code');
  const state = callback.searchParams.get('state');
  const expiresRaw = callback.searchParams.get('expires_in');
  const expiresIn = expiresRaw && /^\d{1,3}$/u.test(expiresRaw) ? Number(expiresRaw) : 0;
  if (!code || code.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(code)
    || !state || !/^[A-Za-z0-9_-]{43}$/u.test(state)
    || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 300) {
    fail('EBAY_ROTATION_AUTH_RESULT_INVALID');
  }
  return { code, state };
}

function stateMatches(actualState: string, expectedDigest: string): boolean {
  const actual = Buffer.from(sha256(actualState).slice('sha256:'.length), 'hex');
  const expected = Buffer.from(expectedDigest.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createBoundedEbayProviderTransport(
  fetchImplementation: typeof fetch = fetch,
): EbayProviderTransport {
  return async (request: EbayProviderRequest): Promise<EbayProviderResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const response = await fetchImplementation(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: controller.signal,
      });
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) {
        if (!/^\d+$/u.test(contentLength)
          || Number(contentLength) > PROVIDER_RESPONSE_LIMIT) {
          await response.body?.cancel().catch(() => undefined);
          fail('EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
        }
      }
      if (!response.body) return Object.freeze({ status: response.status, bodyText: '' });
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.byteLength;
        if (received > PROVIDER_RESPONSE_LIMIT) {
          await reader.cancel().catch(() => undefined);
          fail('EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return Object.freeze({ status: response.status, bodyText });
    } catch (error) {
      if (error instanceof EbayRotationError) throw error;
      return fail('EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
    } finally {
      clearTimeout(timeout);
    }
  };
}

const defaultTransport = createBoundedEbayProviderTransport();

function basic(credentials: Required<EbayRotationCredentials>): string {
  return `Basic ${Buffer.from(`${credentials.appId}:${credentials.newCertId}`, 'utf8').toString('base64')}`;
}

async function providerJson(
  transport: EbayProviderTransport,
  request: EbayProviderRequest,
  failureCode: EbayRotationErrorCode,
): Promise<Record<string, unknown>> {
  let response: EbayProviderResponse;
  try {
    response = await transport(request);
  } catch (error) {
    if (error instanceof EbayRotationError) throw error;
    return fail(failureCode);
  }
  if (response.status !== 200 || typeof response.bodyText !== 'string'
    || Buffer.byteLength(response.bodyText, 'utf8') > PROVIDER_RESPONSE_LIMIT) {
    fail(failureCode);
  }
  try {
    const parsed: unknown = JSON.parse(response.bodyText);
    if (!isRecord(parsed)) fail(failureCode);
    return parsed;
  } catch (error) {
    if (error instanceof EbayRotationError) throw error;
    return fail(failureCode);
  }
}

async function exchangeAuthorizationCode(
  transport: EbayProviderTransport,
  credentials: Required<EbayRotationCredentials>,
  code: string,
  now: Date,
): Promise<Grant> {
  const response = await providerJson(transport, {
    method: 'POST',
    url: TOKEN_URL,
    headers: Object.freeze({
      Authorization: basic(credentials),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: credentials.ruName,
    }).toString(),
  }, 'EBAY_ROTATION_PROVIDER_EXCHANGE_FAILED');
  const accessToken = safeText(response.access_token, 16_384);
  const refreshToken = safeText(response.refresh_token, 16_384);
  const expiresIn = response.expires_in;
  if (response.token_type !== 'User Access Token'
    || !Number.isInteger(expiresIn) || (expiresIn as number) < 300 || (expiresIn as number) > 86_400) {
    fail('EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
  }
  if (response.scope !== undefined && !exactScopeSet(response.scope)) {
    fail('EBAY_ROTATION_PROVIDER_SCOPE_MISMATCH');
  }
  return Object.freeze({
    accessToken,
    refreshToken,
    accessExpiresAt: Math.floor(now.getTime() / 1_000) + (expiresIn as number),
    scope: canonicalScopeString(EBAY_PRODUCTION_SCOPES),
  });
}

async function introspect(
  transport: EbayProviderTransport,
  credentials: Required<EbayRotationCredentials>,
  token: string,
  hint: 'access_token' | 'refresh_token',
): Promise<Record<string, unknown>> {
  return providerJson(transport, {
    method: 'POST',
    url: INTROSPECTION_URL,
    headers: Object.freeze({
      Authorization: basic(credentials),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }),
    body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
  }, 'EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
}

function audienceIsProduction(value: unknown): boolean {
  if (value === 'https://api.ebay.com') return true;
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry === 'https://api.ebay.com');
}

function validateActiveIntrospection(
  value: Record<string, unknown>,
  credentials: Required<EbayRotationCredentials>,
): void {
  if (value.active !== true || value.client_id !== credentials.appId) {
    fail('EBAY_ROTATION_PROVIDER_ENVIRONMENT_MISMATCH');
  }
  if (!exactScopeSet(value.scope)) fail('EBAY_ROTATION_PROVIDER_SCOPE_MISMATCH');
  if (!audienceIsProduction(value.aud)) fail('EBAY_ROTATION_PROVIDER_ENVIRONMENT_MISMATCH');
  if (typeof value.username === 'string'
    && value.username.toLocaleLowerCase('en-US') !== EBAY_ROTATION_SELLER) {
    fail('EBAY_ROTATION_PROVIDER_IDENTITY_MISMATCH');
  }
}

async function validateTradingSeller(
  transport: EbayProviderTransport,
  accessToken: string,
): Promise<void> {
  const response = await transport({
    method: 'POST',
    url: TRADING_URL,
    headers: Object.freeze({
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-CALL-NAME': 'GetUser',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
    }),
    body: '<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"><DetailLevel>ReturnSummary</DetailLevel></GetUserRequest>',
  }).catch(() => null);
  if (!response || response.status !== 200
    || Buffer.byteLength(response.bodyText, 'utf8') > PROVIDER_RESPONSE_LIMIT) {
    fail('EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(response.bodyText)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(response.bodyText)) {
    fail('EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  }
  let parsed: unknown;
  try {
    parsed = await parseStringPromise(response.bodyText, {
      explicitArray: false,
      explicitRoot: true,
      trim: true,
      normalizeTags: false,
    });
  } catch {
    return fail('EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  }
  if (!isRecord(parsed) || !isRecord(parsed.GetUserResponse)) {
    fail('EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  }
  const root = parsed.GetUserResponse;
  if (root.Ack !== 'Success' || root.Errors !== undefined || !isRecord(root.User)) {
    fail('EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  }
  const seller = root.User.UserID;
  if (typeof seller !== 'string'
    || seller.toLocaleLowerCase('en-US') !== EBAY_ROTATION_SELLER) {
    fail('EBAY_ROTATION_PROVIDER_IDENTITY_MISMATCH');
  }
}

async function validateInventoryScope(
  transport: EbayProviderTransport,
  accessToken: string,
): Promise<void> {
  const value = await providerJson(transport, {
    method: 'GET',
    url: INVENTORY_PROBE_URL,
    headers: Object.freeze({
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
    }),
  }, 'EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  if (!Number.isInteger(value.total) || (value.total as number) < 0) {
    fail('EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED');
  }
}

async function validateGrant(
  transport: EbayProviderTransport,
  credentials: Required<EbayRotationCredentials>,
  grant: Grant,
): Promise<void> {
  const [accessMetadata, refreshMetadata] = await Promise.all([
    introspect(transport, credentials, grant.accessToken, 'access_token'),
    introspect(transport, credentials, grant.refreshToken, 'refresh_token'),
  ]);
  validateActiveIntrospection(accessMetadata, credentials);
  validateActiveIntrospection(refreshMetadata, credentials);
  await validateTradingSeller(transport, grant.accessToken);
  await validateInventoryScope(transport, grant.accessToken);
}

async function revokeGrant(
  transport: EbayProviderTransport,
  credentials: Required<EbayRotationCredentials>,
  refreshToken: string,
): Promise<void> {
  let response: EbayProviderResponse;
  try {
    response = await transport({
      method: 'POST',
      url: REVOCATION_URL,
      headers: Object.freeze({
        Authorization: basic(credentials),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      }),
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
    });
  } catch {
    return fail('EBAY_ROTATION_REVOCATION_FAILED');
  }
  if (response.status !== 200 || response.bodyText.trim() !== '') {
    fail('EBAY_ROTATION_REVOCATION_FAILED');
  }
  const after = await introspect(transport, credentials, refreshToken, 'refresh_token');
  if (after.active !== false) fail('EBAY_ROTATION_REVOCATION_FAILED');
}

function validateAuthRow(value: unknown): AuthTokenRow {
  if (!isRecord(value)
    || !Number.isInteger(value.id) || (value.id as number) <= 0
    || typeof value.platform !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.platform)
    || typeof value.access_token !== 'string' || value.access_token.length === 0
    || value.access_token.length > 16_384
    || !(value.refresh_token === null
      || (typeof value.refresh_token === 'string' && value.refresh_token.length <= 16_384))
    || !(value.scope === null || (typeof value.scope === 'string' && value.scope.length <= 4_096))
    || !(value.expires_at === null || Number.isInteger(value.expires_at))
    || !Number.isInteger(value.created_at) || !Number.isInteger(value.updated_at)) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  return Object.freeze({
    id: value.id as number,
    platform: value.platform,
    access_token: value.access_token,
    refresh_token: value.refresh_token as string | null,
    scope: value.scope as string | null,
    expires_at: value.expires_at as number | null,
    created_at: value.created_at as number,
    updated_at: value.updated_at as number,
  });
}

function readAuthRows(database: InstanceType<typeof Database>): readonly AuthTokenRow[] {
  const raw = database.prepare(
    `SELECT id, platform, access_token, refresh_token, scope, expires_at, created_at, updated_at
     FROM auth_tokens ORDER BY id`,
  ).all();
  if (raw.length > 64) fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  const rows = raw.map(validateAuthRow);
  if (rows.filter((row) => row.platform === 'ebay').length > 1
    || new Set(rows.map((row) => row.platform)).size !== rows.length) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  return Object.freeze(rows);
}

function sameRows(left: readonly AuthTokenRow[], right: readonly AuthTokenRow[]): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return other !== undefined
      && row.id === other.id
      && row.platform === other.platform
      && row.access_token === other.access_token
      && row.refresh_token === other.refresh_token
      && row.scope === other.scope
      && row.expires_at === other.expires_at
      && row.created_at === other.created_at
      && row.updated_at === other.updated_at;
  });
}

function verifyDatabaseShape(database: InstanceType<typeof Database>): void {
  const quick = database.pragma('quick_check') as Array<Record<string, unknown>>;
  if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  const objects = database.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'auth_tokens' ORDER BY type, name",
  ).all() as Array<Record<string, unknown>>;
  if (objects.filter((entry) => entry.type === 'table' && entry.name === 'auth_tokens').length !== 1
    || objects.some((entry) => !['table', 'index'].includes(entry.type as string))) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  const tableSql = objects.find(
    (entry) => entry.type === 'table' && entry.name === 'auth_tokens',
  )?.sql;
  const normalizeSql = (value: string) => value
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim()
    .toLocaleLowerCase('en-US');
  const expectedTableSql = `CREATE TABLE auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    scope TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`;
  if (typeof tableSql !== 'string'
    || normalizeSql(tableSql) !== normalizeSql(expectedTableSql)) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }

  const columns = database.pragma('table_info(auth_tokens)') as Array<Record<string, unknown>>;
  const expectedColumns = Object.freeze([
    Object.freeze({ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }),
    Object.freeze({ cid: 1, name: 'platform', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }),
    Object.freeze({ cid: 2, name: 'access_token', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }),
    Object.freeze({ cid: 3, name: 'refresh_token', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }),
    Object.freeze({ cid: 4, name: 'scope', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }),
    Object.freeze({ cid: 5, name: 'expires_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 }),
    Object.freeze({ cid: 6, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: 'unixepoch()', pk: 0 }),
    Object.freeze({ cid: 7, name: 'updated_at', type: 'INTEGER', notnull: 1, dflt_value: 'unixepoch()', pk: 0 }),
  ]);
  if (columns.length !== expectedColumns.length
    || columns.some((column, index) => {
      const expected = expectedColumns[index]!;
      return !hasExactKeys(column, ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'])
        || Object.entries(expected).some(([key, value]) => column[key] !== value);
    })) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }

  const indexes = database.pragma('index_list(auth_tokens)') as Array<Record<string, unknown>>;
  if (indexes.length !== 1) fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  const platformIndex = indexes[0]!;
  if (!hasExactKeys(platformIndex, ['seq', 'name', 'unique', 'origin', 'partial'])
    || platformIndex.unique !== 1
    || platformIndex.origin !== 'u'
    || platformIndex.partial !== 0
    || typeof platformIndex.name !== 'string') {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  const indexColumns = database.pragma(
    `index_info(${JSON.stringify(platformIndex.name)})`,
  ) as Array<Record<string, unknown>>;
  if (indexColumns.length !== 1
    || !hasExactKeys(indexColumns[0]!, ['seqno', 'cid', 'name'])
    || indexColumns[0]?.seqno !== 0
    || indexColumns[0]?.cid !== 1
    || indexColumns[0]?.name !== 'platform') {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }

  const triggers = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'auth_tokens'",
  ).all();
  if (triggers.length !== 0) fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
}

async function assertExistingDatabase(
  databasePath: string,
): Promise<Readonly<{ device: number; inode: number }>> {
  const exact = assertAbsolute(databasePath);
  let stat;
  try {
    stat = await fs.lstat(exact);
  } catch {
    return fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || mode(stat) !== 0o600) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  const resolved = await fs.realpath(exact).catch(() => '');
  if (resolved !== exact) fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)
    || stat.dev < 0 || stat.ino <= 0) {
    fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function openReadOnlyDatabase(databasePath: string): InstanceType<typeof Database> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    if (database.pragma('query_only', { simple: true }) !== 1) {
      throw new Error('query-only');
    }
    verifyDatabaseShape(database);
    return database;
  } catch {
    database.close();
    return fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
}

async function assertLedgerMatchesPrivateBackup(input: {
  databasePath: string;
  backupDirectory: string;
  installation: InstallationBinding | null;
}): Promise<void> {
  try {
    const databasePath = assertAbsolute(input.databasePath);
    const backupDirectory = assertAbsolute(input.backupDirectory);
    const installation = input.installation;
    if (!installation
      || databasePath !== installation.databasePath
      || installation.rowId !== null
      || installation.committedAtUtc !== null
      || installation.accessTokenDigest === null
      || installation.refreshTokenDigest === null) {
      fail('EBAY_ROTATION_RECONCILIATION_DENIED');
    }
    await assertExistingDatabase(databasePath);
    await assertPrivateDirectory(backupDirectory);
    const backupPath = path.join(backupDirectory, installation.backupFileName);
    if (path.dirname(backupPath) !== backupDirectory) {
      fail('EBAY_ROTATION_RECONCILIATION_DENIED');
    }
    await assertPrivateRegularFile(backupPath);

    let current: InstanceType<typeof Database> | null = null;
    let backup: InstanceType<typeof Database> | null = null;
    try {
      current = openReadOnlyDatabase(databasePath);
      backup = openReadOnlyDatabase(backupPath);
      const currentRows = readAuthRows(current);
      const backupRows = readAuthRows(backup);
      const currentForeignKeys = current.pragma(
        'foreign_key_check',
      ) as Array<Record<string, unknown>>;
      const backupForeignKeys = backup.pragma(
        'foreign_key_check',
      ) as Array<Record<string, unknown>>;
      const baselineEbay = backupRows.find((row) => row.platform === 'ebay');
      if (!sameRows(currentRows, backupRows)
        || currentForeignKeys.length !== 0
        || backupForeignKeys.length !== 0
        || (baselineEbay !== undefined
          && baselineEbay.updated_at >= installation.expectedUpdatedAt)) {
        fail('EBAY_ROTATION_RECONCILIATION_DENIED');
      }
    } finally {
      current?.close();
      backup?.close();
    }
  } catch (error) {
    if (error instanceof EbayRotationError
      && error.code === 'EBAY_ROTATION_RECONCILIATION_DENIED') {
      throw error;
    }
    fail('EBAY_ROTATION_RECONCILIATION_DENIED');
  }
}

function backupName(now: Date, random: (size: number) => Buffer): string {
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  return `ebaysync-before-ebay-grant-${stamp}-${random(6).toString('hex')}.sqlite`;
}

async function prepareLedgerInstallation(input: {
  databasePath: string;
  backupDirectory: string;
  now: Date;
  random: (size: number) => Buffer;
  dependencies?: EbayRotationDependencies;
}): Promise<LedgerPreparation> {
  const databasePath = assertAbsolute(input.databasePath);
  const backupDirectory = assertAbsolute(input.backupDirectory);
  const databaseIdentity = await assertExistingDatabase(databasePath);
  await ensurePrivateDirectory(backupDirectory, input.dependencies);

  const source = openReadOnlyDatabase(databasePath);
  let baselineRows: readonly AuthTokenRow[];
  try {
    baselineRows = readAuthRows(source);
  } catch (error) {
    source.close();
    if (error instanceof EbayRotationError) throw error;
    return fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  const existing = baselineRows.find((row) => row.platform === 'ebay');
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  const expectedUpdatedAt = Math.max(nowSeconds, (existing?.updated_at ?? 0) + 1);
  const name = backupName(input.now, input.random);
  const backupPath = path.join(backupDirectory, name);
  try {
    await writeNewPrivateFile(backupPath, '', input.dependencies);
  } catch {
    source.close();
    return fail('EBAY_ROTATION_DATABASE_BACKUP_FAILED');
  }
  const priorUmask = process.umask(0o077);
  try {
    await source.backup(backupPath);
  } catch {
    await fs.unlink(backupPath).catch(() => undefined);
    return fail('EBAY_ROTATION_DATABASE_BACKUP_FAILED');
  } finally {
    process.umask(priorUmask);
    source.close();
  }
  try {
    await fs.chmod(backupPath, 0o600);
    await syncPrivateRegularFile(backupPath);
    await syncPrivateDirectory(backupDirectory, input.dependencies, 'backup-finalize');
    await assertPrivateRegularFile(backupPath);
    const backup = openReadOnlyDatabase(backupPath);
    try {
      if (!sameRows(readAuthRows(backup), baselineRows)) {
        fail('EBAY_ROTATION_DATABASE_BACKUP_FAILED');
      }
    } finally {
      backup.close();
    }
  } catch (error) {
    if (error instanceof EbayRotationError
      && error.code === 'EBAY_ROTATION_DATABASE_BACKUP_FAILED') throw error;
    return fail('EBAY_ROTATION_DATABASE_BACKUP_FAILED');
  }
  const identityAfterBackup = await assertExistingDatabase(databasePath);
  if (identityAfterBackup.device !== databaseIdentity.device
    || identityAfterBackup.inode !== databaseIdentity.inode) {
    return fail('EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED');
  }
  return Object.freeze({
    databasePath,
    databaseDevice: databaseIdentity.device,
    databaseInode: databaseIdentity.inode,
    backupFileName: name,
    backupPath,
    expectedUpdatedAt,
    baselineRows,
  });
}

async function commitLedgerGrant(
  preparation: LedgerPreparation,
  grant: Grant,
  beforeLedgerCas?: () => void | Promise<void>,
  afterCommitAppliedBeforeResult?: () => void | Promise<void>,
): Promise<LedgerCommitResult> {
  await beforeLedgerCas?.();
  const databaseIdentity = await assertExistingDatabase(preparation.databasePath);
  if (databaseIdentity.device !== preparation.databaseDevice
    || databaseIdentity.inode !== preparation.databaseInode) {
    fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
  }
  const database = new Database(preparation.databasePath, { fileMustExist: true });
  let rowId: number | null = null;
  let commitAttempted = false;
  let commitError = false;
  let operationError: unknown;
  try {
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    verifyDatabaseShape(database);
    database.exec('BEGIN IMMEDIATE');
    const currentRows = readAuthRows(database);
    if (!sameRows(currentRows, preparation.baselineRows)) {
      fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
    }
    const existing = currentRows.find((row) => row.platform === 'ebay');
    if (existing) {
      const result = database.prepare(
        `UPDATE auth_tokens
         SET access_token = ?, refresh_token = ?, scope = ?, expires_at = ?, updated_at = ?
         WHERE id = ? AND platform = 'ebay'`,
      ).run(
        grant.accessToken,
        grant.refreshToken,
        grant.scope,
        grant.accessExpiresAt,
        preparation.expectedUpdatedAt,
        existing.id,
      );
      if (result.changes !== 1) fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
      rowId = existing.id;
    } else {
      const result = database.prepare(
        `INSERT INTO auth_tokens (
           platform, access_token, refresh_token, scope, expires_at, created_at, updated_at
         ) VALUES ('ebay', ?, ?, ?, ?, ?, ?)`,
      ).run(
        grant.accessToken,
        grant.refreshToken,
        grant.scope,
        grant.accessExpiresAt,
        preparation.expectedUpdatedAt,
        preparation.expectedUpdatedAt,
      );
      const lastInsertRowid = Number(result.lastInsertRowid);
      if (result.changes !== 1 || !Number.isSafeInteger(lastInsertRowid)
        || lastInsertRowid <= 0) {
        fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
      }
      rowId = lastInsertRowid;
    }

    const after = readAuthRows(database);
    const installed = after.find((row) => row.platform === 'ebay');
    const unrelatedBefore = currentRows.filter((row) => row.platform !== 'ebay');
    const unrelatedAfter = after.filter((row) => row.platform !== 'ebay');
    if (!installed || installed.id !== rowId
      || installed.access_token !== grant.accessToken
      || installed.refresh_token !== grant.refreshToken
      || installed.scope !== grant.scope
      || installed.expires_at !== grant.accessExpiresAt
      || installed.updated_at !== preparation.expectedUpdatedAt
      || !sameRows(unrelatedBefore, unrelatedAfter)
      || after.length !== currentRows.length + (existing ? 0 : 1)) {
      fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
    }
    const quick = database.pragma('quick_check') as Array<Record<string, unknown>>;
    const foreignKeys = database.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok' || foreignKeys.length !== 0) {
      fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
    }
    commitAttempted = true;
    try {
      database.exec('COMMIT');
      await afterCommitAppliedBeforeResult?.();
    } catch {
      commitError = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (!commitAttempted && operationError !== undefined) {
    try { database.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
  }
  try {
    database.close();
  } catch {
    if (commitAttempted) commitError = true;
    else if (operationError === undefined) operationError = new Error('database close failed');
  }
  if (operationError !== undefined) {
    if (operationError instanceof EbayRotationError) throw operationError;
    return fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
  }
  if (rowId === null) return fail('EBAY_ROTATION_DATABASE_CAS_FAILED');
  if (commitError) {
    return classifyCommitError(preparation, grant, rowId);
  }
  return Object.freeze({ outcome: 'committed', rowId });
}

async function classifyCommitError(
  preparation: LedgerPreparation,
  grant: Grant,
  rowId: number,
): Promise<LedgerCommitResult> {
  try {
    const identity = await assertExistingDatabase(preparation.databasePath);
    if (identity.device !== preparation.databaseDevice
      || identity.inode !== preparation.databaseInode) {
      return Object.freeze({ outcome: 'commit-error-unknown' });
    }
    const database = openReadOnlyDatabase(preparation.databasePath);
    try {
      const rows = readAuthRows(database);
      const foreignKeys = database.pragma('foreign_key_check') as Array<Record<string, unknown>>;
      const installed = rows.find((row) => row.platform === 'ebay');
      const unrelatedBaseline = preparation.baselineRows
        .filter((row) => row.platform !== 'ebay');
      const unrelatedAfter = rows.filter((row) => row.platform !== 'ebay');
      if (installed?.id === rowId
        && installed.access_token === grant.accessToken
        && installed.refresh_token === grant.refreshToken
        && installed.scope === grant.scope
        && installed.expires_at === grant.accessExpiresAt
        && installed.updated_at === preparation.expectedUpdatedAt
        && sameRows(unrelatedBaseline, unrelatedAfter)
        && foreignKeys.length === 0) {
        return Object.freeze({ outcome: 'commit-error-committed', rowId });
      }
      if (sameRows(rows, preparation.baselineRows) && foreignKeys.length === 0) {
        return Object.freeze({ outcome: 'commit-error-baseline' });
      }
      return Object.freeze({ outcome: 'commit-error-unknown' });
    } finally {
      database.close();
    }
  } catch {
    return Object.freeze({ outcome: 'commit-error-unknown' });
  }
}

function requireBoundRow(
  databasePath: string,
  binding: InstallationBinding,
  allowCommitPendingRowId = false,
): AuthTokenRow {
  if (assertAbsolute(databasePath) !== binding.databasePath) {
    fail('EBAY_ROTATION_GRANT_BINDING_MISMATCH');
  }
  const database = openReadOnlyDatabase(databasePath);
  try {
    const rows = readAuthRows(database);
    const ebay = rows.find((row) => row.platform === 'ebay');
    if (!ebay || ebay.updated_at !== binding.expectedUpdatedAt
      || (binding.rowId === null
        ? !allowCommitPendingRowId
        : ebay.id !== binding.rowId)
      || binding.accessTokenDigest === null || binding.refreshTokenDigest === null
      || !digestMatchesToken('access', ebay.access_token, binding.accessTokenDigest)
      || !ebay.refresh_token
      || !digestMatchesToken('refresh', ebay.refresh_token, binding.refreshTokenDigest)
      || ebay.scope !== canonicalScopeString(EBAY_PRODUCTION_SCOPES)) {
      fail('EBAY_ROTATION_GRANT_BINDING_MISMATCH');
    }
    return ebay;
  } finally {
    database.close();
  }
}

async function verifyCommittedReadback(
  preparation: LedgerPreparation,
  grant: Grant,
  rowId: number,
): Promise<void> {
  const database = openReadOnlyDatabase(preparation.databasePath);
  try {
    const rows = readAuthRows(database);
    const installed = rows.find((row) => row.platform === 'ebay');
    const unrelatedBaseline = preparation.baselineRows.filter((row) => row.platform !== 'ebay');
    const unrelatedAfter = rows.filter((row) => row.platform !== 'ebay');
    if (!installed || installed.id !== rowId
      || installed.access_token !== grant.accessToken
      || installed.refresh_token !== grant.refreshToken
      || installed.scope !== grant.scope
      || installed.expires_at !== grant.accessExpiresAt
      || installed.updated_at !== preparation.expectedUpdatedAt
      || !sameRows(unrelatedBaseline, unrelatedAfter)) {
      fail('EBAY_ROTATION_DATABASE_READBACK_FAILED');
    }
  } finally {
    database.close();
  }
}

function recordWith(
  record: ConsentRecord,
  update: Partial<Pick<ConsentRecord,
    'status' | 'databaseEffect' | 'consumedAtUtc' | 'installation' | 'terminalCode'>>,
): ConsentRecord {
  return Object.freeze({ ...record, ...update });
}

export async function beginEbayProductionConsent(input: {
  workDirectory: string;
  credentials: EbayRotationCredentials;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  assertCredentials(input.credentials, false);
  const now = (input.dependencies?.now ?? (() => new Date()))();
  const random = input.dependencies?.randomBytes ?? randomBytes;
  const workDirectory = assertAbsolute(input.workDirectory);
  await createPrivateDirectory(workDirectory, input.dependencies);
  const state = random(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) fail('EBAY_ROTATION_STATE_INVALID');
  const createdAtUtc = canonicalTime(now);
  const expiresAtUtc = canonicalTime(new Date(now.getTime() + CONSENT_STATE_TTL_MS));
  const consent = new URL(CONSENT_URL);
  consent.searchParams.set('client_id', input.credentials.appId);
  consent.searchParams.set('response_type', 'code');
  consent.searchParams.set('redirect_uri', input.credentials.ruName);
  consent.searchParams.set('scope', EBAY_PRODUCTION_SCOPES.join(' '));
  consent.searchParams.set('state', state);
  const stateDigest = sha256(state);
  const record: ConsentRecord = Object.freeze({
    schemaVersion: 2,
    kind: 'product-pipeline-ebay-production-consent',
    environment: EBAY_ROTATION_ENVIRONMENT,
    seller: EBAY_ROTATION_SELLER,
    marketplaceId: EBAY_ROTATION_MARKETPLACE,
    scopes: Object.freeze([...EBAY_PRODUCTION_SCOPES]),
    scopesDigest: sha256(canonicalScopeString(EBAY_PRODUCTION_SCOPES)),
    stateDigest,
    requestDigest: consentRequestDigest(input.credentials, stateDigest),
    consentArtifact: 'co-located',
    createdAtUtc,
    expiresAtUtc,
    status: 'pending',
    databaseEffect: 'none',
    consumedAtUtc: null,
    installation: null,
    terminalCode: null,
  });
  try {
    await writeNewPrivateFile(
      path.join(workDirectory, STATE_FILE),
      `${JSON.stringify(record)}\n`,
      input.dependencies,
    );
    await writeNewPrivateFile(
      path.join(workDirectory, CONSENT_FILE),
      `${consent.toString()}\n`,
      input.dependencies,
    );
  } catch (error) {
    await fs.unlink(path.join(workDirectory, CONSENT_FILE)).catch(() => undefined);
    await fs.unlink(path.join(workDirectory, STATE_FILE)).catch(() => undefined);
    if (error instanceof EbayRotationError) throw error;
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  return fixedResult('EBAY_CONSENT_PREPARED');
}

export async function registerEbayProductionConsent(input: {
  workDirectory: string;
  stateDigest: string;
  requestDigest: string;
  credentials: EbayRotationCredentials;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  assertCredentials(input.credentials, false);
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.stateDigest)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.requestDigest)
    || consentRequestDigest(input.credentials, input.stateDigest) !== input.requestDigest) {
    fail('EBAY_ROTATION_STATE_INVALID');
  }
  const now = (input.dependencies?.now ?? (() => new Date()))();
  const workDirectory = assertAbsolute(input.workDirectory);
  await createPrivateDirectory(workDirectory, input.dependencies);
  const record: ConsentRecord = Object.freeze({
    schemaVersion: 2,
    kind: 'product-pipeline-ebay-production-consent',
    environment: EBAY_ROTATION_ENVIRONMENT,
    seller: EBAY_ROTATION_SELLER,
    marketplaceId: EBAY_ROTATION_MARKETPLACE,
    scopes: Object.freeze([...EBAY_PRODUCTION_SCOPES]),
    scopesDigest: sha256(canonicalScopeString(EBAY_PRODUCTION_SCOPES)),
    stateDigest: input.stateDigest,
    requestDigest: input.requestDigest,
    consentArtifact: 'external',
    createdAtUtc: canonicalTime(now),
    expiresAtUtc: canonicalTime(new Date(now.getTime() + CONSENT_STATE_TTL_MS)),
    status: 'pending',
    databaseEffect: 'none',
    consumedAtUtc: null,
    installation: null,
    terminalCode: null,
  });
  await writeNewPrivateFile(
    path.join(workDirectory, STATE_FILE),
    `${JSON.stringify(record)}\n`,
    input.dependencies,
  );
  return fixedResult('EBAY_CONSENT_REGISTERED');
}

export async function archiveAndResetEbayProductionConsent(input: {
  workDirectory: string;
  archiveDirectory: string;
  databasePath: string;
  backupDirectory: string;
  stateDigest: string;
  requestDigest: string;
  confirmation: string;
  credentials: EbayRotationCredentials;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  assertCredentials(input.credentials, false);
  if (input.confirmation !== EBAY_RECONCILIATION_RESET_CONFIRMATION
    || !/^sha256:[0-9a-f]{64}$/u.test(input.stateDigest)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.requestDigest)
    || consentRequestDigest(input.credentials, input.stateDigest) !== input.requestDigest) {
    fail('EBAY_ROTATION_RECONCILIATION_DENIED');
  }
  const workDirectory = assertAbsolute(input.workDirectory);
  const archiveDirectory = assertAbsolute(input.archiveDirectory);
  const maintenanceDirectory = path.dirname(workDirectory);
  if (path.dirname(archiveDirectory) !== maintenanceDirectory
    || archiveDirectory === workDirectory) {
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  return withOperationLock(workDirectory, input.dependencies, async () => {
    const prior = await readConsentRecord(workDirectory);
    const failedBeforeCommit = ['failed-no-provider-effect', 'failed-revoked',
      'failed-cleanup-required'].includes(prior.status)
      && prior.databaseEffect === 'none';
    const commitErrorAtBaseline = prior.status === 'commit-outcome-reconciliation-required'
      && prior.databaseEffect === 'commit-pending';
    if ((!failedBeforeCommit && !commitErrorAtBaseline) || prior.terminalCode === null) {
      fail('EBAY_ROTATION_RECONCILIATION_DENIED');
    }
    if (commitErrorAtBaseline) {
      await assertLedgerMatchesPrivateBackup({
        databasePath: input.databasePath,
        backupDirectory: input.backupDirectory,
        installation: prior.installation,
      });
    }

    const nowProvider = input.dependencies?.now ?? (() => new Date());
    const now = nowProvider();
    const random = input.dependencies?.randomBytes ?? randomBytes;
    await ensurePrivateDirectory(archiveDirectory, input.dependencies);
    const suffix = random(12).toString('hex');
    if (!/^[0-9a-f]{24}$/u.test(suffix)) fail('EBAY_ROTATION_STATE_INVALID');
    const archiveContainer = path.join(
      archiveDirectory,
      `ebay-consent-${now.toISOString().replace(/[:.]/gu, '-')}-${suffix}`,
    );
    const stagingDirectory = path.join(maintenanceDirectory, `.ebay-reset-${suffix}`);
    await createPrivateDirectory(archiveContainer, input.dependencies);
    await createPrivateDirectory(stagingDirectory, input.dependencies);
    const fresh: ConsentRecord = Object.freeze({
      schemaVersion: 2,
      kind: 'product-pipeline-ebay-production-consent',
      environment: EBAY_ROTATION_ENVIRONMENT,
      seller: EBAY_ROTATION_SELLER,
      marketplaceId: EBAY_ROTATION_MARKETPLACE,
      scopes: Object.freeze([...EBAY_PRODUCTION_SCOPES]),
      scopesDigest: sha256(canonicalScopeString(EBAY_PRODUCTION_SCOPES)),
      stateDigest: input.stateDigest,
      requestDigest: input.requestDigest,
      consentArtifact: 'external',
      createdAtUtc: canonicalTime(now),
      expiresAtUtc: canonicalTime(new Date(now.getTime() + CONSENT_STATE_TTL_MS)),
      status: 'pending',
      databaseEffect: 'none',
      consumedAtUtc: null,
      installation: null,
      terminalCode: null,
    });
    await writeNewPrivateFile(
      path.join(stagingDirectory, STATE_FILE),
      `${JSON.stringify(fresh)}\n`,
      input.dependencies,
    );
    try {
      const archivedEvidence = path.join(archiveContainer, 'evidence');
      await durableRename(
        workDirectory,
        archivedEvidence,
        input.dependencies,
        'evidence-archive-target',
        'evidence-archive-source',
      );
      await durableRename(
        stagingDirectory,
        workDirectory,
        input.dependencies,
        'reset-publish',
      );
      await assertPrivateDirectory(archivedEvidence);
      await assertPrivateRegularFile(path.join(archivedEvidence, STATE_FILE));
      await assertPrivateDirectory(workDirectory);
      await assertPrivateRegularFile(path.join(workDirectory, STATE_FILE));
    } catch {
      return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
        databaseRowsChanged: 0,
        credentialProviderMutation: false,
        reconciliationRequired: true,
      }));
    }
    return fixedResult('EBAY_CONSENT_RESET_AFTER_RECONCILIATION');
  });
}

function defaultIsLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function recoverStaleEbayOperationLock(input: {
  workDirectory: string;
  archiveDirectory: string;
  ownerId: string;
  createdAtUtc: string;
  confirmation: string;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  if (input.confirmation !== EBAY_STALE_LOCK_RECOVERY_CONFIRMATION
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.ownerId)) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  let proofCreatedAt: string;
  try {
    proofCreatedAt = new Date(input.createdAtUtc).toISOString();
  } catch {
    return fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  if (proofCreatedAt !== input.createdAtUtc) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  const workDirectory = assertAbsolute(input.workDirectory);
  const maintenanceDirectory = path.dirname(workDirectory);
  await assertPrivateDirectory(maintenanceDirectory);
  const archiveDirectory = assertAbsolute(input.archiveDirectory);
  if (path.dirname(archiveDirectory) !== maintenanceDirectory
    || archiveDirectory === workDirectory) {
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  const lockPath = path.join(maintenanceDirectory, LOCK_FILE);
  const lock = await readOperationLock(lockPath);
  if (!exactOpaqueValue(lock.ownerId, input.ownerId)
    || lock.createdAtUtc !== proofCreatedAt) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  const now = (input.dependencies?.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const expiresMs = new Date(lock.expiresAtUtc).getTime();
  if (nowMs < expiresMs || nowMs > expiresMs + OPERATION_LOCK_RECOVERY_WINDOW_MS) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  const isOwnerAlive = input.dependencies?.isLockOwnerAlive ?? defaultIsLockOwnerAlive;
  if (isOwnerAlive(lock.pid)) fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');

  const current = await readOperationLock(lockPath);
  if (!exactOpaqueValue(current.ownerId, lock.ownerId)
    || current.pid !== lock.pid
    || current.createdAtUtc !== lock.createdAtUtc
    || current.expiresAtUtc !== lock.expiresAtUtc
    || isOwnerAlive(current.pid)) {
    fail('EBAY_ROTATION_LOCK_RECOVERY_DENIED');
  }
  await ensurePrivateDirectory(archiveDirectory, input.dependencies);
  const random = input.dependencies?.randomBytes ?? randomBytes;
  const suffix = random(12).toString('hex');
  if (!/^[0-9a-f]{24}$/u.test(suffix)) fail('EBAY_ROTATION_STATE_INVALID');
  const archiveContainer = path.join(
    archiveDirectory,
    `ebay-lock-${now.toISOString().replace(/[:.]/gu, '-')}-${suffix}`,
  );
  await createPrivateDirectory(archiveContainer, input.dependencies);
  const archivedLock = path.join(archiveContainer, 'operation-lock.json');
  try {
    await durableRename(
      lockPath,
      archivedLock,
      input.dependencies,
      'stale-lock-archive-target',
      'stale-lock-archive-source',
    );
    await assertPrivateRegularFile(archivedLock);
  } catch {
    return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
      databaseRowsChanged: 0,
      credentialProviderMutation: false,
      reconciliationRequired: true,
    }));
  }
  return fixedResult('EBAY_STALE_LOCK_ARCHIVED');
}

export async function ensureEbayProductionPrivateParents(): Promise<void> {
  const data = await fs.lstat('/data').catch(() => null);
  if (!data?.isDirectory() || data.isSymbolicLink()
    || await fs.realpath('/data').catch(() => '') !== '/data') {
    fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
  }
  const privateRoot = '/data/product-pipeline';
  const privateRootEntry = await fs.lstat(privateRoot).catch(() => null);
  if (privateRootEntry === null) {
    await fs.mkdir(privateRoot, { mode: 0o700 }).catch(() => {
      fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
    });
  }
  await assertPrivateDirectory(privateRoot);
  await ensurePrivateDirectory('/data/product-pipeline/credential-maintenance');
  await ensurePrivateDirectory('/data/product-pipeline/credential-backups');
}

export async function installEbayProductionGrant(input: {
  workDirectory: string;
  databasePath: string;
  backupDirectory: string;
  authorizationResult: string;
  credentials: Required<EbayRotationCredentials>;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  assertCredentials(input.credentials, true);
  const transport = input.dependencies?.transport ?? defaultTransport;
  const nowProvider = input.dependencies?.now ?? (() => new Date());
  const random = input.dependencies?.randomBytes ?? randomBytes;
  const workDirectory = assertAbsolute(input.workDirectory);
  return withOperationLock(workDirectory, input.dependencies, async () => {
    let record = await readConsentRecord(workDirectory);
    if (record.status !== 'pending') fail('EBAY_ROTATION_STATE_ALREADY_USED');
    const now = nowProvider();
    if (now.getTime() >= new Date(record.expiresAtUtc).getTime()) {
      fail('EBAY_ROTATION_STATE_EXPIRED');
    }
    const callback = callbackResult(input.authorizationResult);
    if (!stateMatches(callback.state, record.stateDigest)) {
      fail('EBAY_ROTATION_AUTH_RESULT_MISMATCH');
    }
    if (record.consentArtifact === 'co-located') {
      await assertPrivateRegularFile(path.join(workDirectory, CONSENT_FILE));
      await fs.unlink(path.join(workDirectory, CONSENT_FILE)).catch(() => {
        fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
      });
    } else {
      const artifact = await fs.lstat(path.join(workDirectory, CONSENT_FILE)).catch(() => null);
      if (artifact !== null) fail('EBAY_ROTATION_FILE_BOUNDARY_DENIED');
    }
    record = recordWith(record, {
      status: 'consumed',
      consumedAtUtc: canonicalTime(now),
      terminalCode: null,
    });
    await writeConsentRecord(workDirectory, record, input.dependencies);

    let grant: Grant | null = null;
    let databaseCommitted = false;
    let committedRowId: number | null = null;
    let commitOutcomeEffects: EbayRotationFailureEffects | null = null;
    let exchangeAttempted = false;
    try {
      const preparation = await prepareLedgerInstallation({
        databasePath: input.databasePath,
        backupDirectory: input.backupDirectory,
        now,
        random,
        dependencies: input.dependencies,
      });
      record = recordWith(record, {
        status: 'installing',
        installation: Object.freeze({
          databasePath: preparation.databasePath,
          expectedUpdatedAt: preparation.expectedUpdatedAt,
          rowId: null,
          accessTokenDigest: null,
          refreshTokenDigest: null,
          backupFileName: preparation.backupFileName,
          committedAtUtc: null,
        }),
      });
      await writeConsentRecord(workDirectory, record, input.dependencies);
      exchangeAttempted = true;
      grant = await exchangeAuthorizationCode(transport, input.credentials, callback.code, now);
      await validateGrant(transport, input.credentials, grant);
      record = recordWith(record, {
        databaseEffect: 'commit-pending',
        installation: Object.freeze({
          ...record.installation!,
          accessTokenDigest: tokenDigest('access', grant.accessToken),
          refreshTokenDigest: tokenDigest('refresh', grant.refreshToken),
        }),
      });
      await writeConsentRecord(workDirectory, record, input.dependencies);
      const commitResult = await commitLedgerGrant(
        preparation,
        grant,
        input.dependencies?.beforeLedgerCas,
        input.dependencies?.afterCommitAppliedBeforeResult,
      );
      if (commitResult.outcome !== 'committed') {
        const committedAfterError = commitResult.outcome === 'commit-error-committed';
        committedRowId = committedAfterError ? commitResult.rowId : null;
        commitOutcomeEffects = Object.freeze({
          databaseRowsChanged: committedAfterError
            ? 1
            : commitResult.outcome === 'commit-error-baseline'
              ? 0
              : 'unknown',
          credentialProviderMutation: true,
          reconciliationRequired: true,
        });
        record = committedAfterError
          ? recordWith(record, {
              status: 'committed-reconciliation-required',
              databaseEffect: 'committed',
              installation: Object.freeze({
                ...record.installation!,
                rowId: commitResult.rowId,
                committedAtUtc: canonicalTime(nowProvider()),
              }),
              terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
            })
          : recordWith(record, {
              status: 'commit-outcome-reconciliation-required',
              databaseEffect: 'commit-pending',
              terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
            });
        await writeConsentRecord(workDirectory, record, input.dependencies);
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', commitOutcomeEffects);
      }
      committedRowId = commitResult.rowId;
      databaseCommitted = true;
      await input.dependencies?.beforeCommittedStateWrite?.();
      await verifyCommittedReadback(preparation, grant, committedRowId);
      record = recordWith(record, {
        status: 'installed',
        databaseEffect: 'committed',
        installation: Object.freeze({
          ...record.installation!,
          rowId: committedRowId,
          committedAtUtc: canonicalTime(nowProvider()),
        }),
        terminalCode: null,
      });
      await writeConsentRecord(workDirectory, record, input.dependencies);
      return fixedResult('EBAY_GRANT_INSTALLED', {
        sellerVerified: true,
        scopesVerified: true,
        backupCreated: true,
        databaseRowsChanged: 1,
        credentialProviderMutation: true,
      });
    } catch (error) {
      const original = error instanceof EbayRotationError
        ? error
        : new EbayRotationError('EBAY_ROTATION_FAILED_CLOSED');
      if (commitOutcomeEffects) {
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', commitOutcomeEffects);
      }
      if (databaseCommitted) {
        const committed = recordWith(record, {
          status: 'committed-reconciliation-required',
          databaseEffect: 'committed',
          installation: Object.freeze({
            ...record.installation!,
            rowId: committedRowId,
            committedAtUtc: canonicalTime(nowProvider()),
          }),
          terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
        });
        await writeConsentRecord(workDirectory, committed, input.dependencies)
          .catch(() => undefined);
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
          databaseRowsChanged: 1,
          credentialProviderMutation: true,
          reconciliationRequired: true,
        }));
      }
      if (grant) {
        let revoked = false;
        try {
          await revokeGrant(transport, input.credentials, grant.refreshToken);
          revoked = true;
        } catch {
          revoked = false;
        }
        const failed = recordWith(record, {
          status: revoked ? 'failed-revoked' : 'failed-cleanup-required',
          databaseEffect: 'none',
          terminalCode: revoked ? original.code : 'EBAY_ROTATION_CLEANUP_REQUIRED',
        });
        await writeConsentRecord(workDirectory, failed, input.dependencies)
          .catch(() => undefined);
        if (!revoked) {
          return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
            databaseRowsChanged: 0,
            credentialProviderMutation: true,
            reconciliationRequired: true,
          }));
        }
        return failWithEffects(original.code, Object.freeze({
          databaseRowsChanged: 0,
          credentialProviderMutation: true,
          reconciliationRequired: false,
        }));
      } else if (exchangeAttempted && !grant) {
        const failed = recordWith(record, {
          status: 'failed-cleanup-required',
          databaseEffect: 'none',
          terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
        });
        await writeConsentRecord(workDirectory, failed, input.dependencies)
          .catch(() => undefined);
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
          databaseRowsChanged: 0,
          credentialProviderMutation: true,
          reconciliationRequired: true,
        }));
      } else {
        const failed = recordWith(record, {
          status: 'failed-no-provider-effect',
          databaseEffect: 'none',
          terminalCode: original.code,
        });
        await writeConsentRecord(workDirectory, failed, input.dependencies)
          .catch(() => undefined);
      }
      throw original;
    }
  });
}

export async function verifyInstalledEbayGrant(input: {
  workDirectory: string;
  databasePath: string;
  credentials: Required<EbayRotationCredentials>;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  assertCredentials(input.credentials, true);
  const transport = input.dependencies?.transport ?? defaultTransport;
  const nowProvider = input.dependencies?.now ?? (() => new Date());
  return withOperationLock(assertAbsolute(input.workDirectory), input.dependencies, async () => {
    let record = await readConsentRecord(input.workDirectory);
    const commitPending = ['installing', 'commit-outcome-reconciliation-required']
      .includes(record.status)
      && record.databaseEffect === 'commit-pending';
    const committed = ['installed', 'committed-reconciliation-required'].includes(record.status)
      && record.databaseEffect === 'committed';
    if ((!commitPending && !committed) || !record.installation) {
      fail('EBAY_ROTATION_STATE_INVALID');
    }
    const row = requireBoundRow(input.databasePath, record.installation, commitPending);
    const nowSeconds = Math.floor(nowProvider().getTime() / 1_000);
    if (row.expires_at === null || row.expires_at <= nowSeconds + 300) {
      fail('EBAY_ROTATION_PROVIDER_RESPONSE_INVALID');
    }
    const grant: Grant = Object.freeze({
      accessToken: row.access_token,
      refreshToken: row.refresh_token!,
      accessExpiresAt: row.expires_at,
      scope: row.scope!,
    });
    await validateGrant(transport, input.credentials, grant);
    if (commitPending || record.status === 'committed-reconciliation-required') {
      record = recordWith(record, {
        status: 'installed',
        databaseEffect: 'committed',
        installation: Object.freeze({
          ...record.installation,
          rowId: row.id,
          committedAtUtc: canonicalTime(nowProvider()),
        }),
        terminalCode: null,
      });
      try {
        await writeConsentRecord(input.workDirectory, record, input.dependencies);
      } catch {
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
          databaseRowsChanged: 0,
          credentialProviderMutation: false,
          reconciliationRequired: true,
        }));
      }
    }
    return fixedResult('EBAY_GRANT_VERIFIED', {
      sellerVerified: true,
      scopesVerified: true,
    });
  });
}

export async function revokeInstalledEbayGrant(input: {
  workDirectory: string;
  databasePath: string;
  confirmation: string;
  credentials: Required<EbayRotationCredentials>;
  dependencies?: EbayRotationDependencies;
}): Promise<EbayRotationResult> {
  assertCredentials(input.credentials, true);
  if (input.confirmation !== EBAY_REVOKE_CONFIRMATION) {
    fail('EBAY_ROTATION_REVOCATION_DENIED');
  }
  const transport = input.dependencies?.transport ?? defaultTransport;
  return withOperationLock(assertAbsolute(input.workDirectory), input.dependencies, async () => {
    let record = await readConsentRecord(input.workDirectory);
    const commitPending = ['installing', 'commit-outcome-reconciliation-required']
      .includes(record.status)
      && record.databaseEffect === 'commit-pending';
    const committed = ['installed', 'committed-reconciliation-required', 'revoked']
      .includes(record.status) && record.databaseEffect === 'committed';
    if (!record.installation || (!commitPending && !committed)) {
      fail('EBAY_ROTATION_STATE_INVALID');
    }
    const row = requireBoundRow(input.databasePath, record.installation, commitPending);
    if (commitPending) {
      record = recordWith(record, {
        databaseEffect: 'committed',
        installation: Object.freeze({
          ...record.installation,
          rowId: row.id,
          committedAtUtc: canonicalTime(
            (input.dependencies?.now ?? (() => new Date()))(),
          ),
        }),
      });
    }
    const metadata = await introspect(
      transport,
      input.credentials,
      row.refresh_token!,
      'refresh_token',
    );
    if (record.status === 'revoked') {
      if (metadata.active !== false) {
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
          databaseRowsChanged: 0,
          credentialProviderMutation: false,
          reconciliationRequired: true,
        }));
      }
      return fixedResult('EBAY_GRANT_ALREADY_REVOKED');
    }
    if (metadata.active === false) {
      record = recordWith(record, {
        status: 'revoked',
        terminalCode: 'EBAY_GRANT_REVOKED',
      });
      try {
        await writeConsentRecord(input.workDirectory, record, input.dependencies);
      } catch {
        return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
          databaseRowsChanged: 0,
          credentialProviderMutation: false,
          reconciliationRequired: true,
        }));
      }
      return fixedResult('EBAY_GRANT_REVOKED', {
        credentialProviderMutation: false,
      });
    }
    validateActiveIntrospection(metadata, input.credentials);
    try {
      await revokeGrant(transport, input.credentials, row.refresh_token!);
    } catch {
      return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
        databaseRowsChanged: 0,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      }));
    }
    record = recordWith(record, {
      status: 'revoked',
      terminalCode: 'EBAY_GRANT_REVOKED',
    });
    try {
      await writeConsentRecord(input.workDirectory, record, input.dependencies);
    } catch {
      return failWithEffects('EBAY_ROTATION_CLEANUP_REQUIRED', Object.freeze({
        databaseRowsChanged: 0,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      }));
    }
    return fixedResult('EBAY_GRANT_REVOKED', {
      credentialProviderMutation: true,
    });
  });
}
