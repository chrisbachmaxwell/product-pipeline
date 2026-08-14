# eBay Production Credential Rotation

## Status and authority boundary

This is an operator-only, fixed-purpose maintenance procedure. The original eBay source candidate was committed as `665e9ca` on PR #16; its integration onto current `origin/main` remains an uncommitted review candidate. Neither candidate has been deployed, run on Railway, or used against eBay. It does not authorize a credential rotation.

The administrator is a standalone compiled entrypoint shared with a separately isolated Shopify maintenance family. eBay commands are selected only by the exact literal `ebay` family token; the dispatcher does not share provider configuration, authority, network calls, mutation logic, or recovery state. Invoke it only through the direct `node dist/credential-admin/index.js ...` commands below. No npm package-script wrapper is supported because npm can print forwarded arguments before the administrator can reject and redact them. It is not imported by the server, legacy CLI, scheduler, webhook handlers, listing readers, or commerce writers. It has no application route and cannot spawn a shell or another process.

The only accepted eBay grant is:

- environment: Production
- seller: `usedcameragear`
- marketplace proof: Trading `GetUser` with Site ID `0`, followed by a read-only Inventory request
- scopes, exactly and with no additions:
  - `https://api.ebay.com/oauth/api_scope`
  - `https://api.ebay.com/oauth/api_scope/sell.inventory`

Commerce Identity is deliberately not requested or called. `sell.account`, `sell.fulfillment`, `sell.marketing`, and every other extra scope are rejected. Marketplace Connect remains the order, price, and inventory writer. All ProductPipeline commerce writers stay frozen throughout maintenance.

## Compiled Production boundary

Railway commands fail unless the runtime identifies itself as all three compiled values:

- project: `f8c050c9-11c3-4611-8805-092289941aa4`
- environment: `544d8896-b900-48ad-b42e-95272e1ad397`
- service: `32ef14cc-2c85-447d-a890-53c422d81de1`

They accept no path arguments and use only:

- ledger: `/data/ebaysync.db`
- maintenance state: `/data/product-pipeline/credential-maintenance/ebay`
- backups: `/data/product-pipeline/credential-backups/ebay`
- archived terminal consent evidence: `/data/product-pipeline/credential-maintenance/evidence-archive`
- archived stale-lock evidence: `/data/product-pipeline/credential-maintenance/lock-archive`

The operation lock is the fixed file `/data/product-pipeline/credential-maintenance/.ebay-credential-operation.lock`. It contains only a random owner proof, PID, creation time, and five-minute expiry; it never contains a credential.

Private administrator directories must be real, non-linked mode-`0700` directories. State, backup, and database files must be real, single-link mode-`0600` regular files. New and replaced private files are synced, and their parent directory entries are synced before the operation may advance. A file or directory sync failure is terminal and fails closed. `LISTING_CONTROL_SINGLE_WRITER_ACK`, `SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK`, and `SHOPIFY_ROTATION_REFRESH_TOKEN` must all be absent; an empty value is still present and denied. The administrator never changes those assertions.

## Before a human-authorized maintenance window

1. Require a reviewed, clean source revision and verify its exact deployed revision separately. A local build is not deployment or live proof.
2. Confirm one Railway replica and the existing `/data` volume. Keep the scheduler, cloud watcher, webhooks, legacy auth routes, legacy eBay CLI, and every commerce writer quarantined. Complete or reconcile Shopify credential maintenance and remove its temporary acknowledgement and refresh-token variables before this eBay window.
3. Confirm the canonical `auth_tokens` table has its exact eight-column schema, one `UNIQUE(platform)` auto-index, no additional index, and no trigger. The administrator repeats this check before any authorization-code exchange.
4. Confirm `EBAY_APP_ID` and `EBAY_RU_NAME` identify the reviewed Production application. Supply the newly reset Production Cert only as `EBAY_ROTATION_NEW_CERT_ID`; do not place it in an argument, file, transcript, screenshot, or support message.
5. Establish a human-approved provider rollback/recovery owner. Resetting the Cert and revoking consent interrupt the existing ProductPipeline read connection.

## Provider closure and reset order

These are human actions in eBay, not administrator commands:

1. While the old credentials still work, sign in to the `usedcameragear` seller and revoke the existing ProductPipeline third-party application consent. Confirm the old grant is no longer authorized.
2. In the eBay Developer Program Production keyset, reset the Cert with the reviewed immediate/zero-day expiry choice. Never expose either Cert value.
3. Store only the new Cert in the secret manager as `EBAY_ROTATION_NEW_CERT_ID`. Do not fall back to an old Cert. A new Cert must not be treated as proof that an old grant was revoked.

If the old consent cannot be revoked and its state cannot be classified, stop. Do not create a replacement grant while the prior provider authority is ambiguous.

