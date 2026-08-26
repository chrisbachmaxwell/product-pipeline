# Operational Monitoring and Daily Digest

G19 adds a read-only operational view so ceremony failures and future worker
failures do not remain visible only in logs. It does not schedule work, send
email, contact Shopify/eBay, enable a worker, or authorize a commerce write.

## Surfaces

- `GET /api/monitoring/digest` is authenticated like every mounted `/api`
  read. It performs the full local read-only inspection and warms one redacted
  in-memory health snapshot. The **Issues** page polls it once per minute while
  an authenticated operator has that page open.
- `GET /health` reads only that bounded in-memory snapshot. It never opens
  SQLite, verifies the audit chain, scans a directory, or waits for an
  authenticated digest refresh. Before the first authenticated digest it says
  `unavailable`; after five minutes without a refresh it says `stale`. This is
  intentionally not automatic monitoring. The public response never includes
  target IDs, SKUs, order IDs, exception details, database paths, or secrets.
- The migration database is opened read-only at request time through the
  existing configured projection. Startup still does not create, upgrade, or
  write that database.

Migration-readiness blocker codes are a fixed lower-kebab vocabulary. They
are generated from an exhaustive responsibility mapping rather than from the
camel-case control-plane names. The server's strict redaction allowlist stays
unchanged: a new or malformed blocker makes the whole configured projection
invalid instead of being passed through. A generic
`MIGRATION_STATE_STORE_INVALID` response therefore proves that the redacted
projection could not be accepted; it does not by itself prove that the SQLite
schema or audit chain is corrupt. Stop ceremonies and use the standalone
`migration-admin verify` command to distinguish durable-store verification
from a monitoring projection defect. Stage-specific diagnostics remain
deferred because splitting config, open, schema, integrity, audit, ownership,
execution, and projection failures would broaden the verified store-open
boundary; the production-shaped projection regression is the bounded repair
for this incident.

The digest covers the previous completed UTC day using one immutable cohort:
all dispatch attempts whose dispatch-boundary timestamp falls inside that
half-open UTC window. A cohort attempt is successful or failed only if its
resolution was also recorded before the window closed; a resolution after
midnight leaves that attempt classified as unresolved in the completed-day
digest. Therefore `succeeded + failed + unresolved = performed`, even across
midnight, and later reconciliation cannot rewrite a completed cohort.
Reconciliation and exception counts use their own completion timestamp in the
same UTC window. Current job-state totals separately surface the latest
reserved, dispatching, reconciliation-required, successful, and
confirmed-missing jobs. Counts are aggregate only.

## Shadow parity and catalog read health

Railway is configured to read the newest regular JSON report from
`/data/shadow-reports`. The reader is bounded to 100 directory entries and a
1 MiB file. The absolute directory must be a non-symlink directory owned by
the running service UID with exact mode `0700`; the order-import runbook uses
that same creation contract. This trusted private directory prevents another
local account from substituting report names between directory discovery and
descriptor open. The reader opens the report with `O_NOFOLLOW` and binds the
descriptor with `fstat`
before and after one size-bounded read, and rejects symlinks, hard links,
identity swaps, path ambiguity, and internally inconsistent summaries. It
requires the CLI's private `0600` file mode, exact `shadow-poll` contract, and
an exact 24-hour report window before `clean` is possible. It projects only six aggregate fields. Raw observed
orders, order IDs, and SKUs are discarded. The report file modification time
is only local file-arrival evidence; it is not a Shopify/eBay observation
timestamp. The field is named `arrivedAtUtc`; reports older than 36 hours are
shown as stale. One-hour and 168-hour reports are useful operator evidence but
are not accepted as this dashboard's daily parity report.

Catalog read health comes only from the existing in-memory listing cache
status. Monitoring never calls the cache refresh method, reads a token, or
makes a provider request. The cache does not classify why a refresh failed,
so the counter is `catalogReadFailures`, not an authentication diagnosis. A
failed refresh is critical; no first snapshot yet is pending.

## Status interpretation

- **Green:** the migration store and audit chain verify, catalog reads are
  current, the latest shadow report is clean, and the completed UTC day has no
  failed/unresolved writes, blocked/failed reconciliations, or warning/critical
  exceptions.
- **Attention:** a first catalog snapshot is pending or shadow-report evidence
  is missing/stale.
- **Critical:** configured state is unavailable/invalid, a catalog read
  failed, a job is unresolved or confirmed missing, the completed daily
  window contains a failed
  effect or reconciliation exception, or the latest shadow report is not
  clean.

`writes.skipped` is deliberately `null` with status
`not-journaled-until-g18`. There is no worker journal yet, so reporting zero
would be false evidence. G18 must connect its future disabled-by-default run
journal to this projection before any worker is enabled.

## Proof boundary

The digest is a deterministic SHA-256 over the redacted aggregate snapshot.
It is useful for comparing reports and preserving a 14-day operator record,
but it is not an external audit anchor and does not prove provider state by
itself. No automatic digest persistence or notification exists in G19; an
operator or a separately approved future reporting integration must retain or
send it.
