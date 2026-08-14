import {
  archiveAndResetEbayProductionConsent,
  beginEbayProductionConsent,
  EBAY_PRODUCTION_BACKUP_DIRECTORY,
  EBAY_PRODUCTION_DATABASE_PATH,
  EBAY_PRODUCTION_EVIDENCE_ARCHIVE_DIRECTORY,
  EBAY_PRODUCTION_LOCK_ARCHIVE_DIRECTORY,
  EBAY_PRODUCTION_WORK_DIRECTORY,
  EBAY_RECONCILIATION_RESET_CONFIRMATION,
  EBAY_REVOKE_CONFIRMATION,
  EBAY_STALE_LOCK_RECOVERY_CONFIRMATION,
  EbayRotationError,
  ensureEbayProductionPrivateParents,
  installEbayProductionGrant,
  recoverStaleEbayOperationLock,
  registerEbayProductionConsent,
  revokeInstalledEbayGrant,
  type EbayRotationCredentials,
  type EbayRotationDependencies,
  type EbayRotationErrorCode,
  type EbayRotationResult,
  verifyInstalledEbayGrant,
} from './ebay-rotation.js';

export const EBAY_ROTATION_RAILWAY_PROJECT_ID = 'f8c050c9-11c3-4611-8805-092289941aa4' as const;
export const EBAY_ROTATION_RAILWAY_ENVIRONMENT_ID = '544d8896-b900-48ad-b42e-95272e1ad397' as const;
export const EBAY_ROTATION_RAILWAY_SERVICE_ID = '32ef14cc-2c85-447d-a890-53c422d81de1' as const;

export type CredentialAdminIo = Readonly<{
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  readSecret: () => Promise<string>;
  setExitCode: (value: number) => void;
}>;

export type CredentialAdminEnvironment = Readonly<{
  EBAY_APP_ID?: string;
  EBAY_RU_NAME?: string;
  EBAY_ROTATION_NEW_CERT_ID?: string;
  RAILWAY_PROJECT_ID?: string;
  RAILWAY_ENVIRONMENT_ID?: string;
  RAILWAY_SERVICE_ID?: string;
  LISTING_CONTROL_SINGLE_WRITER_ACK?: string;
  SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK?: string;
  SHOPIFY_ROTATION_REFRESH_TOKEN?: string;
}>;

type ParsedCommand =
  | Readonly<{ command: 'help' }>
  | Readonly<{ command: 'prepare-consent'; localWorkDirectory: string }>
  | Readonly<{
      command: 'register-consent';
      stateDigest: string;
      requestDigest: string;
    }>
  | Readonly<{
      command: 'archive-reset-after-reconciliation';
      stateDigest: string;
      requestDigest: string;
      confirmation: string;
    }>
  | Readonly<{
      command: 'recover-stale-lock';
      ownerId: string;
      createdAtUtc: string;
      confirmation: string;
    }>
  | Readonly<{ command: 'install' }>
  | Readonly<{ command: 'verify' }>
  | Readonly<{ command: 'revoke-new-grant'; confirmation: string }>;

export const EBAY_CREDENTIAL_ADMIN_HELP = `ProductPipeline fixed-purpose eBay Production credential administrator

Usage:
  credential-admin ebay prepare-consent --local-work-dir <absolute-private-local-directory>
  credential-admin ebay register-consent --state-digest <sha256-digest> --request-digest <sha256-digest>
  credential-admin ebay archive-reset-after-reconciliation --state-digest <new-sha256-digest> --request-digest <new-sha256-digest> --confirm ${EBAY_RECONCILIATION_RESET_CONFIRMATION}
  credential-admin ebay recover-stale-lock --owner <lock-owner> --created-at <lock-created-at-utc> --confirm ${EBAY_STALE_LOCK_RECOVERY_CONFIRMATION}
  credential-admin ebay install
  credential-admin ebay verify
  credential-admin ebay revoke-new-grant --confirm ${EBAY_REVOKE_CONFIRMATION}

The Railway commands use compiled Production project, environment, service, database, work, and backup boundaries. The authorization result is accepted only through no-echo stdin and is never accepted as an argument or environment variable.
`;

