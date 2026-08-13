import Database from 'better-sqlite3';
export declare const LISTING_CONTROL_SCHEMA_VERSION = 1;
export declare const LISTING_CONTROL_APPLICATION_ID = 1347439683;
export declare const LISTING_CONTROL_MIGRATIONS: readonly Readonly<{
    version: 1;
    name: "listing-control-v1";
    sql: string;
    checksum: string;
}>[];
export declare const LISTING_CONTROL_EXPECTED_CATALOG_DIGEST: string;
export declare function initializeListingControlSchema(database: InstanceType<typeof Database>, appliedAtUtc: string): void;
export declare function verifyListingControlSchema(database: InstanceType<typeof Database>): void;
