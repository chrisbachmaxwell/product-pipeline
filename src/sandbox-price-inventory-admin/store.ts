import { randomUUID } from 'node:crypto';
import { closeSync, chmodSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  SANDBOX_ALIGNMENT_SCOPE_DIGEST,
  SandboxAlignmentError,
  assertDigest,
  deny,
  digest,
  type SandboxAlignmentManifest,
} from './contracts.js';

const APPLICATION_ID = 0x53504941;
const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 16 * 1024 * 1024;

function assertParent(storePath: string): void {
  if (!path.isAbsolute(storePath) || path.extname(storePath) !== '.sqlite') deny('STORE_PATH_INVALID');
  const parent = path.dirname(storePath);
  const parentStat = lstatSync(parent);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o777) !== 0o700 || parentStat.uid !== currentUid) {
    deny('STORE_PARENT_UNTRUSTED');
  }
  if (realpathSync(parent) !== parent) deny('STORE_PARENT_UNTRUSTED');
}

function assertFile(storePath: string): void {
  const fileStat = lstatSync(storePath);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1
    || (fileStat.mode & 0o777) !== 0o600 || fileStat.uid !== currentUid
    || fileStat.size <= 0 || fileStat.size > MAX_STORE_BYTES) {
    deny('STORE_FILE_UNTRUSTED');
  }
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      lstatSync(`${storePath}${suffix}`);
      deny('STORE_SIDECAR_PRESENT');
    } catch (error) {
      if (error instanceof SandboxAlignmentError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') deny('STORE_FILE_UNTRUSTED');
    }
  }
}

function auditDigest(input: {
  sequence: number; occurredAtUtc: string; eventType: string; subject: string;
  payloadDigest: string; stateDigest: string | null; previousDigest: string | null;
}): string {
  return digest(input);
}

export type StoredIntent = Readonly<{
  manifestDigest: `sha256:${string}`;
  manifest: SandboxAlignmentManifest;
  status: string;
  approvalId: string | null;
  approvalTokenDigest: string | null;
  approvalDigest: string | null;
  approvalExpiresAtUtc: string | null;
  approvalConsumedAtUtc: string | null;
  attemptId: string | null;
  providerOutcome: string | null;
  resolution: string | null;
}>;

export class SandboxAlignmentStore {
  constructor(private readonly db: InstanceType<typeof Database>) {}

  close(): void { this.db.close(); }

