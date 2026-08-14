import crypto from 'node:crypto';
import { Command } from 'commander';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { assertShopifyCredentialRotationDispatchAuthorized, loadShopifyCredentialRotationConfig, } from './config.js';
import { requestRotatedShopifyAccessToken, verifyShopifyAccessToken, } from './network.js';
import { LegacyShopifyTokenStore, readShopifyAuthTokenRowReadOnly, } from './store.js';
import { rotationDenied } from './errors.js';
import { diagnoseFixedProductionShopifyDatabase, } from './database-diagnostic.js';
import { repairFixedProductionShopifyDatabasePermissions, } from './database-permission-repair.js';
const AUTHORITY_PROOF = Object.freeze({
    storeDomain: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain,
    shopGid: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid,
    clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
    canonicalReadScopes: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.canonicalReadScopes,
});
export const SHOPIFY_ROTATION_PREFLIGHT_OUTPUT = Object.freeze({
    status: 'preflight_verified',
    ...AUTHORITY_PROOF,
    databaseIntegrityVerified: true,
    tokenRowsVerified: 1,
    providerReadOnlyVerification: true,
    providerCredentialMutationsPerformed: 0,
    temporaryRefreshTokenPersistedToDatabase: false,
    externalCommerceWritesPerformed: 0,
});
export const SHOPIFY_ROTATION_SUCCESS_OUTPUT = Object.freeze({
    status: 'rotated_verified',
    ...AUTHORITY_PROOF,
    databaseIntegrityVerified: true,
    tokenRowsVerified: 1,
    backupCreated: true,
    backupIntegrityVerified: true,
    backupMode: '0600',
    databaseRowsUpdated: 1,
    reopenedStoredTokenVerified: true,
    providerReadOnlyVerification: true,
    providerCredentialMutationsPerformed: 1,
    temporaryRefreshTokenPersistedToDatabase: false,
    externalCommerceWritesPerformed: 0,
});
export const SHOPIFY_ROTATION_VERIFY_OUTPUT = Object.freeze({
    status: 'stored_token_verified',
    ...AUTHORITY_PROOF,
    databaseIntegrityVerified: true,
    tokenRowsVerified: 1,
    reopenedStoredTokenVerified: true,
    providerReadOnlyVerification: true,
    providerCredentialMutationsPerformed: 0,
    temporaryRefreshTokenPersistedToDatabase: false,
    externalCommerceWritesPerformed: 0,
});
function equalToken(left, right) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}
async function preflightStoredToken(config, dependencies) {
    const stored = (dependencies.readStoredRow ?? readShopifyAuthTokenRowReadOnly)(config.databasePath);
    await verifyShopifyAccessToken(stored.accessToken, dependencies.network);
}
export async function executeShopifyCredentialRotationPreflight(config, dependencies = {}) {
    await preflightStoredToken(config, dependencies);
    return SHOPIFY_ROTATION_PREFLIGHT_OUTPUT;
}
export async function executeShopifyCredentialRotation(config, dependencies = {}) {
    const now = dependencies.now ?? (() => new Date());
    const store = (dependencies.openStore ?? LegacyShopifyTokenStore.open)(config.databasePath);
    let storeClosed = false;
    try {
        const current = store.snapshot();
        await verifyShopifyAccessToken(current.accessToken, dependencies.network);
        const operationTime = now();
        await store.createBackup(operationTime);
        assertShopifyCredentialRotationDispatchAuthorized(config, now().getTime());
        const fresh = await requestRotatedShopifyAccessToken({
            config,
            currentAccessToken: current.accessToken,
            dependencies: dependencies.network,
        });
        await verifyShopifyAccessToken(fresh.accessToken, dependencies.network);
        store.compareAndSwapAccessToken(fresh, operationTime);
        store.close();
        storeClosed = true;
        const persisted = (dependencies.readStoredRow ?? readShopifyAuthTokenRowReadOnly)(config.databasePath);
        if (!equalToken(persisted.accessToken, fresh.accessToken)
            || persisted.refreshToken !== null
            || persisted.scope !== fresh.scope
            || persisted.expiresAt !== null)
            return rotationDenied('database-denied');
        await verifyShopifyAccessToken(persisted.accessToken, dependencies.network);
        return SHOPIFY_ROTATION_SUCCESS_OUTPUT;
    }
    finally {
        if (!storeClosed)
            store.close();
    }
}
export async function executeShopifyCredentialRotationVerify(config, dependencies = {}) {
    const persisted = (dependencies.readStoredRow ?? readShopifyAuthTokenRowReadOnly)(config.databasePath);
    await verifyShopifyAccessToken(persisted.accessToken, dependencies.network);
    return SHOPIFY_ROTATION_VERIFY_OUTPUT;
}
export function executeShopifyCredentialDatabaseDiagnostic(environment = process.env, dependencies = {}) {
    return diagnoseFixedProductionShopifyDatabase(environment, dependencies);
}
export function executeShopifyCredentialDatabasePermissionRepair(environment = process.env, dependencies = {}) {
    return repairFixedProductionShopifyDatabasePermissions(environment, dependencies);
}
export function buildShopifyCredentialAdminProgram(dependencies = {}) {
    const output = dependencies.output ?? ((value) => process.stdout.write(`${value}\n`));
    const setExitCode = dependencies.setExitCode ?? ((code) => { process.exitCode = code; });
    const now = dependencies.now ?? (() => new Date());
    const config = (requireRefreshToken) => loadShopifyCredentialRotationConfig({
        environment: dependencies.environment,
        now: now().getTime(),
        requireRefreshToken,
    });
    const program = new Command();
    program.name('credential-admin').description('Fixed-purpose Shopify credential maintenance');
    program.command('preflight-shopify-access-token-rotation')
        .description('Read-only verification of the exact stored Production Shopify authority')
        .action(async () => {
        output(JSON.stringify(await executeShopifyCredentialRotationPreflight(config(false), dependencies)));
    });
    program.command('diagnose-shopify-credential-database')
        .description('Read-only fixed-stage diagnosis of the exact Production legacy database')
        .action(() => {
        const result = executeShopifyCredentialDatabaseDiagnostic(dependencies.environment, dependencies.databaseDiagnostic);
        output(JSON.stringify(result));
        if (result.status !== 'database_diagnostic_verified')
            setExitCode(1);
    });
    program.command('repair-shopify-credential-database-permissions')
        .description('Repair only the exact Production legacy database mode to 0600')
        .action(() => {
        const result = executeShopifyCredentialDatabasePermissionRepair(dependencies.environment, dependencies.databasePermissionRepair);
        output(JSON.stringify(result));
        if (result.status !== 'permission_repair_verified')
            setExitCode(1);
    });
    program.command('rotate-shopify-access-token')
        .description('Rotate the one exact Production Shopify access-token row')
        .action(async () => {
        output(JSON.stringify(await executeShopifyCredentialRotation(config(true), dependencies)));
    });
    program.command('verify-shopify-access-token-rotation')
        .description('Reopen and verify the exact stored Production Shopify authority')
        .action(async () => {
        output(JSON.stringify(await executeShopifyCredentialRotationVerify(config(false), dependencies)));
    });
    // Commander includes raw argv in its default unknown-command/option errors.
    // Suppress every parser error and let the entrypoint emit one fixed JSON
    // failure without ever reflecting operator input.
    const redactedParserOutput = {
        writeErr: () => undefined,
        outputError: () => undefined,
    };
    program.allowExcessArguments(false).exitOverride().configureOutput(redactedParserOutput);
    for (const command of program.commands) {
        command.allowExcessArguments(false).exitOverride().configureOutput(redactedParserOutput);
    }
    return program;
}
