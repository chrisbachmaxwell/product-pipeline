import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveAndResetEbayProductionConsent,
  beginEbayProductionConsent,
  createBoundedEbayProviderTransport,
  EBAY_PRODUCTION_SCOPES,
  EBAY_RECONCILIATION_RESET_CONFIRMATION,
  EBAY_REVOKE_CONFIRMATION,
  EBAY_STALE_LOCK_RECOVERY_CONFIRMATION,
  EbayRotationError,
  installEbayProductionGrant,
  recoverStaleEbayOperationLock,
  registerEbayProductionConsent,
  revokeInstalledEbayGrant,
  type EbayProviderRequest,
  type EbayProviderTransport,
  verifyInstalledEbayGrant,
} from './ebay-rotation.js';
import {
  assertEbayProductionRailwayBoundary,
  EBAY_ROTATION_RAILWAY_ENVIRONMENT_ID,
  EBAY_ROTATION_RAILWAY_PROJECT_ID,
  EBAY_ROTATION_RAILWAY_SERVICE_ID,
  credentialAdminExitCode,
  parseCredentialAdminArguments,
  runCredentialAdmin,
  type CredentialAdminIo,
} from './ebay-program.js';

const NOW = new Date('2026-08-14T20:00:00.000Z');
const CREDENTIALS = Object.freeze({
  appId: 'production-app-id',
  ruName: 'production-runame',
  newCertId: 'new-production-cert',
});
const ACCESS_TOKEN = 'new-user-access-authority';
const REFRESH_TOKEN = 'new-user-refresh-authority';
const OLD_ACCESS_TOKEN = 'old-user-access-authority';
const OLD_REFRESH_TOKEN = 'old-user-refresh-authority';
const AUTHORIZATION_CODE = 'single-use-authorization-code';
const SCOPE = [...EBAY_PRODUCTION_SCOPES].sort().join(' ');

type Fixture = Readonly<{
  root: string;
  workDirectory: string;
  backupDirectory: string;
  databasePath: string;
}>;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(includeEbay = true): Promise<Fixture> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ebay-credential-admin-'));
  const root = await fs.realpath(temporary);
  roots.push(root);
  await fs.chmod(root, 0o700);
  const databasePath = path.join(root, 'ebaysync.sqlite');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE auth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  database.prepare(
    `INSERT INTO auth_tokens (
       platform, access_token, refresh_token, scope, expires_at, created_at, updated_at
     ) VALUES ('shopify', ?, NULL, 'read_products', NULL, 100, 100)`,
  ).run('shopify-authority-must-not-change');
  if (includeEbay) {
    database.prepare(
      `INSERT INTO auth_tokens (
         platform, access_token, refresh_token, scope, expires_at, created_at, updated_at
       ) VALUES ('ebay', ?, ?, 'legacy-scope', 200, 100, 100)`,
    ).run(OLD_ACCESS_TOKEN, OLD_REFRESH_TOKEN);
  }
  database.close();
  await fs.chmod(databasePath, 0o600);
  return Object.freeze({
    root,
    workDirectory: path.join(root, 'consent'),
    backupDirectory: path.join(root, 'backups'),
    databasePath,
  });
}

function rows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare('SELECT * FROM auth_tokens ORDER BY id').all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

async function callbackFor(workDirectory: string, stateOverride?: string): Promise<string> {
  const text = await fs.readFile(path.join(workDirectory, 'consent-url.txt'), 'utf8');
  const consent = new URL(text.trim());
  const state = stateOverride ?? consent.searchParams.get('state')!;
  const callback = new URL('https://operator.example.invalid/ebay/accepted');
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', AUTHORIZATION_CODE);
  callback.searchParams.set('expires_in', '299');
  return callback.toString();
}

async function begin(target: Fixture): Promise<string> {
  const result = await beginEbayProductionConsent({
    workDirectory: target.workDirectory,
    credentials: CREDENTIALS,
    dependencies: {
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 7),
    },
  });
  expect(result).toMatchObject({
    code: 'EBAY_CONSENT_PREPARED',
    commerceWritesPerformed: 0,
    historicalOrdersTouched: 0,
  });
  return callbackFor(target.workDirectory);
}

class FakeProvider {
  readonly requests: EbayProviderRequest[] = [];
  readonly revoked = new Set<string>();
  seller = 'usedcameragear';
  scopes = SCOPE;
  failRevoke = false;
  failExchange = false;
  tradingBody: string | null = null;
  beforeExchange: (() => void | Promise<void>) | null = null;

  readonly transport: EbayProviderTransport = async (request) => {
    this.requests.push(request);
    if (request.url.includes('sandbox')) throw new Error('sandbox denied');
    if (request.url === 'https://api.ebay.com/identity/v1/oauth2/token') {
      const body = new URLSearchParams(request.body);
      if (body.get('grant_type') === 'authorization_code') {
        await this.beforeExchange?.();
        if (this.failExchange) throw new Error('ambiguous token exchange transport failure');
        expect(body.get('code')).toBe(AUTHORIZATION_CODE);
        expect(body.get('redirect_uri')).toBe(CREDENTIALS.ruName);
        return {
          status: 200,
          bodyText: JSON.stringify({
            access_token: ACCESS_TOKEN,
            refresh_token: REFRESH_TOKEN,
            expires_in: 7_200,
            refresh_token_expires_in: 47_304_000,
            token_type: 'User Access Token',
          }),
        };
      }
      throw new Error('unexpected token mint');
    }
    if (request.url === 'https://api.ebay.com/identity/v1/oauth2/token/introspect') {
      const body = new URLSearchParams(request.body);
      const token = body.get('token')!;
      if (this.revoked.has(token)) return { status: 200, bodyText: '{"active":false}' };
      return {
        status: 200,
        bodyText: JSON.stringify({
          active: true,
          scope: this.scopes,
          client_id: CREDENTIALS.appId,
          username: this.seller,
          token_type: 'Bearer',
          aud: 'https://api.ebay.com',
        }),
      };
    }
    if (request.url === 'https://api.ebay.com/ws/api.dll') {
      expect(request.headers['X-EBAY-API-CALL-NAME']).toBe('GetUser');
      expect(request.headers['X-EBAY-API-SITEID']).toBe('0');
      return {
        status: 200,
        bodyText: this.tradingBody
          ?? `<?xml version="1.0" encoding="utf-8"?><GetUserResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><User><UserID>${this.seller}</UserID></User></GetUserResponse>`,
      };
    }
    if (request.url.startsWith('https://api.ebay.com/sell/inventory/v1/inventory_item?')) {
      return { status: 200, bodyText: '{"total":0,"inventoryItems":[]}' };
    }
    if (request.url === 'https://api.ebay.com/identity/v1/oauth2/token/revoke') {
      if (this.failRevoke) return { status: 503, bodyText: '' };
      const token = new URLSearchParams(request.body).get('token')!;
      this.revoked.add(token);
      return { status: 200, bodyText: '' };
    }
    throw new Error('unexpected provider request');
  };
}

