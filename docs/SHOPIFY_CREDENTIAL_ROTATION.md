# Shopify Credential Rotation Runbook

This runbook is for the fixed Production ProductPipeline app and store only. It rotates one stored Shopify access token after a Shopify client-secret change. It cannot create or update a product, listing, order, price, inventory level, fulfillment, policy, mapping, or Marketplace Connect setting. Marketplace Connect remains the incumbent writer.

The credential administrator is a standalone compiled command shared with a separately isolated eBay maintenance family. The three Shopify commands remain option-free at the command root; eBay commands are selected only by the exact literal `ebay` family token. The dispatcher does not share provider configuration, authority, network calls, mutation logic, or recovery state. It is not mounted or imported by the web server. Invoke it only through the direct `node dist/credential-admin/index.js ...` commands below. No npm package-script wrapper is supported because npm can print forwarded arguments before the administrator can reject and redact them. Never paste a client secret, access token, dashboard refresh token, webhook signature, or command output containing authority into a terminal argument, log, ticket, chat, repository file, or runbook.

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

Before maintenance, independently confirm one Railway replica, one attached `/data` volume, no other process or operator writing the legacy database, and no in-progress listing-control or eBay credential administration. `LISTING_CONTROL_SINGLE_WRITER_ACK` and `EBAY_ROTATION_NEW_CERT_ID` must both be absent; any value, including empty, fails closed. The database must already be a regular, non-symlink, single-link mode-`0600` file with a private non-writable parent and no `-journal`, `-wal`, or `-shm` sidecar. Runtime never initializes, migrates, repairs, or replaces this database.

The preflight also requires exactly one Shopify `auth_tokens` row. Its `refresh_token` and `expires_at` must be `NULL`; its `scope` may be `NULL` or the exact four canonical scopes in any order. Any other row count, refresh/expiry metadata, missing/extra/write scope, or malformed value returns fixed `token-row-denied` before backup, provider rotation, or database mutation. Correct the discrepancy through a separately reviewed data-reconciliation plan; do not edit it ad hoc.

## Secret-overlap gate

Use this exact transition order before the fixed commands:

1. Deploy the reviewed dual-verifier release while the old Shopify secret remains the primary secret. Verify the exact deployed release and normal signed-in/inbound health; do not create or revoke a secret yet.
2. Generate the new Shopify secret without revoking the old secret.
3. In one reviewed configuration change, set primary to the new secret, previous to the old secret, and a canonical cutoff no more than one hour ahead; redeploy and prove that current- and previous-secret App Bridge/webhook verification both succeed without logging a signature or secret.
4. Only after dual inbound verification succeeds, generate/store the one-hour dashboard refresh token, set the dedicated expiring single-writer acknowledgement, and run preflight, rotate, and verify below.

### Already-staged recovery exception — SCR-2026-08-14-001

This exception applies only to `SCR-2026-08-14-001`. It does not change the default sequence for future rotations.

A clean secondary Shopify secret was generated and the Railway control plane was committed with the new secret as primary and the old secret as previous before the dual-verifier release was deployed. The active Production deployment still uses its prior old-primary variable snapshot. No access-token rotation, old-secret revocation, or database mutation has occurred.

The reviewed dual-verifier release may therefore deploy directly with the new primary and old previous secret only when all of these gates pass:

- Production deployment `259f4262-0943-4c26-a47b-6b722f73fc75`, revision `234e0cb4de8aeafe494492f7039317915969b9aa`, remains the verified rollback target and its rollback action is available.
- The old secret remains Shopify's oldest unrevoked secret and the new secondary remains unrevoked.
- `SHOPIFY_CLIENT_SECRET` is the new secret, `SHOPIFY_PREVIOUS_CLIENT_SECRET` is the old secret, and `SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC` is canonical UTC, no more than one hour ahead, with enough time for deployment verification and at least 15 minutes remaining at any later rotation dispatch.
- `SHOPIFY_ROTATION_REFRESH_TOKEN` and the credential-rotation acknowledgement are not set until the candidate deployment passes its release and inbound verification gates.
- `LISTING_CONTROL_SINGLE_WRITER_ACK` remains absent.
- Marketplace Connect ownership and every commerce-writer quarantine remain unchanged.

After deployment, prove the exact release revision, one settled active replica with the `/data` volume, the public shadow-read-only health contract, a signed-in authenticated App Bridge read, and a real old-secret-signed webhook recorded only through the fixed verified-shadow log. An HTTP `200` webhook response alone is not proof because the endpoint acknowledges before verification.

Before the single provider token-rotation request, any failed release, authentication, webhook, or configuration proof requires rollback to deployment `259f4262-0943-4c26-a47b-6b722f73fc75`, restoring its old image and custom-variable snapshot, and a stop. Railway rollback is forbidden at or after the provider token-rotation request or after old-secret revocation; those states require the documented forward reconciliation procedure.

Because Shopify signs with its oldest unrevoked secret, pre-revocation live traffic directly proves the old/previous path. The reviewed current/previous regressions prove the current path, and successful fresh-token verification proves that the configured new secret is valid with Shopify. Immediately after old-secret revocation and the new-only deployment, prove signed-in App Bridge and new-secret webhook verification live. Do not claim both live paths were observed before revocation.

Once this incident closes, this exception expires and future rotations must use the default sequence above.

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

`NODE_ENV` must be `production`; the exact Railway project, environment, and service variables must be present; and both `LISTING_CONTROL_SINGLE_WRITER_ACK` and `EBAY_ROTATION_NEW_CERT_ID` must be absent. Production and ambiguous environments never fall back to a local credential file.

## Fixed command sequence

Run only these option-free compiled commands, in order, from the reviewed deployed release:

```sh
node dist/credential-admin/index.js preflight-shopify-access-token-rotation
node dist/credential-admin/index.js rotate-shopify-access-token
node dist/credential-admin/index.js verify-shopify-access-token-rotation
```

Expected successful statuses are `preflight_verified`, `rotated_verified`, and `stored_token_verified`. Output is fixed redacted JSON containing only the pinned store/app/scopes, boolean/count integrity proof, zero commerce writes, and the exact provider credential-mutation count (`0`, `1`, `0`). It also proves that the temporary refresh token was not persisted to the database; the protected Railway variable still exists until the operator removes it after verification. Output never returns a token, secret, refresh token, database path, provider response body, or backup filename.

The rotate command performs this fixed sequence:

1. Validate Production identity, topology acknowledgement, path, permissions, sidecars, canonical `auth_tokens` schema/index, and exactly one Shopify row.
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
