import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { PRODUCT_PIPELINE_PRODUCTION_RUNTIME } from './config.js';
import { diagnoseFixedProductionShopifyDatabase, SHOPIFY_DATABASE_DIAGNOSTIC_STAGES, } from './database-diagnostic.js';
const roots = [];
const FIXED_DATABASE_PATH = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath;
const DIAGNOSTIC_ENVIRONMENT = Object.freeze({
    NODE_ENV: 'production',
    RAILWAY_PROJECT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.projectId,
    RAILWAY_ENVIRONMENT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.environmentId,
    RAILWAY_SERVICE_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.serviceId,
    DATABASE_PATH: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
    SHOPIFY_CLIENT_ID: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
});
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function fixture(options = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shopify-db-diagnostic-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const databasePath = path.join(root, 'ebaysync.db');
    const database = new Database(databasePath);
    if (options.walHeader === true)
        database.pragma('journal_mode = WAL');
    database.exec(options.schema ?? `
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
    CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
    if (options.includeShopifyRow !== false) {
        database.prepare(`INSERT INTO auth_tokens
        (platform, access_token, refresh_token, scope, expires_at, created_at, updated_at)
       VALUES ('shopify', 'shopify-token-value-never-output', NULL, NULL, NULL, 100, 200)`).run();
    }
    if (options.walHeader === true)
        database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();
    fs.chmodSync(databasePath, 0o600);
    return Object.freeze({ root, databasePath });
}
function mappedDependencies(loaded, transformDatabase) {
    const mapped = (fixedPath) => {
        const value = String(fixedPath);
        if (value === FIXED_DATABASE_PATH)
            return loaded.databasePath;
        if (value === path.dirname(FIXED_DATABASE_PATH))
            return loaded.root;
        if (value.startsWith(FIXED_DATABASE_PATH)) {
            return `${loaded.databasePath}${value.slice(FIXED_DATABASE_PATH.length)}`;
        }
        throw Object.assign(new Error('unexpected fixed diagnostic path'), { code: 'EPERM' });
    };
    return Object.freeze({
        filesystem: {
            lstatSync: ((fixedPath) => fs.lstatSync(mapped(fixedPath))),
            openSync: ((fixedPath, flags) => fs.openSync(mapped(fixedPath), flags)),
            fstatSync: fs.fstatSync,
            readSync: fs.readSync,
            closeSync: fs.closeSync,
        },
        openPrivateSnapshotReadOnly: (snapshot) => {
            expect(Buffer.isBuffer(snapshot)).toBe(true);
            const database = new Database(snapshot, { readonly: true });
            return transformDatabase?.(database) ?? database;
        },
    });
}
function proxyPragma(database, override) {
    return new Proxy(database, {
        get(target, property) {
            if (property === 'pragma') {
                return (source, options) => override(source, options);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
function runDiagnostic(dependencies) {
    return diagnoseFixedProductionShopifyDatabase(DIAGNOSTIC_ENVIRONMENT, dependencies);
}
describe('fixed Production Shopify database diagnostic', () => {
    it('verifies the canonical read-only boundary without changing bytes, metadata, or directory entries', () => {
        const loaded = fixture();
        const beforeBytes = fs.readFileSync(loaded.databasePath);
        const beforeStat = fs.statSync(loaded.databasePath);
        const beforeEntries = fs.readdirSync(loaded.root).sort();
        const result = runDiagnostic(mappedDependencies(loaded));
        expect(result).toEqual({
            status: 'database_diagnostic_verified',
            stage: 'verified',
            checks: Object.fromEntries(Object.keys(result.checks).map((key) => [key, true])),
            databaseWritesPerformed: 0,
            providerNetworkRequestsPerformed: 0,
            providerCredentialMutationsPerformed: 0,
            externalCommerceWritesPerformed: 0,
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.checks)).toBe(true);
        expect(fs.readFileSync(loaded.databasePath)).toEqual(beforeBytes);
        const afterStat = fs.statSync(loaded.databasePath);
        expect(afterStat.size).toBe(beforeStat.size);
        expect(afterStat.mode).toBe(beforeStat.mode);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
        expect(fs.readdirSync(loaded.root).sort()).toEqual(beforeEntries);
    });
    it('uses only the fixed database target and never selects credential columns', () => {
        const loaded = fixture();
        const prepared = [];
        const dependencies = mappedDependencies(loaded, (database) => new Proxy(database, {
            get(target, property) {
                if (property === 'prepare') {
                    return (source) => {
                        prepared.push(source);
                        return target.prepare(source);
                    };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }));
        const result = runDiagnostic(dependencies);
        expect(result.stage).toBe('verified');
        expect(prepared.length).toBeGreaterThanOrEqual(5);
        for (const statement of prepared.filter((source) => /^\s*SELECT\b/iu.test(source))) {
            expect(statement).not.toMatch(/(?:access_token|refresh_token|scope|expires_at)/iu);
        }
    });
    it('uses a private snapshot for a clean WAL-header database without creating sidecars', () => {
        const loaded = fixture({ walHeader: true });
        const beforeBytes = fs.readFileSync(loaded.databasePath);
        const beforeStat = fs.statSync(loaded.databasePath);
        const beforeEntries = fs.readdirSync(loaded.root).sort();
        expect(beforeBytes[18]).toBe(2);
        expect(beforeBytes[19]).toBe(2);
        const result = runDiagnostic(mappedDependencies(loaded));
        expect(result.stage).toBe('verified');
        expect(result.checks.sqliteOpenedFromPrivateSnapshot).toBe(true);
        expect(result.checks.sqlitePrivateMemory).toBe(true);
        expect(result.checks.sqliteSidecarsAbsentBeforeSnapshot).toBe(true);
        expect(result.checks.sqliteSidecarsAbsentAfterSnapshot).toBe(true);
        expect(fs.readFileSync(loaded.databasePath)).toEqual(beforeBytes);
        const afterStat = fs.statSync(loaded.databasePath);
        expect(afterStat.size).toBe(beforeStat.size);
        expect(afterStat.mode).toBe(beforeStat.mode);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
        expect(fs.readdirSync(loaded.root).sort()).toEqual(beforeEntries);
    });
    it('fails closed if a sidecar appears while the private snapshot is inspected', () => {
        const loaded = fixture();
        const dependencies = mappedDependencies(loaded);
        const result = runDiagnostic({
            ...dependencies,
            openPrivateSnapshotReadOnly: (snapshot) => {
                fs.writeFileSync(`${loaded.databasePath}-wal`, 'test-only-concurrent-sidecar');
                return new Database(snapshot, { readonly: true });
            },
        });
        expect(result).toMatchObject({
            stage: 'sidecar-post-present',
            checks: {
                sqliteSidecarsAbsentBeforeSnapshot: true,
                sqliteSidecarsAbsentAfterSnapshot: false,
            },
            databaseWritesPerformed: 0,
            providerNetworkRequestsPerformed: 0,
        });
        expect(JSON.stringify(result)).not.toContain('-wal');
    });
    it('returns only the first fixed file, permission, parent, sidecar, or identity stage', () => {
        const missing = fixture();
        fs.unlinkSync(missing.databasePath);
        expect(runDiagnostic(mappedDependencies(missing)).stage)
            .toBe('file-missing');
        const mode = fixture();
        fs.chmodSync(mode.databasePath, 0o640);
        expect(runDiagnostic(mappedDependencies(mode)).stage)
            .toBe('file-permissions-denied');
        const parent = fixture();
        fs.chmodSync(parent.root, 0o720);
        expect(runDiagnostic(mappedDependencies(parent)).stage)
            .toBe('parent-permissions-denied');
        const sidecar = fixture();
        fs.writeFileSync(`${sidecar.databasePath}-wal`, 'sentinel');
        expect(runDiagnostic(mappedDependencies(sidecar)).stage)
            .toBe('sidecar-present');
        const linked = fixture();
        fs.linkSync(linked.databasePath, `${linked.databasePath}.link`);
        expect(runDiagnostic(mappedDependencies(linked)).stage)
            .toBe('file-link-denied');
        const unstable = fixture();
        const dependencies = mappedDependencies(unstable);
        const filesystem = dependencies.filesystem;
        expect(runDiagnostic({
            ...dependencies,
            filesystem: {
                ...filesystem,
                fstatSync: ((descriptor) => {
                    const actual = fs.fstatSync(descriptor);
                    return new Proxy(actual, {
                        get(target, property, receiver) {
                            if (property === 'size')
                                return target.size + 1;
                            return Reflect.get(target, property, receiver);
                        },
                    });
                }),
            },
        }).stage).toBe('descriptor-identity-denied');
    });
    it('reports descriptor open, inspection, post-inspection, and close failures precisely', () => {
        const openLoaded = fixture();
        const openDependencies = mappedDependencies(openLoaded);
        expect(runDiagnostic({
            ...openDependencies,
            filesystem: {
                ...openDependencies.filesystem,
                openSync: (() => {
                    throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        })).toMatchObject({
            stage: 'descriptor-open-denied',
            checks: { descriptorOpenedReadOnly: false, descriptorClosed: false },
        });
        const inspectLoaded = fixture();
        const inspectDependencies = mappedDependencies(inspectLoaded);
        expect(runDiagnostic({
            ...inspectDependencies,
            filesystem: {
                ...inspectDependencies.filesystem,
                fstatSync: (() => {
                    throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        })).toMatchObject({
            stage: 'descriptor-inspection-denied',
            checks: {
                descriptorOpenedReadOnly: true,
                descriptorInspectedBeforeSnapshot: false,
                descriptorClosed: true,
            },
        });
        const postLoaded = fixture();
        const postDependencies = mappedDependencies(postLoaded);
        let fstatCalls = 0;
        expect(runDiagnostic({
            ...postDependencies,
            filesystem: {
                ...postDependencies.filesystem,
                fstatSync: ((descriptor) => {
                    fstatCalls += 1;
                    if (fstatCalls === 2) {
                        throw Object.assign(new Error('private detail'), { code: 'EIO' });
                    }
                    return fs.fstatSync(descriptor);
                }),
            },
        })).toMatchObject({
            stage: 'descriptor-post-inspection-denied',
            checks: {
                descriptorOpenedReadOnly: true,
                descriptorInspectedBeforeSnapshot: true,
                descriptorIdentityStableBeforeSnapshot: true,
                descriptorInspectedAfterSnapshot: false,
                descriptorClosed: true,
            },
        });
        const closeLoaded = fixture();
        const closeDependencies = mappedDependencies(closeLoaded);
        expect(runDiagnostic({
            ...closeDependencies,
            filesystem: {
                ...closeDependencies.filesystem,
                closeSync: ((descriptor) => {
                    fs.closeSync(descriptor);
                    throw Object.assign(new Error('private detail'), { code: 'EIO' });
                }),
            },
        })).toMatchObject({
            stage: 'descriptor-close-denied',
            checks: {
                descriptorOpenedReadOnly: true,
                descriptorIdentityStableBeforeSnapshot: true,
                descriptorIdentityStableAfterSnapshot: true,
                descriptorClosed: false,
            },
        });
    });
    it('inspects the descriptor-bound snapshot and fails if the fixed path is atomically substituted', () => {
        const loaded = fixture();
        const replacement = fixture({ includeShopifyRow: false });
        const dependencies = mappedDependencies(loaded);
        let swapped = false;
        const result = runDiagnostic({
            ...dependencies,
            openPrivateSnapshotReadOnly: (snapshot) => {
                const original = `${loaded.databasePath}.held-open`;
                fs.renameSync(loaded.databasePath, original);
                fs.copyFileSync(replacement.databasePath, loaded.databasePath);
                fs.chmodSync(loaded.databasePath, 0o666);
                swapped = true;
                return new Database(snapshot, { readonly: true });
            },
        });
        expect(swapped).toBe(true);
        expect(result).toMatchObject({
            status: 'database_diagnostic_failed_closed',
            stage: 'path-post-identity-denied',
            checks: {
                authTokensTableDefinitionCanonical: true,
                shopifyRowCardinalityOne: true,
                descriptorIdentityStableAfterSnapshot: true,
                pathIdentityStableAfterSnapshot: false,
            },
            databaseWritesPerformed: 0,
            providerNetworkRequestsPerformed: 0,
        });
        expect(fs.statSync(loaded.databasePath).mode & 0o777).toBe(0o666);
    });
    it('identifies connection-safety failures without reflecting driver errors', () => {
        const loaded = fixture();
        const tempStore = mappedDependencies(loaded, (database) => proxyPragma(database, (source, options) => source === 'temp_store'
            ? 0
            : database.pragma(source, options)));
        expect(runDiagnostic(tempStore).stage)
            .toBe('sqlite-temp-store-denied');
        const queryOnly = mappedDependencies(loaded, (database) => proxyPragma(database, (source, options) => source === 'query_only'
            ? 0
            : database.pragma(source, options)));
        expect(runDiagnostic(queryOnly).stage)
            .toBe('sqlite-query-only-denied');
        const close = mappedDependencies(loaded, (database) => new Proxy(database, {
            get(target, property) {
                if (property === 'close')
                    return () => {
                        target.close();
                        throw new Error('secret close detail');
                    };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }));
        expect(runDiagnostic(close).stage).toBe('sqlite-close-denied');
    });
    it.each([
        {
            label: 'missing table',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: 'CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY)',
                includeShopifyRow: false,
            }),
        },
        {
            label: 'missing column',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
          );
        `,
                includeShopifyRow: false,
            }),
        },
        {
            label: 'token-blocking CHECK constraint',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL UNIQUE,
            access_token TEXT NOT NULL CHECK(access_token = 'shopify-token-value-never-output'),
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          );
        `,
            }),
        },
        {
            label: 'generated hidden column',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            token_length INTEGER GENERATED ALWAYS AS (length(access_token)) VIRTUAL
          );
        `,
            }),
        },
        {
            label: 'STRICT table',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          ) STRICT;
        `,
            }),
        },
        {
            label: 'WITHOUT ROWID table',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY,
            platform TEXT NOT NULL UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          ) WITHOUT ROWID;
        `,
                includeShopifyRow: false,
            }),
        },
        {
            label: 'NOCASE unique index collation',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL COLLATE NOCASE UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          );
        `,
            }),
        },
        {
            label: 'descending unique index order',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({
                schema: `
          CREATE TABLE auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            UNIQUE(platform DESC)
          );
        `,
            }),
        },
        {
            label: 'extra index',
            expected: 'schema-index-denied',
            prepare: () => {
                const loaded = fixture();
                const database = new Database(loaded.databasePath);
                database.exec('CREATE INDEX extra_auth_index ON auth_tokens(updated_at)');
                database.close();
                fs.chmodSync(loaded.databasePath, 0o600);
                return loaded;
            },
        },
        {
            label: 'trigger',
            expected: 'schema-trigger-denied',
            prepare: () => {
                const loaded = fixture();
                const database = new Database(loaded.databasePath);
                database.exec(`CREATE TRIGGER auth_touch AFTER UPDATE ON auth_tokens BEGIN
          SELECT 1;
        END`);
                database.close();
                fs.chmodSync(loaded.databasePath, 0o600);
                return loaded;
            },
        },
        {
            label: 'foreign key',
            expected: 'schema-table-definition-denied',
            prepare: () => fixture({ schema: `
        CREATE TABLE platforms (name TEXT PRIMARY KEY);
        INSERT INTO platforms VALUES ('shopify');
        CREATE TABLE auth_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL UNIQUE REFERENCES platforms(name),
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          scope TEXT,
          expires_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      ` }),
        },
        {
            label: 'missing Shopify row',
            expected: 'shopify-row-cardinality-denied',
            prepare: () => fixture({ includeShopifyRow: false }),
        },
    ])('returns $expected for $label', ({ expected, prepare }) => {
        const loaded = prepare();
        const result = runDiagnostic(mappedDependencies(loaded));
        expect(result.stage).toBe(expected);
        expect(result.status).toBe('database_diagnostic_failed_closed');
        expect(result.databaseWritesPerformed).toBe(0);
        expect(result.providerNetworkRequestsPerformed).toBe(0);
    });
    it('maps shared storage, column, foreign-key, and mutation-shape proof failures precisely', () => {
        const tableStorage = fixture();
        expect(runDiagnostic(mappedDependencies(tableStorage, (database) => proxyPragma(database, (source, options) => {
            const value = database.pragma(source, options);
            if (source !== 'table_list')
                return value;
            return value.map((entry) => entry.name === 'auth_tokens' ? { ...entry, strict: 1 } : entry);
        }))).stage).toBe('schema-table-storage-denied');
        const columns = fixture();
        expect(runDiagnostic(mappedDependencies(columns, (database) => proxyPragma(database, (source, options) => {
            const value = database.pragma(source, options);
            if (source !== 'table_xinfo(auth_tokens)')
                return value;
            return [...value, {
                    cid: 8,
                    name: 'hidden_value',
                    type: 'TEXT',
                    notnull: 0,
                    dflt_value: null,
                    pk: 0,
                    hidden: 2,
                }];
        }))).stage).toBe('schema-columns-denied');
        const foreignKey = fixture();
        expect(runDiagnostic(mappedDependencies(foreignKey, (database) => proxyPragma(database, (source, options) => source === 'foreign_key_list(auth_tokens)'
            ? [{ id: 0 }]
            : database.pragma(source, options)))).stage).toBe('schema-foreign-key-denied');
        const mutation = fixture();
        expect(runDiagnostic(mappedDependencies(mutation, (database) => new Proxy(database, {
            get(target, property) {
                if (property === 'prepare') {
                    return (source) => {
                        if (source.startsWith('EXPLAIN UPDATE auth_tokens')) {
                            throw new Error('private compile detail');
                        }
                        return target.prepare(source);
                    };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }))).stage).toBe('schema-mutation-denied');
    });
    it('reports a fixed integrity stage and never emits paths, contents, digests, or sidecar suffixes', () => {
        const loaded = fixture();
        const dependencies = mappedDependencies(loaded, (database) => proxyPragma(database, (source, options) => source === 'integrity_check'
            ? 'not-ok-secret-driver-detail'
            : database.pragma(source, options)));
        const result = runDiagnostic(dependencies);
        const serialized = JSON.stringify(result);
        expect(result.stage).toBe('integrity-check-denied');
        expect(SHOPIFY_DATABASE_DIAGNOSTIC_STAGES).toContain(result.stage);
        for (const forbidden of [
            FIXED_DATABASE_PATH,
            loaded.databasePath,
            'shopify-token-value-never-output',
            'not-ok-secret-driver-detail',
            '-journal',
            '-wal',
            '-shm',
            'sha256',
        ])
            expect(serialized).not.toContain(forbidden);
    });
});