const SECRET_ARGUMENT_NAMES = new Set([
  '--authorization-result', '--authorization-code', '--code', '--state', '--access-token',
  '--refresh-token', '--cert-id', '--client-secret', '--token', '--database', '--backup-dir',
  '--work-dir',
]);

function failArgument(): never {
  throw new EbayRotationError('EBAY_ROTATION_ARGUMENT_DENIED');
}

function parseOptions(
  values: readonly string[],
  expected: readonly string[],
): Readonly<Record<string, string>> {
  if (values.some((value) => SECRET_ARGUMENT_NAMES.has(value.split('=', 1)[0] ?? value))) {
    failArgument();
  }
  if (values.length !== expected.length * 2) failArgument();
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key || !value || !expected.includes(key) || key in result || value.startsWith('--')) {
      failArgument();
    }
    result[key] = value;
  }
  if (expected.some((key) => !(key in result))) failArgument();
  return Object.freeze(result);
}

export function parseCredentialAdminArguments(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]!))) {
    return Object.freeze({ command: 'help' });
  }
  if (argv[0] !== 'ebay' || !argv[1]) failArgument();
  const command = argv[1];
  const rest = argv.slice(2);
  if (command === 'prepare-consent') {
    const options = parseOptions(rest, ['--local-work-dir']);
    return Object.freeze({
      command,
      localWorkDirectory: options['--local-work-dir']!,
    });
  }
  if (command === 'register-consent') {
    const options = parseOptions(rest, ['--state-digest', '--request-digest']);
    return Object.freeze({
      command,
      stateDigest: options['--state-digest']!,
      requestDigest: options['--request-digest']!,
    });
  }
  if (command === 'archive-reset-after-reconciliation') {
    const options = parseOptions(
      rest,
      ['--state-digest', '--request-digest', '--confirm'],
    );
    return Object.freeze({
      command,
      stateDigest: options['--state-digest']!,
      requestDigest: options['--request-digest']!,
      confirmation: options['--confirm']!,
    });
  }
  if (command === 'recover-stale-lock') {
    const options = parseOptions(rest, ['--owner', '--created-at', '--confirm']);
    return Object.freeze({
      command,
      ownerId: options['--owner']!,
      createdAtUtc: options['--created-at']!,
      confirmation: options['--confirm']!,
    });
  }
  if (command === 'install' || command === 'verify') {
    if (rest.length !== 0) failArgument();
    return Object.freeze({ command });
  }
  if (command === 'revoke-new-grant') {
    const options = parseOptions(rest, ['--confirm']);
    return Object.freeze({
      command,
      confirmation: options['--confirm']!,
    });
  }
  return failArgument();
}

export function assertEbayProductionRailwayBoundary(
  environment: CredentialAdminEnvironment,
): void {
  if (environment.RAILWAY_PROJECT_ID !== EBAY_ROTATION_RAILWAY_PROJECT_ID
    || environment.RAILWAY_ENVIRONMENT_ID !== EBAY_ROTATION_RAILWAY_ENVIRONMENT_ID
    || environment.RAILWAY_SERVICE_ID !== EBAY_ROTATION_RAILWAY_SERVICE_ID
    || environment.LISTING_CONTROL_SINGLE_WRITER_ACK !== undefined
    || environment.SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK !== undefined
    || environment.SHOPIFY_ROTATION_REFRESH_TOKEN !== undefined) {
    throw new EbayRotationError('EBAY_ROTATION_CONFIGURATION_DENIED');
  }
}

function beginCredentials(environment: CredentialAdminEnvironment): EbayRotationCredentials {
  return Object.freeze({
    appId: environment.EBAY_APP_ID ?? '',
    ruName: environment.EBAY_RU_NAME ?? '',
  });
}

function rotationCredentials(
  environment: CredentialAdminEnvironment,
): Required<EbayRotationCredentials> {
  return Object.freeze({
    appId: environment.EBAY_APP_ID ?? '',
    ruName: environment.EBAY_RU_NAME ?? '',
    newCertId: environment.EBAY_ROTATION_NEW_CERT_ID ?? '',
  });
}

