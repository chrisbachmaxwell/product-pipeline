import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { MIGRATION_RESPONSIBILITIES, WRITER_RESPONSIBILITIES, } from '../safety/responsibilities.js';
import { INTENT_ACTIONS, INTENT_ACTION_RESPONSIBILITY } from './types.js';
export const CURRENT_SCHEMA_VERSION = 1;
export const MIGRATION_STORE_APPLICATION_ID = 0x50504d53;
const sqlList = (values) => values.map((value) => `'${value}'`).join(', ');
const migrationResponsibilitiesSql = sqlList(MIGRATION_RESPONSIBILITIES);
const writerResponsibilitiesSql = sqlList(WRITER_RESPONSIBILITIES);
const intentActionsSql = sqlList(INTENT_ACTIONS);
const digestCheck = (column) => `(length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' `
    + `AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*')`;
const immutableTables = [
    'integration_scope',
    'external_identities',
    'order_watermarks',
    'order_links',
    'order_pages',
    'order_observations',
    'order_observation_resolutions',
    'cursor_advances',
    'ownership_versions',
    'idempotency_intents',
    'action_approvals',
    'approval_consumptions',
    'execution_jobs',
    'job_events',
    'intent_attempts',
    'attempt_resolutions',
    'reconciliation_runs',
    'reconciliation_exceptions',
    'audit_events',
];
const immutableTriggerSql = immutableTables
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
END;`)
    .join('\n');
const insertConflictPredicates = {
    integration_scope: 'singleton = NEW.singleton OR scope_key = NEW.scope_key',
    external_identities: `identity_key = NEW.identity_key OR (
    scope_key = NEW.scope_key AND platform = NEW.platform AND resource_kind = NEW.resource_kind
    AND (binding_key = NEW.binding_key OR external_id = NEW.external_id)
  )`,
    order_links: `link_id = NEW.link_id OR ebay_order_identity_key = NEW.ebay_order_identity_key
    OR shopify_order_identity_key = NEW.shopify_order_identity_key`,
    order_pages: 'page_id = NEW.page_id',
    order_observations: `observation_id = NEW.observation_id OR (
    page_id = NEW.page_id AND ebay_order_identity_key = NEW.ebay_order_identity_key
  )`,
    order_observation_resolutions: 'resolution_id = NEW.resolution_id OR observation_id = NEW.observation_id',
    cursor_advances: `cursor_advance_id = NEW.cursor_advance_id OR page_id = NEW.page_id OR (
    scope_key = NEW.scope_key AND source_platform = NEW.source_platform
    AND responsibility = NEW.responsibility
    AND (ordinal = NEW.ordinal OR cursor_digest = NEW.cursor_digest)
  )`,
    ownership_versions: `ownership_id = NEW.ownership_id OR (
    scope_key = NEW.scope_key AND responsibility = NEW.responsibility AND version = NEW.version
  )`,
    idempotency_intents: `intent_key = NEW.intent_key OR (
    NEW.action = 'import_shopify_order' AND scope_key = NEW.scope_key
    AND responsibility = NEW.responsibility AND action = NEW.action
    AND source_identity_key = NEW.source_identity_key
  )`,
    action_approvals: 'approval_digest = NEW.approval_digest',
    approval_consumptions: 'approval_digest = NEW.approval_digest',
    execution_jobs: `job_id = NEW.job_id OR intent_key = NEW.intent_key
    OR approval_digest = NEW.approval_digest
    OR (NEW.order_observation_id IS NOT NULL AND order_observation_id = NEW.order_observation_id)`,
    job_events: 'job_event_id = NEW.job_event_id OR (job_id = NEW.job_id AND sequence = NEW.sequence)',
    intent_attempts: `attempt_id = NEW.attempt_id OR approval_digest = NEW.approval_digest
    OR (intent_key = NEW.intent_key AND ordinal = NEW.ordinal)`,
    attempt_resolutions: 'resolution_id = NEW.resolution_id OR attempt_id = NEW.attempt_id',
    reconciliation_runs: 'run_id = NEW.run_id',
    reconciliation_exceptions: 'exception_id = NEW.exception_id',
    audit_events: `sequence = NEW.sequence OR event_id = NEW.event_id OR event_hash = NEW.event_hash`,
};
const insertConflictTriggerSql = Object.entries(insertConflictPredicates)
    .map(([table, predicate]) => `
CREATE TRIGGER ${table}_deny_conflicting_insert
BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${predicate})
BEGIN
  SELECT RAISE(ABORT, '${table} replay or replacement denied');
END;`)
    .join('\n');
const relationshipTriggerSql = `
CREATE TRIGGER ownership_versions_require_scope
BEFORE INSERT ON ownership_versions
WHEN NOT EXISTS (SELECT 1 FROM integration_scope WHERE scope_key = NEW.scope_key)
BEGIN
  SELECT RAISE(ABORT, 'ownership scope does not exist');
END;

CREATE TRIGGER order_pages_require_scope
BEFORE INSERT ON order_pages
WHEN NOT EXISTS (SELECT 1 FROM integration_scope WHERE scope_key = NEW.scope_key)
BEGIN
  SELECT RAISE(ABORT, 'order page scope does not exist');
END;

CREATE TRIGGER job_events_require_job
BEFORE INSERT ON job_events
WHEN NOT EXISTS (SELECT 1 FROM execution_jobs WHERE job_id = NEW.job_id)
BEGIN
  SELECT RAISE(ABORT, 'job event job does not exist');
END;

CREATE TRIGGER reconciliation_runs_require_scope_target
BEFORE INSERT ON reconciliation_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM integration_scope scope
  JOIN external_identities target ON target.scope_key = scope.scope_key
  WHERE scope.scope_key = NEW.scope_key
    AND target.identity_key = NEW.target_identity_key
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation scope target binding mismatch');
END;