## Prepare and register one consent request

Create a new local private parent directory first. The target directory below must not already exist. Run locally:

```text
node dist/credential-admin/index.js ebay prepare-consent --local-work-dir /absolute/private/local/ebay-consent
```

Success is the fixed value-free code `EBAY_CONSENT_PREPARED`. The command writes:

- `consent-url.txt`, mode `0600`, containing the only raw state-bearing URL
- `consent-state.json`, mode `0600`, containing digests and nonsecret binding metadata, never the raw state

Do not print, pipe, paste, or attach `consent-url.txt` to a task transcript. Read only `stateDigest` and `requestDigest` from the local state record. Those digests may be transferred to the exact Railway service, where the direct command is:

```text
node dist/credential-admin/index.js ebay register-consent --state-digest sha256:<digest> --request-digest sha256:<digest>
```

Success is `EBAY_CONSENT_REGISTERED`. Railway records only the digests in the fixed private maintenance directory; the raw consent state and URL remain local. Both records expire after 15 minutes and are single-use.

## Consent, install, and verify

1. Open the URL directly from the private local file without copying it into logs or a task message.
2. Confirm the browser is signed in as exactly `usedcameragear`, review the exact two scopes, and approve once.
3. In an interactive session attached to the compiled Railway project/environment/service, run the direct command:

   ```text
   node dist/credential-admin/index.js ebay install
   ```

4. Paste the complete authorization result only at the no-echo prompt. It is rejected from arguments and environment variables.

Before exchanging the one-use code, install checks the exact private filesystem and database shape, captures the complete `auth_tokens` baseline, and creates and verifies a private SQLite backup. It then uses only `EBAY_ROTATION_NEW_CERT_ID` to exchange the code, introspects both tokens, verifies the exact client/audience/scopes, verifies seller `usedcameragear` through read-only Trading `GetUser`, and proves the Inventory scope with a read-only request.

Only after those checks does one `BEGIN IMMEDIATE` transaction compare the full baseline and update or insert exactly the `platform = 'ebay'` row. It never deletes first. Any unrelated auth row must remain byte-for-byte equal. It runs database integrity, foreign-key, transaction read-back, and independent post-commit read-back checks. Success is `EBAY_GRANT_INSTALLED`, with one database row changed and zero commerce writes.

Before the compare-and-swap, the private state records domain-separated SHA-256 digests of both returned tokens. It never records either token. The digest-bearing `commit-pending` file and its parent directory entry are both synced before the SQLite transaction can begin. The committed installation binding contains the exact row ID, update timestamp, scope, and both credential-free digests. `verify` and `revoke-new-grant` refuse a row whose token values were swapped even if its ID, timestamp, and scope were preserved. Digests remain private evidence and are never emitted by command output.

Run the value-free verifier immediately:

```text
node dist/credential-admin/index.js ebay verify
```

`verify` uses the bound, still-live stored access token. It does not refresh, mint, or persist a token. Success is `EBAY_GRANT_VERIFIED`, with zero database rows changed and `credentialProviderMutation: false`.

Before restarting the mounted read catalog, securely update its existing `EBAY_CERT_ID` credential source to the same new Production Cert. Keep its exact base-plus-`sell.inventory` scope boundary. Then separately verify the deployed revision, public health quarantine fields, signed-in listing reads, exact seller, and absence of provider writes. Remove the temporary rotation-only Cert variable only after the observation and cleanup window closes.

## Failure and cleanup

- Wrong seller, scope, client, audience, Production endpoint, malformed response, hostile XML, read probe, or pre-commit database failure causes the unused new grant to be revoked. A failed cleanup becomes `EBAY_ROTATION_CLEANUP_REQUIRED`.
- A network failure or timeout during code exchange is outcome-ambiguous. The state is terminally marked `failed-cleanup-required`; the command refuses replay. Inspect the seller's authorized-app state and eBay application state, revoke any uncertain ProductPipeline consent, and start with a completely new consent state. Never replay the authorization result.
- A CAS conflict leaves the ledger unchanged and revokes the newly minted grant. Reconcile the concurrent database change before any new attempt.
- If the process crashes immediately after the database commit, the already durable `commit-pending` record retains both token digests and the expected update timestamp. Do not reinstall. `verify` may promote that record to `installed` only when the exact database row matches its timestamp, scope, and both digests; it then durably records the row ID and commit time. A missing or nonmatching row remains a binding failure requiring manual provider/database reconciliation.
- SQLite can durably apply a transaction and still return an error while finalizing COMMIT. Therefore any COMMIT error is classified only after the connection closes and is never followed by an automatic revoke. An exact digest-bound installed row is recorded as `committed-reconciliation-required` with `databaseRowsChanged: 1`; run `verify`. An exact pre-install backup baseline is recorded as `commit-outcome-reconciliation-required` with `databaseRowsChanged: 0`. An unreadable or different ledger remains `commit-outcome-reconciliation-required` with `databaseRowsChanged: "unknown"`. Every case returns exit `5`, reports the provider mutation, preserves the durable commit intent, and forbids reinstall or blind revoke.
- If a known database commit succeeds but post-commit state or lock finalization fails, the command returns exit `5`, reports `databaseRowsChanged: 1`, `credentialProviderMutation: true`, and `reconciliationRequired: true`, and preserves `committed-reconciliation-required` or installed state evidence. Do not reinstall. Run `verify` to validate the exact digest-bound row and reconcile it to `installed`.
- Backups remain private and are never restored automatically. A restore requires a separate stopped-runtime, exact-file, human-reviewed recovery procedure.

