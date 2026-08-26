import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ControlStateBackupError, createSnapshot, previewSnapshot, rehearseRestore, verifySnapshot, } from './core.js';
import { BACKUP_KIND } from './types.js';
const distinctDevices = { deviceId: (value) => value.includes('off-volume') ? 2 : 1 };
function privateDirectory(value) {
    fs.mkdirSync(value, { recursive: true, mode: 0o700 });
    fs.chmodSync(value, 0o700);
}
function makeDatabase(value, marker) {
    const database = new Database(value);
    database.exec('CREATE TABLE evidence (value TEXT NOT NULL)');
    database.prepare('INSERT INTO evidence (value) VALUES (?)').run(marker);
    database.close();
    fs.chmodSync(value, 0o600);
}
function world() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'control-state-backup-')));
    fs.chmodSync(root, 0o700);
    const volume = path.join(root, 'volume');
    const destination = path.join(root, 'off-volume');
    privateDirectory(volume);
    privateDirectory(destination);
    const app = path.join(volume, 'ebaysync.db');
    const listing = path.join(volume, 'listing-control.sqlite');
    const migration = path.join(volume, 'migration-state.sqlite');
    makeDatabase(app, 'app-state');
    makeDatabase(listing, 'listing-state');
    makeDatabase(migration, 'migration-state');
    const reports = path.join(volume, 'shadow-reports');
    privateDirectory(reports);
    fs.writeFileSync(path.join(reports, '2026-08-26.json'), '{"blockedCount":0}\n', { mode: 0o600 });
    const config = path.join(root, 'backup.json');
    fs.writeFileSync(config, JSON.stringify({
        kind: BACKUP_KIND,
        sourceVolumeRoot: volume,
        destinationRoot: destination,
        sources: {
            appDatabase: app,
            listingControlDatabase: listing,
            migrationStoreDatabase: migration,
            shadowReportsDirectory: reports,
        },
    }), { mode: 0o600 });
    return { root, volume, destination, config, app, reports };
}
describe('control-state backup and restore rehearsal', () => {
    it('previews without writing, creates consistent SQLite snapshots, verifies, and rehearses into a new directory', async () => {
        const fixture = world();
        const createdAtUtc = '2026-08-26T18:00:00.000Z';
        const preview = previewSnapshot(fixture.config, createdAtUtc, distinctDevices);
        expect(fs.existsSync(preview.snapshotPath)).toBe(false);
        const created = await createSnapshot({ configPath: fixture.config, createdAtUtc, confirmDigest: preview.configDigest, platform: distinctDevices });
        expect(created.manifest.totals.files).toBe(4);
        expect(created.manifest.safety).toEqual({ providerAccess: false, commerceWrites: false, sourceMutation: false, liveRestore: false });
        expect(verifySnapshot(created.snapshotPath)).toEqual(created.manifest);
        const rehearsalParent = path.join(fixture.root, 'rehearsals');
        privateDirectory(rehearsalParent);
        const rehearsal = path.join(rehearsalParent, 'restored');
        expect(rehearseRestore({ snapshotPath: created.snapshotPath, destinationPath: rehearsal })).toEqual(created.manifest);
        const restored = new Database(path.join(rehearsal, 'databases', 'app-database.sqlite'), { readonly: true });
        expect(restored.prepare('SELECT value FROM evidence').pluck().get()).toBe('app-state');
        restored.close();
    });
    it('uses SQLite online backup so committed WAL state survives without copying sidecars', async () => {
        const fixture = world();
        const live = new Database(fixture.app);
        live.pragma('journal_mode = WAL');
        live.prepare('INSERT INTO evidence (value) VALUES (?)').run('committed-in-wal');
        const createdAtUtc = '2026-08-26T18:01:00.000Z';
        const preview = previewSnapshot(fixture.config, createdAtUtc, distinctDevices);
        const created = await createSnapshot({ configPath: fixture.config, createdAtUtc, confirmDigest: preview.configDigest, platform: distinctDevices });
        live.close();
        const copy = new Database(path.join(created.snapshotPath, 'databases', 'app-database.sqlite'), { readonly: true });
        expect(copy.prepare('SELECT value FROM evidence ORDER BY rowid').pluck().all()).toEqual(['app-state', 'committed-in-wal']);
        copy.close();
    });
    it('denies an on-volume destination and a mismatched confirmation without creating a snapshot', async () => {
        const fixture = world();
        const config = JSON.parse(fs.readFileSync(fixture.config, 'utf8'));
        config.destinationRoot = path.join(fixture.volume, 'backups');
        privateDirectory(config.destinationRoot);
        fs.writeFileSync(fixture.config, JSON.stringify(config));
        fs.chmodSync(fixture.config, 0o600);
        expect(() => previewSnapshot(fixture.config, '2026-08-26T18:02:00.000Z', distinctDevices)).toThrowError(ControlStateBackupError);
        const safe = world();
        const preview = previewSnapshot(safe.config, '2026-08-26T18:03:00.000Z', distinctDevices);
        await expect(createSnapshot({ configPath: safe.config, createdAtUtc: '2026-08-26T18:03:00.000Z', confirmDigest: 'sha256:wrong', platform: distinctDevices })).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
        expect(fs.existsSync(preview.snapshotPath)).toBe(false);
    });
    it('denies a separate-looking destination on the same filesystem device', () => {
        const fixture = world();
        expect(() => previewSnapshot(fixture.config, '2026-08-26T18:03:30.000Z', { deviceId: () => 7 }))
            .toThrowError('DESTINATION_NOT_OFF_VOLUME');
    });
    it('detects snapshot tampering and refuses every overwrite-shaped rehearsal target', async () => {
        const fixture = world();
        const createdAtUtc = '2026-08-26T18:04:00.000Z';
        const preview = previewSnapshot(fixture.config, createdAtUtc, distinctDevices);
        const created = await createSnapshot({ configPath: fixture.config, createdAtUtc, confirmDigest: preview.configDigest, platform: distinctDevices });
        const existing = path.join(fixture.root, 'existing');
        privateDirectory(existing);
        expect(() => rehearseRestore({ snapshotPath: created.snapshotPath, destinationPath: existing })).toThrowError(ControlStateBackupError);
        fs.appendFileSync(path.join(created.snapshotPath, 'shadow-reports', '2026-08-26.json'), 'tamper');
        expect(() => verifySnapshot(created.snapshotPath)).toThrowError(ControlStateBackupError);
    });
    it('denies symlinked report entries and leaves the source state unchanged', async () => {
        const fixture = world();
        const before = fs.readFileSync(fixture.app);
        const outside = path.join(fixture.root, 'outside.json');
        fs.writeFileSync(outside, '{}', { mode: 0o600 });
        fs.symlinkSync(outside, path.join(fixture.reports, 'linked.json'));
        const preview = previewSnapshot(fixture.config, '2026-08-26T18:05:00.000Z', distinctDevices);
        await expect(createSnapshot({ configPath: fixture.config, createdAtUtc: '2026-08-26T18:05:00.000Z', confirmDigest: preview.configDigest, platform: distinctDevices })).rejects.toBeInstanceOf(ControlStateBackupError);
        expect(fs.readFileSync(fixture.app)).toEqual(before);
        expect(fs.existsSync(preview.snapshotPath)).toBe(false);
    });
});