CREATE TRIGGER reconciliation_exceptions_require_run_subject
BEFORE INSERT ON reconciliation_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM reconciliation_runs run
  WHERE run.run_id = NEW.run_id
    AND (
      NEW.subject_identity_key IS NULL
      OR EXISTS (
        SELECT 1 FROM external_identities subject
        WHERE subject.identity_key = NEW.subject_identity_key
          AND subject.scope_key = run.scope_key
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation exception run subject binding mismatch');
END;

CREATE TRIGGER reconciliation_exceptions_deny_after_resolution
BEFORE INSERT ON reconciliation_exceptions
WHEN EXISTS (
  SELECT 1 FROM attempt_resolutions resolution
  WHERE resolution.reconciliation_run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation run is sealed by attempt resolution');
END;

CREATE TRIGGER audit_events_require_scope
BEFORE INSERT ON audit_events
WHEN NOT EXISTS (SELECT 1 FROM integration_scope WHERE scope_key = NEW.scope_key)
BEGIN
  SELECT RAISE(ABORT, 'audit scope does not exist');
END;
`;
const actionResponsibilitySql = Object.entries(INTENT_ACTION_RESPONSIBILITY)
    .map(([action, responsibility]) => `(NEW.action = '${action}' AND NEW.responsibility = '${responsibility}')`)
    .join('\n    OR ');
const migrationOneSql = `
CREATE TABLE integration_scope (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  scope_key TEXT NOT NULL UNIQUE CHECK (${digestCheck('scope_key')}),
  shopify_store_domain TEXT NOT NULL,
  ebay_environment TEXT NOT NULL CHECK (ebay_environment IN ('sandbox', 'production')),
  ebay_seller_id TEXT NOT NULL,
  ebay_marketplace_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL
);

CREATE TABLE external_identities (
  identity_key TEXT PRIMARY KEY CHECK (${digestCheck('identity_key')}),
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  platform TEXT NOT NULL CHECK (platform IN ('shopify', 'ebay')),
  resource_kind TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  shopify_store_domain TEXT,
  ebay_environment TEXT,
  ebay_seller_id TEXT,
  ebay_marketplace_id TEXT,
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  CHECK (
    (platform = 'shopify'
      AND resource_kind IN ('product', 'variant', 'order')
      AND shopify_store_domain IS NOT NULL
      AND ebay_environment IS NULL
      AND ebay_seller_id IS NULL
      AND ebay_marketplace_id IS NULL)
    OR
    (platform = 'ebay'
      AND resource_kind IN ('inventory_sku', 'offer', 'listing', 'order')
      AND shopify_store_domain IS NULL
      AND ebay_environment IN ('sandbox', 'production')
      AND ebay_seller_id IS NOT NULL
      AND ebay_marketplace_id IS NOT NULL)
  ),
  UNIQUE (scope_key, platform, resource_kind, binding_key),
  UNIQUE (scope_key, platform, resource_kind, external_id),
  UNIQUE (identity_key, scope_key, platform, resource_kind)
);

CREATE TRIGGER external_identities_enforce_scope
BEFORE INSERT ON external_identities
WHEN NOT EXISTS (
  SELECT 1 FROM integration_scope scope
  WHERE scope.scope_key = NEW.scope_key
    AND (
      (NEW.platform = 'shopify'
        AND NEW.shopify_store_domain = scope.shopify_store_domain)
      OR
      (NEW.platform = 'ebay'
        AND NEW.ebay_environment = scope.ebay_environment
        AND NEW.ebay_seller_id = scope.ebay_seller_id
        AND NEW.ebay_marketplace_id = scope.ebay_marketplace_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'external identity account drift');
END;

CREATE TABLE ownership_versions (
  ownership_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  responsibility TEXT NOT NULL CHECK (responsibility IN (${migrationResponsibilitiesSql})),
  version INTEGER NOT NULL CHECK (version > 0),
  owner TEXT NOT NULL CHECK (owner IN ('marketplace_connect', 'paused', 'product_pipeline')),
  single_writer_verified INTEGER NOT NULL CHECK (single_writer_verified IN (0, 1)),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  effective_at_utc TEXT NOT NULL,
  effective_epoch_ms INTEGER NOT NULL,
  recorded_at_utc TEXT NOT NULL,
  recorded_epoch_ms INTEGER NOT NULL,
  UNIQUE (scope_key, responsibility, version)
);

CREATE TRIGGER ownership_versions_require_next_version
BEFORE INSERT ON ownership_versions
WHEN NEW.version != COALESCE((
  SELECT MAX(version) FROM ownership_versions
  WHERE scope_key = NEW.scope_key AND responsibility = NEW.responsibility
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'ownership version must advance exactly once');
END;

CREATE TRIGGER ownership_versions_enforce_safe_transition
BEFORE INSERT ON ownership_versions
WHEN (
  NEW.version = 1 AND NEW.owner != 'marketplace_connect'
)
OR (
  NEW.version > 1 AND NOT EXISTS (
    SELECT 1 FROM ownership_versions previous
    WHERE previous.scope_key = NEW.scope_key
      AND previous.responsibility = NEW.responsibility
      AND previous.version = NEW.version - 1
      AND (
        (previous.owner = 'marketplace_connect' AND NEW.owner = 'paused')
        OR (previous.owner = 'paused' AND NEW.owner IN ('marketplace_connect', 'product_pipeline'))
        OR (previous.owner = 'product_pipeline' AND NEW.owner = 'paused')
      )
  )
)
OR EXISTS (
  SELECT 1 FROM integration_scope scope
  WHERE scope.scope_key = NEW.scope_key
    AND scope.ebay_environment = 'production'
    AND (
      NEW.version != 1
      OR NEW.owner != 'marketplace_connect'
      OR NEW.responsibility NOT IN ('orderImport', 'price', 'inventory')
    )
)
OR EXISTS (
  SELECT 1
  FROM execution_jobs job
  JOIN job_events latest ON latest.job_id = job.job_id
  WHERE job.scope_key = NEW.scope_key
    AND job.responsibility = NEW.responsibility
    AND latest.sequence = (
      SELECT MAX(candidate.sequence) FROM job_events candidate WHERE candidate.job_id = job.job_id
    )
    AND latest.to_state IN ('dispatching', 'reconciliation_required')
)
BEGIN
  SELECT RAISE(ABORT, 'unsafe ownership transition');
END;

CREATE TABLE order_watermarks (
  watermark_key TEXT PRIMARY KEY CHECK (${digestCheck('watermark_key')}),
  scope_key TEXT NOT NULL UNIQUE REFERENCES integration_scope(scope_key),
  source_platform TEXT NOT NULL CHECK (source_platform = 'ebay'),
  responsibility TEXT NOT NULL CHECK (responsibility = 'orderImport'),
  ownership_version INTEGER NOT NULL,
  ownership_evidence_digest TEXT NOT NULL CHECK (${digestCheck('ownership_evidence_digest')}),
  accepted_evidence_digest TEXT NOT NULL CHECK (${digestCheck('accepted_evidence_digest')}),
  event_field TEXT NOT NULL CHECK (event_field = 'creationDate'),
  boundary_mode TEXT NOT NULL CHECK (boundary_mode = 'exclusive'),
  boundary_exclusive_utc TEXT NOT NULL,
  boundary_exclusive_epoch_ms INTEGER NOT NULL,
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  CHECK (
    boundary_exclusive_utc = strftime(
      '%Y-%m-%dT%H:%M:%fZ', boundary_exclusive_epoch_ms / 1000.0, 'unixepoch'
    )
  ),
  FOREIGN KEY (scope_key, responsibility, ownership_version)
    REFERENCES ownership_versions(scope_key, responsibility, version)
);

CREATE TRIGGER order_watermarks_enforce_ownership_evidence
BEFORE INSERT ON order_watermarks
WHEN NOT EXISTS (
  SELECT 1 FROM ownership_versions ownership
  WHERE ownership.scope_key = NEW.scope_key
    AND ownership.responsibility = NEW.responsibility
    AND ownership.version = NEW.ownership_version
    AND ownership.owner = 'marketplace_connect'
    AND ownership.single_writer_verified = 1
    AND ownership.evidence_digest = NEW.ownership_evidence_digest
    AND ownership.version = (
      SELECT MAX(current.version) FROM ownership_versions current
      WHERE current.scope_key = NEW.scope_key
        AND current.responsibility = NEW.responsibility
    )
)
OR EXISTS (
  SELECT 1 FROM integration_scope scope
  WHERE scope.scope_key = NEW.scope_key AND scope.ebay_environment = 'production'
)
BEGIN
  SELECT RAISE(ABORT, 'order watermark ownership evidence mismatch or production scope denied');
END;

-- REPLACE can otherwise obscure a second cutoff attempt. This guard makes the
-- one-time cutoff immutable independently of delete-trigger semantics.
CREATE TRIGGER order_watermarks_deny_second_insert
BEFORE INSERT ON order_watermarks
WHEN EXISTS (
  SELECT 1 FROM order_watermarks
  WHERE watermark_key = NEW.watermark_key OR scope_key = NEW.scope_key
)
BEGIN
  SELECT RAISE(ABORT, 'order watermark already established');
END;

CREATE TABLE idempotency_intents (
  intent_key TEXT PRIMARY KEY CHECK (${digestCheck('intent_key')}),
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  responsibility TEXT NOT NULL CHECK (responsibility IN (${writerResponsibilitiesSql})),
  action TEXT NOT NULL CHECK (action IN (${intentActionsSql})),
  source_identity_key TEXT NOT NULL REFERENCES external_identities(identity_key),
  target_identity_key TEXT REFERENCES external_identities(identity_key),
  approval_target_identity_key TEXT NOT NULL REFERENCES external_identities(identity_key),
  desired_state_digest TEXT NOT NULL CHECK (${digestCheck('desired_state_digest')}),
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL,
  CHECK (
    (action = 'import_shopify_order' AND target_identity_key IS NULL
      AND approval_target_identity_key = source_identity_key)
    OR
    (action != 'import_shopify_order' AND target_identity_key IS NOT NULL
      AND approval_target_identity_key = target_identity_key)
  ),
  UNIQUE (intent_key, scope_key, responsibility, approval_target_identity_key)
);

CREATE UNIQUE INDEX unique_order_import_intent
ON idempotency_intents(scope_key, responsibility, action, source_identity_key)
WHERE action = 'import_shopify_order';

CREATE TRIGGER idempotency_intents_enforce_action_responsibility
BEFORE INSERT ON idempotency_intents
WHEN NOT (
    ${actionResponsibilitySql}
)
BEGIN
  SELECT RAISE(ABORT, 'intent action and responsibility mismatch');
END;

CREATE TRIGGER idempotency_intents_deny_production
BEFORE INSERT ON idempotency_intents
WHEN EXISTS (
  SELECT 1 FROM integration_scope scope
  WHERE scope.scope_key = NEW.scope_key AND scope.ebay_environment = 'production'
)
BEGIN
  SELECT RAISE(ABORT, 'production writer intents are disabled');
END;

CREATE TRIGGER idempotency_intents_enforce_identity_scope
BEFORE INSERT ON idempotency_intents
WHEN NOT EXISTS (
  SELECT 1 FROM external_identities source
  WHERE source.identity_key = NEW.source_identity_key AND source.scope_key = NEW.scope_key
)
OR (
  NEW.target_identity_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM external_identities target
    WHERE target.identity_key = NEW.target_identity_key AND target.scope_key = NEW.scope_key
  )
)
BEGIN
  SELECT RAISE(ABORT, 'intent identity scope mismatch');
END;

CREATE TRIGGER idempotency_intents_enforce_order_eligibility
BEFORE INSERT ON idempotency_intents
WHEN NEW.action = 'import_shopify_order' AND NOT EXISTS (
  SELECT 1
  FROM order_observations observation
  JOIN external_identities source
    ON source.identity_key = observation.ebay_order_identity_key
  LEFT JOIN order_observation_resolutions resolution
    ON resolution.observation_id = observation.observation_id
  WHERE observation.scope_key = NEW.scope_key
    AND observation.ebay_order_identity_key = NEW.source_identity_key
    AND source.scope_key = NEW.scope_key
    AND source.platform = 'ebay'
    AND source.resource_kind = 'order'
    AND observation.eligible_after_watermark = 1
    AND resolution.observation_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM order_links existing_link
      WHERE existing_link.ebay_order_identity_key = NEW.source_identity_key
    )
)
BEGIN
  SELECT RAISE(ABORT, 'order import intent requires an eligible unresolved observation');
END;

CREATE TABLE action_approvals (
  approval_digest TEXT PRIMARY KEY CHECK (${digestCheck('approval_digest')}),
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  intent_key TEXT NOT NULL,
  responsibility TEXT NOT NULL CHECK (responsibility IN (${writerResponsibilitiesSql})),
  target_identity_key TEXT NOT NULL REFERENCES external_identities(identity_key),
  ownership_version INTEGER NOT NULL,
  issued_at_utc TEXT NOT NULL,
  issued_epoch_ms INTEGER NOT NULL,
  expires_at_utc TEXT NOT NULL,
  expires_epoch_ms INTEGER NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  CHECK (expires_epoch_ms > issued_epoch_ms),
  CHECK (expires_epoch_ms - issued_epoch_ms <= 900000),
  CHECK (
    issued_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', issued_epoch_ms / 1000.0, 'unixepoch')
  ),
  CHECK (
    expires_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', expires_epoch_ms / 1000.0, 'unixepoch')
  ),
  UNIQUE (
    approval_digest, scope_key, intent_key, responsibility,
    target_identity_key, ownership_version, evidence_digest
  ),
  FOREIGN KEY (intent_key, scope_key, responsibility, target_identity_key)
    REFERENCES idempotency_intents(
      intent_key, scope_key, responsibility, approval_target_identity_key
    ),
  FOREIGN KEY (scope_key, responsibility, ownership_version)
    REFERENCES ownership_versions(scope_key, responsibility, version)
);

CREATE TRIGGER action_approvals_require_current_product_pipeline_owner
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM ownership_versions ownership
  WHERE ownership.scope_key = NEW.scope_key
    AND ownership.responsibility = NEW.responsibility
    AND ownership.version = NEW.ownership_version
    AND ownership.owner = 'product_pipeline'
    AND ownership.single_writer_verified = 1
    AND ownership.version = (
      SELECT MAX(current.version) FROM ownership_versions current
      WHERE current.scope_key = NEW.scope_key
        AND current.responsibility = NEW.responsibility
    )
)
BEGIN
  SELECT RAISE(ABORT, 'approval requires current ProductPipeline ownership');
END;

CREATE TRIGGER action_approvals_require_exact_intent_target
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM idempotency_intents intent
  JOIN external_identities target
    ON target.identity_key = intent.approval_target_identity_key
  WHERE intent.intent_key = NEW.intent_key
    AND intent.scope_key = NEW.scope_key
    AND intent.responsibility = NEW.responsibility
    AND intent.approval_target_identity_key = NEW.target_identity_key
    AND target.scope_key = NEW.scope_key
)
BEGIN
  SELECT RAISE(ABORT, 'approval intent target binding mismatch');
END;

CREATE TABLE approval_consumptions (
  approval_digest TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  target_identity_key TEXT NOT NULL,
  ownership_version INTEGER NOT NULL,
  approval_evidence_digest TEXT NOT NULL CHECK (${digestCheck('approval_evidence_digest')}),
  consumed_at_utc TEXT NOT NULL,
  consumed_epoch_ms INTEGER NOT NULL,
  UNIQUE (
    approval_digest, scope_key, intent_key, responsibility,
    target_identity_key, ownership_version, approval_evidence_digest
  ),
  FOREIGN KEY (
    approval_digest, scope_key, intent_key, responsibility,
    target_identity_key, ownership_version, approval_evidence_digest
  ) REFERENCES action_approvals (
    approval_digest, scope_key, intent_key, responsibility,
    target_identity_key, ownership_version, evidence_digest
  )
);

CREATE TRIGGER approval_consumptions_require_active_approval
BEFORE INSERT ON approval_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals approval
  WHERE approval.approval_digest = NEW.approval_digest
    AND approval.scope_key = NEW.scope_key
    AND approval.intent_key = NEW.intent_key
    AND approval.responsibility = NEW.responsibility
    AND approval.target_identity_key = NEW.target_identity_key
    AND approval.ownership_version = NEW.ownership_version
    AND approval.evidence_digest = NEW.approval_evidence_digest
    AND NEW.consumed_epoch_ms >= approval.issued_epoch_ms
    AND NEW.consumed_epoch_ms < approval.expires_epoch_ms
)
BEGIN
  SELECT RAISE(ABORT, 'approval is expired or does not match consumption');
END;

CREATE TABLE execution_jobs (
  job_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  intent_key TEXT NOT NULL UNIQUE,
  approval_digest TEXT NOT NULL UNIQUE,
  responsibility TEXT NOT NULL CHECK (responsibility IN (${writerResponsibilitiesSql})),
  target_identity_key TEXT NOT NULL,
  ownership_version INTEGER NOT NULL,
  approval_evidence_digest TEXT NOT NULL CHECK (${digestCheck('approval_evidence_digest')}),
  order_observation_id TEXT UNIQUE REFERENCES order_observations(observation_id),
  reserved_at_utc TEXT NOT NULL,
  reserved_epoch_ms INTEGER NOT NULL,
  CHECK (
    (responsibility = 'orderImport' AND order_observation_id IS NOT NULL)
    OR (responsibility != 'orderImport' AND order_observation_id IS NULL)
  ),
  FOREIGN KEY (
    approval_digest, scope_key, intent_key, responsibility,
    target_identity_key, ownership_version, approval_evidence_digest
  ) REFERENCES approval_consumptions (
    approval_digest, scope_key, intent_key, responsibility,
    target_identity_key, ownership_version, approval_evidence_digest
  ),
  UNIQUE (job_id, intent_key, approval_digest, ownership_version)
);

CREATE TRIGGER execution_jobs_enforce_current_owner_and_order_eligibility
BEFORE INSERT ON execution_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM ownership_versions ownership
  WHERE ownership.scope_key = NEW.scope_key
    AND ownership.responsibility = NEW.responsibility
    AND ownership.version = NEW.ownership_version
    AND ownership.owner = 'product_pipeline'
    AND ownership.single_writer_verified = 1
    AND ownership.version = (
      SELECT MAX(current.version) FROM ownership_versions current
      WHERE current.scope_key = NEW.scope_key
        AND current.responsibility = NEW.responsibility
    )
)
OR NOT EXISTS (
  SELECT 1 FROM approval_consumptions consumption
  WHERE consumption.approval_digest = NEW.approval_digest
    AND consumption.scope_key = NEW.scope_key
    AND consumption.intent_key = NEW.intent_key
    AND consumption.responsibility = NEW.responsibility
    AND consumption.target_identity_key = NEW.target_identity_key
    AND consumption.ownership_version = NEW.ownership_version
    AND consumption.approval_evidence_digest = NEW.approval_evidence_digest
    AND consumption.consumed_epoch_ms = NEW.reserved_epoch_ms
    AND consumption.consumed_at_utc = NEW.reserved_at_utc
)
OR (
  NEW.responsibility = 'orderImport' AND NOT EXISTS (
    SELECT 1
    FROM idempotency_intents intent
    JOIN order_observations observation
      ON observation.ebay_order_identity_key = intent.source_identity_key
    LEFT JOIN order_observation_resolutions resolution
      ON resolution.observation_id = observation.observation_id
    WHERE intent.intent_key = NEW.intent_key
      AND intent.scope_key = NEW.scope_key
      AND intent.action = 'import_shopify_order'
      AND observation.scope_key = NEW.scope_key
      AND observation.observation_id = NEW.order_observation_id
      AND observation.eligible_after_watermark = 1
      AND resolution.observation_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM order_links existing_link
        WHERE existing_link.ebay_order_identity_key = intent.source_identity_key
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'job ownership or order eligibility mismatch');
END;

CREATE TABLE job_events (
  job_event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (
    to_state IN ('reserved', 'dispatching',
      'reconciliation_required', 'resolved_existing', 'confirmed_missing')
  ),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  occurred_at_utc TEXT NOT NULL,
  occurred_epoch_ms INTEGER NOT NULL,
  UNIQUE (job_id, sequence)
);

CREATE TRIGGER job_events_enforce_transition
BEFORE INSERT ON job_events
WHEN NOT (
  (NEW.sequence = 1 AND NEW.from_state IS NULL AND NEW.to_state = 'reserved'
    AND NOT EXISTS (SELECT 1 FROM job_events WHERE job_id = NEW.job_id))
  OR
  (NEW.sequence > 1
    AND NEW.from_state = (
      SELECT to_state FROM job_events WHERE job_id = NEW.job_id ORDER BY sequence DESC LIMIT 1
    )
    AND NEW.sequence = COALESCE((
      SELECT MAX(sequence) FROM job_events WHERE job_id = NEW.job_id
    ), 0) + 1
    AND (
      (NEW.from_state = 'reserved' AND NEW.to_state = 'dispatching')
      OR (NEW.from_state = 'dispatching' AND NEW.to_state = 'reconciliation_required')
      OR (NEW.from_state = 'reconciliation_required'
        AND NEW.to_state IN ('resolved_existing', 'confirmed_missing'))
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid job state transition');
END;

CREATE TRIGGER job_events_enforce_dispatch_authority
BEFORE INSERT ON job_events
WHEN (NEW.to_state = 'dispatching' AND NOT EXISTS (
  SELECT 1
  FROM execution_jobs job
  JOIN action_approvals approval ON approval.approval_digest = job.approval_digest
  JOIN ownership_versions ownership
    ON ownership.scope_key = job.scope_key
   AND ownership.responsibility = job.responsibility
   AND ownership.version = job.ownership_version
  WHERE job.job_id = NEW.job_id
    AND approval.scope_key = job.scope_key
    AND approval.intent_key = job.intent_key
    AND approval.responsibility = job.responsibility
    AND approval.target_identity_key = job.target_identity_key
    AND approval.ownership_version = job.ownership_version
    AND approval.evidence_digest = job.approval_evidence_digest
    AND NEW.occurred_epoch_ms >= approval.issued_epoch_ms
    AND NEW.occurred_epoch_ms < approval.expires_epoch_ms
    AND ownership.owner = 'product_pipeline'
    AND ownership.single_writer_verified = 1
    AND ownership.version = (
      SELECT MAX(current.version) FROM ownership_versions current
      WHERE current.scope_key = job.scope_key
        AND current.responsibility = job.responsibility
    )
))
OR (NEW.to_state = 'dispatching' AND EXISTS (
  SELECT 1
  FROM execution_jobs job
  JOIN idempotency_intents intent ON intent.intent_key = job.intent_key
  JOIN order_links link ON link.ebay_order_identity_key = intent.source_identity_key
  WHERE job.job_id = NEW.job_id
    AND job.responsibility = 'orderImport'
    AND intent.action = 'import_shopify_order'
    AND link.scope_key = job.scope_key
))
BEGIN
  SELECT RAISE(ABORT, 'dispatch lacks authority or order is already linked');
END;

CREATE TRIGGER job_events_enforce_reconciled_terminal
BEFORE INSERT ON job_events
WHEN NEW.to_state IN ('resolved_existing', 'confirmed_missing') AND NOT EXISTS (
  SELECT 1
  FROM intent_attempts attempt
  JOIN attempt_resolutions resolution ON resolution.attempt_id = attempt.attempt_id
  WHERE attempt.job_id = NEW.job_id
    AND resolution.resolution = NEW.to_state
    AND resolution.evidence_digest = NEW.evidence_digest
    AND resolution.reconciled_epoch_ms = NEW.occurred_epoch_ms
)
BEGIN
  SELECT RAISE(ABORT, 'terminal job event requires exact attempt resolution');
END;

CREATE TRIGGER job_events_enforce_reconciliation_gate
BEFORE INSERT ON job_events
WHEN NEW.to_state = 'reconciliation_required' AND NOT EXISTS (
  SELECT 1 FROM intent_attempts attempt
  WHERE attempt.job_id = NEW.job_id
    AND attempt.outcome = 'outcome_unknown'
    AND attempt.recorded_epoch_ms <= NEW.occurred_epoch_ms
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation gate requires the exact unknown attempt');
END;

CREATE TABLE intent_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
  intent_key TEXT NOT NULL REFERENCES idempotency_intents(intent_key),
  approval_digest TEXT NOT NULL UNIQUE REFERENCES approval_consumptions(approval_digest),
  ownership_version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  outcome TEXT NOT NULL CHECK (outcome = 'outcome_unknown'),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  recorded_at_utc TEXT NOT NULL,
  recorded_epoch_ms INTEGER NOT NULL,
  UNIQUE (intent_key, ordinal),
  FOREIGN KEY (job_id, intent_key, approval_digest, ownership_version)
    REFERENCES execution_jobs(job_id, intent_key, approval_digest, ownership_version)
);

CREATE TRIGGER intent_attempts_require_next_ordinal
BEFORE INSERT ON intent_attempts
WHEN NEW.ordinal != COALESCE((
  SELECT MAX(ordinal) FROM intent_attempts WHERE intent_key = NEW.intent_key
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'attempt ordinal must advance exactly once');
END;

CREATE TRIGGER intent_attempts_enforce_dispatch_binding
BEFORE INSERT ON intent_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_jobs job
  JOIN action_approvals approval ON approval.approval_digest = job.approval_digest
  JOIN ownership_versions ownership
    ON ownership.scope_key = job.scope_key
   AND ownership.responsibility = job.responsibility
   AND ownership.version = job.ownership_version
  JOIN job_events dispatch
    ON dispatch.job_id = job.job_id
   AND dispatch.to_state = 'dispatching'
  WHERE job.job_id = NEW.job_id
    AND job.intent_key = NEW.intent_key
    AND job.approval_digest = NEW.approval_digest
    AND job.ownership_version = NEW.ownership_version
    AND NEW.ordinal = 1
    AND dispatch.sequence = (
      SELECT MAX(latest.sequence) FROM job_events latest WHERE latest.job_id = job.job_id
    )
    AND dispatch.occurred_epoch_ms = NEW.recorded_epoch_ms
    AND approval.evidence_digest = job.approval_evidence_digest
    AND NEW.recorded_epoch_ms < approval.expires_epoch_ms
    AND ownership.owner = 'product_pipeline'
    AND ownership.single_writer_verified = 1
    AND ownership.version = (
      SELECT MAX(current.version) FROM ownership_versions current
      WHERE current.scope_key = job.scope_key
        AND current.responsibility = job.responsibility
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attempt is not exactly bound to an authorized dispatch');
END;

CREATE TABLE attempt_resolutions (
  resolution_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES intent_attempts(attempt_id),
  resolution TEXT NOT NULL CHECK (
    resolution IN ('resolved_existing', 'confirmed_missing')
  ),
  reconciliation_run_id TEXT NOT NULL REFERENCES reconciliation_runs(run_id),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  reconciled_at_utc TEXT NOT NULL,
  reconciled_epoch_ms INTEGER NOT NULL
);

CREATE TABLE order_links (
  link_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  ebay_order_identity_key TEXT NOT NULL UNIQUE REFERENCES external_identities(identity_key),
  shopify_order_identity_key TEXT NOT NULL UNIQUE REFERENCES external_identities(identity_key),
  link_kind TEXT NOT NULL CHECK (link_kind IN ('observed_existing', 'product_pipeline_created')),
  idempotency_intent_key TEXT REFERENCES idempotency_intents(intent_key),
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  linked_at_utc TEXT NOT NULL,
  linked_epoch_ms INTEGER NOT NULL,
  CHECK (
    (link_kind = 'observed_existing' AND idempotency_intent_key IS NULL)
    OR
    (link_kind = 'product_pipeline_created' AND idempotency_intent_key IS NOT NULL)
  )
);

CREATE TRIGGER order_links_enforce_scope_and_kinds
BEFORE INSERT ON order_links
WHEN NOT EXISTS (
  SELECT 1
  FROM external_identities ebay_order
  JOIN external_identities shopify_order
  WHERE ebay_order.identity_key = NEW.ebay_order_identity_key
    AND ebay_order.scope_key = NEW.scope_key
    AND ebay_order.platform = 'ebay'
    AND ebay_order.resource_kind = 'order'
    AND shopify_order.identity_key = NEW.shopify_order_identity_key
    AND shopify_order.scope_key = NEW.scope_key
    AND shopify_order.platform = 'shopify'
    AND shopify_order.resource_kind = 'order'
)
OR (
  NEW.idempotency_intent_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM idempotency_intents intent
    WHERE intent.intent_key = NEW.idempotency_intent_key
      AND intent.scope_key = NEW.scope_key
      AND intent.action = 'import_shopify_order'
      AND intent.source_identity_key = NEW.ebay_order_identity_key
  )
)
BEGIN
  SELECT RAISE(ABORT, 'order link scope, kind, or intent mismatch');
END;

CREATE TABLE order_pages (
  page_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  cursor_before TEXT,
  cursor_before_digest TEXT,
  cursor_after TEXT NOT NULL,
  cursor_after_digest TEXT NOT NULL CHECK (${digestCheck('cursor_after_digest')}),
  observed_at_utc TEXT NOT NULL,
  observed_epoch_ms INTEGER NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (${digestCheck('snapshot_digest')}),
  CHECK (
    (cursor_before IS NULL AND cursor_before_digest IS NULL)
    OR
    (cursor_before IS NOT NULL AND ${digestCheck('cursor_before_digest')})
  )
);

CREATE TABLE order_observations (
  observation_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES order_pages(page_id),
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  ebay_order_identity_key TEXT NOT NULL REFERENCES external_identities(identity_key),
  source_created_at_utc TEXT NOT NULL,
  source_created_epoch_ms INTEGER NOT NULL,
  watermark_epoch_ms INTEGER NOT NULL,
  eligible_after_watermark INTEGER NOT NULL CHECK (eligible_after_watermark IN (0, 1)),
  observed_at_utc TEXT NOT NULL,
  observed_epoch_ms INTEGER NOT NULL,
  CHECK (eligible_after_watermark = (source_created_epoch_ms > watermark_epoch_ms)),
  CHECK (
    source_created_at_utc = strftime(
      '%Y-%m-%dT%H:%M:%fZ', source_created_epoch_ms / 1000.0, 'unixepoch'
    )
  ),
  UNIQUE (page_id, ebay_order_identity_key)
);

CREATE TRIGGER order_observations_enforce_scope_and_actual_watermark
BEFORE INSERT ON order_observations
WHEN NOT EXISTS (
  SELECT 1
  FROM order_pages page
  JOIN external_identities ebay_order
    ON ebay_order.identity_key = NEW.ebay_order_identity_key
  JOIN order_watermarks watermark
    ON watermark.scope_key = NEW.scope_key
  WHERE page.page_id = NEW.page_id
    AND page.scope_key = NEW.scope_key
    AND ebay_order.scope_key = NEW.scope_key
    AND ebay_order.platform = 'ebay'
    AND ebay_order.resource_kind = 'order'
    AND watermark.event_field = 'creationDate'
    AND watermark.boundary_mode = 'exclusive'
    AND watermark.boundary_exclusive_epoch_ms = NEW.watermark_epoch_ms
    AND NEW.eligible_after_watermark =
      (NEW.source_created_epoch_ms > watermark.boundary_exclusive_epoch_ms)
)
BEGIN
  SELECT RAISE(ABORT, 'order observation scope or watermark mismatch');
END;

CREATE TRIGGER order_observations_enforce_immutable_creation_date
BEFORE INSERT ON order_observations
WHEN EXISTS (
  SELECT 1 FROM order_observations existing
  WHERE existing.scope_key = NEW.scope_key
    AND existing.ebay_order_identity_key = NEW.ebay_order_identity_key
    AND (
      existing.source_created_epoch_ms != NEW.source_created_epoch_ms
      OR existing.source_created_at_utc != NEW.source_created_at_utc
    )
)
BEGIN
  SELECT RAISE(ABORT, 'eBay order creationDate changed across observations');
END;

CREATE TABLE order_observation_resolutions (
  resolution_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES order_observations(observation_id),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('excluded_by_watermark', 'linked_existing', 'reserved_job')
  ),
  reference_key TEXT,
  evidence_digest TEXT NOT NULL CHECK (${digestCheck('evidence_digest')}),
  resolved_at_utc TEXT NOT NULL,
  resolved_epoch_ms INTEGER NOT NULL
);

CREATE TRIGGER order_observation_resolutions_enforce_disposition
BEFORE INSERT ON order_observation_resolutions
WHEN NOT (
  (NEW.disposition = 'excluded_by_watermark'
    AND NEW.reference_key IS NULL
    AND EXISTS (
      SELECT 1 FROM order_observations observation
      WHERE observation.observation_id = NEW.observation_id
        AND observation.eligible_after_watermark = 0
        AND NEW.resolved_epoch_ms >= observation.observed_epoch_ms
    ))
  OR
  (NEW.disposition = 'linked_existing'
    AND NEW.reference_key IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM order_observations observation
      JOIN order_links link
        ON link.ebay_order_identity_key = observation.ebay_order_identity_key
      WHERE observation.observation_id = NEW.observation_id
        AND observation.eligible_after_watermark = 1
        AND link.scope_key = observation.scope_key
        AND link.link_id = NEW.reference_key
        AND NEW.resolved_epoch_ms >= observation.observed_epoch_ms
    ))
  OR
  (NEW.disposition = 'reserved_job'
    AND NEW.reference_key IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM order_observations observation
      JOIN execution_jobs job ON job.order_observation_id = observation.observation_id
      WHERE observation.observation_id = NEW.observation_id
        AND observation.eligible_after_watermark = 1
        AND job.scope_key = observation.scope_key
        AND job.job_id = NEW.reference_key
        AND NEW.resolved_epoch_ms >= observation.observed_epoch_ms
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'order observation resolution mismatch');
END;

CREATE TABLE cursor_advances (
  cursor_advance_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  source_platform TEXT NOT NULL CHECK (source_platform = 'ebay'),
  responsibility TEXT NOT NULL CHECK (responsibility = 'orderImport'),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  cursor_value TEXT NOT NULL,
  cursor_digest TEXT NOT NULL CHECK (${digestCheck('cursor_digest')}),
  page_id TEXT NOT NULL UNIQUE REFERENCES order_pages(page_id),
  advanced_at_utc TEXT NOT NULL,
  advanced_epoch_ms INTEGER NOT NULL,
  UNIQUE (scope_key, source_platform, responsibility, ordinal),
  UNIQUE (scope_key, source_platform, responsibility, cursor_digest)
);

CREATE TRIGGER cursor_advances_require_resolved_same_scope_page
BEFORE INSERT ON cursor_advances
WHEN NOT EXISTS (
  SELECT 1 FROM order_pages page
  WHERE page.page_id = NEW.page_id
    AND page.scope_key = NEW.scope_key
    AND page.cursor_after = NEW.cursor_value
    AND page.cursor_after_digest = NEW.cursor_digest
)
OR EXISTS (
  SELECT 1 FROM order_observations observation
  LEFT JOIN order_observation_resolutions resolution
    ON resolution.observation_id = observation.observation_id
  WHERE observation.page_id = NEW.page_id
    AND resolution.observation_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cursor page is cross-scope or unresolved');
END;

CREATE TRIGGER cursor_advances_require_next_ordinal
BEFORE INSERT ON cursor_advances
WHEN NEW.ordinal != COALESCE((
  SELECT MAX(ordinal) FROM cursor_advances
  WHERE scope_key = NEW.scope_key
    AND source_platform = NEW.source_platform
    AND responsibility = NEW.responsibility
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'cursor ordinal must advance exactly once');
END;

CREATE TABLE reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  responsibility TEXT NOT NULL CHECK (responsibility IN (${migrationResponsibilitiesSql})),
  target_identity_key TEXT NOT NULL REFERENCES external_identities(identity_key),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'test_lane', 'production_canary')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'blocked', 'failed')),
  source_snapshot_digest TEXT NOT NULL CHECK (${digestCheck('source_snapshot_digest')}),
  target_snapshot_digest TEXT NOT NULL CHECK (${digestCheck('target_snapshot_digest')}),
  result_digest TEXT NOT NULL CHECK (${digestCheck('result_digest')}),
  authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
  authority_evidence_digest TEXT NOT NULL CHECK (${digestCheck('authority_evidence_digest')}),
  external_writes_observed INTEGER NOT NULL CHECK (external_writes_observed >= 0),
  started_at_utc TEXT NOT NULL,
  started_epoch_ms INTEGER NOT NULL,
  completed_at_utc TEXT NOT NULL,
  completed_epoch_ms INTEGER NOT NULL,
  CHECK (completed_epoch_ms >= started_epoch_ms),
  CHECK (mode != 'shadow' OR external_writes_observed = 0)
);

CREATE TABLE reconciliation_exceptions (
  exception_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(run_id),
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject_identity_key TEXT REFERENCES external_identities(identity_key),
  details_digest TEXT NOT NULL CHECK (${digestCheck('details_digest')}),
  created_at_utc TEXT NOT NULL,
  created_epoch_ms INTEGER NOT NULL
);

CREATE TRIGGER reconciliation_runs_enforce_production_shadow_only
BEFORE INSERT ON reconciliation_runs
WHEN EXISTS (
  SELECT 1 FROM integration_scope scope
  WHERE scope.scope_key = NEW.scope_key
    AND scope.ebay_environment = 'production'
    AND (
      NEW.mode != 'shadow'
      OR NEW.authoritative != 0
      OR NEW.external_writes_observed != 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'production reconciliation is shadow-only and non-authoritative');
END;

CREATE TRIGGER attempt_resolutions_require_authoritative_target_reconciliation
BEFORE INSERT ON attempt_resolutions
WHEN NOT EXISTS (
  SELECT 1
  FROM intent_attempts attempt
  JOIN execution_jobs job ON job.job_id = attempt.job_id
  JOIN idempotency_intents intent ON intent.intent_key = attempt.intent_key
  JOIN reconciliation_runs run ON run.run_id = NEW.reconciliation_run_id
  JOIN job_events reconciliation_event ON reconciliation_event.job_id = job.job_id
  WHERE attempt.attempt_id = NEW.attempt_id
    AND job.scope_key = run.scope_key
    AND job.responsibility = run.responsibility
    AND intent.approval_target_identity_key = run.target_identity_key
    AND run.status = 'passed'
    AND run.authoritative = 1
    AND run.mode IN ('test_lane', 'production_canary')
    AND run.external_writes_observed = 0
    AND run.result_digest = NEW.evidence_digest
    AND reconciliation_event.to_state = 'reconciliation_required'
    AND reconciliation_event.sequence = (
      SELECT MAX(latest.sequence) FROM job_events latest WHERE latest.job_id = job.job_id
    )
    AND run.started_epoch_ms >= reconciliation_event.occurred_epoch_ms
    AND run.completed_epoch_ms <= NEW.reconciled_epoch_ms
    AND NOT EXISTS (
      SELECT 1 FROM reconciliation_exceptions exception
      WHERE exception.run_id = run.run_id AND exception.severity = 'critical'
    )
    AND (
      (NEW.resolution = 'resolved_existing' AND EXISTS (
        SELECT 1 FROM order_links link
        WHERE link.scope_key = job.scope_key
          AND link.ebay_order_identity_key = intent.source_identity_key
          AND link.idempotency_intent_key = intent.intent_key
          AND link.link_kind = 'product_pipeline_created'
      ))
      OR
      (NEW.resolution = 'confirmed_missing' AND NOT EXISTS (
        SELECT 1 FROM order_links link
        WHERE link.scope_key = job.scope_key
          AND link.ebay_order_identity_key = intent.source_identity_key
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attempt resolution lacks authoritative target reconciliation');
END;

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  scope_key TEXT NOT NULL REFERENCES integration_scope(scope_key),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL,
  occurred_epoch_ms INTEGER NOT NULL,
  payload_digest TEXT NOT NULL CHECK (${digestCheck('payload_digest')}),
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE CHECK (${digestCheck('event_hash')})
);

CREATE TRIGGER audit_events_enforce_chain_position
BEFORE INSERT ON audit_events
WHEN NOT (
  NEW.sequence = COALESCE((SELECT MAX(sequence) FROM audit_events), 0) + 1
  AND NEW.previous_hash = COALESCE((
    SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1
  ), 'GENESIS')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid audit chain position');
END;

${immutableTriggerSql}
${insertConflictTriggerSql}
${relationshipTriggerSql}
`;
function sqlChecksum(sql) {
    return `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`;
}
export const SCHEMA_MIGRATIONS = [
    {
        version: 1,
        name: 'durable_migration_state_v1',
        sql: migrationOneSql,
        checksum: sqlChecksum(migrationOneSql),
    },
];
const bootstrapSql = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (${digestCheck('checksum')}),
  applied_at_utc TEXT NOT NULL
);

CREATE TRIGGER schema_migrations_deny_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema migrations are immutable');
END;

CREATE TRIGGER schema_migrations_deny_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema migrations are immutable');
END;

CREATE TRIGGER schema_migrations_deny_conflicting_insert
BEFORE INSERT ON schema_migrations
WHEN EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = NEW.version OR name = NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'schema migration replay or replacement denied');
END;
`;
function installSchema(database, appliedAtUtc) {
    const apply = database.transaction(() => {
        database.exec(bootstrapSql);
        for (const migration of SCHEMA_MIGRATIONS) {
            database.exec(migration.sql);
            database
                .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)')
                .run(migration.version, migration.name, migration.checksum, appliedAtUtc);
            database.pragma(`user_version = ${migration.version}`);
        }
        database.pragma(`application_id = ${MIGRATION_STORE_APPLICATION_ID}`);
    });
    apply.immediate();
}
function canonicalCatalog(database) {
    const rows = database
        .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
        .all();
    return rows.map((row) => ({
        type: row.type,
        name: row.name,
        tableName: row.tbl_name,
        sql: (row.sql ?? '').replace(/\s+/g, ' ').trim(),
    }));
}
function catalogDigest(database) {
    return sqlChecksum(JSON.stringify(canonicalCatalog(database)));
}
function expectedCatalogDigest() {
    const database = new Database(':memory:');
    try {
        database.pragma('foreign_keys = ON');
        database.pragma('recursive_triggers = ON');
        installSchema(database, '2000-01-01T00:00:00.000Z');
        return catalogDigest(database);
    }
    finally {
        database.close();
    }
}
export const EXPECTED_SCHEMA_CATALOG_DIGEST = expectedCatalogDigest();
export function initializeSchema(database, appliedAtUtc) {
    const applicationId = database.pragma('application_id', { simple: true });
    const userVersion = database.pragma('user_version', { simple: true });
    const existing = database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
        .get();
    if (applicationId !== 0 || userVersion !== 0 || existing.count !== 0) {
        throw new Error('Refusing to initialize a non-empty or foreign SQLite database');
    }
    installSchema(database, appliedAtUtc);
}
export function verifySchema(database) {
    const applicationId = database.pragma('application_id', { simple: true });
    if (applicationId !== MIGRATION_STORE_APPLICATION_ID) {
        throw new Error('SQLite application ID is not ProductPipeline migration state');
    }
    const userVersion = database.pragma('user_version', { simple: true });
    if (userVersion !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`Migration store schema version ${String(userVersion)} does not match required version ${CURRENT_SCHEMA_VERSION}`);
    }
    const rows = database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all();
    if (rows.length !== SCHEMA_MIGRATIONS.length) {
        throw new Error('Migration store schema history is incomplete or unexpected');
    }
    for (const [index, expected] of SCHEMA_MIGRATIONS.entries()) {
        const actual = rows[index];
        if (actual.version !== expected.version
            || actual.name !== expected.name
            || actual.checksum !== expected.checksum) {
            throw new Error(`Migration store schema checksum mismatch at version ${expected.version}`);
        }
    }
    if (catalogDigest(database) !== EXPECTED_SCHEMA_CATALOG_DIGEST) {
        throw new Error('Migration store SQLite catalog does not match the application schema');
    }
}
