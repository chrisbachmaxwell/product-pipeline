# Migration-State Administration

`migration-admin` is a separate, local-only command for creating one inert migration-state database, upgrading its reviewed schema, and verifying it without provider access. It is not the legacy CLI, the offline reconciliation CLI, a platform client, or a cutover control.

The command surface is intentionally limited to:

- `init`: preview by default; initialize once only after the operator repeats the exact account-scope digest.
- `upgrade`: upgrade one existing verified store only after the operator repeats the exact account-scope digest and supplies a fresh canonical UTC instant.
- `verify`: open an existing store read-only, verify schema/account/integrity/audit invariants, and emit a redacted local-state projection.

There is no `force`, reset, sync, import, watermark, ownership, approval, job, canary, or provider-write command. None of these commands loads credentials, contacts Shopify/eBay/Marketplace Connect, reads the legacy application database, or changes commerce data. `upgrade` changes only the dedicated migration-state schema in one verified transaction.

## Configuration

Copy `config/migration-state.example.json` to a separate repository-local JSON file and replace its deliberately invalid eBay seller placeholder with the exact nonsecret account identifier. Never add a token, cookie, password, client secret, API key, customer value, or raw payload.

The strict schema requires:

- the exact ProductPipeline project/mode and schema version;
- a lane whose eBay environment matches (`development`/`sandbox` use sandbox; `production-shadow` uses production);
- exact Shopify store, eBay environment/seller/`EBAY_US` scope;
- a `databasePath` that is either the fixed ignored repository path
  `.local/migration-state/product-pipeline-migration-v1.sqlite` or an exact absolute durable
  path (for a deployment’s persistent volume) whose final two components are
  `migration-state/product-pipeline-migration-v1.sqlite`. The durable form must resolve
  outside the repository checkout; its `migration-state` directory and the volume root that
  contains it must be regular non-symlink directories that are not group/world writable
  (create with `mkdir -p -m 700 <volume>/migration-state`), no ancestor may be a symlink,
  and the parent must already exist at `init` time — the tool never creates it;
- explicit false assertions for platform access, external writes, historical backfill, ownership transfer, and credential use;
- a null cutover watermark.

Unknown fields, wildcard identities, the shipped invalid placeholder and common placeholder prefixes, credential-like material, symlink/hard-link paths, path traversal, oversized files, and SQLite sidecars fail closed. Error output names only stable validation categories; it does not echo rejected values or paths. The working `config/migration-state.json` path is ignored by Git. The tracked `config/migration-state.production.json` is the one nonsecret, exact-scope Railway configuration; it contains no authority or customer data.

## Preview, initialize, and verify

Preview performs no filesystem write and exits `2`:

```bash
npm run migration-admin -- init \
  --config config/migration-state.json \
  --created-at 2026-08-11T20:00:00.000Z \
  --json
```

Use a trusted current UTC instant rather than copying the example timestamp. Review the exact target and scope digest in the preview. If it is correct, create the fixed local parent yourself, then repeat the command with the exact digest:

```bash
mkdir -p -m 700 .local/migration-state
npm run migration-admin -- init \
  --config config/migration-state.json \
  --created-at 2026-08-11T20:00:00.000Z \
  --confirm-scope sha256:<exact-preview-digest> \
  --json
```

Initialization refuses an existing database or sidecar and creates only schema, one account scope, and its genesis audit record. It does not create ownership, watermark, cursor, identity, link, intent, approval, job, attempt, or reconciliation records. The returned writable construction handle is always closed before the database is reopened and projected read-only.

Verify an existing store with:

```bash
npm run migration-admin -- verify \
  --config config/migration-state.json \
  --json
```

Verification exits `0` only for a locally valid store. It preserves the database bytes, size, mode, modification time, and directory entries. Missing, legacy, tampered, cross-account, unsafe-permission, linked, or sidecar-bearing state exits `1` without creating or repairing anything.

## Railway production verify and schema upgrade

The Docker image creates a mode-`0700` `.git` root marker because Railway excludes
Git history from the build context. The existing package-name, configuration,
scope, durable-path, permission, schema, catalog, and audit-chain checks remain
unchanged. The image also points the authenticated read-only web projection at
the tracked production configuration; startup still never opens or upgrades the
store.

Before an in-place upgrade, stop all ceremony commands, take a verified
off-volume backup, and retain it until post-upgrade verification passes. Never
restore a pre-order-cutover backup after real order imports begin because doing
so could discard durable deduplication evidence.

Run on the Railway production service from `/app`:

```bash
node dist/migration-admin/index.js verify \
  --repo-root /app \
  --config config/migration-state.production.json \
  --json

node dist/migration-admin/index.js upgrade \
  --repo-root /app \
  --config config/migration-state.production.json \
  --applied-at '<fresh-canonical-UTC>' \
  --confirm-scope sha256:f1f798163d3f7c7042825d998c9f2b6f3f0ad5f75794a9d12dd887daa7e8f54c \
  --json

node dist/migration-admin/index.js verify \
  --repo-root /app \
  --config config/migration-state.production.json \
  --json
```

The first `verify` is expected to fail closed with `SCHEMA_MISMATCH` when the
deployed code requires a newer reviewed schema. That expected mismatch is not
permission to skip the backup or the exact-scope confirmation. The final
`verify` must report the current schema, a valid audit chain, and zero external
writes before any ownership or dispatch ceremony continues.

## Web projection

The mounted application reads migration state only when `MIGRATION_STATE_CONFIG_PATH` explicitly names the strict repository-local configuration. The reader runs only when authenticated `/api/migration/status` is requested; server startup does not open, create, initialize, or migrate the store.

The API/UI projection is deeply allowlisted. It can show the local schema, safe scope subset, fixed counts, ownership summaries, watermark absence, audit status, and blockers. It never returns a database/config path, seller ID, raw row, approval or entity identifier, rejected value, credential, customer value, or store handle. It always reports zero eligible orders, no historical backfill, no canary authorization, no cutover authorization, and no external-write capability.

For production (Railway) use, place the store on the persistent volume with the absolute
durable `databasePath` form above (e.g. `<volume>/migration-state/product-pipeline-migration-v1.sqlite`,
alongside the application database) so it survives redeploys — the repository-local path lives on the
ephemeral container filesystem and is wiped on every deploy. One-replica/topology fencing,
backup/restore rehearsal, trusted time, and external audit anchoring remain separate deployment
gates. A verified local projection is not Shopify/eBay/Marketplace Connect evidence or production parity.

## Exit codes

- `0`: initialization or schema upgrade completed with verified postconditions, an already-current store was confirmed, or an existing store verified locally.
- `1`: configuration, path, confirmation, creation, or integrity verification denied.
- `2`: safe initialization preview; no filesystem state was created.
