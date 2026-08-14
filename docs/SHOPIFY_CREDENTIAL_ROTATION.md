# Shopify Credential Rotation Runbook

This runbook is for the fixed Production ProductPipeline app and store only. It rotates one stored Shopify access token after a Shopify client-secret change. It cannot create or update a product, listing, order, price, inventory level, fulfillment, policy, mapping, or Marketplace Connect setting. Marketplace Connect remains the incumbent writer.

The credential administrator is a standalone compiled command. It is not mounted or imported by the web server. Never paste a client secret, access token, dashboard refresh token, webhook signature, or command output containing authority into a terminal argument, log, ticket, chat, repository file, or runbook.

## Release and authority gate

Do not run the procedure until the exact reviewed release containing this runbook and `dist/credential-admin/index.js` is deployed. A passing local build is not deployment proof.

The command fails closed unless all of these nonsecret Production pins match:

- Railway project: `f8c050c9-11c3-4611-8805-092289941aa4`
- Railway environment: `544d8896-b900-48ad-b42e-95272e1ad397`
- Railway service: `32ef14cc-2c85-447d-a890-53c422d81de1`
- Shopify store: `usedcameragear.myshopify.com`
- Shopify app client ID: `2db0555e4848a8264383dc0edfcfb8fe`
- legacy database: `/data/ebaysync.db`
- private backup directory: `/data/product-pipeline/credential-backups/shopify`
- exact scopes: `read_fulfillments`, `read_inventory`, `read_orders`, and `read_products`; missing, extra, or write scopes are denied

The mounted live catalog currently consumes `read_products` and `read_inventory`; bounded evidence/order attribution consumes `read_orders`; and `read_fulfillments` is retained because it is part of the existing `shopify.app.toml` and legacy installation contract. Credential maintenance deliberately makes no scope change. Any later narrowing is a separate reviewed authority migration.

Before maintenance, independently confirm one Railway replica, one attached `/data` volume, no other process or operator writing the legacy database, and no in-progress listing-control administration. The database must already be a regular, non-symlink, single-link mode-`0600` file with a private non-writable parent and no `-journal`, `-wal`, or `-shm` sidecar. Runtime never initializes, migrates, repairs, or replaces this database.

The preflight also requires exactly one Shopify `auth_tokens` row. Its `refresh_token` and `expires_at` must be `NULL`; its `scope` may be `NULL` or the exact four canonical scopes in any order. Any other row count, refresh/expiry metadata, missing/extra/write scope, or malformed value returns fixed `token-row-denied` before backup, provider rotation, or database mutation. Correct the discrepancy through a separately reviewed data-reconciliation plan; do not edit it ad hoc.

## Secret-overlap gate

Use this exact transition order before the fixed commands:

1. Deploy the reviewed dual-verifier release while the old Shopify secret remains the primary secret. Verify the exact deployed release and normal signed-in/inbound health; do not create or revoke a secret yet.
2. Generate the new Shopify secret without revoking the old secret.
3. In one reviewed configuration change, set primary to the new secret, previous to the old secret, and a canonical cutoff no more than one hour ahead; redeploy and prove that current- and previous-secret App Bridge/webhook verification both succeed without logging a signature or secret.
4. Only after dual inbound verification succeeds, generate/store the one-hour dashboard refresh token, set the dedicated expiring single-writer acknowledgement, and run preflight, rotate, and verify below.

### Current recovery checkpoint — SCR-2026-08-14-001

This exception applies only to `SCR-2026-08-14-001`. It does not change the default sequence for future rotations.

PR #15 merged and deployed as `579cc077a6ca4930fbfa88d415b80cc04c12d963`. Shopify app version `productpipeline-read-only-8` (`1090140569601`) was released with exactly the four documented read scopes; the merchant approved Update and the signed-in embedded app loaded afterward.

During maintenance, a cutoff-only Railway change unexpectedly redeployed the prior single-secret release. The operation immediately rolled back before any provider token request. A broad Shopify credential-settings accessibility capture then exposed the unused staged secondary secret. That secondary was revoked, a fresh clean secondary was generated and installed through value-blind control-plane handling, and the browser clipboard was cleared. Never reproduce the broad credential-page capture; use exact controls only and retain no raw credential evidence.

Temporary-ack deployment `77c18d72-e757-41be-8692-284d77f2490c` ran only the fixed direct preflight. It returned `{"status":"failed_closed","code":"database-denied"}` before any provider credential request or database write. The rotation acknowledgement variables were then removed. Same-revision deployment `d44e6238-0072-4c8c-bbd3-df6929f6164d` is Active with one replica; public `/health` at `2026-08-14T20:52:35.738Z` reported `ok`, `shadow-read-only`, external writes false, and historical backfill false. The signed-in embedded app loaded after scope approval.

