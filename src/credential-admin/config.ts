import crypto from 'node:crypto';
import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { rotationDenied, translateRotationError } from './errors.js';

const MAX_CREDENTIAL_LENGTH = 8_192;
const MAXIMUM_ACK_LIFETIME_MS = 60 * 60 * 1_000;
const MINIMUM_ROTATION_DISPATCH_WINDOW_MS = 15 * 60 * 1_000;
const SAFE_CREDENTIAL = /^[^\s\u0000-\u001f\u007f]+$/u;

export const PRODUCT_PIPELINE_PRODUCTION_RUNTIME = Object.freeze({
  projectId: 'f8c050c9-11c3-4611-8805-092289941aa4',
  environmentId: '544d8896-b900-48ad-b42e-95272e1ad397',
  serviceId: '32ef14cc-2c85-447d-a890-53c422d81de1',
  databasePath: '/data/ebaysync.db',
  backupDirectory: '/data/product-pipeline/credential-backups/shopify',
  singleWriterAck: 'product-pipeline-shopify-credential-rotation-v1',
});

export const SHOPIFY_ROTATION_ENVIRONMENT = Object.freeze({
  clientId: 'SHOPIFY_CLIENT_ID',
  clientSecret: 'SHOPIFY_CLIENT_SECRET',
  previousClientSecret: 'SHOPIFY_PREVIOUS_CLIENT_SECRET',
  previousClientSecretExpiresAtUtc: 'SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC',
  refreshToken: 'SHOPIFY_ROTATION_REFRESH_TOKEN',
  databasePath: 'DATABASE_PATH',
  projectId: 'RAILWAY_PROJECT_ID',
  environmentId: 'RAILWAY_ENVIRONMENT_ID',
  serviceId: 'RAILWAY_SERVICE_ID',
  singleWriterAck: 'SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK',
  singleWriterAckExpiresAtUtc: 'SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK_EXPIRES_AT_UTC',
  listingWriterAck: 'LISTING_CONTROL_SINGLE_WRITER_ACK',
  ebayRotationCert: 'EBAY_ROTATION_NEW_CERT_ID',
} as const);

export type ShopifyCredentialRotationConfig = Readonly<{
  databasePath: typeof PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
  clientId: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId;
  clientSecret: string;
  previousClientSecret: string | null;
  previousClientSecretExpiresAtEpochMs: number | null;
  refreshToken: string | null;
  storeDomain: typeof PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain;
  authorizationExpiresAtEpochMs: number;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function credential(value: string | undefined, minimumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < minimumLength
    || value.length > MAX_CREDENTIAL_LENGTH
    || value.trim() !== value
    || !SAFE_CREDENTIAL.test(value)
  ) return rotationDenied('configuration-denied');
  return value;
}

function exactEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function requireRuntimeBinding(environment: Environment, now: number): number {
  if (
    environment.NODE_ENV !== 'production'
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.projectId] !== PRODUCT_PIPELINE_PRODUCTION_RUNTIME.projectId
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.environmentId] !== PRODUCT_PIPELINE_PRODUCTION_RUNTIME.environmentId
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.serviceId] !== PRODUCT_PIPELINE_PRODUCTION_RUNTIME.serviceId
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.databasePath] !== PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.singleWriterAck] !== PRODUCT_PIPELINE_PRODUCTION_RUNTIME.singleWriterAck
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.listingWriterAck] !== undefined
    || environment[SHOPIFY_ROTATION_ENVIRONMENT.ebayRotationCert] !== undefined
  ) return rotationDenied('configuration-denied');
  const expiresAtUtc = environment[SHOPIFY_ROTATION_ENVIRONMENT.singleWriterAckExpiresAtUtc];
  if (typeof expiresAtUtc !== 'string') return rotationDenied('configuration-denied');
  const expiresAt = Date.parse(expiresAtUtc);
  if (
    !Number.isSafeInteger(expiresAt)
    || new Date(expiresAt).toISOString() !== expiresAtUtc
    || expiresAt <= now
    || expiresAt - now > MAXIMUM_ACK_LIFETIME_MS
  ) return rotationDenied('configuration-denied');
  return expiresAt;
}

function requireActivePreviousSecret(
  environment: Environment,
  currentSecret: string,
  now: number,
  required: boolean,
): Readonly<{ secret: string | null; expiresAtEpochMs: number | null }> {
  const previous = environment[SHOPIFY_ROTATION_ENVIRONMENT.previousClientSecret];
  const expiresAtUtc = environment[SHOPIFY_ROTATION_ENVIRONMENT.previousClientSecretExpiresAtUtc];
  if (previous === undefined && expiresAtUtc === undefined && !required) {
    return Object.freeze({ secret: null, expiresAtEpochMs: null });
  }
  if (previous === undefined || expiresAtUtc === undefined) {
    return rotationDenied('configuration-denied');
  }
  const secret = credential(previous, 16);
  if (exactEqual(secret, currentSecret)) return rotationDenied('configuration-denied');
  const expiresAt = Date.parse(expiresAtUtc);
  if (
    !Number.isSafeInteger(expiresAt)
    || new Date(expiresAt).toISOString() !== expiresAtUtc
    || expiresAt <= now
    || expiresAt - now > MAXIMUM_ACK_LIFETIME_MS
    || (required && expiresAt - now < MINIMUM_ROTATION_DISPATCH_WINDOW_MS)
  ) return rotationDenied('configuration-denied');
  return Object.freeze({ secret, expiresAtEpochMs: expiresAt });
}

