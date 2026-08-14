import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL_SHOPIFY_SCOPE_TEXT } from './network.js';
import {
  LegacyShopifyTokenStore,
  readShopifyAuthTokenRowReadOnly,
  type LegacyShopifyTokenStorePathPolicy,
} from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(scope: string | null = null): {
  databasePath: string;
  policy: LegacyShopifyTokenStorePathPolicy;
} {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shopify-rotation-store-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const databasePath = path.join(root, 'ebaysync.db');
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
    CREATE TABLE unrelated_state (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  database.prepare(
    `INSERT INTO auth_tokens
      (platform, access_token, refresh_token, scope, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('shopify', 'old-shopify-access-token-value', null, scope, null, 100, 200);
  database.prepare(
    `INSERT INTO auth_tokens
      (platform, access_token, refresh_token, scope, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ebay', 'ebay-access-token-value', 'ebay-refresh-token-value', 'sell.inventory', 999, 101, 201);
  database.prepare('INSERT INTO unrelated_state (id, value) VALUES (?, ?)')
    .run(1, 'must-survive-byte-for-byte');
  database.close();
  fs.chmodSync(databasePath, 0o600);
  return {
    databasePath,
    policy: {
      expectedDatabasePath: databasePath,
      backupDirectory: path.join(root, 'private', 'credential-backups', 'shopify'),
    },
  };
}

function rawRows(databasePath: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      tokens: database.prepare('SELECT * FROM auth_tokens ORDER BY id').all(),
      unrelated: database.prepare('SELECT * FROM unrelated_state ORDER BY id').all(),
    };
  } finally {
    database.close();
  }
}

describe('legacy Shopify token store maintenance boundary', () => {
  it('creates a whole consistent 0600 backup before a metadata-aware one-row CAS', async () => {
    const loaded = fixture();
    const before = rawRows(loaded.databasePath);
    const store = LegacyShopifyTokenStore.open(loaded.databasePath, loaded.policy);
    const backupPath = await store.createBackup(new Date('2026-08-14T18:00:00.000Z'));
    expect(fs.statSync(loaded.policy.backupDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(rawRows(backupPath)).toEqual(before);

    store.compareAndSwapAccessToken({
      accessToken: 'new-shopify-access-token-value',
      refreshToken: null,
      scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
      expiresAt: null,
    }, new Date('2026-08-14T18:00:01.000Z'));
    store.close();

    const after = rawRows(loaded.databasePath) as {
      tokens: Array<Record<string, unknown>>;
      unrelated: Array<Record<string, unknown>>;
    };
    const beforeTyped = before as typeof after;
    expect(after.unrelated).toEqual(beforeTyped.unrelated);
    expect(after.tokens[1]).toEqual(beforeTyped.tokens[1]);
    expect(after.tokens[0]).toEqual({
      ...beforeTyped.tokens[0],
      access_token: 'new-shopify-access-token-value',
      refresh_token: null,
      scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
      expires_at: null,
      updated_at: Math.floor(Date.parse('2026-08-14T18:00:01.000Z') / 1_000),
    });
    expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath))
      .toMatchObject({
        accessToken: 'new-shopify-access-token-value',
        refreshToken: null,
        scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
        expiresAt: null,
      });
  });

  it('rejects and removes a backup whose unrelated content differs despite matching schema/counts', async () => {
    const loaded = fixture();
    const before = rawRows(loaded.databasePath);
    const originalBackup = Database.prototype.backup;
    const backupSpy = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      destinationFile: string,
      options?: Database.BackupOptions,
    ) {
      const result = await originalBackup.call(this, destinationFile, options);
      const tampered = new Database(destinationFile, { fileMustExist: true });
      tampered.prepare(`UPDATE unrelated_state SET value = 'same-count-different-content' WHERE id = 1`)
        .run();
      tampered.close();
      return result;
    });
    const store = LegacyShopifyTokenStore.open(loaded.databasePath, loaded.policy);
    try {
      await expect(store.createBackup(new Date('2026-08-14T18:00:00.000Z')))
        .rejects.toMatchObject({ code: 'backup-denied' });
      expect(fs.readdirSync(loaded.policy.backupDirectory)).toEqual([]);
      expect(rawRows(loaded.databasePath)).toEqual(before);
    } finally {
      store.close();
      backupSpy.mockRestore();
    }
  });

  it('detects a full-row CAS race and never overwrites the concurrent value', async () => {
    const loaded = fixture(CANONICAL_SHOPIFY_SCOPE_TEXT);
    const store = LegacyShopifyTokenStore.open(loaded.databasePath, loaded.policy);
    await store.createBackup(new Date('2026-08-14T18:00:00.000Z'));
    const concurrent = new Database(loaded.databasePath, { fileMustExist: true });
    concurrent.prepare(`UPDATE auth_tokens SET updated_at = 999 WHERE platform = 'shopify'`).run();
    concurrent.close();
    await expect(() => store.compareAndSwapAccessToken({
      accessToken: 'new-shopify-access-token-value',
      refreshToken: null,
      scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
      expiresAt: null,
    }, new Date('2026-08-14T18:00:01.000Z'))).toThrow(expect.objectContaining({
      code: 'concurrency-denied',
    }));
    store.close();
    expect(readShopifyAuthTokenRowReadOnly(loaded.databasePath, loaded.databasePath))
      .toMatchObject({ accessToken: 'old-shopify-access-token-value', updatedAt: 999 });
  });

  it('rejects a same-count unrelated-content race after backup without overwriting either state', async () => {
    const loaded = fixture(CANONICAL_SHOPIFY_SCOPE_TEXT);
    const store = LegacyShopifyTokenStore.open(loaded.databasePath, loaded.policy);
    await store.createBackup(new Date('2026-08-14T18:00:00.000Z'));
    const concurrent = new Database(loaded.databasePath, { fileMustExist: true });
    concurrent.prepare(`UPDATE unrelated_state SET value = 'concurrent-preserved' WHERE id = 1`).run();
    concurrent.close();
    await expect(() => store.compareAndSwapAccessToken({
      accessToken: 'new-shopify-access-token-value',
      refreshToken: null,
      scope: CANONICAL_SHOPIFY_SCOPE_TEXT,
      expiresAt: null,
    }, new Date('2026-08-14T18:00:01.000Z'))).toThrow(expect.objectContaining({
      code: 'concurrency-denied',
    }));
    store.close();
    const after = rawRows(loaded.databasePath) as {
      tokens: Array<Record<string, unknown>>;
      unrelated: Array<Record<string, unknown>>;
    };
    expect(after.tokens[0]?.access_token).toBe('old-shopify-access-token-value');
    expect(after.unrelated).toEqual([{ id: 1, value: 'concurrent-preserved' }]);
  });

  it('fails without mutation on noncanonical schema, triggers, or stale token metadata', () => {
    for (const mutate of [
      (db: Database.Database) => db.exec('CREATE INDEX extra_auth_index ON auth_tokens(updated_at)'),
      (db: Database.Database) => db.exec(`CREATE TRIGGER auth_touch AFTER UPDATE ON auth_tokens BEGIN UPDATE unrelated_state SET value = 'changed' WHERE id = 1; END`),
      (db: Database.Database) => db.prepare(`UPDATE auth_tokens SET refresh_token = 'stale-refresh' WHERE platform = 'shopify'`).run(),
      (db: Database.Database) => db.prepare(`UPDATE auth_tokens SET expires_at = 123 WHERE platform = 'shopify'`).run(),
      (db: Database.Database) => db.prepare(`UPDATE auth_tokens SET scope = 'read_products,write_products' WHERE platform = 'shopify'`).run(),
      (db: Database.Database) => db.prepare(`UPDATE auth_tokens SET scope = 'read_fulfillments,read_inventory,read_orders,read_products,read_products' WHERE platform = 'shopify'`).run(),
    ]) {
      const loaded = fixture();
      const database = new Database(loaded.databasePath, { fileMustExist: true });
      mutate(database);
      database.close();
      fs.chmodSync(loaded.databasePath, 0o600);
      const before = fs.readFileSync(loaded.databasePath);
      const opening = () => LegacyShopifyTokenStore.open(loaded.databasePath, loaded.policy);
      if (mutate.toString().includes('refresh_token')
        || mutate.toString().includes('expires_at')
        || mutate.toString().includes("scope =")) {
        expect(opening).toThrow(expect.objectContaining({ code: 'token-row-denied' }));
      } else {
        expect(opening).toThrow();
      }
      expect(fs.readFileSync(loaded.databasePath)).toEqual(before);
    }
  });

  it('rejects insecure paths, modes, links, and SQLite sidecars before opening', () => {
    const modeFixture = fixture();
    fs.chmodSync(modeFixture.databasePath, 0o640);
    expect(() => LegacyShopifyTokenStore.open(modeFixture.databasePath, modeFixture.policy)).toThrow();

    const hardlinkFixture = fixture();
    fs.linkSync(hardlinkFixture.databasePath, `${hardlinkFixture.databasePath}.link`);
    expect(() => LegacyShopifyTokenStore.open(hardlinkFixture.databasePath, hardlinkFixture.policy))
      .toThrow();

    const symlinkFixture = fixture();
    const symlink = path.join(path.dirname(symlinkFixture.databasePath), 'linked.db');
    fs.symlinkSync(symlinkFixture.databasePath, symlink);
    expect(() => LegacyShopifyTokenStore.open(symlink, {
      ...symlinkFixture.policy,
      expectedDatabasePath: symlink,
    })).toThrow();

    const sidecarFixture = fixture();
    fs.writeFileSync(`${sidecarFixture.databasePath}-wal`, 'unsafe');
    expect(() => LegacyShopifyTokenStore.open(sidecarFixture.databasePath, sidecarFixture.policy))
      .toThrow();
  });

  it('requires exactly one Shopify row while retaining the unrelated eBay row', () => {
    const loaded = fixture();
    const database = new Database(loaded.databasePath, { fileMustExist: true });
    database.prepare(`DELETE FROM auth_tokens WHERE platform = 'shopify'`).run();
    database.close();
    fs.chmodSync(loaded.databasePath, 0o600);
    expect(() => LegacyShopifyTokenStore.open(loaded.databasePath, loaded.policy)).toThrow();
    expect((rawRows(loaded.databasePath).tokens as unknown[])).toHaveLength(1);
  });
});