function safeSuccess(result: EbayRotationResult): string {
  return JSON.stringify(result);
}

function safeFailure(error: EbayRotationError): string {
  return JSON.stringify(Object.freeze({
    ok: false,
    code: error.code,
    environment: 'production',
    databaseRowsChanged: error.effects.databaseRowsChanged,
    credentialProviderMutation: error.effects.credentialProviderMutation,
    reconciliationRequired: error.effects.reconciliationRequired,
    commerceWritesPerformed: 0,
    historicalOrdersTouched: 0,
  }));
}

export function credentialAdminExitCode(
  code: EbayRotationErrorCode,
  reconciliationRequired = false,
): number {
  if (reconciliationRequired) return 5;
  if (code.includes('CLEANUP')) return 5;
  if (code.includes('PROVIDER') || code.includes('REVOCATION')) return 3;
  if (code.includes('DATABASE') || code.includes('GRANT_BINDING')) return 4;
  return 2;
}

async function readPipedSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > 8_193) {
      for (const stored of chunks) stored.fill(0);
      chunk.fill(0);
      throw new EbayRotationError('EBAY_ROTATION_AUTH_RESULT_INVALID');
    }
    chunks.push(chunk);
  }
  const combined = Buffer.concat(chunks);
  try {
    const value = combined.toString('utf8').replace(/\n$/u, '');
    if (value.includes('\n') || value.includes('\r')) {
      throw new EbayRotationError('EBAY_ROTATION_AUTH_RESULT_INVALID');
    }
    return value;
  } finally {
    combined.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function readTtySecret(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return readPipedSecret();
  }
  process.stderr.write('Paste the complete eBay authorization result: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (raw: Buffer | string) => {
        const chunk = Buffer.from(raw);
        try {
          for (const byte of chunk) {
            if (byte === 3) {
              cleanup();
              reject(new EbayRotationError('EBAY_ROTATION_AUTH_RESULT_INVALID'));
              return;
            }
            if (byte === 10 || byte === 13) {
              const combined = Buffer.concat(chunks);
              const value = combined.toString('utf8');
              combined.fill(0);
              cleanup();
              resolve(value);
              return;
            }
            if (byte === 8 || byte === 127) {
              const prior = chunks.pop();
              if (prior) {
                length -= prior.length;
                prior.fill(0);
              }
              continue;
            }
            if (length >= 8_192) {
              cleanup();
              reject(new EbayRotationError('EBAY_ROTATION_AUTH_RESULT_INVALID'));
              return;
            }
            chunks.push(Buffer.from([byte]));
            length += 1;
          }
        } finally {
          chunk.fill(0);
        }
      };
      const cleanup = () => {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write('\n');
        for (const chunk of chunks) chunk.fill(0);
      };
      process.stdin.on('data', onData);
    });
  } finally {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
  }
}

export async function defaultNoEchoSecretReader(): Promise<string> {
  return process.stdin.isTTY ? readTtySecret() : readPipedSecret();
}

const defaultIo: CredentialAdminIo = Object.freeze({
  stdout: (value: string) => process.stdout.write(`${value}\n`),
  stderr: (value: string) => process.stderr.write(`${value}\n`),
  readSecret: defaultNoEchoSecretReader,
  setExitCode: (value: number) => { process.exitCode = value; },
});

