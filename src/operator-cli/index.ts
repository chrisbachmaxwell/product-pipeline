#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOperatorProgram } from './program.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectExecution = fileURLToPath(import.meta.url) === entryPath;

if (isDirectExecution) {
  buildOperatorProgram().parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Operator CLI failed closed');
    process.exitCode = 1;
  });
}
