import Database from 'better-sqlite3';
export declare const CURRENT_SCHEMA_VERSION = 2;
export declare const MIGRATION_STORE_APPLICATION_ID = 1347439955;
export type SchemaMigration = {
    version: number;
    name: string;
    sql: string;
    checksum: string;
};
export declare const SCHEMA_MIGRATIONS: readonly SchemaMigration[];
export declare const EXPECTED_SCHEMA_CATALOG_DIGEST: string;
export declare function initializeSchema(database: InstanceType<typeof Database>, appliedAtUtc: string, throughVersion?: number): void;
export declare function verifySchemaAtExactVersion(database: InstanceType<typeof Database>, requiredVersion: number): void;
export declare function verifySchema(database: InstanceType<typeof Database>): void;
/**
 * Read the stored schema version without trusting it: the version is accepted
 * only when the full migration history and catalog digest for that exact
 * version verify. Used by the explicit operator upgrade path only.
 */
export declare function verifiedStoredSchemaVersion(database: InstanceType<typeof Database>): number;
/**
 * Apply every migration beyond the store's verified current version, inside
 * one immediate transaction, and verify the resulting catalog exactly.
 */
export declare function upgradeSchemaToCurrent(database: InstanceType<typeof Database>, appliedAtUtc: string): {
    fromVersion: number;
    toVersion: number;
};
