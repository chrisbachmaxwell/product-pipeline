import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { assertLegacyDatabaseIdentity, assertLegacyDatabasePath, PRODUCT_PIPELINE_PRODUCTION_RUNTIME, } from './config.js';
import { rotationDenied, translateRotationError } from './errors.js';
import { CANONICAL_SHOPIFY_SCOPE_TEXT, } from './network.js';
const EXPECTED_COLUMNS = Object.freeze([
    Object.freeze({ name: 'id', type: 'INTEGER', notnull: 0, pk: 1 }),
    Object.freeze({ name: 'platform', type: 'TEXT', notnull: 1, pk: 0 }),
    Object.freeze({ name: 'access_token', type: 'TEXT', notnull: 1, pk: 0 }),
    Object.freeze({ name: 'refresh_token', type: 'TEXT', notnull: 0, pk: 0 }),
    Object.freeze({ name: 'scope', type: 'TEXT', notnull: 0, pk: 0 }),
    Object.freeze({ name: 'expires_at', type: 'INTEGER', notnull: 0, pk: 0 }),
    Object.freeze({ name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 }),
    Object.freeze({ name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 }),
]);
const SAFE_TOKEN = /^[^\s\u0000-\u001f\u007f]+$/u;
const CONTENT_PROOF_MAX_TABLES = 256;
const CONTENT_PROOF_MAX_COLUMNS_PER_TABLE = 256;
const CONTENT_PROOF_MAX_ROWS = 2_000_000;
const CONTENT_PROOF_MAX_BYTES = 512 * 1_024 * 1_024;
const SHOPIFY_MUTABLE_COLUMNS = new Set([
    'access_token',
    'refresh_token',
    'scope',
    'expires_at',
    'updated_at',
]);
function canonicalScopeOrNull(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string')
        return rotationDenied('token-row-denied');
    const scopes = value.split(',');
    if (scopes.some((scope) => scope.trim() !== scope || scope.length === 0)) {
        return rotationDenied('token-row-denied');
    }
    const unique = [...new Set(scopes)].sort();
    const expected = CANONICAL_SHOPIFY_SCOPE_TEXT.split(',');
    if (scopes.length !== expected.length
        || unique.length !== expected.length
        || unique.some((scope, index) => scope !== expected[index])) {
        return rotationDenied('token-row-denied');
    }
    return CANONICAL_SHOPIFY_SCOPE_TEXT;
}
function row(database) {
    const rows = database.prepare(`SELECT id, platform, access_token, refresh_token, scope, expires_at, created_at, updated_at
     FROM auth_tokens WHERE platform = 'shopify' LIMIT 2`).all();
    if (rows.length !== 1)
        return rotationDenied('token-row-denied');
    const value = rows[0];
    if (!Number.isSafeInteger(value.id) || Number(value.id) <= 0
        || value.platform !== 'shopify'
        || typeof value.access_token !== 'string'
        || value.access_token.length < 16
        || value.access_token.length > 8_192
        || value.access_token.trim() !== value.access_token
        || !SAFE_TOKEN.test(value.access_token)
        || value.refresh_token !== null
        || value.expires_at !== null
        || !Number.isSafeInteger(value.created_at)
        || !Number.isSafeInteger(value.updated_at))
        return rotationDenied('token-row-denied');
    return Object.freeze({
        id: Number(value.id),
        platform: 'shopify',
        accessToken: value.access_token,
        refreshToken: null,
        rawScope: value.scope,
        scope: canonicalScopeOrNull(value.scope),
        expiresAt: null,
        createdAt: Number(value.created_at),
        updatedAt: Number(value.updated_at),
    });
}
function equalRows(left, right) {
    return left.id === right.id
        && left.platform === right.platform
        && left.accessToken === right.accessToken
        && left.refreshToken === right.refreshToken
        && left.rawScope === right.rawScope
        && left.scope === right.scope
        && left.expiresAt === right.expiresAt
        && left.createdAt === right.createdAt
        && left.updatedAt === right.updatedAt;
}
function verifySchema(database) {
    const table = database.prepare(`SELECT type FROM sqlite_schema WHERE name = 'auth_tokens'`).all();
    if (table.length !== 1 || table[0]?.type !== 'table')
        return rotationDenied('database-denied');
    const columns = database.pragma('table_info(auth_tokens)');
    if (columns.length !== EXPECTED_COLUMNS.length || columns.some((column, index) => {
        const expected = EXPECTED_COLUMNS[index];
        return column.name !== expected.name
            || column.type.toUpperCase() !== expected.type
            || column.notnull !== expected.notnull
            || column.pk !== expected.pk;
    }))
        return rotationDenied('database-denied');
    const indexes = database.pragma('index_list(auth_tokens)');
    if (indexes.length !== 1 || indexes[0]?.unique !== 1
        || indexes[0].origin !== 'u' || indexes[0].partial !== 0) {
        return rotationDenied('database-denied');
    }
    const indexedColumns = database.pragma(`index_info('${indexes[0].name.replaceAll("'", "''")}')`);
    if (indexedColumns.length !== 1 || indexedColumns[0]?.name !== 'platform') {
        return rotationDenied('database-denied');
    }
    const triggers = database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'auth_tokens'`).all();
    const foreignKeys = database.pragma('foreign_key_list(auth_tokens)');
    if (triggers.length !== 0 || foreignKeys.length !== 0) {
        return rotationDenied('database-denied');
    }
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
        return rotationDenied('database-denied');
    }
}
function configureContentProofConnection(database, denyCode) {
    try {
        database.pragma('temp_store = MEMORY');
        if (database.pragma('temp_store', { simple: true }) !== 2) {
            return rotationDenied(denyCode);
        }
    }
    catch (error) {
        return translateRotationError(error, denyCode);
    }
}
function quotedIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function digestValue(digest, value, counters, denyCode) {
    let tag;
    let bytes;
    if (value === null) {
        tag = 'null';
        bytes = Buffer.alloc(0);
    }
    else if (typeof value === 'string') {
        tag = 'text';
        bytes = Buffer.from(value, 'utf8');
    }
    else if (typeof value === 'number') {
        tag = 'number';
        bytes = Buffer.from(Object.is(value, -0) ? '-0' : String(value), 'utf8');
    }
    else if (typeof value === 'bigint') {
        tag = 'integer';
        bytes = Buffer.from(value.toString(10), 'utf8');
    }
    else if (Buffer.isBuffer(value)) {
        tag = 'blob';
        bytes = value;
    }
    else {
        return rotationDenied(denyCode);
    }
    counters.bytes += bytes.byteLength;
    if (counters.bytes > CONTENT_PROOF_MAX_BYTES)
        return rotationDenied(denyCode);
    digest.update(`${tag}:${bytes.byteLength}:`, 'utf8');
    digest.update(bytes);
    digest.update(';', 'utf8');
}
function catalogProof(database, mutableShopifyRowId, denyCode) {
    if (database.pragma('temp_store', { simple: true }) !== 2)
        return rotationDenied(denyCode);
    const schemaRows = database.prepare(`SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
     FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence'
     ORDER BY type, name, tbl_name, sql`).all();
    const schema = schemaRows.map((entry) => JSON.stringify([entry.type, entry.name, entry.tbl_name, entry.sql]));
    const tableEntries = schemaRows.filter((item) => item.type === 'table');
    if (tableEntries.length > CONTENT_PROOF_MAX_TABLES)
        return rotationDenied(denyCode);
    const tableCounts = {};
    const digest = createHash('sha256');
    const counters = { bytes: 0 };
    let contentRows = 0;
    for (const schemaEntry of schema)
        digestValue(digest, schemaEntry, counters, denyCode);
    for (const entry of tableEntries) {
        const quoted = quotedIdentifier(entry.name);
        const count = database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get();
        if (!Number.isSafeInteger(count.count) || count.count < 0)
            return rotationDenied(denyCode);
        tableCounts[entry.name] = count.count;
        const columns = database.prepare(`PRAGMA table_info(${quoted})`).all();
        if (columns.length === 0 || columns.length > CONTENT_PROOF_MAX_COLUMNS_PER_TABLE) {
            return rotationDenied(denyCode);
        }
        digestValue(digest, entry.name, counters, denyCode);
        for (const column of columns)
            digestValue(digest, column.name, counters, denyCode);
        const selected = columns.map((column) => quotedIdentifier(column.name)).join(', ');
        const ordered = columns.flatMap((column) => {
            const identifier = quotedIdentifier(column.name);
            return [`typeof(${identifier})`, `hex(CAST(${identifier} AS BLOB))`];
        }).join(', ');
        const statement = database.prepare(`SELECT ${selected} FROM ${quoted} ORDER BY ${ordered}`);
        statement.safeIntegers(true);
        for (const raw of statement.iterate()) {
            contentRows += 1;
            if (contentRows > CONTENT_PROOF_MAX_ROWS)
                return rotationDenied(denyCode);
            const isMutableShopifyRow = mutableShopifyRowId !== null
                && entry.name === 'auth_tokens'
                && raw.platform === 'shopify'
                && raw.id === BigInt(mutableShopifyRowId);
            for (const column of columns) {
                const value = isMutableShopifyRow && SHOPIFY_MUTABLE_COLUMNS.has(column.name)
                    ? '<shopify-rotation-mutable>'
                    : raw[column.name];
                digestValue(digest, value, counters, denyCode);
            }
        }
    }
    return Object.freeze({
        schema: Object.freeze(schema),
        tableCounts: Object.freeze(tableCounts),
        contentDigest: digest.digest('hex'),
        contentRows,
        contentBytes: counters.bytes,
    });
}
function equalCatalog(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function assertBackupDirectory(directory) {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
        return rotationDenied('backup-denied');
    }
    const parsed = path.parse(directory);
    let current = parsed.root;
    for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
            const stat = fs.lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
                return rotationDenied('backup-denied');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                return translateRotationError(error, 'backup-denied');
            }
            try {
                fs.mkdirSync(current, { mode: 0o700 });
            }
            catch (mkdirError) {
                return translateRotationError(mkdirError, 'backup-denied');
            }
        }
    }
    const final = fs.lstatSync(directory);
    if ((final.mode & 0o777) !== 0o700) {
        return rotationDenied('backup-denied');
    }
}
const PRODUCTION_PATH_POLICY = Object.freeze({
    expectedDatabasePath: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
    backupDirectory: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.backupDirectory,
});
export class LegacyShopifyTokenStore {
    #database;
    #databasePath;
    #expectedDatabasePath;
    #backupDirectory;
    #identity;
    #initialRow;
    #initialProtectedCatalog;
    constructor(database, databasePath, pathPolicy, identity, initialRow, initialProtectedCatalog) {
        this.#database = database;
        this.#databasePath = databasePath;
        this.#expectedDatabasePath = pathPolicy.expectedDatabasePath;
        this.#backupDirectory = pathPolicy.backupDirectory;
        this.#identity = identity;
        this.#initialRow = initialRow;
        this.#initialProtectedCatalog = initialProtectedCatalog;
    }
    static open(databasePath, pathPolicy = PRODUCTION_PATH_POLICY) {
        const identity = assertLegacyDatabasePath(databasePath, pathPolicy.expectedDatabasePath);
        let database = null;
        try {
            database = new Database(databasePath, { fileMustExist: true });
            configureContentProofConnection(database, 'database-denied');
            database.pragma('query_only = ON');
            verifySchema(database);
            const initialRow = row(database);
            const initialProtectedCatalog = catalogProof(database, initialRow.id, 'database-denied');
            return new LegacyShopifyTokenStore(database, databasePath, pathPolicy, identity, initialRow, initialProtectedCatalog);
        }
        catch (error) {
            if (database?.open)
                database.close();
            return translateRotationError(error, 'database-denied');
        }
    }
    snapshot() {
        return this.#initialRow;
    }
    async createBackup(now) {
        assertLegacyDatabaseIdentity(this.#databasePath, this.#identity, this.#expectedDatabasePath);
        const backupDirectory = this.#backupDirectory;
        assertBackupDirectory(backupDirectory);
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDirectory, `shopify-auth-token-before-${timestamp}-${randomUUID()}.sqlite`);
        const sourceDataVersion = this.#database.pragma('data_version', { simple: true });
        if (!equalCatalog(catalogProof(this.#database, this.#initialRow.id, 'concurrency-denied'), this.#initialProtectedCatalog))
            return rotationDenied('concurrency-denied');
        const sourceCatalog = catalogProof(this.#database, null, 'backup-denied');
        try {
            await this.#database.backup(backupPath);
            fs.chmodSync(backupPath, 0o600);
            const stat = fs.lstatSync(backupPath);
            if (!stat.isFile()
                || stat.isSymbolicLink()
                || stat.nlink !== 1
                || stat.size <= 0
                || (stat.mode & 0o777) !== 0o600
                || this.#database.pragma('data_version', { simple: true }) !== sourceDataVersion)
                return rotationDenied('backup-denied');
            const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
            try {
                configureContentProofConnection(backup, 'backup-denied');
                backup.pragma('query_only = ON');
                verifySchema(backup);
                if (!equalRows(row(backup), this.#initialRow)
                    || !equalCatalog(catalogProof(backup, null, 'backup-denied'), sourceCatalog)) {
                    return rotationDenied('backup-denied');
                }
            }
            finally {
                backup.close();
            }
            const descriptor = fs.openSync(backupPath, 'r');
            try {
                fs.fsyncSync(descriptor);
            }
            finally {
                fs.closeSync(descriptor);
            }
            const directoryDescriptor = fs.openSync(backupDirectory, 'r');
            try {
                fs.fsyncSync(directoryDescriptor);
            }
            finally {
                fs.closeSync(directoryDescriptor);
            }
            return backupPath;
        }
        catch (error) {
            if (fs.existsSync(backupPath))
                fs.unlinkSync(backupPath);
            return translateRotationError(error, 'backup-denied');
        }
    }
    compareAndSwapAccessToken(fresh, now) {
        if (fresh.accessToken.length < 16
            || fresh.accessToken.length > 8_192
            || fresh.accessToken.trim() !== fresh.accessToken
            || !SAFE_TOKEN.test(fresh.accessToken)
            || fresh.accessToken === this.#initialRow.accessToken
            || fresh.refreshToken !== null
            || fresh.scope !== CANONICAL_SHOPIFY_SCOPE_TEXT
            || fresh.expiresAt !== null)
            return rotationDenied('database-denied');
        assertLegacyDatabaseIdentity(this.#databasePath, this.#identity, this.#expectedDatabasePath);
        const updatedAt = Math.max(Math.floor(now.getTime() / 1_000), this.#initialRow.updatedAt + 1);
        if (!Number.isSafeInteger(updatedAt))
            return rotationDenied('database-denied');
        this.#database.pragma('query_only = OFF');
        try {
            const transaction = this.#database.transaction(() => {
                verifySchema(this.#database);
                if (!equalRows(row(this.#database), this.#initialRow)) {
                    return rotationDenied('concurrency-denied');
                }
                if (!equalCatalog(catalogProof(this.#database, this.#initialRow.id, 'concurrency-denied'), this.#initialProtectedCatalog))
                    return rotationDenied('concurrency-denied');
                const result = this.#database.prepare(`UPDATE auth_tokens
           SET access_token = ?, refresh_token = NULL, scope = ?, expires_at = NULL, updated_at = ?
           WHERE id = ? AND platform = 'shopify' AND access_token = ?
             AND refresh_token IS NULL AND scope IS ? AND expires_at IS NULL
             AND created_at = ? AND updated_at = ?`).run(fresh.accessToken, fresh.scope, updatedAt, this.#initialRow.id, this.#initialRow.accessToken, this.#initialRow.rawScope, this.#initialRow.createdAt, this.#initialRow.updatedAt);
                if (result.changes !== 1)
                    return rotationDenied('concurrency-denied');
                const after = row(this.#database);
                if (after.id !== this.#initialRow.id
                    || after.platform !== this.#initialRow.platform
                    || after.accessToken !== fresh.accessToken
                    || after.refreshToken !== null
                    || after.rawScope !== fresh.scope
                    || after.scope !== fresh.scope
                    || after.expiresAt !== null
                    || after.createdAt !== this.#initialRow.createdAt
                    || after.updatedAt !== updatedAt)
                    return rotationDenied('database-denied');
                if (!equalCatalog(catalogProof(this.#database, this.#initialRow.id, 'database-denied'), this.#initialProtectedCatalog))
                    return rotationDenied('database-denied');
            });
            transaction.immediate();
        }
        catch (error) {
            return translateRotationError(error, 'concurrency-denied');
        }
        finally {
            this.#database.pragma('query_only = ON');
        }
    }
    close() {
        if (this.#database.open)
            this.#database.close();
    }
}
export function readShopifyAuthTokenRowReadOnly(databasePath, expectedDatabasePath = PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath) {
    assertLegacyDatabasePath(databasePath, expectedDatabasePath);
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        configureContentProofConnection(database, 'database-denied');
        database.pragma('query_only = ON');
        verifySchema(database);
        return row(database);
    }
    catch (error) {
        return translateRotationError(error, 'database-denied');
    }
    finally {
        database.close();
    }
}
