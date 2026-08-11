import { randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  assertPathInsideRoot,
  canonicalJson,
  type EbayEnvironment,
  OPERATOR_AUDIT_LOG_PATH,
  type OperatorLane,
  sha256Digest,
} from './config.js';

export const DEFAULT_AUDIT_LOG_PATH = OPERATOR_AUDIT_LOG_PATH;
const GENESIS_HASH = 'GENESIS';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const AUDIT_RECORD_KEYS = [
  'schemaVersion',
  'sequence',
  'timestampUtc',
  'runId',
  'command',
  'lane',
  'mode',
  'outcome',
  'configDigest',
  'target',
  'ownershipDigest',
  'checks',
  'previousHash',
  'recordHash',
] as const;

export type AuditOutcome = 'passed' | 'blocked' | 'denied';

export type AuditEventInput = {
  command: 'preflight' | 'ownership';
  lane: OperatorLane | 'unavailable';
  mode: 'read-only' | 'unavailable';
  outcome: AuditOutcome;
  configDigest: string | null;
  target: {
    shopifyStoreDomain: string | null;
    ebayEnvironment: EbayEnvironment | null;
    ebaySellerAccount: string | null;
    marketplaceConnectAccount: string | null;
  };
  ownershipDigest: string | null;
  checks: Array<{
    id: string;
    result: 'pass' | 'block' | 'deny';
  }>;
};

export type AuditRecord = AuditEventInput & {
  schemaVersion: 1;
  sequence: number;
  timestampUtc: string;
  runId: string;
  previousHash: string;
  recordHash: string;
};

export type AuditVerification = {
  valid: boolean;
  recordCount: number;
  headHash: string | null;
  error?: string;
};

export class AuditIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditIntegrityError';
  }
}

function recordWithoutHash(record: AuditRecord): Omit<AuditRecord, 'recordHash'> {
  const { recordHash: _recordHash, ...rest } = record;
  return rest;
}

function calculateRecordHash(record: Omit<AuditRecord, 'recordHash'>): string {
  return sha256Digest(record);
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<AuditRecord>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...AUDIT_RECORD_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return false;
  }
  if (typeof record.target !== 'object' || record.target === null || Array.isArray(record.target)) {
    return false;
  }
  const target = record.target as AuditRecord['target'];
  const targetKeys = Object.keys(target).sort();
  const expectedTargetKeys = [
    'ebayEnvironment',
    'ebaySellerAccount',
    'marketplaceConnectAccount',
    'shopifyStoreDomain',
  ];
  if (
    targetKeys.length !== expectedTargetKeys.length ||
    targetKeys.some((key, index) => key !== expectedTargetKeys[index])
  ) {
    return false;
  }
  const checksAreValid =
    Array.isArray(record.checks) &&
    record.checks.every((check) => {
      if (typeof check !== 'object' || check === null || Array.isArray(check)) return false;
      const checkValue = check as { id?: unknown; result?: unknown };
      const checkKeys = Object.keys(check).sort();
      return (
        checkKeys.length === 2 &&
        checkKeys[0] === 'id' &&
        checkKeys[1] === 'result' &&
        typeof checkValue.id === 'string' &&
        /^[a-z0-9.-]+$/.test(checkValue.id) &&
        ['pass', 'block', 'deny'].includes(String(checkValue.result))
      );
    });
  const timestampIsCanonical =
    typeof record.timestampUtc === 'string' &&
    !Number.isNaN(Date.parse(record.timestampUtc)) &&
    new Date(record.timestampUtc).toISOString() === record.timestampUtc;
  return (
    record.schemaVersion === 1 &&
    Number.isInteger(record.sequence) &&
    typeof record.sequence === 'number' &&
    record.sequence > 0 &&
    timestampIsCanonical &&
    typeof record.runId === 'string' &&
    record.runId.length > 0 &&
    record.runId.length <= 128 &&
    ['preflight', 'ownership'].includes(String(record.command)) &&
    ['development', 'sandbox', 'production-shadow', 'unavailable'].includes(String(record.lane)) &&
    ['read-only', 'unavailable'].includes(String(record.mode)) &&
    ['passed', 'blocked', 'denied'].includes(String(record.outcome)) &&
    (record.configDigest === null ||
      (typeof record.configDigest === 'string' && DIGEST_PATTERN.test(record.configDigest))) &&
    (target.shopifyStoreDomain === null || typeof target.shopifyStoreDomain === 'string') &&
    (target.ebayEnvironment === null || ['sandbox', 'production'].includes(target.ebayEnvironment)) &&
    (target.ebaySellerAccount === null || typeof target.ebaySellerAccount === 'string') &&
    (target.marketplaceConnectAccount === null ||
      typeof target.marketplaceConnectAccount === 'string') &&
    (record.ownershipDigest === null ||
      (typeof record.ownershipDigest === 'string' && DIGEST_PATTERN.test(record.ownershipDigest))) &&
    checksAreValid &&
    (record.previousHash === GENESIS_HASH || DIGEST_PATTERN.test(String(record.previousHash))) &&
    typeof record.recordHash === 'string' &&
    DIGEST_PATTERN.test(record.recordHash)
  );
}

