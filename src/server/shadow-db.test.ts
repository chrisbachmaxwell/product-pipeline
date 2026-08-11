import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openShadowDatabase } from './shadow-db.js';

const temporaryDirectories: string[] = [];

async function fixtureDatabase(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pipeline-shadow-db-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'ledger.db');
  const writable = new Database(databasePath);
  writable.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  writable.prepare('INSERT INTO observations (value) VALUES (?)').run('redacted');
  writable.close();
  return databasePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('shadow database boundary', () => {
  it('opens an existing ledger query-only and denies mutations', async () => {
    const databasePath = await fixtureDatabase();
    const database = openShadowDatabase(databasePath);
    try {
      expect(database.pragma('query_only', { simple: true })).toBe(1);
      expect(database.prepare('SELECT value FROM observations').pluck().get()).toBe('redacted');
      expect(() => database.prepare('UPDATE observations SET value = ?').run('changed'))
        .toThrow(/readonly|read-only/i);
    } finally {
      database.close();
    }
  });

  it('does not create a missing database', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pipeline-shadow-db-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'missing.db');

    expect(() => openShadowDatabase(databasePath)).toThrow();
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the ledger bytes and modification time unchanged after reads', async () => {
    const databasePath = await fixtureDatabase();
    const beforeBytes = await fs.readFile(databasePath);
    const beforeStat = await fs.stat(databasePath);
    const database = openShadowDatabase(databasePath);
    try {
      database.prepare('SELECT COUNT(*) FROM observations').get();
    } finally {
      database.close();
    }
    const afterBytes = await fs.readFile(databasePath);
    const afterStat = await fs.stat(databasePath);

    expect(crypto.createHash('sha256').update(afterBytes).digest('hex'))
      .toBe(crypto.createHash('sha256').update(beforeBytes).digest('hex'));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
