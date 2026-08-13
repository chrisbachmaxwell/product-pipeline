import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  LISTING_DRAFT_STATES,
  LISTING_FIELD_NAMES,
  LISTING_MANAGEMENT_MODELS,
} from './types.js';

export const LISTING_CONTROL_SCHEMA_VERSION = 1;
export const LISTING_CONTROL_APPLICATION_ID = 0x50504c43;

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');
const digestCheck = (column: string): string =>
  `(length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' `
  + `AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*')`;
const nullableDigestCheck = (column: string): string =>
  `(${column} IS NULL OR ${digestCheck(column)})`;

const migrationOneSql = `
CREATE TABLE control_scope (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  scope_key TEXT NOT NULL UNIQUE CHECK (${digestCheck('scope_key')}),
  shopify_store_domain TEXT NOT NULL,
  ebay_environment TEXT NOT NULL CHECK (ebay_environment IN ('sandbox', 'production')),
  ebay_seller_id TEXT NOT NULL,
  ebay_marketplace_id TEXT NOT NULL CHECK (ebay_marketplace_id = 'EBAY_US'),
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  CHECK (created_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_epoch_ms / 1000.0, 'unixepoch'))
);

CREATE TABLE listing_subjects (
  subject_key TEXT PRIMARY KEY CHECK (${digestCheck('subject_key')}),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  shopify_product_gid TEXT NOT NULL,
  shopify_variant_gid TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  UNIQUE (scope_key, shopify_variant_gid),
  UNIQUE (scope_key, subject_key),
  CHECK (created_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_epoch_ms / 1000.0, 'unixepoch'))
);

CREATE TABLE listing_revisions (
  revision_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  revision_digest TEXT NOT NULL UNIQUE CHECK (${digestCheck('revision_digest')}),
  previous_revision_digest TEXT CHECK (${nullableDigestCheck('previous_revision_digest')}),
  raw_sku TEXT NOT NULL,
  ebay_seller_id TEXT NOT NULL,
  ebay_marketplace_id TEXT NOT NULL CHECK (ebay_marketplace_id = 'EBAY_US'),
  management_model TEXT NOT NULL CHECK (management_model IN (${sqlList(LISTING_MANAGEMENT_MODELS)})),
  ebay_inventory_sku TEXT,
  ebay_offer_id TEXT,
  ebay_listing_id TEXT,
  base_source_digest TEXT NOT NULL CHECK (${digestCheck('base_source_digest')}),
  base_source_observed_at_utc TEXT NOT NULL,
  base_source_observed_epoch_ms INTEGER NOT NULL,
  base_ebay_observation_digest TEXT NOT NULL CHECK (${digestCheck('base_ebay_observation_digest')}),
  base_ebay_observed_at_utc TEXT NOT NULL,
  base_ebay_observed_epoch_ms INTEGER NOT NULL,
  actor TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${sqlList(LISTING_DRAFT_STATES)})),
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  UNIQUE (subject_key, revision_number),
  UNIQUE (subject_key, revision_digest),
  CHECK (ebay_inventory_sku IS NULL OR ebay_inventory_sku = raw_sku),
  CHECK (
    (management_model = 'inventory_api' AND ebay_inventory_sku IS NOT NULL)
    OR (management_model <> 'inventory_api')
  ),
  CHECK (base_source_observed_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', base_source_observed_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (base_ebay_observed_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', base_ebay_observed_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (created_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (
    (revision_number = 1 AND previous_revision_digest IS NULL)
    OR (revision_number > 1 AND previous_revision_digest IS NOT NULL)
  )
);

CREATE TABLE ebay_artifact_bindings (
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('offer', 'listing')),
  artifact_id TEXT NOT NULL,
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_key, artifact_type, artifact_id),
  CHECK (created_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_epoch_ms / 1000.0, 'unixepoch'))
) WITHOUT ROWID;

CREATE TABLE shopify_sku_bindings (
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  raw_sku TEXT NOT NULL,
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_key, raw_sku),
  CHECK (created_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_epoch_ms / 1000.0, 'unixepoch'))
) WITHOUT ROWID;

CREATE TABLE listing_revision_fields (
  revision_id TEXT NOT NULL REFERENCES listing_revisions(revision_id),
  field_name TEXT NOT NULL CHECK (field_name IN (${sqlList(LISTING_FIELD_NAMES)})),
  source_value TEXT,
  source_digest TEXT NOT NULL CHECK (${digestCheck('source_digest')}),
  default_value TEXT,
  default_digest TEXT NOT NULL CHECK (${digestCheck('default_digest')}),
  override_value TEXT,
  override_digest TEXT NOT NULL CHECK (${digestCheck('override_digest')}),
  proposed_value TEXT,
  proposed_digest TEXT NOT NULL CHECK (${digestCheck('proposed_digest')}),
  proposed_source TEXT NOT NULL CHECK (proposed_source IN ('source', 'default', 'override', 'omit')),
  observed_value TEXT,
  observed_digest TEXT NOT NULL CHECK (${digestCheck('observed_digest')}),
  PRIMARY KEY (revision_id, field_name),
  CHECK (default_value IS NULL),
  CHECK (proposed_source <> 'default'),
  CHECK (
    (proposed_source = 'omit' AND proposed_value IS NULL)
    OR (proposed_source = 'source' AND source_value IS NOT NULL AND proposed_value IS source_value)
    OR (proposed_source = 'override' AND override_value IS NOT NULL AND proposed_value IS override_value)
  )
) WITHOUT ROWID;

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('scope.initialized', 'revision.created')),
  occurred_at_utc TEXT NOT NULL,
  occurred_epoch_ms INTEGER NOT NULL,
  subject_key TEXT CHECK (${nullableDigestCheck('subject_key')}),
  revision_digest TEXT UNIQUE REFERENCES listing_revisions(revision_digest) CHECK (${nullableDigestCheck('revision_digest')}),
  payload_digest TEXT NOT NULL CHECK (${digestCheck('payload_digest')}),
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE CHECK (${digestCheck('event_hash')}),
  CHECK (occurred_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (
    (event_type = 'scope.initialized' AND subject_key IS NULL AND revision_digest IS NULL)
    OR (event_type = 'revision.created' AND subject_key IS NOT NULL AND revision_digest IS NOT NULL)
  )
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (${digestCheck('checksum')}),
  applied_at_utc TEXT NOT NULL
);

CREATE TRIGGER listing_subjects_deny_conflicting_insert
BEFORE INSERT ON listing_subjects
WHEN EXISTS (
  SELECT 1 FROM listing_subjects subject
  WHERE subject.subject_key = NEW.subject_key
     OR (subject.scope_key = NEW.scope_key AND subject.shopify_variant_gid = NEW.shopify_variant_gid)
)
BEGIN
  SELECT RAISE(ABORT, 'listing subject replay or replacement denied');
END;

CREATE TRIGGER ebay_artifact_bindings_deny_conflicting_insert
BEFORE INSERT ON ebay_artifact_bindings
WHEN EXISTS (
  SELECT 1 FROM ebay_artifact_bindings binding
  WHERE binding.scope_key = NEW.scope_key
    AND binding.artifact_type = NEW.artifact_type
    AND binding.artifact_id = NEW.artifact_id
)
BEGIN
  SELECT RAISE(ABORT, 'eBay artifact replay or replacement denied');
END;

CREATE TRIGGER shopify_sku_bindings_deny_conflicting_insert
BEFORE INSERT ON shopify_sku_bindings
WHEN EXISTS (
  SELECT 1 FROM shopify_sku_bindings binding
  WHERE binding.scope_key = NEW.scope_key AND binding.raw_sku = NEW.raw_sku
)
BEGIN
  SELECT RAISE(ABORT, 'Shopify SKU replay or replacement denied');
END;

CREATE TRIGGER control_scope_deny_conflicting_insert
BEFORE INSERT ON control_scope
WHEN EXISTS (
  SELECT 1 FROM control_scope scope
  WHERE scope.singleton = NEW.singleton OR scope.scope_key = NEW.scope_key
)
BEGIN
  SELECT RAISE(ABORT, 'control scope replay or replacement denied');
END;

CREATE TRIGGER listing_revisions_deny_conflicting_insert
BEFORE INSERT ON listing_revisions
WHEN EXISTS (
  SELECT 1 FROM listing_revisions revision
  WHERE revision.revision_id = NEW.revision_id
     OR revision.revision_digest = NEW.revision_digest
     OR (revision.subject_key = NEW.subject_key AND revision.revision_number = NEW.revision_number)
)
BEGIN
  SELECT RAISE(ABORT, 'listing revision replay or replacement denied');
END;

CREATE TRIGGER listing_revisions_scope_identity
BEFORE INSERT ON listing_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM control_scope scope
  WHERE scope.scope_key = NEW.scope_key
    AND scope.ebay_seller_id = NEW.ebay_seller_id
    AND scope.ebay_marketplace_id = NEW.ebay_marketplace_id
)
BEGIN
  SELECT RAISE(ABORT, 'listing revision account drift');
END;

CREATE TRIGGER ebay_artifact_bindings_scope_identity
BEFORE INSERT ON ebay_artifact_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM listing_subjects subject
  WHERE subject.subject_key = NEW.subject_key AND subject.scope_key = NEW.scope_key
)
BEGIN
  SELECT RAISE(ABORT, 'eBay artifact scope drift');
END;

CREATE TRIGGER shopify_sku_bindings_scope_identity
BEFORE INSERT ON shopify_sku_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM listing_subjects subject
  WHERE subject.subject_key = NEW.subject_key AND subject.scope_key = NEW.scope_key
)
BEGIN
  SELECT RAISE(ABORT, 'Shopify SKU scope drift');
END;

CREATE TRIGGER listing_revision_fields_deny_conflicting_insert
BEFORE INSERT ON listing_revision_fields
WHEN EXISTS (
  SELECT 1 FROM listing_revision_fields field
  WHERE field.revision_id = NEW.revision_id AND field.field_name = NEW.field_name
)
BEGIN
  SELECT RAISE(ABORT, 'listing field replay or replacement denied');
END;

CREATE TRIGGER audit_events_deny_conflicting_insert
BEFORE INSERT ON audit_events
WHEN EXISTS (
  SELECT 1 FROM audit_events event
  WHERE event.sequence = NEW.sequence
     OR event.event_id = NEW.event_id
     OR event.event_hash = NEW.event_hash
)
BEGIN
  SELECT RAISE(ABORT, 'audit event replay or replacement denied');
END;

CREATE TRIGGER schema_migrations_deny_conflicting_insert
BEFORE INSERT ON schema_migrations
WHEN EXISTS (
  SELECT 1 FROM schema_migrations migration
  WHERE migration.version = NEW.version OR migration.name = NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'schema migration replay or replacement denied');
END;

CREATE TRIGGER listing_revisions_require_chain
BEFORE INSERT ON listing_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM listing_subjects subject
  WHERE subject.subject_key = NEW.subject_key AND subject.scope_key = NEW.scope_key
)
OR NEW.revision_number <> COALESCE(
  (SELECT MAX(revision_number) + 1 FROM listing_revisions WHERE subject_key = NEW.subject_key),
  1
)
OR (
  NEW.revision_number = 1 AND NEW.previous_revision_digest IS NOT NULL
)
OR (
  NEW.revision_number > 1 AND NEW.previous_revision_digest <> (
    SELECT revision_digest FROM listing_revisions
    WHERE subject_key = NEW.subject_key ORDER BY revision_number DESC LIMIT 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'listing revision chain mismatch');
END;

CREATE TRIGGER audit_events_enforce_chain_position
BEFORE INSERT ON audit_events
WHEN NOT (
  NEW.sequence = COALESCE((SELECT MAX(sequence) FROM audit_events), 0) + 1
  AND NEW.previous_hash = COALESCE(
    (SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1),
    'GENESIS'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid audit chain position');
END;

${['control_scope', 'listing_subjects', 'listing_revisions', 'ebay_artifact_bindings', 'shopify_sku_bindings', 'listing_revision_fields', 'audit_events', 'schema_migrations']
  .map((table) => `
