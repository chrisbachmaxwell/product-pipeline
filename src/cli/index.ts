#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrationPolicyStatus } from '../safety/writer-quarantine.js';

/**
 * The legacy CLI previously exposed live sync/import/publish commands. During
 * shadow mode its executable is intentionally reduced to a read-only status
 * surface. Local reconciliation lives in the isolated `operator` CLI.
 */
export function buildLegacyCli(): Command {
  const program = new Command();
  program
    .name('ebaysync')
    .description('ProductPipeline legacy CLI (writers quarantined)')
    .version('0.3.0')
    .showHelpAfterError();

  program
    .command('status')
    .description('Print the enforced Marketplace Connect ownership baseline')
    .option('--json', 'Emit one JSON object')
    .action((options: { json?: boolean }) => {
      const status = getMigrationPolicyStatus();
      if (options.json) {
        console.log(JSON.stringify(status));
        return;
      }
      console.log('ProductPipeline: SHADOW READ-ONLY');
      console.log('Marketplace Connect owns production order, price, and inventory writes.');
      console.log('Legacy sync/import/publish commands are unmounted.');
      console.log('Use `npm run operator -- --help` for local preflight and reconciliation.');
    });

  return program;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entryPath) {
  buildLegacyCli().parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Legacy CLI failed closed');
    process.exitCode = 1;
  });
}
