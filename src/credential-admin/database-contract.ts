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

export const EXPECTED_AUTH_TOKEN_COLUMNS: readonly AuthTokenColumnShape[] = Object.freeze([
  Object.freeze({
    cid: 0,
    name: 'id',
    type: 'INTEGER',
    notnull: 0,
    dflt_value: null,
    pk: 1,
    hidden: 0,
  }),
  Object.freeze({
    cid: 1,
    name: 'platform',
    type: 'TEXT',
    notnull: 1,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  }),
  Object.freeze({
    cid: 2,
    name: 'access_token',
    type: 'TEXT',
    notnull: 1,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  }),
  Object.freeze({
    cid: 3,
    name: 'refresh_token',
    type: 'TEXT',
    notnull: 0,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  }),
  Object.freeze({
    cid: 4,
    name: 'scope',
    type: 'TEXT',
    notnull: 0,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  }),
  Object.freeze({
    cid: 5,
    name: 'expires_at',
    type: 'INTEGER',
    notnull: 0,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  }),
  Object.freeze({
    cid: 6,
    name: 'created_at',
    type: 'INTEGER',
    notnull: 1,
    dflt_value: 'unixepoch()',
    pk: 0,
    hidden: 0,
  }),
  Object.freeze({
    cid: 7,
    name: 'updated_at',
    type: 'INTEGER',
    notnull: 1,
    dflt_value: 'unixepoch()',
    pk: 0,
    hidden: 0,
  }),
]);

export const CANONICAL_AUTH_TOKENS_TABLE_SQL = `CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)`;

export const SHOPIFY_ACCESS_TOKEN_COMPARE_AND_SWAP_SQL = `UPDATE auth_tokens
 SET access_token = ?, refresh_token = NULL, scope = ?, expires_at = NULL, updated_at = ?
 WHERE id = ? AND platform = 'shopify' AND access_token = ?
   AND refresh_token IS NULL AND scope IS ? AND expires_at IS NULL
   AND created_at = ? AND updated_at = ?`;

export const AUTH_TOKENS_SCHEMA_INSPECTION_STAGES = Object.freeze([
  'table-definition',
  'table-storage',
  'columns',
  'index',
  'triggers',
  'foreign-keys',
  'mutation-statement',
  'verified',
] as const);

export type AuthTokensSchemaInspectionStage =
  (typeof AUTH_TOKENS_SCHEMA_INSPECTION_STAGES)[number];

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

type MutableInspection = {
  -readonly [Key in keyof Omit<AuthTokensSchemaInspection, 'stage' | 'canonical'>]: boolean;
};

const NORMALIZED_CANONICAL_TABLE_SQL = normalizeSchemaSql(CANONICAL_AUTH_TOKENS_TABLE_SQL);

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function result(
  stage: AuthTokensSchemaInspectionStage,
  inspection: MutableInspection,
): AuthTokensSchemaInspection {
  return Object.freeze({
    stage,
    ...inspection,
    canonical: stage === 'verified',
  });
}

function columnsAreCanonical(columns: readonly AuthTokenColumnShape[]): boolean {
  return columns.length === EXPECTED_AUTH_TOKEN_COLUMNS.length
    && columns.every((column, index) => {
      const expected = EXPECTED_AUTH_TOKEN_COLUMNS[index]!;
      return column.cid === expected.cid
        && column.name === expected.name
        && column.type === expected.type
        && column.notnull === expected.notnull
        && column.dflt_value === expected.dflt_value
        && column.pk === expected.pk
        && column.hidden === expected.hidden;
    });
}

/**
 * Verifies the exact legacy auth_tokens shape accepted by the rotation CAS.
 * The checks intentionally reject semantically surprising alternatives such
 * as CHECK constraints, generated columns, STRICT/WITHOUT ROWID tables, or a
 * differently ordered/collated unique index.
 */
