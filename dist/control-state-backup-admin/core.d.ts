import { type BackupConfig, type BackupManifest } from './types.js';
export type BackupPlatform = {
    deviceId: (value: string) => number | bigint;
};
export declare class ControlStateBackupError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function loadBackupConfig(configPath: string, platform?: BackupPlatform): {
    config: BackupConfig;
    configDigest: string;
};
export declare function previewSnapshot(configPath: string, createdAtUtc: string, platform?: BackupPlatform): {
    configDigest: string;
    snapshotName: string;
    snapshotPath: string;
    config: BackupConfig;
};
export declare function createSnapshot(input: {
    configPath: string;
    createdAtUtc: string;
    confirmDigest: string;
    platform?: BackupPlatform;
}): Promise<{
    snapshotPath: string;
    manifest: BackupManifest;
}>;
export declare function verifySnapshot(snapshotPath: string): BackupManifest;
export declare function rehearseRestore(input: {
    snapshotPath: string;
    destinationPath: string;
}): BackupManifest;
