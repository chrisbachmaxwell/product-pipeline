import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BACKUP_KIND } from './types.js';
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_REPORT_FILES = 400;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MANIFEST_FILE = 'manifest.json';
const defaultPlatform = { deviceId: (value) => fs.statSync(value).dev };
export class ControlStateBackupError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ControlStateBackupError';
    }
}
function deny(code) { throw new ControlStateBackupError(code); }
function digest(data) {
    return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function assertAbsoluteSafePath(value, code) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value)
        deny(code);
    const parts = value.split(path.sep);
    if (parts.includes('..') || value === path.parse(value).root)
        deny(code);
    return value;
}
function assertNoSymlinkAncestors(value) {
    let cursor = path.parse(value).root;
    for (const part of value.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        if (!fs.existsSync(cursor))
            continue;
        if (fs.lstatSync(cursor).isSymbolicLink())
            deny('PATH_SYMLINK_DENIED');
    }
}
function assertPrivateDirectory(value, code) {
    assertNoSymlinkAncestors(value);
    const stat = fs.lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        deny(code);
}
function assertPrivateFile(value, code) {
    assertNoSymlinkAncestors(value);
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
        deny(code);
}
export function loadBackupConfig(configPath, platform = defaultPlatform) {
    const exact = assertAbsoluteSafePath(configPath, 'CONFIG_PATH_INVALID');
    assertPrivateFile(exact, 'CONFIG_FILE_DENIED');
    const stat = fs.statSync(exact);
    if (stat.size < 2 || stat.size > MAX_CONFIG_BYTES)
        deny('CONFIG_FILE_DENIED');
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(exact, 'utf8'));
    }
    catch {
        deny('CONFIG_INVALID');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        deny('CONFIG_INVALID');
    const object = raw;
    if (Object.keys(object).sort().join(',') !== 'destinationRoot,kind,sourceVolumeRoot,sources')
        deny('CONFIG_INVALID');
    if (object.kind !== BACKUP_KIND || !object.sources || typeof object.sources !== 'object' || Array.isArray(object.sources))
        deny('CONFIG_INVALID');
    const sourcesObject = object.sources;
    if (Object.keys(sourcesObject).sort().join(',') !== 'appDatabase,listingControlDatabase,migrationStoreDatabase,shadowReportsDirectory')
        deny('CONFIG_INVALID');
    const config = {
        kind: BACKUP_KIND,
        sourceVolumeRoot: assertAbsoluteSafePath(object.sourceVolumeRoot, 'SOURCE_ROOT_INVALID'),
        destinationRoot: assertAbsoluteSafePath(object.destinationRoot, 'DESTINATION_ROOT_INVALID'),
        sources: {
            appDatabase: assertAbsoluteSafePath(sourcesObject.appDatabase, 'SOURCE_PATH_INVALID'),
            listingControlDatabase: assertAbsoluteSafePath(sourcesObject.listingControlDatabase, 'SOURCE_PATH_INVALID'),
            migrationStoreDatabase: assertAbsoluteSafePath(sourcesObject.migrationStoreDatabase, 'SOURCE_PATH_INVALID'),
            shadowReportsDirectory: assertAbsoluteSafePath(sourcesObject.shadowReportsDirectory, 'SOURCE_PATH_INVALID'),
        },
    };
    assertPrivateDirectory(config.sourceVolumeRoot, 'SOURCE_ROOT_DENIED');
    assertPrivateDirectory(config.destinationRoot, 'DESTINATION_ROOT_DENIED');
    if (isWithin(config.sourceVolumeRoot, config.destinationRoot) || isWithin(config.destinationRoot, config.sourceVolumeRoot))
        deny('DESTINATION_NOT_OFF_VOLUME');
    if (platform.deviceId(config.sourceVolumeRoot) === platform.deviceId(config.destinationRoot))
        deny('DESTINATION_NOT_OFF_VOLUME');
    for (const source of Object.values(config.sources)) {
        if (!isWithin(config.sourceVolumeRoot, source))
            deny('SOURCE_OUTSIDE_VOLUME');
    }
    return { config, configDigest: digest(stable(config)) };
}
function canonicalTime(value) {
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString() !== value)
        deny('CREATED_AT_INVALID');
    return value;
}
export function previewSnapshot(configPath, createdAtUtc, platform = defaultPlatform) {
    const loaded = loadBackupConfig(configPath, platform);
    const created = canonicalTime(createdAtUtc);
    const snapshotName = `snapshot-${created.replace(/[:.]/g, '-')}`;
    const snapshotPath = path.join(loaded.config.destinationRoot, snapshotName);
    if (fs.existsSync(snapshotPath))
        deny('SNAPSHOT_EXISTS');
    return { configDigest: loaded.configDigest, snapshotName, snapshotPath, config: loaded.config };
}
async function snapshotSqlite(source, destination) {
    assertPrivateFile(source, 'DATABASE_SOURCE_DENIED');
    for (const suffix of ['-journal'])
        if (fs.existsSync(`${source}${suffix}`))
            deny('DATABASE_JOURNAL_DENIED');
    const database = new Database(source, { readonly: true, fileMustExist: true });
    try {
        database.pragma('query_only = ON');
        const integrity = database.pragma('quick_check', { simple: true });
        if (integrity !== 'ok')
            deny('DATABASE_INTEGRITY_DENIED');
        await database.backup(destination);
    }
    finally {
        database.close();
    }
    const copy = new Database(destination, { fileMustExist: true });
    try {
        copy.pragma('journal_mode = DELETE');
        if (copy.pragma('quick_check', { simple: true }) !== 'ok')
            deny('DATABASE_BACKUP_INVALID');
    }
    finally {
        copy.close();
    }
    fs.chmodSync(destination, 0o600);
}
function listReports(root) {
    assertPrivateDirectory(root, 'REPORT_DIRECTORY_DENIED');
    const result = [];
    let bytes = 0;
    for (const name of fs.readdirSync(root).sort()) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name))
            deny('REPORT_ENTRY_DENIED');
        const source = path.join(root, name);
        assertPrivateFile(source, 'REPORT_ENTRY_DENIED');
        const stat = fs.statSync(source);
        bytes += stat.size;
        result.push({ source, relative: name });
        if (result.length > MAX_REPORT_FILES || bytes > MAX_REPORT_BYTES)
            deny('REPORT_LIMIT_EXCEEDED');
    }
    return result;
}
function fileRecord(logicalName, relativePath, format, absolutePath) {
    const content = fs.readFileSync(absolutePath);
    return { logicalName, relativePath, format, bytes: content.byteLength, sha256: digest(content) };
}
export async function createSnapshot(input) {
    const preview = previewSnapshot(input.configPath, input.createdAtUtc, input.platform);
    if (input.confirmDigest !== preview.configDigest)
        deny('CONFIRMATION_MISMATCH');
    const databases = [
        ['app-database', preview.config.sources.appDatabase],
        ['listing-control-database', preview.config.sources.listingControlDatabase],
        ['migration-store-database', preview.config.sources.migrationStoreDatabase],
    ];
    for (const [, source] of databases)
        assertPrivateFile(source, 'DATABASE_SOURCE_DENIED');
    const reports = listReports(preview.config.sources.shadowReportsDirectory);
    fs.mkdirSync(preview.snapshotPath, { mode: 0o700 });
    const files = [];
    for (const [logicalName, source] of databases) {
        const relative = `databases/${logicalName}.sqlite`;
        fs.mkdirSync(path.join(preview.snapshotPath, 'databases'), { recursive: true, mode: 0o700 });
        const target = path.join(preview.snapshotPath, relative);
        await snapshotSqlite(source, target);
        files.push(fileRecord(logicalName, relative, 'sqlite', target));
    }
    if (reports.length)
        fs.mkdirSync(path.join(preview.snapshotPath, 'shadow-reports'), { mode: 0o700 });
    for (const report of reports) {
        const relative = `shadow-reports/${report.relative}`;
        const target = path.join(preview.snapshotPath, relative);
        fs.copyFileSync(report.source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
        files.push(fileRecord('shadow-report', relative, 'json', target));
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const manifest = {
        kind: BACKUP_KIND,
        createdAtUtc: input.createdAtUtc,
        configDigest: preview.configDigest,
        files,
        totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
        safety: { providerAccess: false, commerceWrites: false, sourceMutation: false, liveRestore: false },
    };
    const descriptor = fs.openSync(path.join(preview.snapshotPath, MANIFEST_FILE), 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${stable(manifest)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    const directoryDescriptor = fs.openSync(preview.snapshotPath, 'r');
    try {
        fs.fsyncSync(directoryDescriptor);
    }
    finally {
        fs.closeSync(directoryDescriptor);
    }
    return { snapshotPath: preview.snapshotPath, manifest: verifySnapshot(preview.snapshotPath) };
}
export function verifySnapshot(snapshotPath) {
    const root = assertAbsoluteSafePath(snapshotPath, 'SNAPSHOT_PATH_INVALID');
    assertPrivateDirectory(root, 'SNAPSHOT_DIRECTORY_DENIED');
    const manifestPath = path.join(root, MANIFEST_FILE);
    assertPrivateFile(manifestPath, 'MANIFEST_DENIED');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    catch {
        deny('MANIFEST_DENIED');
    }
    if (manifest.kind !== BACKUP_KIND || !Array.isArray(manifest.files) || !manifest.totals
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.createdAtUtc)
        || !/^sha256:[0-9a-f]{64}$/.test(manifest.configDigest)
        || manifest.safety?.providerAccess !== false || manifest.safety.commerceWrites !== false
        || manifest.safety.sourceMutation !== false || manifest.safety.liveRestore !== false)
        deny('MANIFEST_DENIED');
    const expected = new Set([MANIFEST_FILE]);
    const seen = new Set();
    const requiredDatabases = new Map([
        ['databases/app-database.sqlite', 'app-database'],
        ['databases/listing-control-database.sqlite', 'listing-control-database'],
        ['databases/migration-store-database.sqlite', 'migration-store-database'],
    ]);
    let total = 0;
    for (const file of manifest.files) {
        if (!file || typeof file !== 'object')
            deny('MANIFEST_DENIED');
        if (!/^(databases\/[a-z-]+\.sqlite|shadow-reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json)$/.test(file.relativePath))
            deny('MANIFEST_DENIED');
        const absolute = path.join(root, file.relativePath);
        if (!isWithin(root, absolute))
            deny('MANIFEST_DENIED');
        if (seen.has(file.relativePath))
            deny('MANIFEST_DENIED');
        seen.add(file.relativePath);
        if (typeof file.logicalName !== 'string' || file.logicalName.length < 1
            || file.logicalName.length > 64 || !Number.isSafeInteger(file.bytes) || file.bytes < 0
            || !/^sha256:[0-9a-f]{64}$/.test(file.sha256)
            || (file.format !== 'sqlite' && file.format !== 'json'))
            deny('MANIFEST_DENIED');
        const requiredLogicalName = requiredDatabases.get(file.relativePath);
        if (requiredLogicalName !== undefined) {
            if (file.logicalName !== requiredLogicalName || file.format !== 'sqlite')
                deny('MANIFEST_DENIED');
            requiredDatabases.delete(file.relativePath);
        }
        else if (!file.relativePath.startsWith('shadow-reports/')
            || file.logicalName !== 'shadow-report' || file.format !== 'json')
            deny('MANIFEST_DENIED');
        assertPrivateFile(absolute, 'SNAPSHOT_FILE_DENIED');
        const content = fs.readFileSync(absolute);
        if (content.byteLength !== file.bytes || digest(content) !== file.sha256)
            deny('SNAPSHOT_DIGEST_MISMATCH');
        if (file.format === 'sqlite') {
            const database = new Database(absolute, { readonly: true, fileMustExist: true });
            try {
                if (database.pragma('quick_check', { simple: true }) !== 'ok')
                    deny('SNAPSHOT_DATABASE_INVALID');
            }
            finally {
                database.close();
            }
        }
        expected.add(file.relativePath);
        total += file.bytes;
    }
    if (Object.keys(manifest.totals).sort().join(',') !== 'bytes,files'
        || !Number.isSafeInteger(manifest.totals.files) || !Number.isSafeInteger(manifest.totals.bytes)
        || requiredDatabases.size !== 0 || manifest.totals.files !== manifest.files.length
        || manifest.totals.bytes !== total)
        deny('MANIFEST_DENIED');
    const actual = new Set();
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isFile())
                actual.add(path.relative(root, absolute));
            else if (entry.isDirectory())
                walk(absolute);
            else
                deny('SNAPSHOT_ENTRY_DENIED');
        }
    };
    walk(root);
    if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry)))
        deny('SNAPSHOT_EXTRA_FILE');
    return manifest;
}
export function rehearseRestore(input) {
    const manifest = verifySnapshot(input.snapshotPath);
    const destination = assertAbsoluteSafePath(input.destinationPath, 'RESTORE_PATH_INVALID');
    if (fs.existsSync(destination))
        deny('RESTORE_DESTINATION_EXISTS');
    if (isWithin(input.snapshotPath, destination) || isWithin(destination, input.snapshotPath))
        deny('RESTORE_PATH_INVALID');
    assertPrivateDirectory(path.dirname(destination), 'RESTORE_PARENT_DENIED');
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const file of manifest.files) {
        const target = path.join(destination, file.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(input.snapshotPath, file.relativePath), target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
    }
    const copiedManifest = path.join(destination, MANIFEST_FILE);
    fs.copyFileSync(path.join(input.snapshotPath, MANIFEST_FILE), copiedManifest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(copiedManifest, 0o600);
    verifySnapshot(destination);
    return manifest;
}