function assertNewCertOnly(requests: readonly EbayProviderRequest[]): void {
  const expected = `Basic ${Buffer.from(`${CREDENTIALS.appId}:${CREDENTIALS.newCertId}`).toString('base64')}`;
  for (const request of requests.filter((entry) => entry.url.includes('/identity/v1/oauth2/token'))) {
    expect(request.headers.Authorization).toBe(expected);
  }
}

async function install(target: Fixture, provider: FakeProvider) {
  const authorizationResult = await begin(target);
  return installEbayProductionGrant({
    workDirectory: target.workDirectory,
    databasePath: target.databasePath,
    backupDirectory: target.backupDirectory,
    authorizationResult,
    credentials: CREDENTIALS,
    dependencies: {
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 9),
      transport: provider.transport,
    },
  });
}

describe('eBay Production credential administrator', () => {
  it('pins exactly the mounted Production base and Inventory scopes', () => {
    expect(EBAY_PRODUCTION_SCOPES).toEqual([
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
    ]);
  });

  it('creates a private one-use state record without recording the raw state', async () => {
    const target = await fixture();
    await begin(target);
    const stateText = await fs.readFile(path.join(target.workDirectory, 'consent-state.json'), 'utf8');
    const consentText = await fs.readFile(path.join(target.workDirectory, 'consent-url.txt'), 'utf8');
    const state = new URL(consentText.trim()).searchParams.get('state')!;
    expect(stateText).not.toContain(state);
    expect(stateText).not.toContain('access_token');
    expect(stateText).not.toContain('refresh_token');
    expect((await fs.stat(target.workDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(target.workDirectory, 'consent-state.json'))).mode & 0o777)
      .toBe(0o600);
    expect((await fs.stat(path.join(target.workDirectory, 'consent-url.txt'))).mode & 0o777)
      .toBe(0o600);
  });

  it('registers only consent digests at the fixed-purpose remote boundary', async () => {
    const target = await fixture();
    const authorizationResult = await begin(target);
    const localStateText = await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    );
    const localState = JSON.parse(localStateText) as Record<string, unknown>;
    const consentText = await fs.readFile(path.join(target.workDirectory, 'consent-url.txt'), 'utf8');
    const rawState = new URL(consentText.trim()).searchParams.get('state')!;
    const remoteWorkDirectory = path.join(target.root, 'remote-consent');

    const result = await registerEbayProductionConsent({
      workDirectory: remoteWorkDirectory,
      stateDigest: localState.stateDigest as string,
      requestDigest: localState.requestDigest as string,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW },
    });

    expect(result.code).toBe('EBAY_CONSENT_REGISTERED');
    const remoteStateText = await fs.readFile(
      path.join(remoteWorkDirectory, 'consent-state.json'),
      'utf8',
    );
    expect(remoteStateText).not.toContain(rawState);
    expect(remoteStateText).not.toContain(AUTHORIZATION_CODE);
    expect(JSON.parse(remoteStateText)).toMatchObject({
      stateDigest: localState.stateDigest,
      requestDigest: localState.requestDigest,
      consentArtifact: 'external',
      status: 'pending',
    });
    await expect(fs.access(path.join(remoteWorkDirectory, 'consent-url.txt'))).rejects.toThrow();

    const provider = new FakeProvider();
    await installEbayProductionGrant({
      workDirectory: remoteWorkDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    });
    expect(rows(target.databasePath).find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
    });
  });

  it('validates the Production grant and CAS-updates only the eBay row after a private backup', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    const result = await install(target, provider);
    expect(result).toEqual({
      ok: true,
      code: 'EBAY_GRANT_INSTALLED',
      environment: 'production',
      sellerVerified: true,
      scopesVerified: true,
      backupCreated: true,
      databaseRowsChanged: 1,
      credentialProviderMutation: true,
      commerceWritesPerformed: 0,
      historicalOrdersTouched: 0,
    });
    const after = rows(target.databasePath);
    expect(after.find((row) => row.platform === 'shopify'))
      .toEqual(before.find((row) => row.platform === 'shopify'));
    expect(after.find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      scope: SCOPE,
    });
    const backupFiles = await fs.readdir(target.backupDirectory);
    expect(backupFiles).toHaveLength(1);
    const backupPath = path.join(target.backupDirectory, backupFiles[0]!);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
    expect(rows(backupPath)).toEqual(before);
    await expect(fs.access(path.join(target.workDirectory, 'consent-url.txt'))).rejects.toThrow();
    const stateText = await fs.readFile(path.join(target.workDirectory, 'consent-state.json'), 'utf8');
    const state = JSON.parse(stateText) as Record<string, unknown>;
    const installation = state.installation as Record<string, unknown>;
    expect(installation.accessTokenDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(installation.refreshTokenDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(installation.accessTokenDigest).not.toBe(installation.refreshTokenDigest);
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, AUTHORIZATION_CODE, CREDENTIALS.newCertId]) {
      expect(stateText).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(JSON.stringify(result)).not.toContain(String(installation.accessTokenDigest));
    expect(JSON.stringify(result)).not.toContain(String(installation.refreshTokenDigest));
    assertNewCertOnly(provider.requests);
  });

  it('CAS-inserts one eBay row when none exists and preserves the unrelated row', async () => {
    const target = await fixture(false);
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    await install(target, provider);
    const after = rows(target.databasePath);
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.platform === 'shopify')).toEqual(before[0]);
    expect(after.find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      scope: SCOPE,
    });
  });

  it('durably syncs the digest-bearing commit intent before the ledger CAS', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    const events: string[] = [];
    await installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => NOW,
        transport: provider.transport,
        afterDirectorySync: async (_directory, phase) => {
          if (phase !== 'state-replace') return;
          const state = JSON.parse(await fs.readFile(
            path.join(target.workDirectory, 'consent-state.json'),
            'utf8',
          )) as Record<string, unknown>;
          events.push(`state-synced:${String(state.status)}:${String(state.databaseEffect)}`);
        },
        beforeLedgerCas: async () => {
          const state = JSON.parse(await fs.readFile(
            path.join(target.workDirectory, 'consent-state.json'),
            'utf8',
          )) as Record<string, unknown>;
          expect(state).toMatchObject({
            status: 'installing',
            databaseEffect: 'commit-pending',
            installation: {
              accessTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              refreshTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            },
          });
          events.push('ledger-cas');
        },
      },
    });
    expect(events).toContain('state-synced:installing:commit-pending');
    expect(events.indexOf('state-synced:installing:commit-pending'))
      .toBeLessThan(events.indexOf('ledger-cas'));
  });

  it('fails closed before CAS when the commit-intent directory sync fails', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let casCalled = false;
    let injected = false;
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => NOW,
        transport: provider.transport,
        beforeDirectorySync: async (_directory, phase) => {
          if (phase !== 'state-replace' || injected) return;
          const state = JSON.parse(await fs.readFile(
            path.join(target.workDirectory, 'consent-state.json'),
            'utf8',
          )) as Record<string, unknown>;
          if (state.databaseEffect === 'commit-pending') {
            injected = true;
            throw new Error('simulated commit-intent directory fsync failure');
          }
        },
        beforeLedgerCas: () => { casCalled = true; },
      },
    })).rejects.toMatchObject({
      code: 'EBAY_ROTATION_FILE_BOUNDARY_DENIED',
      effects: {
        databaseRowsChanged: 0,
        credentialProviderMutation: true,
        reconciliationRequired: false,
      },
    });
    expect(injected).toBe(true);
    expect(casCalled).toBe(false);
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'failed-revoked',
      databaseEffect: 'none',
      terminalCode: 'EBAY_ROTATION_FILE_BOUNDARY_DENIED',
    });
  });

  it('reconciles a durable commit-pending intent after a crash immediately following COMMIT', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let durableCommitIntent: string | null = null;
    await installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => NOW,
        transport: provider.transport,
        afterDirectorySync: async (_directory, phase) => {
          if (phase !== 'state-replace') return;
          const stateText = await fs.readFile(
            path.join(target.workDirectory, 'consent-state.json'),
            'utf8',
          );
          const state = JSON.parse(stateText) as Record<string, unknown>;
          if (state.databaseEffect === 'commit-pending') durableCommitIntent = stateText;
        },
      },
    });
    expect(durableCommitIntent).not.toBeNull();

    const statePath = path.join(target.workDirectory, 'consent-state.json');
    await fs.writeFile(statePath, durableCommitIntent!, { mode: 0o600 });
    const stateHandle = await fs.open(statePath, 'r');
    await stateHandle.sync();
    await stateHandle.close();
    const directoryHandle = await fs.open(target.workDirectory, 'r');
    await directoryHandle.sync();
    await directoryHandle.close();

    const verified = await verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => new Date(NOW.getTime() + 1_000), transport: provider.transport },
    });
    expect(verified.code).toBe('EBAY_GRANT_VERIFIED');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toMatchObject({
      status: 'installed',
      databaseEffect: 'committed',
      installation: {
        rowId: expect.any(Number),
        committedAtUtc: new Date(NOW.getTime() + 1_000).toISOString(),
      },
    });
  });

  it('rejects a wrong state before provider access and leaves consent pending', async () => {
    const target = await fixture();
    await begin(target);
    const provider = new FakeProvider();
    const authorizationResult = await callbackFor(target.workDirectory, Buffer.alloc(32, 4).toString('base64url'));
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_AUTH_RESULT_MISMATCH' });
    expect(provider.requests).toHaveLength(0);
    expect(JSON.parse(await fs.readFile(path.join(target.workDirectory, 'consent-state.json'), 'utf8')).status)
      .toBe('pending');
    await expect(fs.access(path.join(target.workDirectory, 'consent-url.txt'))).resolves.toBeUndefined();
  });

  it('consumes state once and rejects a replay without another provider exchange', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    });
    const requestCount = provider.requests.length;
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_STATE_ALREADY_USED' });
    expect(provider.requests).toHaveLength(requestCount);
  });

  it('backs up and fixes the baseline before exchange, then quarantines an ambiguous exchange', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    provider.failExchange = true;
    let backupObservedBeforeExchange = false;
    provider.beforeExchange = async () => {
      const names = await fs.readdir(target.backupDirectory);
      backupObservedBeforeExchange = names.length === 1;
    };
    const authorizationResult = await begin(target);

    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_CLEANUP_REQUIRED' });

    expect(backupObservedBeforeExchange).toBe(true);
    expect(rows(target.databasePath)).toEqual(before);
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'failed-cleanup-required',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
    });
    const requestCount = provider.requests.length;
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_STATE_ALREADY_USED' });
    expect(provider.requests).toHaveLength(requestCount);
  });

  it('archives terminal evidence and permits a fresh consent only after exact reconciliation confirmation', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    provider.failExchange = true;
    const firstAuthorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult: firstAuthorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_CLEANUP_REQUIRED' });

    const localFreshDirectory = path.join(target.root, 'fresh-local-consent');
    await beginEbayProductionConsent({
      workDirectory: localFreshDirectory,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size) => Buffer.alloc(size, 5),
      },
    });
    const freshLocalState = JSON.parse(await fs.readFile(
      path.join(localFreshDirectory, 'consent-state.json'),
      'utf8',
    )) as Record<string, string>;
    const freshAuthorizationResult = await callbackFor(localFreshDirectory);
    const archiveDirectory = path.join(target.root, 'evidence-archive');
    const resetSyncPhases: string[] = [];
    const resetInput = {
      workDirectory: target.workDirectory,
      archiveDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      stateDigest: freshLocalState.stateDigest!,
      requestDigest: freshLocalState.requestDigest!,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size: number) => Buffer.alloc(size, 6),
        afterDirectorySync: (_directory: string, phase: string) => {
          resetSyncPhases.push(phase);
        },
      },
    };

    await expect(archiveAndResetEbayProductionConsent({
      ...resetInput,
      confirmation: 'not-reconciled',
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_RECONCILIATION_DENIED' });
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult: freshAuthorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => new Date(NOW.getTime() + 60_000), transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_STATE_ALREADY_USED' });

    const reset = await archiveAndResetEbayProductionConsent({
      ...resetInput,
      confirmation: EBAY_RECONCILIATION_RESET_CONFIRMATION,
    });
    expect(reset.code).toBe('EBAY_CONSENT_RESET_AFTER_RECONCILIATION');
    expect(resetSyncPhases.indexOf('evidence-archive-target')).toBeGreaterThanOrEqual(0);
    expect(resetSyncPhases.indexOf('evidence-archive-target'))
      .toBeLessThan(resetSyncPhases.indexOf('evidence-archive-source'));
    expect(resetSyncPhases.indexOf('evidence-archive-source'))
      .toBeLessThan(resetSyncPhases.indexOf('reset-publish'));
    const freshRemoteState = JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(freshRemoteState).toMatchObject({
      status: 'pending',
      databaseEffect: 'none',
      stateDigest: freshLocalState.stateDigest,
      requestDigest: freshLocalState.requestDigest,
    });
    expect((await fs.stat(target.workDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(target.workDirectory, 'consent-state.json'))).mode & 0o777)
      .toBe(0o600);
    const archiveContainers = await fs.readdir(archiveDirectory);
    expect(archiveContainers).toHaveLength(1);
    const archivedEvidence = path.join(archiveDirectory, archiveContainers[0]!, 'evidence');
    expect(JSON.parse(await fs.readFile(
      path.join(archivedEvidence, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'failed-cleanup-required',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
    });
    expect((await fs.stat(archivedEvidence)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(archivedEvidence, 'consent-state.json'))).mode & 0o777)
      .toBe(0o600);

    provider.failExchange = false;
    const installed = await installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult: freshAuthorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size) => Buffer.alloc(size, 8),
        transport: provider.transport,
      },
    });
    expect(installed.code).toBe('EBAY_GRANT_INSTALLED');
    await expect(archiveAndResetEbayProductionConsent({
      ...resetInput,
      confirmation: EBAY_RECONCILIATION_RESET_CONFIRMATION,
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_RECONCILIATION_DENIED' });
  });

  it('never overwrites an existing backup candidate', async () => {
    const target = await fixture();
    await fs.mkdir(target.backupDirectory, { mode: 0o700 });
    const collision = path.join(
      target.backupDirectory,
      'ebaysync-before-ebay-grant-2026-08-14T20-00-00-000Z-090909090909.sqlite',
    );
    await fs.writeFile(collision, 'existing-private-artifact', { mode: 0o600 });
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => NOW,
        randomBytes: (size) => Buffer.alloc(size, 9),
        transport: provider.transport,
      },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_DATABASE_BACKUP_FAILED' });
    expect(provider.requests).toHaveLength(0);
    expect(await fs.readFile(collision, 'utf8')).toBe('existing-private-artifact');
  });

  it('rejects an auth_tokens trigger before exchange and preserves every row', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const database = new Database(target.databasePath);
    database.exec(`
      CREATE TRIGGER auth_tokens_side_effect AFTER UPDATE ON auth_tokens
      BEGIN
        UPDATE auth_tokens SET scope = 'side-effect' WHERE platform = 'shopify';
      END;
    `);
    database.close();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED' });
    expect(provider.requests).toHaveLength(0);
    expect(rows(target.databasePath)).toEqual(before);
  });

  it('rejects any auth_tokens schema extension before exchange', async () => {
    const target = await fixture();
    const database = new Database(target.databasePath);
    database.exec('ALTER TABLE auth_tokens ADD COLUMN unexpected TEXT');
    database.close();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED' });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects a lookalike auth_tokens table without AUTOINCREMENT', async () => {
    const target = await fixture();
    const database = new Database(target.databasePath);
    database.exec(`
      ALTER TABLE auth_tokens RENAME TO auth_tokens_original;
      CREATE TABLE auth_tokens (
        id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        scope TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO auth_tokens SELECT * FROM auth_tokens_original;
      DROP TABLE auth_tokens_original;
    `);
    database.close();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_DATABASE_PREFLIGHT_FAILED' });
    expect(provider.requests).toHaveLength(0);
  });

  it('revokes a wrong-seller grant and leaves the database unchanged', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    provider.seller = 'different-seller';
    await expect(install(target, provider)).rejects.toMatchObject({
      code: 'EBAY_ROTATION_PROVIDER_IDENTITY_MISMATCH',
    });
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(target.workDirectory, 'consent-state.json'), 'utf8')).status)
      .toBe('failed-revoked');
  });

  it('revokes a wrong-scope grant before any ledger change', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    provider.scopes = EBAY_PRODUCTION_SCOPES.slice(0, -1).join(' ');
    await expect(install(target, provider)).rejects.toMatchObject({
      code: 'EBAY_ROTATION_PROVIDER_SCOPE_MISMATCH',
    });
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
  });

  it('rejects and revokes a grant containing any scope beyond the mounted runtime pair', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    provider.scopes = `${SCOPE} https://api.ebay.com/oauth/api_scope/sell.account`;
    await expect(install(target, provider)).rejects.toMatchObject({
      code: 'EBAY_ROTATION_PROVIDER_SCOPE_MISMATCH',
    });
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
  });

  it('rejects hostile Trading XML before parsing and revokes the unused grant', async () => {
    for (const body of [
      '<?xml version="1.0"?><!DOCTYPE GetUserResponse [<!ENTITY seller "usedcameragear">]><GetUserResponse><Ack>Success</Ack><User><UserID>&seller;</UserID></User></GetUserResponse>',
      '<?xml version="1.0"?><GetUserResponse><Ack>Success</Ack><User><UserID>used\u0001cameragear</UserID></User></GetUserResponse>',
    ]) {
      const target = await fixture();
      const before = rows(target.databasePath);
      const provider = new FakeProvider();
      provider.tradingBody = body;
      await expect(install(target, provider)).rejects.toMatchObject({
        code: 'EBAY_ROTATION_PROVIDER_READ_PROBE_FAILED',
      });
      expect(rows(target.databasePath)).toEqual(before);
      expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
    }
  });

  it('detects concurrent ledger drift, rolls back eBay, and revokes the unused new grant', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => NOW,
        transport: provider.transport,
        beforeLedgerCas: () => {
          const concurrent = new Database(target.databasePath);
          concurrent.prepare("UPDATE auth_tokens SET scope = 'concurrent-change' WHERE platform = 'shopify'").run();
          concurrent.close();
        },
      },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_DATABASE_CAS_FAILED' });
    const after = rows(target.databasePath);
    expect(after.find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: OLD_ACCESS_TOKEN,
      refresh_token: OLD_REFRESH_TOKEN,
    });
    expect(after.find((row) => row.platform === 'shopify')).toMatchObject({ scope: 'concurrent-change' });
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
  });

  it('rejects a database inode swap before the CAS and revokes the unused grant', async () => {
    const target = await fixture();
    const before = rows(target.databasePath);
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    await expect(installEbayProductionGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      authorizationResult,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => NOW,
        transport: provider.transport,
        beforeLedgerCas: async () => {
          const displaced = `${target.databasePath}.displaced`;
          await fs.rename(target.databasePath, displaced);
          await fs.copyFile(displaced, target.databasePath);
          await fs.chmod(target.databasePath, 0o600);
        },
      },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_DATABASE_CAS_FAILED' });
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
  });

  it('verifies the bound installed grant with no database write', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    await install(target, provider);
    const before = rows(target.databasePath);
    const tokenRequestCount = provider.requests.filter(
      (request) => request.url === 'https://api.ebay.com/identity/v1/oauth2/token',
    ).length;
    const result = await verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    });
    expect(result).toMatchObject({
      code: 'EBAY_GRANT_VERIFIED',
      databaseRowsChanged: 0,
      credentialProviderMutation: false,
      commerceWritesPerformed: 0,
    });
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.requests.filter(
      (request) => request.url === 'https://api.ebay.com/identity/v1/oauth2/token',
    )).toHaveLength(tokenRequestCount);
    assertNewCertOnly(provider.requests);
  });

  it('rejects a same-row same-time same-scope token swap before verify or revoke provider access', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    await install(target, provider);
    const installed = rows(target.databasePath).find((row) => row.platform === 'ebay')!;
    const requestCount = provider.requests.length;
    const database = new Database(target.databasePath);
    database.prepare(
      "UPDATE auth_tokens SET access_token = ?, refresh_token = ? WHERE platform = 'ebay'",
    ).run('swapped-access-token', 'swapped-refresh-token');
    database.close();
    expect(rows(target.databasePath).find((row) => row.platform === 'ebay')).toMatchObject({
      id: installed.id,
      updated_at: installed.updated_at,
      scope: installed.scope,
    });
    await expect(verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_GRANT_BINDING_MISMATCH' });
    await expect(revokeInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      confirmation: EBAY_REVOKE_CONFIRMATION,
      credentials: CREDENTIALS,
      dependencies: { transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_GRANT_BINDING_MISMATCH' });
    expect(provider.requests).toHaveLength(requestCount);
  });

  it('records a post-COMMIT state failure as committed reconciliation-required with exit 5 truth', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let failure: EbayRotationError | null = null;
    let installedDirectorySyncFailed = false;
    try {
      await installEbayProductionGrant({
        workDirectory: target.workDirectory,
        databasePath: target.databasePath,
        backupDirectory: target.backupDirectory,
        authorizationResult,
        credentials: CREDENTIALS,
        dependencies: {
          now: () => NOW,
          transport: provider.transport,
          beforeDirectorySync: async (_directory, phase) => {
            if (phase !== 'state-replace' || installedDirectorySyncFailed) return;
            const state = JSON.parse(await fs.readFile(
              path.join(target.workDirectory, 'consent-state.json'),
              'utf8',
            )) as Record<string, unknown>;
            if (state.status === 'installed') {
              installedDirectorySyncFailed = true;
              throw new Error('simulated post-commit state directory fsync failure');
            }
          },
        },
      });
    } catch (error) {
      failure = error as EbayRotationError;
    }
    expect(failure).toMatchObject({
      code: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      effects: {
        databaseRowsChanged: 1,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      },
    });
    expect(installedDirectorySyncFailed).toBe(true);
    expect(credentialAdminExitCode(failure!.code, failure!.effects.reconciliationRequired)).toBe(5);
    expect(rows(target.databasePath).find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      scope: SCOPE,
    });
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'committed-reconciliation-required',
      databaseEffect: 'committed',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      installation: {
        rowId: expect.any(Number),
        accessTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        refreshTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    const verified = await verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    });
    expect(verified.code).toBe('EBAY_GRANT_VERIFIED');
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({ status: 'installed', databaseEffect: 'committed', terminalCode: null });
  });

  it('never revokes or erases evidence when COMMIT applies the row and then surfaces an error', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let commitErrorInjected = false;
    let failure: EbayRotationError | null = null;
    try {
      await installEbayProductionGrant({
        workDirectory: target.workDirectory,
        databasePath: target.databasePath,
        backupDirectory: target.backupDirectory,
        authorizationResult,
        credentials: CREDENTIALS,
        dependencies: {
          now: () => NOW,
          transport: provider.transport,
          afterCommitAppliedBeforeResult: () => {
            commitErrorInjected = true;
            throw new Error('simulated SQLite COMMIT phase-two error after apply');
          },
        },
      });
    } catch (error) {
      failure = error as EbayRotationError;
    }
    expect(commitErrorInjected).toBe(true);
    expect(failure).toMatchObject({
      code: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      effects: {
        databaseRowsChanged: 1,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      },
    });
    expect(credentialAdminExitCode(failure!.code, failure!.effects.reconciliationRequired)).toBe(5);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(false);
    expect(provider.requests.some(
      (request) => request.url === 'https://api.ebay.com/identity/v1/oauth2/token/revoke',
    )).toBe(false);
    expect(rows(target.databasePath).find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      scope: SCOPE,
    });
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'committed-reconciliation-required',
      databaseEffect: 'committed',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      installation: {
        rowId: expect.any(Number),
        accessTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        refreshTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });

    await expect(verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => new Date(NOW.getTime() + 1_000), transport: provider.transport },
    })).resolves.toMatchObject({ code: 'EBAY_GRANT_VERIFIED' });
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({ status: 'installed', databaseEffect: 'committed', terminalCode: null });
  });

  it('preserves commit-pending evidence and reports an unknown database effect when readback is ambiguous', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let failure: EbayRotationError | null = null;
    try {
      await installEbayProductionGrant({
        workDirectory: target.workDirectory,
        databasePath: target.databasePath,
        backupDirectory: target.backupDirectory,
        authorizationResult,
        credentials: CREDENTIALS,
        dependencies: {
          now: () => NOW,
          transport: provider.transport,
          afterCommitAppliedBeforeResult: () => {
            const ambiguous = new Database(target.databasePath);
            ambiguous.prepare(
              "UPDATE auth_tokens SET access_token = ? WHERE platform = 'ebay'",
            ).run('post-commit-ambiguous-authority');
            ambiguous.close();
            throw new Error('simulated ambiguous SQLite COMMIT result');
          },
        },
      });
    } catch (error) {
      failure = error as EbayRotationError;
    }
    expect(failure).toMatchObject({
      code: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      effects: {
        databaseRowsChanged: 'unknown',
        credentialProviderMutation: true,
        reconciliationRequired: true,
      },
    });
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(false);
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'commit-outcome-reconciliation-required',
      databaseEffect: 'commit-pending',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      installation: {
        rowId: null,
        accessTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        refreshTokenDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    const requestCount = provider.requests.length;
    await expect(verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_GRANT_BINDING_MISMATCH' });
    expect(provider.requests).toHaveLength(requestCount);

    const preserved = JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    )) as { installation: { backupFileName: string } };
    const freshLocalDirectory = path.join(target.root, 'fresh-after-database-reconciliation');
    await beginEbayProductionConsent({
      workDirectory: freshLocalDirectory,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size) => Buffer.alloc(size, 12),
      },
    });
    const fresh = JSON.parse(await fs.readFile(
      path.join(freshLocalDirectory, 'consent-state.json'),
      'utf8',
    )) as { stateDigest: string; requestDigest: string };
    const archiveDirectory = path.join(target.root, 'evidence-archive');
    const reset = {
      workDirectory: target.workDirectory,
      archiveDirectory,
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      stateDigest: fresh.stateDigest,
      requestDigest: fresh.requestDigest,
      confirmation: EBAY_RECONCILIATION_RESET_CONFIRMATION,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size: number) => Buffer.alloc(size, 13),
      },
    };
    await expect(archiveAndResetEbayProductionConsent(reset))
      .rejects.toMatchObject({ code: 'EBAY_ROTATION_RECONCILIATION_DENIED' });

    const backupPath = path.join(
      target.backupDirectory,
      preserved.installation.backupFileName,
    );
    await fs.copyFile(backupPath, target.databasePath);
    await fs.chmod(target.databasePath, 0o600);
    await expect(archiveAndResetEbayProductionConsent(reset)).resolves.toMatchObject({
      code: 'EBAY_CONSENT_RESET_AFTER_RECONCILIATION',
      databaseRowsChanged: 0,
      credentialProviderMutation: false,
    });
    expect(rows(target.databasePath).find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: OLD_ACCESS_TOKEN,
      refresh_token: OLD_REFRESH_TOKEN,
      scope: 'legacy-scope',
      updated_at: 100,
    });
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({ status: 'pending', databaseEffect: 'none' });
    const archivedContainers = await fs.readdir(archiveDirectory);
    expect(archivedContainers).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(
      archiveDirectory,
      archivedContainers[0]!,
      'evidence',
      'consent-state.json',
    ), 'utf8'))).toMatchObject({
      status: 'commit-outcome-reconciliation-required',
      databaseEffect: 'commit-pending',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
    });
  });

  it('classifies an exact baseline after a COMMIT error and permits only confirmed reconciliation reset', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let failure: EbayRotationError | null = null;
    try {
      await installEbayProductionGrant({
        workDirectory: target.workDirectory,
        databasePath: target.databasePath,
        backupDirectory: target.backupDirectory,
        authorizationResult,
        credentials: CREDENTIALS,
        dependencies: {
          now: () => NOW,
          transport: provider.transport,
          afterCommitAppliedBeforeResult: () => {
            const baseline = new Database(target.databasePath);
            baseline.prepare(
              `UPDATE auth_tokens
               SET access_token = ?, refresh_token = ?, scope = 'legacy-scope',
                   expires_at = 200, created_at = 100, updated_at = 100
               WHERE platform = 'ebay'`,
            ).run(OLD_ACCESS_TOKEN, OLD_REFRESH_TOKEN);
            baseline.close();
            throw new Error('simulated COMMIT error with exact baseline after close');
          },
        },
      });
    } catch (error) {
      failure = error as EbayRotationError;
    }
    expect(failure).toMatchObject({
      code: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      effects: {
        databaseRowsChanged: 0,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      },
    });
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(false);
    expect(rows(target.databasePath).find((row) => row.platform === 'ebay')).toMatchObject({
      access_token: OLD_ACCESS_TOKEN,
      refresh_token: OLD_REFRESH_TOKEN,
      scope: 'legacy-scope',
      updated_at: 100,
    });
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({
      status: 'commit-outcome-reconciliation-required',
      databaseEffect: 'commit-pending',
      terminalCode: 'EBAY_ROTATION_CLEANUP_REQUIRED',
    });

    const freshLocalDirectory = path.join(target.root, 'fresh-after-exact-baseline');
    await beginEbayProductionConsent({
      workDirectory: freshLocalDirectory,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size) => Buffer.alloc(size, 14),
      },
    });
    const fresh = JSON.parse(await fs.readFile(
      path.join(freshLocalDirectory, 'consent-state.json'),
      'utf8',
    )) as { stateDigest: string; requestDigest: string };
    const reset = {
      workDirectory: target.workDirectory,
      archiveDirectory: path.join(target.root, 'evidence-archive'),
      databasePath: target.databasePath,
      backupDirectory: target.backupDirectory,
      stateDigest: fresh.stateDigest,
      requestDigest: fresh.requestDigest,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 60_000),
        randomBytes: (size: number) => Buffer.alloc(size, 15),
      },
    };
    await expect(archiveAndResetEbayProductionConsent({
      ...reset,
      confirmation: 'provider-not-reconciled',
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_RECONCILIATION_DENIED' });
    await expect(archiveAndResetEbayProductionConsent({
      ...reset,
      confirmation: EBAY_RECONCILIATION_RESET_CONFIRMATION,
    })).resolves.toMatchObject({
      code: 'EBAY_CONSENT_RESET_AFTER_RECONCILIATION',
      databaseRowsChanged: 0,
      credentialProviderMutation: false,
    });
  });

  it('leaves post-COMMIT lock evidence and recovers it only with expired dead-owner exact proof', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    const authorizationResult = await begin(target);
    let failure: EbayRotationError | null = null;
    try {
      await installEbayProductionGrant({
        workDirectory: target.workDirectory,
        databasePath: target.databasePath,
        backupDirectory: target.backupDirectory,
        authorizationResult,
        credentials: CREDENTIALS,
        dependencies: {
          now: () => NOW,
          transport: provider.transport,
          beforeLockRelease: () => { throw new Error('fake post-commit lock release failure'); },
        },
      });
    } catch (error) {
      failure = error as EbayRotationError;
    }
    expect(failure).toMatchObject({
      code: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      effects: {
        databaseRowsChanged: 1,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      },
    });
    const lockPath = path.join(target.root, '.ebay-credential-operation.lock');
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, string | number>;
    expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
    const lockArchiveDirectory = path.join(target.root, 'lock-archive');
    const recovery = {
      workDirectory: target.workDirectory,
      archiveDirectory: lockArchiveDirectory,
      ownerId: lock.ownerId as string,
      createdAtUtc: lock.createdAtUtc as string,
      confirmation: EBAY_STALE_LOCK_RECOVERY_CONFIRMATION,
    };
    await expect(recoverStaleEbayOperationLock({
      ...recovery,
      dependencies: { now: () => new Date(NOW.getTime() + 60_000), isLockOwnerAlive: () => false },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_LOCK_RECOVERY_DENIED' });
    await expect(recoverStaleEbayOperationLock({
      ...recovery,
      dependencies: { now: () => new Date(NOW.getTime() + 6 * 60_000), isLockOwnerAlive: () => true },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_LOCK_RECOVERY_DENIED' });
    await expect(recoverStaleEbayOperationLock({
      ...recovery,
      ownerId: Buffer.alloc(32, 2).toString('base64url'),
      dependencies: { now: () => new Date(NOW.getTime() + 6 * 60_000), isLockOwnerAlive: () => false },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_LOCK_RECOVERY_DENIED' });
    await expect(recoverStaleEbayOperationLock({
      ...recovery,
      createdAtUtc: new Date(NOW.getTime() + 1).toISOString(),
      dependencies: { now: () => new Date(NOW.getTime() + 6 * 60_000), isLockOwnerAlive: () => false },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_LOCK_RECOVERY_DENIED' });
    await expect(recoverStaleEbayOperationLock({
      ...recovery,
      dependencies: {
        now: () => new Date(NOW.getTime() + 25 * 60 * 60_000),
        isLockOwnerAlive: () => false,
      },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_LOCK_RECOVERY_DENIED' });
    const recoverySyncPhases: string[] = [];
    const recovered = await recoverStaleEbayOperationLock({
      ...recovery,
      dependencies: {
        now: () => new Date(NOW.getTime() + 6 * 60_000),
        randomBytes: (size) => Buffer.alloc(size, 4),
        isLockOwnerAlive: () => false,
        afterDirectorySync: (_directory, phase) => { recoverySyncPhases.push(phase); },
      },
    });
    expect(recovered.code).toBe('EBAY_STALE_LOCK_ARCHIVED');
    expect(recoverySyncPhases.indexOf('stale-lock-archive-target')).toBeGreaterThanOrEqual(0);
    expect(recoverySyncPhases.indexOf('stale-lock-archive-target'))
      .toBeLessThan(recoverySyncPhases.indexOf('stale-lock-archive-source'));
    await expect(fs.access(lockPath)).rejects.toThrow();
    const containers = await fs.readdir(lockArchiveDirectory);
    expect(containers).toHaveLength(1);
    const archivedLock = path.join(lockArchiveDirectory, containers[0]!, 'operation-lock.json');
    expect(JSON.parse(await fs.readFile(archivedLock, 'utf8'))).toEqual(lock);
    expect((await fs.stat(archivedLock)).mode & 0o777).toBe(0o600);
    await expect(verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: {
        now: () => new Date(NOW.getTime() + 6 * 60_000),
        transport: provider.transport,
      },
    })).resolves.toMatchObject({ code: 'EBAY_GRANT_VERIFIED' });
  });

  it('revokes only the bound installed new grant and leaves the ledger unchanged', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    await install(target, provider);
    const before = rows(target.databasePath);
    const result = await revokeInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      confirmation: EBAY_REVOKE_CONFIRMATION,
      credentials: CREDENTIALS,
      dependencies: { transport: provider.transport },
    });
    expect(result).toMatchObject({
      code: 'EBAY_GRANT_REVOKED',
      credentialProviderMutation: true,
      databaseRowsChanged: 0,
      commerceWritesPerformed: 0,
    });
    expect(rows(target.databasePath)).toEqual(before);
    expect(provider.revoked.has(REFRESH_TOKEN)).toBe(true);
    const repeated = await revokeInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      confirmation: EBAY_REVOKE_CONFIRMATION,
      credentials: CREDENTIALS,
      dependencies: { transport: provider.transport },
    });
    expect(repeated.code).toBe('EBAY_GRANT_ALREADY_REVOKED');
  });

  it('classifies an ambiguous bound-grant revocation as mandatory reconciliation', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    await install(target, provider);
    provider.failRevoke = true;
    await expect(revokeInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      confirmation: EBAY_REVOKE_CONFIRMATION,
      credentials: CREDENTIALS,
      dependencies: { transport: provider.transport },
    })).rejects.toMatchObject({
      code: 'EBAY_ROTATION_CLEANUP_REQUIRED',
      effects: {
        databaseRowsChanged: 0,
        credentialProviderMutation: true,
        reconciliationRequired: true,
      },
    });
    expect(JSON.parse(await fs.readFile(
      path.join(target.workDirectory, 'consent-state.json'),
      'utf8',
    ))).toMatchObject({ status: 'installed', databaseEffect: 'committed' });
  });

  it('requires the exact cleanup confirmation and exact ledger binding', async () => {
    const target = await fixture();
    const provider = new FakeProvider();
    await install(target, provider);
    await expect(revokeInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      confirmation: 'wrong',
      credentials: CREDENTIALS,
      dependencies: { transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_REVOCATION_DENIED' });
    const database = new Database(target.databasePath);
    database.prepare("UPDATE auth_tokens SET updated_at = updated_at + 1 WHERE platform = 'ebay'").run();
    database.close();
    await expect(verifyInstalledEbayGrant({
      workDirectory: target.workDirectory,
      databasePath: target.databasePath,
      credentials: CREDENTIALS,
      dependencies: { now: () => NOW, transport: provider.transport },
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_GRANT_BINDING_MISMATCH' });
  });

  it('cancels a streamed provider response as soon as the byte cap is crossed', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1_024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    });
    const fakeFetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const transport = createBoundedEbayProviderTransport(fakeFetch);
    await expect(transport({
      method: 'GET',
      url: 'https://api.ebay.com/read-only',
      headers: Object.freeze({ Accept: 'application/json' }),
    })).rejects.toMatchObject({ code: 'EBAY_ROTATION_PROVIDER_RESPONSE_INVALID' });
    expect(canceled).toBe(true);
  });
});

describe('credential administrator command boundary', () => {
  it('rejects every secret or Railway path argument', () => {
    for (const name of [
      '--authorization-result', '--authorization-code', '--code', '--state', '--access-token',
      '--refresh-token', '--cert-id', '--client-secret', '--token', '--work-dir', '--database',
      '--backup-dir',
    ]) {
      expect(() => parseCredentialAdminArguments([
        'ebay', 'install', name, 'not-allowed',
      ])).toThrow(EbayRotationError);
    }
  });

  it('accepts one explicit local path but no path on a Railway command', () => {
    expect(parseCredentialAdminArguments([
      'ebay', 'prepare-consent', '--local-work-dir', '/private/local-consent',
    ])).toEqual({
      command: 'prepare-consent',
      localWorkDirectory: '/private/local-consent',
    });
    expect(parseCredentialAdminArguments([
      'ebay', 'register-consent',
      '--state-digest', `sha256:${'a'.repeat(64)}`,
      '--request-digest', `sha256:${'b'.repeat(64)}`,
    ])).toMatchObject({ command: 'register-consent' });
    expect(parseCredentialAdminArguments([
      'ebay', 'archive-reset-after-reconciliation',
      '--state-digest', `sha256:${'a'.repeat(64)}`,
      '--request-digest', `sha256:${'b'.repeat(64)}`,
      '--confirm', EBAY_RECONCILIATION_RESET_CONFIRMATION,
    ])).toMatchObject({ command: 'archive-reset-after-reconciliation' });
    expect(parseCredentialAdminArguments([
      'ebay', 'recover-stale-lock',
      '--owner', Buffer.alloc(32, 1).toString('base64url'),
      '--created-at', NOW.toISOString(),
      '--confirm', EBAY_STALE_LOCK_RECOVERY_CONFIRMATION,
    ])).toMatchObject({ command: 'recover-stale-lock' });
    expect(parseCredentialAdminArguments(['ebay', 'install'])).toEqual({ command: 'install' });
    expect(parseCredentialAdminArguments(['ebay', 'verify'])).toEqual({ command: 'verify' });
    expect(() => parseCredentialAdminArguments([
      'ebay', 'verify', '--database', '/data/other.sqlite',
    ])).toThrow(EbayRotationError);
  });

  it('requires the exact Railway project, environment, service, and absent writer ACK', () => {
    const exact = Object.freeze({
      RAILWAY_PROJECT_ID: EBAY_ROTATION_RAILWAY_PROJECT_ID,
      RAILWAY_ENVIRONMENT_ID: EBAY_ROTATION_RAILWAY_ENVIRONMENT_ID,
      RAILWAY_SERVICE_ID: EBAY_ROTATION_RAILWAY_SERVICE_ID,
    });
    expect(() => assertEbayProductionRailwayBoundary(exact)).not.toThrow();
    for (const environment of [
      { ...exact, RAILWAY_PROJECT_ID: 'wrong' },
      { ...exact, RAILWAY_ENVIRONMENT_ID: 'wrong' },
      { ...exact, RAILWAY_SERVICE_ID: 'wrong' },
      { ...exact, LISTING_CONTROL_SINGLE_WRITER_ACK: '' },
      { ...exact, SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK: '' },
      { ...exact, SHOPIFY_ROTATION_REFRESH_TOKEN: 'shopify-maintenance-active' },
      {},
    ]) {
      expect(() => assertEbayProductionRailwayBoundary(environment))
        .toThrowError(EbayRotationError);
    }
  });

  it('emits only fixed value-free failure JSON', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = 0;
    const secret = 'must-never-be-emitted';
    const io: CredentialAdminIo = {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readSecret: async () => secret,
      setExitCode: (value) => { code = value; },
    };
    await runCredentialAdmin({
      argv: ['ebay', 'install', '--authorization-result', secret],
      environment: {
        EBAY_APP_ID: 'app',
        EBAY_RU_NAME: 'runame',
        EBAY_ROTATION_NEW_CERT_ID: 'cert',
      },
      io,
    });
    expect(stdout).toHaveLength(0);
    expect(stderr).toEqual([JSON.stringify({
      ok: false,
      code: 'EBAY_ROTATION_ARGUMENT_DENIED',
      environment: 'production',
      databaseRowsChanged: 0,
      credentialProviderMutation: false,
      reconciliationRequired: false,
      commerceWritesPerformed: 0,
      historicalOrdersTouched: 0,
    })]);
    expect(stderr.join('')).not.toContain(secret);
    expect(code).toBe(2);
  });

  it('emits a fixed value-free consent preparation result', async () => {
    const target = await fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = 0;
    const io: CredentialAdminIo = {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readSecret: async () => { throw new Error('secret reader must not run'); },
      setExitCode: (value) => { code = value; },
    };
    const localWorkDirectory = path.join(target.root, 'cli-local-consent');
    await runCredentialAdmin({
      argv: ['ebay', 'prepare-consent', '--local-work-dir', localWorkDirectory],
      environment: {
        EBAY_APP_ID: CREDENTIALS.appId,
        EBAY_RU_NAME: CREDENTIALS.ruName,
      },
      io,
      dependencies: {
        now: () => NOW,
        randomBytes: (size) => Buffer.alloc(size, 3),
      },
    });
    expect(stderr).toHaveLength(0);
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual({
      ok: true,
      code: 'EBAY_CONSENT_PREPARED',
      environment: 'production',
      sellerVerified: false,
      scopesVerified: false,
      backupCreated: false,
      databaseRowsChanged: 0,
      credentialProviderMutation: false,
      commerceWritesPerformed: 0,
      historicalOrdersTouched: 0,
    });
    expect(stdout[0]).not.toContain(localWorkDirectory);
    expect(stdout[0]).not.toContain(CREDENTIALS.appId);
    expect(stdout[0]).not.toContain(CREDENTIALS.ruName);
  });

  it('keeps the standalone source disconnected from runtime and shell/process launchers', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const directory = path.join(root, 'credential-admin');
    const source = ['ebay-rotation.ts', 'ebay-program.ts', 'index.ts']
      .map((name) => readFileSync(path.join(directory, name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/from ['"]\.\.\/(?:server|sync|watcher|cli|db|config|ebay|shopify)\//u);
    expect(source).not.toMatch(/node:child_process|(?:^|[^\w.])exec\s*\(|\bspawn\s*\(|\bexecFile\s*\(|from ['"]open['"]/u);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toContain('response.text()');
    expect(source).not.toMatch(/\b(?:loadCredentials|getValidEbayToken|refreshEbayUserToken)\b/u);
    expect(source).not.toMatch(/process\.env\.EBAY_CERT_ID\b/u);
    expect(source).not.toMatch(/DELETE\s+FROM\s+auth_tokens|INSERT\s+OR\s+REPLACE/iu);
    expect(source).not.toMatch(/console\.(?:log|error|warn|debug)/u);
    const server = readFileSync(path.join(root, 'server', 'index.ts'), 'utf8');
    const legacyCli = readFileSync(path.join(root, 'cli', 'index.ts'), 'utf8');
    expect(server).not.toContain('credential-admin');
    expect(legacyCli).not.toContain('credential-admin');
  });
});
