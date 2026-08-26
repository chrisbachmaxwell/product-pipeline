#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildControlStateBackupProgram } from './program.js';

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  buildControlStateBackupProgram().parseAsync(process.argv).catch(() => {
    console.error('Control-state backup administration failed closed');
    process.exitCode = 1;
  });
}
