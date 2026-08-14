import fs from 'node:fs';
import { Command } from 'commander';
import { initializeListingControlStore, openListingControlStoreReadOnly, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export function buildListingControlAdminProgram(dependencies = {}) {
    const databasePath = dependencies.databasePath
        ?? (() => process.env.LISTING_CONTROL_DATABASE_PATH);
    const now = dependencies.now ?? (() => new Date());
    const output = dependencies.output ?? ((value) => process.stdout.write(`${value}\n`));
    const program = new Command();
    program.name('listing-control-admin').description('Local listing draft store administration');
    program.command('init')
        .description('Initialize a fresh V2 store; the target must not exist')
        .action(() => {
        const target = databasePath();
        if (typeof target !== 'string' || target.length === 0)
            throw new Error('Unavailable');
        if (fs.existsSync(target))
            throw new Error('Unavailable');
        const store = initializeListingControlStore({
            databasePath: target, scope: LISTING_DRAFT_SCOPE, createdAtUtc: now().toISOString(),
        });
        try {
            store.verifyIntegrity();
            output(JSON.stringify({
                status: 'initialized',
                schemaVersion: 2,
                mode: 'local_draft_only',
                externalWritesPerformed: 0,
            }));
        }
        finally {
            store.close();
        }
    });
    program.command('verify')
        .description('Verify an existing canonical V2 store without changing it')
        .action(() => {
        const target = databasePath();
        if (typeof target !== 'string' || target.length === 0 || !fs.existsSync(target)) {
            throw new Error('Unavailable');
        }
        const store = openListingControlStoreReadOnly({
            databasePath: target, expectedScope: LISTING_DRAFT_SCOPE,
        });
        try {
            store.verifyIntegrity();
            output(JSON.stringify({
                status: 'verified', schemaVersion: 2, mode: 'local_draft_only',
                externalWritesPerformed: 0,
            }));
        }
        finally {
            store.close();
        }
    });
    return program;
}