Maintenance is stopped at the local database gate. Do not generate another dashboard refresh token, restore a database, edit the token row, rerun preflight, request token rotation, revoke the old secret, or remove the previous-secret verifier merely because the generic code is understood. The fixed read-only diagnostic source described below passed fresh independent adversarial review with no P0/P1 on frozen 29-path manifest `c0a55f38073ca52c138c83635464f168e9245cd7a8c2fc58821ff0a31bf26e28`; it remains uncommitted, unpushed, unmerged, undeployed, and unrun against Production. First preserve that reviewed source through exact commit/merge/deployment identity, then run the option-free compiled diagnostic once, preserve only its fixed credential-free stage, and prepare the smallest reviewed reconciliation for that exact boundary.

No access-token rotation, old-secret revocation, Production database write, proposal activation, listing/order/price/inventory write, Marketplace Connect change, or Lightspeed effect has occurred. Once this incident closes, this exception expires and future rotations must use the default sequence above.

During the Shopify overlap window:

- `SHOPIFY_CLIENT_SECRET` is the current/new secret and is the only client secret used for token acquisition.
- `SHOPIFY_PREVIOUS_CLIENT_SECRET` is the previous/old secret used only to verify inbound App Bridge JWTs and Shopify webhook HMACs.
- `SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC` is a canonical UTC timestamp no more than one hour in the future.

The secrets must be present, safe, and distinct. Immediately before the provider request, both the previous-secret overlap and the dedicated single-writer acknowledgement must have at least 15 minutes remaining. At or after the previous-secret cutoff, the runtime continues to accept the current secret and rejects the previous secret.

Set the following through the protected Production variable control plane, never through a command-line argument or a command that prints the environment:

- `SHOPIFY_ROTATION_REFRESH_TOKEN`: the temporary dashboard refresh token, required only for the rotate command
- `SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK=product-pipeline-shopify-credential-rotation-v1`
- `SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK_EXPIRES_AT_UTC`: canonical UTC, no more than one hour ahead and at least 15 minutes beyond dispatch
- `DATABASE_PATH=/data/ebaysync.db`

`NODE_ENV` must be `production`; the exact Railway project, environment, and service variables must be present; and `LISTING_CONTROL_SINGLE_WRITER_ACK` must be absent. Production and ambiguous environments never fall back to a local credential file.

## Fixed command sequence

Run only these option-free compiled commands, in order, from the reviewed deployed release. The `credential-admin` npm script is deliberately absent because npm prints raw arguments before the compiled entrypoint can redact them. Do not use `npm run credential-admin`, `npx`, `tsx`, a source entrypoint, an alias, or any wrapper for this maintenance boundary. Invoke only the exact compiled `node` commands below, and never append an option or value.

```sh
node dist/credential-admin/index.js preflight-shopify-access-token-rotation
node dist/credential-admin/index.js rotate-shopify-access-token
node dist/credential-admin/index.js verify-shopify-access-token-rotation
```

### Fixed database-denied diagnostic

If preflight returns exactly `database-denied`, stop the rotation sequence. Remove any temporary refresh-token and rotation-ack variables, return to a healthy no-ack deployment, and use only a separately reviewed release containing this option-free command:

```sh
node dist/credential-admin/index.js diagnose-shopify-credential-database
```

The diagnostic requires `NODE_ENV=production`, the exact Railway project/environment/service IDs, the exact ProductPipeline client ID, `DATABASE_PATH=/data/ebaysync.db`, and an absent `LISTING_CONTROL_SINGLE_WRITER_ACK`. It does not require or read a client secret, previous secret, dashboard refresh token, overlap deadline, or rotation acknowledgement. It accepts no path, identity, repair, schema, SQL, or output option and inspects only the compiled fixed database target.

The command opens the fixed file once with `O_RDONLY` and `O_NOFOLLOW`, keeps that descriptor open through inspection, and reads at most 512 MiB into private memory. SQLite receives only a copied in-memory snapshot and never receives or opens the filesystem path. A clean checkpointed database may retain WAL header mode without sidecars; only the private copy's header is presented to the in-memory reader as rollback-journal mode so SQLite cannot create `-wal` or `-shm` files. The source bytes are never changed. Before success, the command closes SQLite, rereads the held descriptor for an internal content-stability proof, rechecks descriptor and fixed-path identity plus sidecar absence, closes the descriptor, and clears its explicit buffers.

