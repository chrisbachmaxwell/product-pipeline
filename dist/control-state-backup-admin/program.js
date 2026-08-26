import { Command } from 'commander';
import { createSnapshot, previewSnapshot, rehearseRestore, verifySnapshot } from './core.js';
const defaultIo = { out: console.log, error: console.error, exit: (code) => { process.exitCode = code; } };
const safe = { providerAccess: false, commerceWrites: false, sourceMutation: false, liveRestore: false };
export function buildControlStateBackupProgram(io = defaultIo, platform) {
    const program = new Command().name('control-state-backup-admin').description('Offline, inert control-state backup and restore-rehearsal tool');
    const fail = () => { io.error(JSON.stringify({ status: 'denied', error: 'CONTROL_STATE_BACKUP_DENIED', safety: safe })); io.exit(1); };
    program.command('preview').requiredOption('--config <path>').requiredOption('--created-at <utc>').action((options) => {
        try {
            const result = previewSnapshot(options.config, options.createdAt, platform);
            io.out(JSON.stringify({ command: 'preview', status: 'preview', configDigest: result.configDigest, snapshotName: result.snapshotName, safety: safe }));
        }
        catch {
            fail();
        }
    });
    program.command('snapshot').requiredOption('--config <path>').requiredOption('--created-at <utc>').requiredOption('--confirm-digest <digest>').action(async (options) => {
        try {
            const result = await createSnapshot({ configPath: options.config, createdAtUtc: options.createdAt, confirmDigest: options.confirmDigest, platform });
            io.out(JSON.stringify({ command: 'snapshot', status: 'created', files: result.manifest.totals.files, bytes: result.manifest.totals.bytes, safety: safe }));
        }
        catch {
            fail();
        }
    });
    program.command('verify').requiredOption('--snapshot <path>').action((options) => {
        try {
            const result = verifySnapshot(options.snapshot);
            io.out(JSON.stringify({ command: 'verify', status: 'verified', files: result.totals.files, bytes: result.totals.bytes, safety: safe }));
        }
        catch {
            fail();
        }
    });
    program.command('rehearse-restore').requiredOption('--snapshot <path>').requiredOption('--destination <path>').action((options) => {
        try {
            const result = rehearseRestore({ snapshotPath: options.snapshot, destinationPath: options.destination });
            io.out(JSON.stringify({ command: 'rehearse-restore', status: 'verified', files: result.totals.files, bytes: result.totals.bytes, safety: safe }));
        }
        catch {
            fail();
        }
    });
    return program;
}