CREATE TRIGGER ${table}_deny_update
BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only');
END;
CREATE TRIGGER ${table}_deny_delete
BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only');
END;`).join('\n')}
`;

const checksum = (value: string): string =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

export const LISTING_CONTROL_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'listing-control-v1',
    sql: migrationOneSql,
    checksum: checksum(migrationOneSql),
  }),
]);

function installSchema(database: InstanceType<typeof Database>, appliedAtUtc: string): void {
  const apply = database.transaction(() => {
    for (const migration of LISTING_CONTROL_MIGRATIONS) {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, migration.checksum, appliedAtUtc);
      database.pragma(`user_version = ${migration.version}`);
    }
    database.pragma(`application_id = ${LISTING_CONTROL_APPLICATION_ID}`);
  });
  apply.immediate();
}

function canonicalCatalog(database: InstanceType<typeof Database>) {
  const rows = database.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tbl_name,
    sql: (row.sql ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

function catalogDigest(database: InstanceType<typeof Database>): string {
  return checksum(JSON.stringify(canonicalCatalog(database)));
}

function expectedCatalogDigest(): string {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('recursive_triggers = ON');
    installSchema(database, '2000-01-01T00:00:00.000Z');
    return catalogDigest(database);
  } finally {
    database.close();
  }
}

export const LISTING_CONTROL_EXPECTED_CATALOG_DIGEST = expectedCatalogDigest();

export function initializeListingControlSchema(
  database: InstanceType<typeof Database>,
  appliedAtUtc: string,
): void {
  const existing = database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
  ).get() as { count: number };
  if (database.pragma('application_id', { simple: true }) !== 0
    || database.pragma('user_version', { simple: true }) !== 0
    || existing.count !== 0) {
    throw new Error('Refusing to initialize a non-empty or foreign SQLite database');
  }
  installSchema(database, appliedAtUtc);
}

export function verifyListingControlSchema(database: InstanceType<typeof Database>): void {
  if (database.pragma('application_id', { simple: true }) !== LISTING_CONTROL_APPLICATION_ID) {
    throw new Error('SQLite application ID is not ProductPipeline listing control state');
  }
  if (database.pragma('user_version', { simple: true }) !== LISTING_CONTROL_SCHEMA_VERSION) {
    throw new Error('Listing control schema version mismatch');
  }
  const history = database.prepare(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  ).all() as Array<{ version: number; name: string; checksum: string }>;
  if (history.length !== LISTING_CONTROL_MIGRATIONS.length) {
    throw new Error('Listing control schema history is incomplete or unexpected');
  }
  for (const [index, expected] of LISTING_CONTROL_MIGRATIONS.entries()) {
    const actual = history[index];
    if (actual?.version !== expected.version
      || actual.name !== expected.name
      || actual.checksum !== expected.checksum) {
      throw new Error('Listing control schema checksum mismatch');
    }
  }
  if (catalogDigest(database) !== LISTING_CONTROL_EXPECTED_CATALOG_DIGEST) {
    throw new Error('Listing control SQLite catalog does not match the application schema');
  }
}
