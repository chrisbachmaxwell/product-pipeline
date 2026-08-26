import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildControlStateBackupProgram } from './program.js';
import { BACKUP_KIND } from './types.js';

function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-program-')));
  fs.chmodSync(root, 0o700);
  for (const directory of ['volume', 'off-volume', 'volume/reports']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, directory), 0o700);
  }
  const paths = ['app.db', 'listing.db', 'migration.db'].map((name) => path.join(root, 'volume', name));
  for (const value of paths) {
    const database = new Database(value);
    database.exec('CREATE TABLE proof (value TEXT)');
    database.close();
    fs.chmodSync(value, 0o600);
  }
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    kind: BACKUP_KIND,
    sourceVolumeRoot: path.join(root, 'volume'),
    destinationRoot: path.join(root, 'off-volume'),
    sources: { appDatabase: paths[0], listingControlDatabase: paths[1], migrationStoreDatabase: paths[2], shadowReportsDirectory: path.join(root, 'volume', 'reports') },
  }), { mode: 0o600 });
  return config;
}

describe('control-state backup CLI', () => {
  it('prints only bounded nonsecret preview output', async () => {
    const config = fixture();
    const output: string[] = [];
    const errors: string[] = [];
    let exitCode = 0;
    const program = buildControlStateBackupProgram({ out: (value) => output.push(value), error: (value) => errors.push(value), exit: (value) => { exitCode = value; } }, { deviceId: (value) => value.includes('off-volume') ? 2 : 1 });
    await program.parseAsync(['node', 'cli', 'preview', '--config', config, '--created-at', '2026-08-26T19:00:00.000Z']);
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ command: 'preview', status: 'preview', safety: { commerceWrites: false, liveRestore: false } });
    expect(output[0]).not.toContain(config);
  });

  it('redacts rejected paths and values behind one fixed denial', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let exitCode = 0;
    const secretLike = '/does-not-exist/token-secret-value';
    const program = buildControlStateBackupProgram({ out: (value) => output.push(value), error: (value) => errors.push(value), exit: (value) => { exitCode = value; } });
    await program.parseAsync(['node', 'cli', 'verify', '--snapshot', secretLike]);
    expect(output).toEqual([]);
    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(secretLike);
    expect(JSON.parse(errors[0]!)).toMatchObject({ status: 'denied', error: 'CONTROL_STATE_BACKUP_DENIED' });
  });

  it('stays outside the mounted server and all network/provider writer boundaries', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const adminRoot = path.join(sourceRoot, 'control-state-backup-admin');
    for (const file of (await fs.promises.readdir(adminRoot)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = await fs.promises.readFile(path.join(adminRoot, file), 'utf8');
      expect(source, file).not.toMatch(/from\s+['"]\.\.\/(?:server|sync|shopify|ebay|order-import-admin|listing-revise-admin|price-inventory-admin)\/|child_process|node:(?:http|https|net|dns)|\bfetch\s*\(/);
    }
    const serverRoot = path.join(sourceRoot, 'server');
    for (const file of (await fs.promises.readdir(serverRoot)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = await fs.promises.readFile(path.join(serverRoot, file), 'utf8');
      expect(source, file).not.toContain('control-state-backup-admin');
    }
  });
});
