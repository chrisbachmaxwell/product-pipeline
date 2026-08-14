import fs from 'node:fs';
import { Command } from 'commander';
import {
  initializeListingControlStore,
  openListingControlStoreReadOnly,
  upgradeListingControlStoreV2ToV3,
} from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';

export type ListingControlAdminDependencies = Readonly<{
  databasePath?: () => string | undefined;
  now?: () => Date;
  output?: (value: string) => void;
}>;

export function buildListingControlAdminProgram(
  dependencies: ListingControlAdminDependencies = {},
): Command {
  const databasePath = dependencies.databasePath
    ?? (() => process.env.LISTING_CONTROL_DATABASE_PATH);
  const now = dependencies.now ?? (() => new Date());
  const output = dependencies.output ?? ((value: string) => process.stdout.write(`${value}\n`));
  const program = new Command();
  program.name('listing-control-admin').description('Local listing draft store administration');
  program.command('init')
    .description('Initialize a fresh V3 store; the target must not exist')
    .action(() => {
      const target = databasePath();
      if (typeof target !== 'string' || target.length === 0) throw new Error('Unavailable');
      if (fs.existsSync(target)) throw new Error('Unavailable');
      const store = initializeListingControlStore({
        databasePath: target, scope: LISTING_DRAFT_SCOPE, createdAtUtc: now().toISOString(),
      });
      try {
        store.verifyIntegrity();
        output(JSON.stringify({
          status: 'initialized',
          schemaVersion: 3,
          mode: 'local_draft_only',
          externalWritesPerformed: 0,
        }));
      } finally { store.close(); }
    });
  program.command('verify')
    .description('Verify an existing canonical V3 store without changing it')
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
          status: 'verified', schemaVersion: 3, mode: 'local_draft_only',
          externalWritesPerformed: 0,
        }));
      } finally { store.close(); }
    });
  program.command('upgrade-v2-v3')
    .description('Explicitly upgrade one canonical V2 store to V3')
    .action(() => {
      const target = databasePath();
      if (typeof target !== 'string' || target.length === 0 || !fs.existsSync(target)) {
        throw new Error('Unavailable');
      }
      const store = upgradeListingControlStoreV2ToV3({
        databasePath: target,
        expectedScope: LISTING_DRAFT_SCOPE,
        appliedAtUtc: now().toISOString(),
      });
      try {
        store.verifyIntegrity();
        output(JSON.stringify({
          status: 'upgraded', fromSchemaVersion: 2, schemaVersion: 3,
          mode: 'local_draft_only', externalWritesPerformed: 0,
        }));
      } finally { store.close(); }
    });
  return program;
}