export async function runCredentialAdmin(input: {
  argv: readonly string[];
  environment?: CredentialAdminEnvironment;
  io?: CredentialAdminIo;
  dependencies?: EbayRotationDependencies;
}): Promise<void> {
  const environment = input.environment ?? {
    EBAY_APP_ID: process.env.EBAY_APP_ID,
    EBAY_RU_NAME: process.env.EBAY_RU_NAME,
    EBAY_ROTATION_NEW_CERT_ID: process.env.EBAY_ROTATION_NEW_CERT_ID,
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
    RAILWAY_SERVICE_ID: process.env.RAILWAY_SERVICE_ID,
    LISTING_CONTROL_SINGLE_WRITER_ACK: process.env.LISTING_CONTROL_SINGLE_WRITER_ACK,
    SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK:
      process.env.SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK,
    SHOPIFY_ROTATION_REFRESH_TOKEN: process.env.SHOPIFY_ROTATION_REFRESH_TOKEN,
  };
  const io = input.io ?? defaultIo;
  try {
    const parsed = parseCredentialAdminArguments(input.argv);
    if (parsed.command === 'help') {
      io.stdout(EBAY_CREDENTIAL_ADMIN_HELP.trimEnd());
      return;
    }
    let result: EbayRotationResult;
    if (parsed.command === 'prepare-consent') {
      result = await beginEbayProductionConsent({
        workDirectory: parsed.localWorkDirectory,
        credentials: beginCredentials(environment),
        dependencies: input.dependencies,
      });
    } else {
      assertEbayProductionRailwayBoundary(environment);
      await ensureEbayProductionPrivateParents();
      if (parsed.command === 'register-consent') {
        result = await registerEbayProductionConsent({
          workDirectory: EBAY_PRODUCTION_WORK_DIRECTORY,
          stateDigest: parsed.stateDigest,
          requestDigest: parsed.requestDigest,
          credentials: beginCredentials(environment),
          dependencies: input.dependencies,
        });
      } else if (parsed.command === 'archive-reset-after-reconciliation') {
        result = await archiveAndResetEbayProductionConsent({
          workDirectory: EBAY_PRODUCTION_WORK_DIRECTORY,
          archiveDirectory: EBAY_PRODUCTION_EVIDENCE_ARCHIVE_DIRECTORY,
          databasePath: EBAY_PRODUCTION_DATABASE_PATH,
          backupDirectory: EBAY_PRODUCTION_BACKUP_DIRECTORY,
          stateDigest: parsed.stateDigest,
          requestDigest: parsed.requestDigest,
          confirmation: parsed.confirmation,
          credentials: beginCredentials(environment),
          dependencies: input.dependencies,
        });
      } else if (parsed.command === 'recover-stale-lock') {
        result = await recoverStaleEbayOperationLock({
          workDirectory: EBAY_PRODUCTION_WORK_DIRECTORY,
          archiveDirectory: EBAY_PRODUCTION_LOCK_ARCHIVE_DIRECTORY,
          ownerId: parsed.ownerId,
          createdAtUtc: parsed.createdAtUtc,
          confirmation: parsed.confirmation,
          dependencies: input.dependencies,
        });
      } else if (parsed.command === 'install') {
        const authorizationResult = await io.readSecret();
        result = await installEbayProductionGrant({
          workDirectory: EBAY_PRODUCTION_WORK_DIRECTORY,
          databasePath: EBAY_PRODUCTION_DATABASE_PATH,
          backupDirectory: EBAY_PRODUCTION_BACKUP_DIRECTORY,
          authorizationResult,
          credentials: rotationCredentials(environment),
          dependencies: input.dependencies,
        });
      } else if (parsed.command === 'verify') {
        result = await verifyInstalledEbayGrant({
          workDirectory: EBAY_PRODUCTION_WORK_DIRECTORY,
          databasePath: EBAY_PRODUCTION_DATABASE_PATH,
          credentials: rotationCredentials(environment),
          dependencies: input.dependencies,
        });
      } else {
        result = await revokeInstalledEbayGrant({
          workDirectory: EBAY_PRODUCTION_WORK_DIRECTORY,
          databasePath: EBAY_PRODUCTION_DATABASE_PATH,
          confirmation: parsed.confirmation,
          credentials: rotationCredentials(environment),
          dependencies: input.dependencies,
        });
      }
    }
    io.stdout(safeSuccess(result));
  } catch (error) {
    const failure = error instanceof EbayRotationError
      ? error
      : new EbayRotationError('EBAY_ROTATION_FAILED_CLOSED');
    io.stderr(safeFailure(failure));
    io.setExitCode(credentialAdminExitCode(
      failure.code,
      failure.effects.reconciliationRequired,
    ));
  }
}
