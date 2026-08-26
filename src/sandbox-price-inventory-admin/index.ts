#!/usr/bin/env node
import { runSandboxPriceInventoryAdmin } from './program.js';

await runSandboxPriceInventoryAdmin(process.argv.slice(2));
