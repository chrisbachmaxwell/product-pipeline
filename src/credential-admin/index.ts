#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShopifyCredentialAdminProgram } from './program.js';
import { fixedShopifyCredentialRotationFailure } from './errors.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entryPath) {
  buildShopifyCredentialAdminProgram().parseAsync(process.argv).catch((error: unknown) => {
    if (
      error !== null
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'commander.helpDisplayed'
      && 'exitCode' in error
      && error.exitCode === 0
    ) return;
    process.stderr.write(`${fixedShopifyCredentialRotationFailure(error)}\n`);
    process.exitCode = 1;
  });
}
