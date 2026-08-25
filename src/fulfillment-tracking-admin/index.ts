#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFulfillmentTrackingAdminProgram } from './program.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entryPath) {
  buildFulfillmentTrackingAdminProgram().parseAsync(process.argv).catch((error: unknown) => {
    if (
      error !== null
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'commander.helpDisplayed'
      && 'exitCode' in error
      && error.exitCode === 0
    ) return;
    process.stderr.write('{"status":"denied","code":"FULFILLMENT_TRACKING_DENIED"}\n');
    process.exitCode = 1;
  });
}