  private appendAudit(eventType: string, subject: string, payload: unknown, occurredAtUtc: string,
    stateDigest: string | null = null): void {
    const prior = this.db.prepare('SELECT sequence, digest FROM audit ORDER BY sequence DESC LIMIT 1')
      .get() as { sequence: number; digest: string } | undefined;
    const sequence = (prior?.sequence ?? 0) + 1;
    const payloadDigest = digest(payload);
    const rowDigest = auditDigest({ sequence, occurredAtUtc, eventType, subject, payloadDigest,
      stateDigest, previousDigest: prior?.digest ?? null });
    this.db.prepare(`INSERT INTO audit
      (sequence, occurred_at_utc, event_type, subject, payload_digest, state_digest, previous_digest, digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sequence, occurredAtUtc, eventType, subject, payloadDigest, stateDigest,
        prior?.digest ?? null, rowDigest);
  }

  private computeIntentStateDigest(manifestDigest: string): string {
    const row = this.db.prepare(`SELECT manifest_digest, manifest_json, action, listing_id, offer_id,
      status, created_at_utc, approval_id, approval_token_digest, approval_digest,
      approval_expires_at_utc, approval_consumed_at_utc, attempt_id, provider_outcome,
      resolution, resolved_at_utc FROM intents WHERE manifest_digest = ?`).get(manifestDigest);
    if (!row) deny('STORE_AUDIT_INVALID');
    return digest(row);
  }

  private sealIntent(manifestDigest: string): string {
    const stateDigest = this.computeIntentStateDigest(manifestDigest);
    this.db.prepare('UPDATE intents SET state_digest = ? WHERE manifest_digest = ?')
      .run(stateDigest, manifestDigest);
    return stateDigest;
  }

  recordInitialization(now: string): void {
    this.appendAudit('store-initialized', SANDBOX_ALIGNMENT_SCOPE_DIGEST, { schemaVersion: 1 }, now);
  }

  verify(): Readonly<{ schemaVersion: 1; scopeDigest: string; auditValid: true; intentCount: number }> {
    const applicationId = this.db.pragma('application_id', { simple: true });
    const userVersion = this.db.pragma('user_version', { simple: true });
    if (applicationId !== APPLICATION_ID || userVersion !== SCHEMA_VERSION
      || this.db.pragma('integrity_check', { simple: true }) !== 'ok') deny('STORE_SCHEMA_INVALID');
    const metadata = this.db.prepare('SELECT scope_digest FROM metadata WHERE singleton = 1')
      .get() as { scope_digest: string } | undefined;
    if (!metadata || metadata.scope_digest !== SANDBOX_ALIGNMENT_SCOPE_DIGEST) {
      throw new SandboxAlignmentError('STORE_SCOPE_MISMATCH');
    }
    const scopeDigest = metadata.scope_digest;
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY sequence').all() as Array<Record<string, unknown>>;
    let previous: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.sequence !== index + 1 || row.previous_digest !== previous) deny('STORE_AUDIT_INVALID');
      const expected = auditDigest({
        sequence: row.sequence as number,
        occurredAtUtc: row.occurred_at_utc as string,
        eventType: row.event_type as string,
        subject: row.subject as string,
        payloadDigest: row.payload_digest as string,
        stateDigest: row.state_digest as string | null,
        previousDigest: row.previous_digest as string | null,
      });
      if (expected !== row.digest) deny('STORE_AUDIT_INVALID');
      previous = row.digest as string;
    }
    const intents = this.db.prepare('SELECT manifest_digest, manifest_json, state_digest FROM intents').all() as unknown as
      Array<{ manifest_digest: string; manifest_json: string; state_digest: string }>;
    for (const intent of intents) {
      let manifest: unknown;
      try { manifest = JSON.parse(intent.manifest_json) as unknown; } catch { deny('STORE_AUDIT_INVALID'); }
      if (digest(manifest) !== intent.manifest_digest) deny('STORE_AUDIT_INVALID');
      if (this.computeIntentStateDigest(intent.manifest_digest) !== intent.state_digest) deny('STORE_AUDIT_INVALID');
      const seal = this.db.prepare(`SELECT state_digest FROM audit WHERE subject = ? AND state_digest IS NOT NULL
        ORDER BY sequence DESC LIMIT 1`).get(intent.manifest_digest) as { state_digest: string } | undefined;
      if (seal?.state_digest !== intent.state_digest) deny('STORE_AUDIT_INVALID');
    }
    const observations = this.db.prepare(`SELECT observation_id, manifest_digest, effect, observed_digest,
      observed_at_utc, state_digest FROM observations`).all() as Array<Record<string, unknown>>;
    for (const observation of observations) {
      const rowDigest = digest({ observation_id: observation.observation_id,
        manifest_digest: observation.manifest_digest, effect: observation.effect,
        observed_digest: observation.observed_digest, observed_at_utc: observation.observed_at_utc });
      const seal = this.db.prepare(`SELECT state_digest FROM audit WHERE subject = ? AND state_digest IS NOT NULL
        ORDER BY sequence DESC LIMIT 1`).get(observation.observation_id) as { state_digest: string } | undefined;
      if (observation.state_digest !== rowDigest || seal?.state_digest !== rowDigest) deny('STORE_AUDIT_INVALID');
    }
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM intents').get() as { count: number };
    return Object.freeze({ schemaVersion: 1, scopeDigest, auditValid: true, intentCount: count.count });
  }

  recordIntent(manifestDigest: `sha256:${string}`, manifest: SandboxAlignmentManifest, now: string): void {
    const transaction = this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM intents WHERE manifest_digest = ?').get(manifestDigest)) {
        deny('INTENT_ALREADY_EXISTS');
      }
      this.db.prepare(`INSERT INTO intents
        (manifest_digest, manifest_json, action, listing_id, offer_id, status, created_at_utc)
        VALUES (?, ?, ?, ?, ?, 'preflighted', ?)`)
        .run(manifestDigest, JSON.stringify(manifest), manifest.action, manifest.target.listingId, manifest.target.offerId, now);
      const stateDigest = this.sealIntent(manifestDigest);
      this.appendAudit('intent-preflighted', manifestDigest, { manifestDigest, action: manifest.action }, now, stateDigest);
    });
    transaction.immediate();
  }

  approve(manifestDigest: string, now: string, expiresAtUtc: string): Readonly<{
    approvalId: string; approvalToken: string; approvalDigest: `sha256:${string}`;
  }> {
    assertDigest(manifestDigest);
    const approvalId = `sandbox-approval:${randomUUID()}`;
    const approvalToken = `sandbox-approval-token:${randomUUID()}`;
    const approvalTokenDigest = digest({ approvalToken, manifestDigest });
    let approvalDigest: `sha256:${string}` = digest('uninitialized');
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT status, approval_id, action FROM intents WHERE manifest_digest = ?')
        .get(manifestDigest) as { status: string; approval_id: string | null; action: string } | undefined;
      if (!row || row.status !== 'preflighted' || row.approval_id !== null) {
        throw new SandboxAlignmentError('APPROVAL_DENIED');
      }
      approvalDigest = digest({ schemaVersion: 1, manifestDigest, action: row.action, approvalId,
        approvalTokenDigest, expiresAtUtc });
      this.db.prepare(`UPDATE intents SET status = 'approved', approval_id = ?, approval_token_digest = ?,
        approval_digest = ?, approval_expires_at_utc = ? WHERE manifest_digest = ?`)
        .run(approvalId, approvalTokenDigest, approvalDigest, expiresAtUtc, manifestDigest);
      const stateDigest = this.sealIntent(manifestDigest);
      this.appendAudit('approval-issued', manifestDigest,
        { approvalId, manifestDigest, approvalDigest, expiresAtUtc }, now, stateDigest);
    });
    transaction.immediate();
    return Object.freeze({ approvalId, approvalToken, approvalDigest });
  }

  getIntent(manifestDigest: string): StoredIntent {
    assertDigest(manifestDigest);
    const row = this.db.prepare('SELECT * FROM intents WHERE manifest_digest = ?').get(manifestDigest) as Record<string, unknown> | undefined;
    if (!row) throw new SandboxAlignmentError('INTENT_NOT_FOUND');
    return Object.freeze({
      manifestDigest: row.manifest_digest as `sha256:${string}`,
      manifest: JSON.parse(row.manifest_json as string) as SandboxAlignmentManifest,
      status: row.status as string,
      approvalId: row.approval_id as string | null,
      approvalTokenDigest: row.approval_token_digest as string | null,
      approvalDigest: row.approval_digest as string | null,
      approvalExpiresAtUtc: row.approval_expires_at_utc as string | null,
      approvalConsumedAtUtc: row.approval_consumed_at_utc as string | null,
      attemptId: row.attempt_id as string | null,
      providerOutcome: row.provider_outcome as string | null,
      resolution: row.resolution as string | null,
    });
  }

  beginDispatch(manifestDigest: string, approvalToken: string, approvalDigest: string, now: string): string {
    assertDigest(approvalDigest);
    const attemptId = `sandbox-attempt:${randomUUID()}`;
    const transaction = this.db.transaction(() => {
      const intent = this.getIntent(manifestDigest);
      if (intent.status !== 'approved' || intent.approvalConsumedAtUtc !== null
        || intent.attemptId !== null || intent.approvalExpiresAtUtc === null
        || Date.parse(intent.approvalExpiresAtUtc) <= Date.parse(now)
        || intent.approvalDigest !== approvalDigest
        || intent.approvalTokenDigest !== digest({ approvalToken, manifestDigest })) {
        deny('DISPATCH_APPROVAL_DENIED');
      }
      this.db.prepare(`UPDATE intents SET status = 'dispatching', approval_consumed_at_utc = ?, attempt_id = ?
        WHERE manifest_digest = ?`).run(now, attemptId, manifestDigest);
      const stateDigest = this.sealIntent(manifestDigest);
      this.appendAudit('dispatch-started', manifestDigest,
        { attemptId, manifestDigest, approvalId: intent.approvalId }, now, stateDigest);
    });
    transaction.immediate();
    return attemptId;
  }

  markReconciliationRequired(manifestDigest: string, providerOutcome: 'reported-success' | 'unknown', now: string): void {
    const transaction = this.db.transaction(() => {
      const intent = this.getIntent(manifestDigest);
      if (intent.status !== 'dispatching') deny('DISPATCH_STATE_CONFLICT');
      this.db.prepare(`UPDATE intents SET status = 'reconciliation_required', provider_outcome = ?
        WHERE manifest_digest = ?`).run(providerOutcome, manifestDigest);
      const stateDigest = this.sealIntent(manifestDigest);
      this.appendAudit('reconciliation-required', manifestDigest,
        { attemptId: intent.attemptId, manifestDigest, providerOutcome }, now, stateDigest);
    });
    transaction.immediate();
  }

  recordObservation(manifestDigest: string, effect: string, observedDigest: string, now: string): string {
    const observationId = `sandbox-observation:${randomUUID()}`;
    const transaction = this.db.transaction(() => {
      const intent = this.getIntent(manifestDigest);
      if (intent.status !== 'reconciliation_required') deny('RECONCILIATION_STATE_CONFLICT');
      const observationStateDigest = digest({ observation_id: observationId, manifest_digest: manifestDigest,
        effect, observed_digest: observedDigest, observed_at_utc: now });
      this.db.prepare(`INSERT INTO observations
        (observation_id, manifest_digest, effect, observed_digest, observed_at_utc, state_digest)
        VALUES (?, ?, ?, ?, ?, ?)`).run(observationId, manifestDigest, effect, observedDigest, now,
        observationStateDigest);
      this.appendAudit('state-observed', observationId, { manifestDigest, effect, observedDigest }, now,
        observationStateDigest);
      if (effect === 'effect_observed') {
        this.db.prepare(`UPDATE intents SET status = 'resolved', resolution = 'resolved-existing', resolved_at_utc = ?
          WHERE manifest_digest = ?`).run(now, manifestDigest);
        const stateDigest = this.sealIntent(manifestDigest);
        this.appendAudit('attempt-resolved', manifestDigest,
          { attemptId: intent.attemptId, manifestDigest, resolution: 'resolved-existing', observationId },
          now, stateDigest);
      }
    });
    transaction.immediate();
    return observationId;
  }
}

const SCHEMA = `
CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), scope_digest TEXT NOT NULL);
CREATE TABLE intents (
  manifest_digest TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, action TEXT NOT NULL,
  listing_id TEXT NOT NULL, offer_id TEXT NOT NULL, status TEXT NOT NULL, created_at_utc TEXT NOT NULL,
  approval_id TEXT UNIQUE, approval_token_digest TEXT, approval_digest TEXT,
  approval_expires_at_utc TEXT, approval_consumed_at_utc TEXT,
  attempt_id TEXT UNIQUE, provider_outcome TEXT, resolution TEXT, resolved_at_utc TEXT,
  state_digest TEXT NOT NULL DEFAULT ''
);
CREATE TABLE observations (
  observation_id TEXT PRIMARY KEY, manifest_digest TEXT NOT NULL REFERENCES intents(manifest_digest),
  effect TEXT NOT NULL, observed_digest TEXT NOT NULL, observed_at_utc TEXT NOT NULL,
  state_digest TEXT NOT NULL
);
CREATE TABLE audit (
  sequence INTEGER PRIMARY KEY, occurred_at_utc TEXT NOT NULL, event_type TEXT NOT NULL,
  subject TEXT NOT NULL, payload_digest TEXT NOT NULL, state_digest TEXT,
  previous_digest TEXT, digest TEXT NOT NULL UNIQUE
);`;

export function initializeSandboxAlignmentStore(storePath: string, confirmScope: string, now: string): SandboxAlignmentStore {
  assertDigest(confirmScope);
  if (confirmScope !== SANDBOX_ALIGNMENT_SCOPE_DIGEST) deny('STORE_SCOPE_MISMATCH');
  assertParent(storePath);
  let descriptor: number;
  try {
    descriptor = openSync(storePath, 'wx', 0o600);
  } catch {
    return deny('STORE_ALREADY_EXISTS');
  }
  closeSync(descriptor);
  chmodSync(storePath, 0o600);
  const emptyStat = lstatSync(storePath);
  if (!emptyStat.isFile() || emptyStat.isSymbolicLink() || emptyStat.nlink !== 1
    || (emptyStat.mode & 0o777) !== 0o600 || emptyStat.uid !== process.getuid?.()
    || emptyStat.size !== 0) deny('STORE_FILE_UNTRUSTED');
  const db = new Database(storePath, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = ON');
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec(SCHEMA);
    db.prepare('INSERT INTO metadata (singleton, scope_digest) VALUES (1, ?)').run(SANDBOX_ALIGNMENT_SCOPE_DIGEST);
    const store = new SandboxAlignmentStore(db);
    store.recordInitialization(now);
    store.verify();
    return store;
  } catch (error) {
    db.close();
    if (error instanceof SandboxAlignmentError) throw error;
    return deny('STORE_INITIALIZATION_FAILED');
  }
}

export function openSandboxAlignmentStore(storePath: string): SandboxAlignmentStore {
  assertParent(storePath);
  assertFile(storePath);
  const before = statSync(storePath);
  const db = new Database(storePath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = DELETE');
    const after = statSync(storePath);
    if (before.dev !== after.dev || before.ino !== after.ino) deny('STORE_FILE_UNTRUSTED');
    const store = new SandboxAlignmentStore(db);
    store.verify();
    return store;
  } catch (error) {
    db.close();
    if (error instanceof SandboxAlignmentError) throw error;
    return deny('STORE_OPEN_FAILED');
  }
}
