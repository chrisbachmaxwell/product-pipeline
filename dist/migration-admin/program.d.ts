import { Command } from 'commander';
import { type MigrationStoreProjection } from '../migration-store/projection.js';
import { type LoadedMigrationAdminConfig } from './config.js';
export type MigrationAdminIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
type SafeScopeSummary = {
    scopeDigest: string;
    shopifyStoreDomain: string;
    ebayEnvironment: string;
    ebayMarketplaceId: string;
};
export type MigrationAdminResult = {
    command: 'init' | 'verify';
    status: 'preview' | 'initialized-inert' | 'verified';
    scope: SafeScopeSummary;
    databaseRelativePath: string;
    projection: MigrationStoreProjection | null;
    safety: {
        externalPlatformAccess: false;
        externalWrites: false;
        historicalBackfill: false;
        cutoverWatermarkUtc: null;
        ownershipTransferAllowed: false;
        credentialsAllowed: false;
        canaryReady: false;
        cutoverReady: false;
    };
};
export declare function previewMigrationStoreInitialization(input: {
    repoRoot: string;
    configPath: string;
    createdAtUtc: string;
    now?: number;
}): {
    loaded: LoadedMigrationAdminConfig;
    result: MigrationAdminResult;
};
export declare function initializeMigrationStore(input: {
    repoRoot: string;
    configPath: string;
    createdAtUtc: string;
    confirmScope: string;
    now?: number;
}): MigrationAdminResult;
export declare function verifyMigrationStore(input: {
    repoRoot: string;
    configPath: string;
}): MigrationAdminResult;
export declare function buildMigrationAdminProgram(io?: MigrationAdminIo): Command;
export {};