export type LegacyDatabaseIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
}>;

export function assertLegacyDatabasePath(
  databasePath: string,
  expectedDatabasePath: string = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
): LegacyDatabaseIdentity {
  if (
    typeof databasePath !== 'string'
    || databasePath !== expectedDatabasePath
    || !path.isAbsolute(databasePath)
    || path.normalize(databasePath) !== databasePath
    || databasePath.includes('\u0000')
  ) return rotationDenied('database-denied');

  let before: fs.Stats;
  let descriptor: number | null = null;
  try {
    before = fs.lstatSync(databasePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0
      || (before.mode & 0o777) !== 0o600) {
      return rotationDenied('database-denied');
    }
    const parent = fs.lstatSync(path.dirname(databasePath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) {
      return rotationDenied('database-denied');
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        fs.lstatSync(`${databasePath}${suffix}`);
        return rotationDenied('database-denied');
      } catch (sidecarError) {
        if ((sidecarError as NodeJS.ErrnoException).code !== 'ENOENT') {
          return translateRotationError(sidecarError, 'database-denied');
        }
      }
    }
    descriptor = fs.openSync(databasePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) return rotationDenied('database-denied');
    return Object.freeze({ dev: opened.dev, ino: opened.ino, size: opened.size });
  } catch (error) {
    return translateRotationError(error, 'database-denied');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function assertLegacyDatabaseIdentity(
  databasePath: string,
  expected: LegacyDatabaseIdentity,
  expectedDatabasePath: string = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
): void {
  const actual = assertLegacyDatabasePath(databasePath, expectedDatabasePath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    return rotationDenied('database-denied');
  }
}

export function loadShopifyCredentialRotationConfig(input: Readonly<{
  environment?: Environment;
  now?: number;
  requireRefreshToken: boolean;
  validateDatabasePath?: (databasePath: string) => unknown;
}>): ShopifyCredentialRotationConfig {
  const environment = input.environment ?? process.env;
  const now = input.now ?? Date.now();
  const authorizationExpiresAtEpochMs = requireRuntimeBinding(
    environment,
    now,
  );
  const clientId = credential(environment[SHOPIFY_ROTATION_ENVIRONMENT.clientId], 8);
  const clientSecret = credential(environment[SHOPIFY_ROTATION_ENVIRONMENT.clientSecret], 16);
  if (clientId !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId) {
    return rotationDenied('configuration-denied');
  }
  const refreshToken = input.requireRefreshToken
    ? credential(environment[SHOPIFY_ROTATION_ENVIRONMENT.refreshToken], 16)
    : null;
  const previous = requireActivePreviousSecret(
    environment,
    clientSecret,
    now,
    input.requireRefreshToken,
  );
  if (refreshToken !== null && exactEqual(clientSecret, refreshToken)) {
    return rotationDenied('configuration-denied');
  }
  (input.validateDatabasePath ?? assertLegacyDatabasePath)(
    PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
  );
  return Object.freeze({
    databasePath: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
    clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
    clientSecret,
    previousClientSecret: previous.secret,
    previousClientSecretExpiresAtEpochMs: previous.expiresAtEpochMs,
    refreshToken,
    storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
    authorizationExpiresAtEpochMs,
  });
}

export function assertShopifyCredentialRotationAuthorizationActive(
  config: ShopifyCredentialRotationConfig,
  now: number,
): void {
  if (!Number.isSafeInteger(now) || now >= config.authorizationExpiresAtEpochMs) {
    return rotationDenied('configuration-denied');
  }
}

/**
 * Last time-based gate before the single no-retry provider request. A verified
 * token is committed forward after issuance even if wall clock time later
 * crosses a deadline; abandoning it would orphan the provider-side effect.
 */
export function assertShopifyCredentialRotationDispatchAuthorized(
  config: ShopifyCredentialRotationConfig,
  now: number,
): void {
  assertShopifyCredentialRotationAuthorizationActive(config, now);
  const previousSecret = config.previousClientSecret;
  const previousExpiresAt = config.previousClientSecretExpiresAtEpochMs;
  if (
    config.refreshToken === null
    || previousSecret === null
    || previousExpiresAt === null
    || !Number.isSafeInteger(previousExpiresAt)
    || previousSecret.length < 16
    || previousSecret.length > MAX_CREDENTIAL_LENGTH
    || !SAFE_CREDENTIAL.test(previousSecret)
    || exactEqual(config.clientSecret, previousSecret)
    || config.authorizationExpiresAtEpochMs - now < MINIMUM_ROTATION_DISPATCH_WINDOW_MS
    || config.authorizationExpiresAtEpochMs - now > MAXIMUM_ACK_LIFETIME_MS
    || previousExpiresAt - now < MINIMUM_ROTATION_DISPATCH_WINDOW_MS
    || previousExpiresAt - now > MAXIMUM_ACK_LIFETIME_MS
  ) return rotationDenied('configuration-denied');
}

export const SHOPIFY_CREDENTIAL_ROTATION_CONFIG_LIMITS = Object.freeze({
  maximumAckLifetimeMs: MAXIMUM_ACK_LIFETIME_MS,
  minimumRotationDispatchWindowMs: MINIMUM_ROTATION_DISPATCH_WINDOW_MS,
});
