#!/usr/bin/env node
/**
 * Standalone compiled entrypoint for the isolated listing-revise operator
 * CLI. It is never imported or mounted by the server; invoke it directly as
 * `node dist/listing-revise-admin/index.js <command> ...`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildListingReviseAdminProgram } from './program.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entryPath) {
  buildListingReviseAdminProgram().parseAsync(process.argv).catch((error: unknown) => {
    if (
      error !== null
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'commander.helpDisplayed'
      && 'exitCode' in error
      && error.exitCode === 0
    ) return;
    process.stderr.write('{"status":"denied","code":"LISTING_REVISE_DENIED"}\n');
    process.exitCode = 1;
  });
}
