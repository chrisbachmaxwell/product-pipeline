import Database from 'better-sqlite3';
export declare function applicationDatabasePath(): string;
/**
 * Open the existing ProductPipeline ledger without creating a file, schema,
 * migration, seed row, journal policy, or write-capable connection.
 */
export declare function openShadowDatabase(databasePath?: string): InstanceType<typeof Database>;
