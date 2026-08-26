export declare const BACKUP_KIND: "product-pipeline-control-state-backup-v1";
export type BackupConfig = {
    kind: typeof BACKUP_KIND;
    sourceVolumeRoot: string;
    destinationRoot: string;
    sources: {
        appDatabase: string;
        listingControlDatabase: string;
        migrationStoreDatabase: string;
        shadowReportsDirectory: string;
    };
};
export type BackupManifest = {
    kind: typeof BACKUP_KIND;
    createdAtUtc: string;
    configDigest: string;
    files: Array<{
        logicalName: string;
        relativePath: string;
        bytes: number;
        sha256: string;
        format: 'sqlite' | 'json';
    }>;
    totals: {
        files: number;
        bytes: number;
    };
    safety: {
        providerAccess: false;
        commerceWrites: false;
        sourceMutation: false;
        liveRestore: false;
    };
};