The diagnostic never queries, selects, serializes, logs, or outputs token-row values and never contacts Shopify. Its one frozen JSON result contains only fixed booleans, a first-failing stage from the compiled allowlist, `databaseWritesPerformed: 0`, `providerNetworkRequestsPerformed: 0`, `providerCredentialMutationsPerformed: 0`, and `externalCommerceWritesPerformed: 0`. Checks cover file existence/type/link/bounded-size/mode, parent permissions, sidecar absence before and after the snapshot, precise descriptor open/inspection/identity/close stages, private-memory/read-only/query-only SQLite state, exact canonical `sqlite_schema.sql`, ordinary rowid/non-STRICT storage, exact visible/default column shape, exact ascending `BINARY` unique-platform autoindex, no triggers or foreign keys, compilation of the same compare-and-swap statement used by rotation, SQLite integrity, and exactly one Shopify row. `CHECK` constraints, generated/hidden columns, STRICT or WITHOUT ROWID shape, and different index collation/order all fail closed before provider rotation.

`database_diagnostic_verified` exits zero. `database_diagnostic_failed_closed` exits nonzero with one fixed stage such as `file-missing`, `file-permissions-denied`, `sidecar-present`, `descriptor-inspection-denied`, `snapshot-post-stability-denied`, `path-post-identity-denied`, `schema-table-definition-denied`, `schema-index-denied`, `integrity-check-denied`, or `shopify-row-cardinality-denied`. Output never includes a path, token, secret, row value, row count, permission integer, digest, provider body, driver error, filename, or sidecar suffix. Preserve only the fixed result. The diagnostic neither repairs state nor authorizes preflight, rotation, retry, restore, revocation, or any commerce write.

Expected successful statuses are `preflight_verified`, `rotated_verified`, and `stored_token_verified`. Output is fixed redacted JSON containing only the pinned store/app/scopes, boolean/count integrity proof, zero commerce writes, and the exact provider credential-mutation count (`0`, `1`, `0`). It also proves that the temporary refresh token was not persisted to the database; the protected Railway variable still exists until the operator removes it after verification. Output never returns a token, secret, refresh token, database path, provider response body, or backup filename.

The rotate command performs this fixed sequence:

1. Validate Production identity, topology acknowledgement, path, permissions, sidecars, exact mutation-compatible `auth_tokens` schema/index/CAS contract, and exactly one Shopify row.
2. Verify the currently stored token against the exact Shopify shop GID, domain, app API key, and four exact read-only scopes.
3. Create and verify a complete SQLite backup before any provider credential effect. The directory is mode `0700`; each backup is a regular single-link mode-`0600` file and must preserve the full catalog, unrelated tables, and unrelated token rows.
4. Recheck the 15-minute acknowledgement and dual-secret overlap window, then send one bounded, no-retry official Shopify token-rotation request.
5. Verify the fresh token against the same exact shop, app, and scope authority.
6. Compare-and-swap only the original Shopify row in an `IMMEDIATE` transaction, preserving its identity/creation metadata and every unrelated row and column. The dashboard refresh token is never stored.
7. Close and reopen the database read-only, prove the committed row, and repeat the exact provider verification with the stored token.

After all three commands succeed, remove `SHOPIFY_ROTATION_REFRESH_TOKEN` and the dedicated acknowledgement variables immediately. Revoke the old Shopify secret only after the stored-token verification succeeds and inbound current-secret verification remains healthy. Then remove the previous-secret variables; do not extend their deadline beyond one hour.

## Failure and recovery truth

- A preflight or backup failure has no Shopify token-rotation request and no token-row mutation. No restore is needed. Preserve the fixed failure code and fix only the reviewed gate; do not repair or initialize the database.
- A timeout, transport failure, non-success response, malformed response, or process loss at/after the single provider request is an ambiguous remote credential effect. Do not rerun, restore the database, or revoke either secret. Escalate for credential-state reconciliation.
- A fresh-token verification or compare-and-swap failure can leave Shopify changed while the database retains the old token. Do not retry, restore, or revoke. The verified pre-rotation backup cannot undo Shopify.
- Once a fresh provider token verifies, the command commits it forward even if the wall clock crosses an acknowledgement or overlap deadline. A concurrent-row or database-integrity failure still stops the local commit and requires incident reconciliation.
- If compare-and-swap completed but the reopen or final provider verification failed, keep both secrets, run only the fixed read-only verify command, and escalate for reviewed local/provider reconciliation. Do not restore or revoke on the basis of a failed final check.
- Restore the old backup only under a separately reviewed recovery plan that has proved the old secret and old token are still valid. Never restore it after revoking the old secret: Shopify revocation removes the tokens associated with that secret.
- Record only fixed phase/status codes, timestamps, release identity, and credential-free integrity evidence. Escalate the exact partial-effect phase for reviewed recovery before any new refresh-token request, secret revocation, database restore, or retry.

See `docs/RELEASE_MAINTENANCE_INCIDENTS.md` for the release-blocking incident and prevention proof.
