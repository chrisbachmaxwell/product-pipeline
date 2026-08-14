import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { LISTING_DRAFT_STATES, LISTING_AI_PROPOSABLE_FIELDS, LISTING_FIELD_NAMES, LISTING_MANAGEMENT_MODELS, LISTING_PROPOSAL_CONFIDENCE_LEVELS, LISTING_PROPOSAL_EVENT_TYPES, LISTING_PROPOSAL_FAILURE_CODES, LISTING_PROPOSAL_FIELD_REASON_CODES, LISTING_PROPOSAL_OUTCOMES, LISTING_PROPOSAL_REVIEW_REASON_CODES, LISTING_PROPOSAL_WARNING_CODES, } from './types.js';
export const LISTING_CONTROL_SCHEMA_VERSION = 3;
export const LISTING_CONTROL_APPLICATION_ID = 0x50504c43;
const sqlList = (values) => values.map((value) => `'${value}'`).join(', ');
const digestCheck = (column) => `(length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' `
    + `AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*')`;
const nullableDigestCheck = (column) => `(${column} IS NULL OR ${digestCheck(column)})`;
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
/**
 * V2 adds a truthful unchanged-observation provenance lane. The table rebuild
 * preserves every immutable V1 row and leaves V1's checksum untouched.
 */
const migrationTwoSql = `
CREATE TABLE listing_revision_fields_v2 (
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
  proposed_source TEXT NOT NULL CHECK (proposed_source IN ('source', 'observed', 'default', 'override', 'omit')),
  observed_value TEXT,
  observed_digest TEXT NOT NULL CHECK (${digestCheck('observed_digest')}),
  PRIMARY KEY (revision_id, field_name),
  CHECK (default_value IS NULL),
  CHECK (proposed_source <> 'default'),
  CHECK (
    (proposed_source = 'omit' AND proposed_value IS NULL)
    OR (proposed_source = 'source' AND source_value IS NOT NULL AND proposed_value IS source_value)
    OR (proposed_source = 'observed' AND observed_value IS NOT NULL AND proposed_value IS observed_value)
    OR (proposed_source = 'override' AND override_value IS NOT NULL AND proposed_value IS override_value)
  )
) WITHOUT ROWID;

INSERT INTO listing_revision_fields_v2 (
  revision_id, field_name, source_value, source_digest, default_value, default_digest,
  override_value, override_digest, proposed_value, proposed_digest, proposed_source,
  observed_value, observed_digest
)
SELECT
  revision_id, field_name, source_value, source_digest, default_value, default_digest,
  override_value, override_digest, proposed_value, proposed_digest, proposed_source,
  observed_value, observed_digest
FROM listing_revision_fields;

DROP TRIGGER listing_revision_fields_deny_conflicting_insert;
DROP TRIGGER listing_revision_fields_deny_update;
DROP TRIGGER listing_revision_fields_deny_delete;
DROP TABLE listing_revision_fields;
ALTER TABLE listing_revision_fields_v2 RENAME TO listing_revision_fields;

CREATE TRIGGER listing_revision_fields_deny_conflicting_insert
BEFORE INSERT ON listing_revision_fields
WHEN EXISTS (
  SELECT 1 FROM listing_revision_fields field
  WHERE field.revision_id = NEW.revision_id AND field.field_name = NEW.field_name
)
BEGIN
  SELECT RAISE(ABORT, 'listing field replay or replacement denied');
END;

CREATE TRIGGER listing_revision_fields_deny_update
BEFORE UPDATE ON listing_revision_fields
BEGIN
  SELECT RAISE(ABORT, 'listing_revision_fields is append-only');
END;

CREATE TRIGGER listing_revision_fields_deny_delete
BEFORE DELETE ON listing_revision_fields
BEGIN
  SELECT RAISE(ABORT, 'listing_revision_fields is append-only');
END;
`;
/**
 * V3 adds a local-only AI proposal and content-review ledger. Proposal state is
 * append-only and is deliberately separate from ordinary listing revisions.
 */
