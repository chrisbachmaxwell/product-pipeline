import Database from 'better-sqlite3';
export declare const CURRENT_SCHEMA_VERSION = 1;
export declare const MIGRATION_STORE_APPLICATION_ID = 1347439955;
export type SchemaMigration = {
    version: number;
    name: string;
    sql: string;
    checksum: string;
};
export declare const SCHEMA_MIGRATIONS: readonly SchemaMigration[];
export declare const EXPECTED_SCHEMA_CATALOG_DIGEST: string;
export declare function initializeSchema(database: InstanceType<typeof Database>, appliedAtUtc: string): void;
export declare function verifySchema(database: InstanceType<typeof Database>): void;
