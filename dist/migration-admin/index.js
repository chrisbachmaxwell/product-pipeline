#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMigrationAdminProgram } from './program.js';
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectExecution = fileURLToPath(import.meta.url) === entryPath;
if (isDirectExecution) {
    buildMigrationAdminProgram().parseAsync(process.argv).catch(() => {
        console.error('Migration-state administration failed closed');
        process.exitCode = 1;
    });
}
