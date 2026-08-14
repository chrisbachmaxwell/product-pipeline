#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildListingControlAdminProgram } from './program.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entryPath) {
  buildListingControlAdminProgram().parseAsync(process.argv).catch(() => {
    process.stderr.write('Listing control administration failed closed\n');
    process.exitCode = 1;
  });
}
