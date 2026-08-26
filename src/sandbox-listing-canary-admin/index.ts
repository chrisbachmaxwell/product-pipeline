#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxListingCanaryProgram } from './program.js';

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  buildSandboxListingCanaryProgram()
    .parseAsync(process.argv)
    .catch(() => {
      process.stderr.write('{"status":"denied","code":"SANDBOX_CANARY_DENIED"}\n');
      process.exitCode = 1;
    });
}
