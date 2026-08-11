#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidenceCaptureProgram } from './program.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const directExecution = fileURLToPath(import.meta.url) === entryPath;

if (directExecution) {
  buildEvidenceCaptureProgram().parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error
      ? error.message
      : 'Evidence capture CLI failed closed');
    process.exitCode = 1;
  });
}