export function inspectCanonicalAuthTokensSchema(database: Sqlite): AuthTokensSchemaInspection {
  const inspection: MutableInspection = {
    tableDefinitionCanonical: false,
    tableStorageCanonical: false,
    columnsCanonical: false,
    uniquePlatformIndexCanonical: false,
    triggersAbsent: false,
    foreignKeysAbsent: false,
    mutationStatementCompiles: false,
  };

  try {
    const tables = database.prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema WHERE name = 'auth_tokens'`,
    ).all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>;
    inspection.tableDefinitionCanonical = tables.length === 1
      && tables[0]?.type === 'table'
      && tables[0].name === 'auth_tokens'
      && tables[0].tbl_name === 'auth_tokens'
      && typeof tables[0].sql === 'string'
      && normalizeSchemaSql(tables[0].sql) === NORMALIZED_CANONICAL_TABLE_SQL;
  } catch {
    return result('table-definition', inspection);
  }
  if (!inspection.tableDefinitionCanonical) return result('table-definition', inspection);

  try {
    const entries = (database.pragma('table_list') as Array<{
      schema: string;
      name: string;
      type: string;
      ncol: number;
      wr: number;
      strict: number;
    }>).filter((entry) => entry.schema === 'main' && entry.name === 'auth_tokens');
    inspection.tableStorageCanonical = entries.length === 1
      && entries[0]?.type === 'table'
      && entries[0].ncol === EXPECTED_AUTH_TOKEN_COLUMNS.length
      && entries[0].wr === 0
      && entries[0].strict === 0;
  } catch {
    return result('table-storage', inspection);
  }
  if (!inspection.tableStorageCanonical) return result('table-storage', inspection);

  try {
    const columns = database.pragma('table_xinfo(auth_tokens)') as AuthTokenColumnShape[];
    inspection.columnsCanonical = columnsAreCanonical(columns);
  } catch {
    return result('columns', inspection);
  }
  if (!inspection.columnsCanonical) return result('columns', inspection);

  try {
    const indexes = database.pragma('index_list(auth_tokens)') as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const index = indexes[0];
    if (indexes.length === 1
      && index?.seq === 0
      && index.name === 'sqlite_autoindex_auth_tokens_1'
      && index.unique === 1
      && index.origin === 'u'
      && index.partial === 0) {
      const indexSchema = database.prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema WHERE name = 'sqlite_autoindex_auth_tokens_1'`,
      ).all() as Array<{
        type: string;
        name: string;
        tbl_name: string;
        sql: string | null;
      }>;
      const columns = database.pragma(
        `index_xinfo('sqlite_autoindex_auth_tokens_1')`,
      ) as Array<{
        seqno: number;
        cid: number;
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }>;
      inspection.uniquePlatformIndexCanonical = indexSchema.length === 1
        && indexSchema[0]?.type === 'index'
        && indexSchema[0].name === 'sqlite_autoindex_auth_tokens_1'
        && indexSchema[0].tbl_name === 'auth_tokens'
        && indexSchema[0].sql === null
        && columns.length === 2
        && columns[0]?.seqno === 0
        && columns[0].cid === 1
        && columns[0].name === 'platform'
        && columns[0].desc === 0
        && columns[0].coll === 'BINARY'
        && columns[0].key === 1
        && columns[1]?.seqno === 1
        && columns[1].cid === -1
        && columns[1].name === null
        && columns[1].desc === 0
        && columns[1].coll === 'BINARY'
        && columns[1].key === 0;
    }
  } catch {
    return result('index', inspection);
  }
  if (!inspection.uniquePlatformIndexCanonical) return result('index', inspection);

  try {
    const triggers = database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'auth_tokens'`,
    ).all();
    inspection.triggersAbsent = triggers.length === 0;
  } catch {
    return result('triggers', inspection);
  }
  if (!inspection.triggersAbsent) return result('triggers', inspection);

  try {
    const foreignKeys = database.pragma('foreign_key_list(auth_tokens)') as unknown[];
    inspection.foreignKeysAbsent = foreignKeys.length === 0;
  } catch {
    return result('foreign-keys', inspection);
  }
  if (!inspection.foreignKeysAbsent) return result('foreign-keys', inspection);

  try {
    database.prepare(`EXPLAIN ${SHOPIFY_ACCESS_TOKEN_COMPARE_AND_SWAP_SQL}`).all(
      'replacement-token-shape',
      'read_fulfillments,read_inventory,read_orders,read_products',
      2,
      1,
      'current-token-shape',
      null,
      1,
      1,
    );
    inspection.mutationStatementCompiles = true;
  } catch {
    return result('mutation-statement', inspection);
  }

  return result('verified', inspection);
}