### Reset only after provider reconciliation

An ambiguous or failed pre-commit attempt, or a COMMIT-error outcome that does not exactly prove the installed row, is terminal. First reconcile eBay directly: determine whether the uncertain consent exists and revoke it if necessary. For a COMMIT-error outcome, also reconcile the ledger under a separately reviewed stopped-runtime procedure. The administrator never restores the backup automatically. Then create an entirely new local consent request in a new private directory. Use its new `stateDigest` and `requestDigest` in the following fixed Railway command:

```text
node dist/credential-admin/index.js ebay archive-reset-after-reconciliation --state-digest sha256:<new-digest> --request-digest sha256:<new-digest> --confirm provider-reconciled-reset-ebay-consent
```

The command accepts `failed-no-provider-effect`, `failed-revoked`, or `failed-cleanup-required` evidence with no database effect. It also accepts `commit-outcome-reconciliation-required` only when the current fixed ledger is readable, structurally valid, and byte-for-byte equal at the row level to the named private pre-install backup, whose eBay row must predate the attempted CAS timestamp. A mismatched, unreadable, missing, linked, or non-private ledger/backup is denied; reconcile it first. The command moves the complete prior mode-`0700` work directory into the fixed evidence archive without deleting it, syncing the evidence-bearing destination directory before the source directory. It then installs and directory-syncs a fresh mode-`0700` work directory and mode-`0600` pending state bound to the new consent. Wrong or missing confirmation fails closed. It cannot reset a committed effect or an unresolved commit-pending effect; use exact-bound `verify` or stop for provider/database reconciliation.

### Recover a stale operation lock

Never remove or overwrite the lock manually. A five-minute-old lock may still belong to a live operation, so first stop and classify the operation. The recovery command requires the exact owner and creation time from the private lock record, refuses a lock before its fixed expiry, refuses a live PID, refuses changed proof, and permits recovery only during the bounded 24-hour post-expiry window:

```text
node dist/credential-admin/index.js ebay recover-stale-lock --owner <exact-owner> --created-at <exact-utc-time> --confirm recover-stale-ebay-credential-lock
```

Successful recovery atomically moves the mode-`0600` lock into the fixed lock archive and syncs the archive destination before the source directory; it does not delete evidence. Re-run `verify` after any post-commit lock recovery. If either directory sync fails, recovery returns mandatory reconciliation rather than claiming success. If the owner could still be live, the proof changed, or the recovery window closed, stop for manual reconciliation rather than unlocking.

To revoke only the exact new grant bound by the installation record:

```text
node dist/credential-admin/index.js ebay revoke-new-grant --confirm revoke-productpipeline-ebay-grant
```

This command introspects and revokes the bound refresh grant but does not change the ledger. The ledger will then point to revoked authority, so keep writers frozen and either execute the reviewed restore procedure or complete a fresh consent/install cycle. Repeating the command is value-free and returns `EBAY_GRANT_ALREADY_REVOKED` only after the provider reports the grant inactive.

If the revocation request or its confirmation is outcome-ambiguous, the command returns exit `5` with reconciliation required and leaves the installation evidence intact. Classify the grant directly with eBay before any subsequent cleanup; do not assume the provider mutation failed and do not repeat it blindly.

The fixed process exit classes are: `2` for argument/configuration/state/file denial, `3` for provider/revocation failure, `4` for database/binding failure, and `5` for mandatory cleanup or reconciliation. Failure output includes only fixed effect fields; it never includes a callback, authorization code, state, token, token digest, Cert, provider body, database value, backup name, lock proof, or path supplied by the operator.

## Official eBay references

- [Authorization code grant and user consent](https://developer.ebay.com/develop/guides-v2/authorization#the-authorization-code-grant-flow)
- [Token introspection and revocation](https://developer.ebay.com/develop/guides-v2/authorization#oauth-token-introspection-and-revocation)
- [Trading GetUser](https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetUser.html)
- [Inventory getInventoryItems](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/getInventoryItems)