export function verifyAuditText(text: string): AuditVerification {
  if (text === '') return { valid: true, recordCount: 0, headHash: null };
  if (!text.endsWith('\n')) {
    return {
      valid: false,
      recordCount: 0,
      headHash: null,
      error: 'Audit log has an incomplete final line',
    };
  }

  const lines = text.slice(0, -1).split('\n');
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (lines[index].trim() === '') {
      return {
        valid: false,
        recordCount: index,
        headHash: index === 0 ? null : previousHash,
        error: `Audit line ${lineNumber} is empty`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]) as unknown;
    } catch {
      return {
        valid: false,
        recordCount: index,
        headHash: index === 0 ? null : previousHash,
        error: `Audit line ${lineNumber} is not valid JSON`,
      };
    }
    if (!isAuditRecord(parsed)) {
      return {
        valid: false,
        recordCount: index,
        headHash: index === 0 ? null : previousHash,
        error: `Audit line ${lineNumber} has an invalid record shape`,
      };
    }
    if (parsed.sequence !== lineNumber) {
      return {
        valid: false,
        recordCount: index,
        headHash: index === 0 ? null : previousHash,
        error: `Audit line ${lineNumber} has a non-contiguous sequence`,
      };
    }
    if (parsed.previousHash !== previousHash) {
      return {
        valid: false,
        recordCount: index,
        headHash: index === 0 ? null : previousHash,
        error: `Audit line ${lineNumber} does not link to the previous record`,
      };
    }
    const expectedHash = calculateRecordHash(recordWithoutHash(parsed));
    if (parsed.recordHash !== expectedHash) {
      return {
        valid: false,
        recordCount: index,
        headHash: index === 0 ? null : previousHash,
        error: `Audit line ${lineNumber} hash does not match its contents`,
      };
    }
    previousHash = parsed.recordHash;
  }

  return {
    valid: true,
    recordCount: lines.length,
    headHash: lines.length === 0 ? null : previousHash,
  };
}

async function readAuditText(filePath: string, allowMissing: boolean): Promise<string> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) {
    if (allowMissing) return '';
    throw new AuditIntegrityError('Audit log does not exist');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AuditIntegrityError('Audit log must be a regular, non-symlink file');
  }
  return fs.readFile(filePath, 'utf8');
}

async function resolveAuditPath(
  repoRoot: string,
  requestedPath: string,
  createParent: boolean,
): Promise<string> {
  const realRoot = await fs.realpath(repoRoot);
  if (path.normalize(requestedPath) !== OPERATOR_AUDIT_LOG_PATH) {
    throw new AuditIntegrityError(`Audit path must be exactly ${OPERATOR_AUDIT_LOG_PATH}`);
  }
  const localDirectory = path.join(realRoot, '.local');
  const auditDirectory = path.join(localDirectory, 'operator-audit');
  for (const directory of [localDirectory, auditDirectory]) {
    let stat = await fs.lstat(directory).catch(() => null);
    if (!stat && createParent) {
      await fs.mkdir(directory, { mode: 0o700 }).catch(() => undefined);
      stat = await fs.lstat(directory).catch(() => null);
    }
    if (!stat) return path.join(realRoot, OPERATOR_AUDIT_LOG_PATH);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AuditIntegrityError('Audit directory must be a real directory inside the repository');
    }
    const realDirectory = await fs.realpath(directory);
    assertPathInsideRoot(realRoot, realDirectory, 'Audit path');
  }
  const filePath = path.join(realRoot, OPERATOR_AUDIT_LOG_PATH);
  return filePath;
}

export async function verifyAuditLog(
  repoRoot: string,
  requestedPath: string,
  allowMissing = false,
): Promise<AuditVerification> {
  const filePath = await resolveAuditPath(repoRoot, requestedPath, false);
  try {
    return verifyAuditText(await readAuditText(filePath, allowMissing));
  } catch (error) {
    if (error instanceof AuditIntegrityError) {
      return { valid: false, recordCount: 0, headHash: null, error: error.message };
    }
    throw error;
  }
}

export async function appendAuditRecord(
  repoRoot: string,
  requestedPath: string,
  input: AuditEventInput,
  options: {
    now?: () => Date;
    createRunId?: () => string;
  } = {},
): Promise<AuditRecord> {
  // Refuse arbitrary secret-shaped data before it can reach disk.
  const serializedInput = canonicalJson(input);
  if (/(?:token|secret|password|credential|authorization|cookie)/i.test(serializedInput)) {
    throw new AuditIntegrityError('Audit event contains a forbidden credential-like field');
  }

  const filePath = await resolveAuditPath(repoRoot, requestedPath, true);
  const lockPath = `${filePath}.lock`;
  let lockHandle: FileHandle | undefined;
  try {
    lockHandle = await fs.open(lockPath, 'wx', 0o600);
  } catch {
    throw new AuditIntegrityError('Audit log is locked by another or interrupted writer');
  }

  try {
    const beforeText = await readAuditText(filePath, true);
    const before = verifyAuditText(beforeText);
    if (!before.valid) {
      throw new AuditIntegrityError(`Refusing to append to an invalid audit log: ${before.error}`);
    }

    const withoutHash: Omit<AuditRecord, 'recordHash'> = {
      schemaVersion: 1,
      sequence: before.recordCount + 1,
      timestampUtc: (options.now ?? (() => new Date()))().toISOString(),
      runId: (options.createRunId ?? randomUUID)(),
      ...input,
      previousHash: before.headHash ?? GENESIS_HASH,
    };
    const record: AuditRecord = {
      ...withoutHash,
      recordHash: calculateRecordHash(withoutHash),
    };

    const handle = await fs.open(filePath, 'a', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${canonicalJson(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    const after = verifyAuditText(await readAuditText(filePath, false));
    if (!after.valid || after.headHash !== record.recordHash) {
      throw new AuditIntegrityError(`Audit verification failed after append: ${after.error ?? 'head mismatch'}`);
    }
    return record;
  } finally {
    await lockHandle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}
