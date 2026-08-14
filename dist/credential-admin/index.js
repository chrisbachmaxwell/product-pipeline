#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EBAY_CREDENTIAL_ADMIN_HELP, runCredentialAdmin as runEbayCredentialAdmin } from './ebay-program.js';
import { fixedShopifyCredentialRotationFailure } from './errors.js';
import { buildShopifyCredentialAdminProgram } from './program.js';
function buildCombinedCredentialAdminProgram() {
    return buildShopifyCredentialAdminProgram()
        .description('Fixed-purpose Shopify and eBay credential maintenance')
        .addHelpText('after', `\n${EBAY_CREDENTIAL_ADMIN_HELP.trimEnd()}\n`);
}
export async function runCompiledCredentialAdmin(argv) {
    const commandArguments = argv.slice(2);
    if (commandArguments[0] === 'ebay') {
        await runEbayCredentialAdmin({ argv: commandArguments });
        return;
    }
    await buildCombinedCredentialAdminProgram().parseAsync([...argv]);
}
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entryPath) {
    void runCompiledCredentialAdmin(process.argv).catch((error) => {
        if (error !== null
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'commander.helpDisplayed'
            && 'exitCode' in error
            && error.exitCode === 0)
            return;
        process.stderr.write(`${fixedShopifyCredentialRotationFailure(error)}\n`);
        process.exitCode = 1;
    });
}
