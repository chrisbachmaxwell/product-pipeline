import type Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;
export type AuthTokenColumnShape = Readonly<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
}>;
export declare const EXPECTED_AUTH_TOKEN_COLUMNS: readonly AuthTokenColumnShape[];
export declare const CANONICAL_AUTH_TOKENS_TABLE_SQL = "CREATE TABLE auth_tokens (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  platform TEXT NOT NULL UNIQUE,\n  access_token TEXT NOT NULL,\n  refresh_token TEXT,\n  scope TEXT,\n  expires_at INTEGER,\n  created_at INTEGER NOT NULL DEFAULT (unixepoch()),\n  updated_at INTEGER NOT NULL DEFAULT (unixepoch())\n)";
export declare const SHOPIFY_ACCESS_TOKEN_COMPARE_AND_SWAP_SQL = "UPDATE auth_tokens\n SET access_token = ?, refresh_token = NULL, scope = ?, expires_at = NULL, updated_at = ?\n WHERE id = ? AND platform = 'shopify' AND access_token = ?\n   AND refresh_token IS NULL AND scope IS ? AND expires_at IS NULL\n   AND created_at = ? AND updated_at = ?";
export declare const AUTH_TOKENS_SCHEMA_INSPECTION_STAGES: readonly ["table-definition", "table-storage", "columns", "index", "triggers", "foreign-keys", "mutation-statement", "verified"];
export type AuthTokensSchemaInspectionStage = (typeof AUTH_TOKENS_SCHEMA_INSPECTION_STAGES)[number];
export type AuthTokensSchemaInspection = Readonly<{
    stage: AuthTokensSchemaInspectionStage;
    tableDefinitionCanonical: boolean;
    tableStorageCanonical: boolean;
    columnsCanonical: boolean;
    uniquePlatformIndexCanonical: boolean;
    triggersAbsent: boolean;
    foreignKeysAbsent: boolean;
    mutationStatementCompiles: boolean;
    canonical: boolean;
}>;
/**
 * Verifies the exact legacy auth_tokens shape accepted by the rotation CAS.
 * The checks intentionally reject semantically surprising alternatives such
 * as CHECK constraints, generated columns, STRICT/WITHOUT ROWID tables, or a
 * differently ordered/collated unique index.
 */
export declare function inspectCanonicalAuthTokensSchema(database: Sqlite): AuthTokensSchemaInspection;
export {};