const migrationThreeSql = `
CREATE TABLE listing_proposal_jobs (
  job_id TEXT PRIMARY KEY,
  job_digest TEXT NOT NULL UNIQUE CHECK (${digestCheck('job_digest')}),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  shopify_product_gid TEXT NOT NULL,
  shopify_variant_gid TEXT NOT NULL,
  raw_sku TEXT NOT NULL,
  ebay_seller_id TEXT NOT NULL,
  ebay_marketplace_id TEXT NOT NULL CHECK (ebay_marketplace_id = 'EBAY_US'),
  management_model TEXT NOT NULL CHECK (management_model IN (${sqlList(LISTING_MANAGEMENT_MODELS)})),
  ebay_inventory_sku TEXT,
  ebay_offer_id TEXT,
  ebay_listing_id TEXT,
  base_revision_digest TEXT REFERENCES listing_revisions(revision_digest) CHECK (${nullableDigestCheck('base_revision_digest')}),
  base_source_digest TEXT NOT NULL CHECK (${digestCheck('base_source_digest')}),
  base_ebay_observation_digest TEXT NOT NULL CHECK (${digestCheck('base_ebay_observation_digest')}),
  trigger_digest TEXT NOT NULL CHECK (${digestCheck('trigger_digest')}),
  catalog_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  policy_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (${digestCheck('policy_digest')}),
  prompt_version TEXT NOT NULL,
  prompt_digest TEXT NOT NULL CHECK (${digestCheck('prompt_digest')}),
  proposal_schema_version TEXT NOT NULL,
  proposal_schema_digest TEXT NOT NULL CHECK (${digestCheck('proposal_schema_digest')}),
  agent_version TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'fixture')),
  requested_model TEXT NOT NULL,
  model_digest TEXT NOT NULL CHECK (${digestCheck('model_digest')}),
  requested_by TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  UNIQUE (scope_key, subject_key, trigger_digest),
  CHECK (ebay_inventory_sku IS NULL OR ebay_inventory_sku = raw_sku),
  CHECK ((management_model = 'inventory_api' AND ebay_inventory_sku IS NOT NULL)
    OR management_model <> 'inventory_api'),
  CHECK (created_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_epoch_ms / 1000.0, 'unixepoch'))
);

CREATE TABLE listing_proposal_results (
  result_id TEXT PRIMARY KEY,
  result_digest TEXT NOT NULL UNIQUE CHECK (${digestCheck('result_digest')}),
  job_id TEXT NOT NULL UNIQUE REFERENCES listing_proposal_jobs(job_id),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  outcome TEXT NOT NULL CHECK (outcome IN (${sqlList(LISTING_PROPOSAL_OUTCOMES)})),
  parsed_output_digest TEXT CHECK (${nullableDigestCheck('parsed_output_digest')}),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (${sqlList(LISTING_PROPOSAL_FAILURE_CODES)})),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  actor TEXT NOT NULL,
  completed_at_utc TEXT NOT NULL,
  completed_epoch_ms INTEGER NOT NULL,
  CHECK (completed_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', completed_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (
    (input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL)
    OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND total_tokens = input_tokens + output_tokens)
  ),
  CHECK (
    (outcome = 'failed' AND failure_code IS NOT NULL)
    OR (outcome <> 'failed' AND failure_code IS NULL AND parsed_output_digest IS NOT NULL)
  )
);

CREATE TABLE listing_proposal_field_decisions (
  result_id TEXT NOT NULL REFERENCES listing_proposal_results(result_id),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  field_name TEXT NOT NULL CHECK (field_name IN (${sqlList(LISTING_AI_PROPOSABLE_FIELDS)})),
  proposed_value TEXT,
  proposed_digest TEXT NOT NULL CHECK (${digestCheck('proposed_digest')}),
  proposed_source TEXT NOT NULL CHECK (proposed_source IN ('source', 'observed', 'override', 'omit')),
  confidence TEXT NOT NULL CHECK (confidence IN (${sqlList(LISTING_PROPOSAL_CONFIDENCE_LEVELS)})),
  reason_code TEXT NOT NULL CHECK (reason_code IN (${sqlList(LISTING_PROPOSAL_FIELD_REASON_CODES)})),
  warning_code TEXT CHECK (warning_code IS NULL OR warning_code IN (${sqlList(LISTING_PROPOSAL_WARNING_CODES)})),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  PRIMARY KEY (result_id, field_name),
  CHECK (
    (proposed_source = 'omit' AND proposed_value IS NULL)
    OR (proposed_source <> 'omit' AND proposed_value IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE TABLE listing_proposal_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES listing_proposal_jobs(job_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  subject_key TEXT NOT NULL REFERENCES listing_subjects(subject_key),
  event_type TEXT NOT NULL CHECK (event_type IN (${sqlList(LISTING_PROPOSAL_EVENT_TYPES)})),
  event_digest TEXT NOT NULL UNIQUE CHECK (${digestCheck('event_digest')}),
  previous_event_digest TEXT CHECK (${nullableDigestCheck('previous_event_digest')}),
  actor TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL,
  occurred_epoch_ms INTEGER NOT NULL,
  result_digest TEXT REFERENCES listing_proposal_results(result_digest) CHECK (${nullableDigestCheck('result_digest')}),
  reviewed_revision_digest TEXT REFERENCES listing_revisions(revision_digest) CHECK (${nullableDigestCheck('reviewed_revision_digest')}),
  review_reason_code TEXT CHECK (review_reason_code IS NULL OR review_reason_code IN (${sqlList(LISTING_PROPOSAL_REVIEW_REASON_CODES)})),
  payload_digest TEXT NOT NULL CHECK (${digestCheck('payload_digest')}),
  UNIQUE (job_id, sequence),
  CHECK (occurred_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (
    (sequence = 1 AND previous_event_digest IS NULL)
    OR (sequence > 1 AND previous_event_digest IS NOT NULL)
  ),
  CHECK (
    (event_type IN ('queued', 'generating') AND result_digest IS NULL
      AND reviewed_revision_digest IS NULL AND review_reason_code IS NULL)
    OR (event_type IN ('ready', 'no_change', 'needs_human', 'failed')
      AND result_digest IS NOT NULL AND reviewed_revision_digest IS NULL
      AND review_reason_code IS NULL)
    OR (event_type = 'approved' AND result_digest IS NOT NULL
      AND reviewed_revision_digest IS NOT NULL AND review_reason_code = 'accepted')
    OR (event_type IN ('rejected', 'stale') AND result_digest IS NOT NULL
      AND reviewed_revision_digest IS NULL AND review_reason_code IS NOT NULL)
  )
);

CREATE TRIGGER listing_proposal_jobs_require_base
BEFORE INSERT ON listing_proposal_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM listing_revisions revision
  WHERE revision.revision_digest = NEW.base_revision_digest
    AND revision.scope_key = NEW.scope_key
    AND revision.subject_key = NEW.subject_key
)
AND NEW.base_revision_digest IS NOT NULL
OR NEW.base_revision_digest IS NULL AND EXISTS (
  SELECT 1 FROM listing_revisions revision WHERE revision.subject_key = NEW.subject_key
)
OR NOT EXISTS (
  SELECT 1 FROM listing_subjects subject
  JOIN control_scope scope ON scope.scope_key = subject.scope_key
  WHERE subject.subject_key = NEW.subject_key AND subject.scope_key = NEW.scope_key
    AND subject.shopify_product_gid = NEW.shopify_product_gid
    AND subject.shopify_variant_gid = NEW.shopify_variant_gid
    AND scope.ebay_seller_id = NEW.ebay_seller_id
    AND scope.ebay_marketplace_id = NEW.ebay_marketplace_id
)
BEGIN
  SELECT RAISE(ABORT, 'proposal base mismatch');
END;

CREATE TRIGGER listing_proposal_events_require_chain
BEFORE INSERT ON listing_proposal_events
WHEN NEW.sequence <> COALESCE(
  (SELECT MAX(sequence) + 1 FROM listing_proposal_events WHERE job_id = NEW.job_id), 1
)
OR NEW.previous_event_digest IS NOT (
  SELECT event_digest FROM listing_proposal_events
  WHERE job_id = NEW.job_id ORDER BY sequence DESC LIMIT 1
)
OR NOT EXISTS (
  SELECT 1 FROM listing_proposal_jobs job
  WHERE job.job_id = NEW.job_id AND job.scope_key = NEW.scope_key
    AND job.subject_key = NEW.subject_key
)
OR (
  NEW.sequence = 1 AND NEW.event_type <> 'queued'
)
OR (
  NEW.sequence = 2 AND (
    NEW.event_type <> 'generating'
    OR (SELECT event_type FROM listing_proposal_events
        WHERE job_id = NEW.job_id ORDER BY sequence DESC LIMIT 1) <> 'queued'
  )
)
OR (
  NEW.sequence = 3 AND (
    NEW.event_type NOT IN (${sqlList(LISTING_PROPOSAL_OUTCOMES)})
    OR (SELECT event_type FROM listing_proposal_events
        WHERE job_id = NEW.job_id ORDER BY sequence DESC LIMIT 1) <> 'generating'
  )
)
OR (
  NEW.sequence = 4 AND (
    NEW.event_type NOT IN ('approved', 'rejected', 'stale')
    OR (SELECT event_type FROM listing_proposal_events
        WHERE job_id = NEW.job_id ORDER BY sequence DESC LIMIT 1)
       NOT IN ('ready', 'no_change', 'needs_human')
    OR (NEW.event_type = 'approved' AND (
      SELECT event_type FROM listing_proposal_events
      WHERE job_id = NEW.job_id ORDER BY sequence DESC LIMIT 1
    ) <> 'ready')
  )
)
OR NEW.sequence > 4
BEGIN
  SELECT RAISE(ABORT, 'proposal event chain mismatch');
END;

CREATE TRIGGER listing_proposal_results_require_scope
BEFORE INSERT ON listing_proposal_results
WHEN NOT EXISTS (
  SELECT 1 FROM listing_proposal_jobs job
  WHERE job.job_id = NEW.job_id AND job.scope_key = NEW.scope_key
    AND job.subject_key = NEW.subject_key
)
BEGIN
  SELECT RAISE(ABORT, 'proposal result scope mismatch');
END;

CREATE TRIGGER listing_proposal_field_decisions_require_scope
BEFORE INSERT ON listing_proposal_field_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM listing_proposal_results result
  JOIN listing_proposal_jobs job ON job.job_id = result.job_id
  WHERE result.result_id = NEW.result_id AND result.scope_key = NEW.scope_key
    AND result.subject_key = NEW.subject_key AND job.scope_key = NEW.scope_key
    AND job.subject_key = NEW.subject_key
)
BEGIN
  SELECT RAISE(ABORT, 'proposal field scope mismatch');
END;

CREATE TRIGGER listing_proposal_events_require_result
BEFORE INSERT ON listing_proposal_events
WHEN NEW.result_digest IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM listing_proposal_results result
  WHERE result.result_digest = NEW.result_digest AND result.job_id = NEW.job_id
    AND (
      NEW.event_type IN ('approved', 'rejected', 'stale')
      OR result.outcome = NEW.event_type
    )
)
BEGIN
  SELECT RAISE(ABORT, 'proposal result mismatch');
END;

CREATE TRIGGER listing_proposal_events_require_confidence_coherence
BEFORE INSERT ON listing_proposal_events
WHEN (
  NEW.event_type = 'needs_human' AND NOT EXISTS (
    SELECT 1 FROM listing_proposal_results result
    JOIN listing_proposal_field_decisions decision ON decision.result_id = result.result_id
    WHERE result.result_digest = NEW.result_digest AND result.job_id = NEW.job_id
      AND decision.confidence = 'low'
  )
)
OR (
  NEW.event_type IN ('ready', 'no_change') AND EXISTS (
    SELECT 1 FROM listing_proposal_results result
    JOIN listing_proposal_field_decisions decision ON decision.result_id = result.result_id
    WHERE result.result_digest = NEW.result_digest AND result.job_id = NEW.job_id
      AND decision.confidence = 'low'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'proposal confidence outcome mismatch');
END;

CREATE TRIGGER listing_proposal_events_approved_revision
BEFORE INSERT ON listing_proposal_events
WHEN NEW.event_type = 'approved' AND NOT EXISTS (
  SELECT 1 FROM listing_revisions revision
  JOIN listing_proposal_jobs job ON job.job_id = NEW.job_id
  WHERE revision.revision_digest = NEW.reviewed_revision_digest
    AND revision.scope_key = NEW.scope_key
    AND revision.subject_key = NEW.subject_key
    AND revision.previous_revision_digest IS job.base_revision_digest
    AND revision.state = 'reviewed'
)
BEGIN
  SELECT RAISE(ABORT, 'approved revision mismatch');
END;

${['listing_proposal_jobs', 'listing_proposal_results', 'listing_proposal_field_decisions', 'listing_proposal_events']
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

CREATE TRIGGER listing_proposal_jobs_deny_conflicting_insert
BEFORE INSERT ON listing_proposal_jobs
WHEN EXISTS (
  SELECT 1 FROM listing_proposal_jobs job
  WHERE job.job_id = NEW.job_id OR job.job_digest = NEW.job_digest
    OR (job.scope_key = NEW.scope_key AND job.subject_key = NEW.subject_key
      AND job.trigger_digest = NEW.trigger_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'proposal job replay or replacement denied');
END;

CREATE TRIGGER listing_proposal_results_deny_conflicting_insert
BEFORE INSERT ON listing_proposal_results
WHEN EXISTS (
  SELECT 1 FROM listing_proposal_results result
  WHERE result.result_id = NEW.result_id OR result.result_digest = NEW.result_digest
    OR result.job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'proposal result replay or replacement denied');
END;

CREATE TRIGGER listing_proposal_field_decisions_deny_conflicting_insert
BEFORE INSERT ON listing_proposal_field_decisions
WHEN EXISTS (
  SELECT 1 FROM listing_proposal_field_decisions decision
  WHERE decision.result_id = NEW.result_id AND decision.field_name = NEW.field_name
)
BEGIN
  SELECT RAISE(ABORT, 'proposal field replay or replacement denied');
END;

CREATE TRIGGER listing_proposal_events_deny_conflicting_insert
BEFORE INSERT ON listing_proposal_events
WHEN EXISTS (
  SELECT 1 FROM listing_proposal_events event
  WHERE event.event_id = NEW.event_id OR event.event_digest = NEW.event_digest
    OR (event.job_id = NEW.job_id AND event.sequence = NEW.sequence)
)
BEGIN
  SELECT RAISE(ABORT, 'proposal event replay or replacement denied');
END;

CREATE TABLE audit_events_v3 (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  scope_key TEXT NOT NULL REFERENCES control_scope(scope_key),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('scope.initialized', 'revision.created', 'proposal.event')),
  occurred_at_utc TEXT NOT NULL,
  occurred_epoch_ms INTEGER NOT NULL,
  subject_key TEXT CHECK (${nullableDigestCheck('subject_key')}),
  revision_digest TEXT UNIQUE REFERENCES listing_revisions(revision_digest) CHECK (${nullableDigestCheck('revision_digest')}),
  proposal_event_digest TEXT UNIQUE REFERENCES listing_proposal_events(event_digest) CHECK (${nullableDigestCheck('proposal_event_digest')}),
  payload_digest TEXT NOT NULL CHECK (${digestCheck('payload_digest')}),
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE CHECK (${digestCheck('event_hash')}),
  CHECK (occurred_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_epoch_ms / 1000.0, 'unixepoch')),
  CHECK (
    (event_type = 'scope.initialized' AND subject_key IS NULL
      AND revision_digest IS NULL AND proposal_event_digest IS NULL)
    OR (event_type = 'revision.created' AND subject_key IS NOT NULL
      AND revision_digest IS NOT NULL AND proposal_event_digest IS NULL)
    OR (event_type = 'proposal.event' AND subject_key IS NOT NULL
      AND revision_digest IS NULL AND proposal_event_digest IS NOT NULL)
  )
);

INSERT INTO audit_events_v3 (
  sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
  subject_key, revision_digest, proposal_event_digest, payload_digest, previous_hash, event_hash
)
SELECT sequence, scope_key, event_id, event_type, occurred_at_utc, occurred_epoch_ms,
  subject_key, revision_digest, NULL, payload_digest, previous_hash, event_hash
FROM audit_events;

DROP TRIGGER audit_events_deny_conflicting_insert;
DROP TRIGGER audit_events_enforce_chain_position;
DROP TRIGGER audit_events_deny_update;
DROP TRIGGER audit_events_deny_delete;
DROP TABLE audit_events;
ALTER TABLE audit_events_v3 RENAME TO audit_events;

CREATE TRIGGER audit_events_deny_conflicting_insert
BEFORE INSERT ON audit_events
WHEN EXISTS (
  SELECT 1 FROM audit_events event
  WHERE event.sequence = NEW.sequence OR event.event_id = NEW.event_id
    OR event.event_hash = NEW.event_hash
    OR (NEW.proposal_event_digest IS NOT NULL
      AND event.proposal_event_digest = NEW.proposal_event_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'audit event replay or replacement denied');
END;

CREATE TRIGGER audit_events_enforce_chain_position
BEFORE INSERT ON audit_events
WHEN NOT (
  NEW.sequence = COALESCE((SELECT MAX(sequence) FROM audit_events), 0) + 1
  AND NEW.previous_hash = COALESCE(
    (SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1), 'GENESIS'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid audit chain position');
END;

CREATE TRIGGER audit_events_deny_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_deny_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
`;
const checksum = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
export const LISTING_CONTROL_MIGRATIONS = Object.freeze([
    Object.freeze({
        version: 1,
        name: 'listing-control-v1',
        sql: migrationOneSql,
        checksum: checksum(migrationOneSql),
    }),
    Object.freeze({
        version: 2,
        name: 'listing-control-observed-provenance-v2',
        sql: migrationTwoSql,
        checksum: checksum(migrationTwoSql),
    }),
    Object.freeze({
        version: 3,
        name: 'listing-control-ai-proposal-review-v3',
        sql: migrationThreeSql,
        checksum: checksum(migrationThreeSql),
    }),
]);
function installMigrations(database, appliedAtUtc, migrations) {
    const apply = database.transaction(() => {
        for (const migration of migrations) {
            database.exec(migration.sql);
            database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)').run(migration.version, migration.name, migration.checksum, appliedAtUtc);
            database.pragma(`user_version = ${migration.version}`);
        }
        database.pragma(`application_id = ${LISTING_CONTROL_APPLICATION_ID}`);
    });
    apply.immediate();
}
function installSchema(database, appliedAtUtc) {
    installMigrations(database, appliedAtUtc, LISTING_CONTROL_MIGRATIONS);
}
function canonicalCatalog(database) {
    const rows = database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
    return rows.map((row) => ({
        type: row.type,
        name: row.name,
        tableName: row.tbl_name,
        sql: (row.sql ?? '').replace(/\s+/g, ' ').trim(),
    }));
}
function catalogDigest(database) {
    return checksum(JSON.stringify(canonicalCatalog(database)));
}
function expectedCatalogDigest(migrations = LISTING_CONTROL_MIGRATIONS) {
    const database = new Database(':memory:');
    try {
        database.pragma('foreign_keys = ON');
        database.pragma('recursive_triggers = ON');
        installMigrations(database, '2000-01-01T00:00:00.000Z', migrations);
        return catalogDigest(database);
    }
    finally {
        database.close();
    }
}
export const LISTING_CONTROL_EXPECTED_CATALOG_DIGEST = expectedCatalogDigest();
const LISTING_CONTROL_V1_EXPECTED_CATALOG_DIGEST = expectedCatalogDigest(LISTING_CONTROL_MIGRATIONS.slice(0, 1));
const LISTING_CONTROL_V2_EXPECTED_CATALOG_DIGEST = expectedCatalogDigest(LISTING_CONTROL_MIGRATIONS.slice(0, 2));
export function initializeListingControlSchema(database, appliedAtUtc) {
    const existing = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get();
    if (database.pragma('application_id', { simple: true }) !== 0
        || database.pragma('user_version', { simple: true }) !== 0
        || existing.count !== 0) {
        throw new Error('Refusing to initialize a non-empty or foreign SQLite database');
    }
    installSchema(database, appliedAtUtc);
}
export function verifyListingControlSchema(database) {
    if (database.pragma('application_id', { simple: true }) !== LISTING_CONTROL_APPLICATION_ID) {
        throw new Error('SQLite application ID is not ProductPipeline listing control state');
    }
    if (database.pragma('user_version', { simple: true }) !== LISTING_CONTROL_SCHEMA_VERSION) {
        throw new Error('Listing control schema version mismatch');
    }
    const history = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
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
export function verifyListingControlSchemaV1(database) {
    if (database.pragma('application_id', { simple: true }) !== LISTING_CONTROL_APPLICATION_ID
        || database.pragma('user_version', { simple: true }) !== 1) {
        throw new Error('Listing control V1 schema identity mismatch');
    }
    const history = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    const expected = LISTING_CONTROL_MIGRATIONS[0];
    if (history.length !== 1 || history[0]?.version !== expected.version
        || history[0].name !== expected.name || history[0].checksum !== expected.checksum
        || catalogDigest(database) !== LISTING_CONTROL_V1_EXPECTED_CATALOG_DIGEST) {
        throw new Error('Listing control V1 schema is not canonical');
    }
}
export function verifyListingControlSchemaV2(database) {
    if (database.pragma('application_id', { simple: true }) !== LISTING_CONTROL_APPLICATION_ID
        || database.pragma('user_version', { simple: true }) !== 2) {
        throw new Error('Listing control V2 schema identity mismatch');
    }
    const history = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    const expected = LISTING_CONTROL_MIGRATIONS.slice(0, 2);
    if (history.length !== expected.length
        || expected.some((migration, index) => history[index]?.version !== migration.version
            || history[index]?.name !== migration.name
            || history[index]?.checksum !== migration.checksum)
        || catalogDigest(database) !== LISTING_CONTROL_V2_EXPECTED_CATALOG_DIGEST) {
        throw new Error('Listing control V2 schema is not canonical');
    }
}
/** Explicit admin-only upgrade. Runtime open paths never invoke this function. */
export function upgradeListingControlSchemaV1ToV2(database, appliedAtUtc) {
    verifyListingControlSchemaV1(database);
    const migration = LISTING_CONTROL_MIGRATIONS[1];
    const apply = database.transaction(() => {
        database.exec(migration.sql);
        database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)').run(migration.version, migration.name, migration.checksum, appliedAtUtc);
        database.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
    verifyListingControlSchemaV2(database);
}
/** Explicit admin-only upgrade. Runtime open paths never invoke this function. */
export function upgradeListingControlSchemaV2ToV3(database, appliedAtUtc) {
    verifyListingControlSchemaV2(database);
    const migration = LISTING_CONTROL_MIGRATIONS[2];
    const apply = database.transaction(() => {
        database.exec(migration.sql);
        database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)').run(migration.version, migration.name, migration.checksum, appliedAtUtc);
        database.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
    verifyListingControlSchema(database);
}
