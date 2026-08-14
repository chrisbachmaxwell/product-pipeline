# Credential Maintenance Incidents

This log contains no credential values, suffixes, callback material, provider response bodies, or database-row contents. A source candidate, passing test, or fixed output code is not evidence that provider or Production state changed.

## ECM-2026-08-14-001 — eBay Production rotation safety gap

Status: open; prevention source candidate only.

Trigger: ProductPipeline needed a bounded way to reset its Production eBay Cert, obtain fresh seller consent, validate the replacement grant, and replace only its eBay ledger authority. The repository had mounted read-only refresh behavior and quarantined legacy authentication paths, but no fixed-purpose maintenance boundary with one-use state, exact seller/scope validation, pre-effect backup, compare-and-swap installation, or deterministic cleanup.

Observed impact in this implementation slice:

- No eBay, Shopify, Marketplace Connect, Railway, or other provider request was made.
- No live database, credential, environment variable, deployment, application route, writer, order, listing, price, or inventory state changed.
- The live validity of the old grant and Cert remains unknown here. Human provider closure and a separately authorized maintenance window are still required.

Prevention candidate:

- Standalone direct-Node `credential-admin ebay` family with a compiled Railway identity and filesystem boundary. The npm argument-forwarding wrapper is absent because npm can print raw appended arguments before parser redaction. The shared compiled dispatcher selects only the literal provider family, keeps Shopify/eBay implementation modules separate, and refuses eBay Railway work while Shopify's rotation acknowledgement or temporary refresh-token variable is present.
- Local-only raw consent state plus digest-only Railway registration, 15-minute expiry, one-use consumption, and no-echo callback input.
- Exact Production base-plus-`sell.inventory` scope set, exact app/audience introspection, strict Trading `GetUser` seller `usedcameragear`, Site ID `0`, and read-only Inventory proof. Commerce Identity and broader scopes are denied.
- Exact `auth_tokens` DDL/index/trigger checks and mode/link checks, verified private backup before code exchange, full-row baseline, one `BEGIN IMMEDIATE` CAS upsert without delete-first, unrelated-row preservation, integrity checks, and read-back.
- Credential-free, domain-separated access- and refresh-token digests are durably recorded before the ledger CAS. Stored-access-token verification and new-grant revocation require the exact row ID, timestamp, scope, and both token digests, without minting or changing the database.
- Every new/replaced private record is file-synced and parent-directory-synced. The digest-bearing `commit-pending` record is durable before SQLite CAS begins; a directory-sync failure prevents CAS and revokes the unused grant. After a crash immediately following COMMIT, `verify` can promote only an exact timestamp/scope/token-digest match and durably records the recovered row binding.
- Ambiguous and failed pre-commit evidence is terminal. A separately confirmed provider-reconciliation command preserves the entire old private work directory in an evidence archive and creates a fresh private pending state; it never deletes evidence or resets a committed database effect. A COMMIT-error state is resettable only after provider reconciliation and proof that the fixed ledger exactly matches its named private pre-install backup.
- A COMMIT call error is classified only after closing SQLite and is never treated as proof of rollback: exact installed row means known one-row effect, exact backup baseline means known zero-row effect, and unreadable/mismatched state means unknown database effect. Every outcome preserves token-digest evidence, reports provider mutation and mandatory reconciliation, and forbids automatic revoke or replay. Exact-bound `verify` reconciles committed state; the confirmed archive/reset path handles only an exact recovered baseline.
- Post-commit state or lock failure returns mandatory cleanup/reconciliation with the known one-row database effect and provider mutation. Evidence and stale-lock renames sync the target directory before the source; stale locks also require exact owner/time proof, fixed expiry, dead-owner proof, a bounded recovery window, and archival rather than deletion.
- Adversarial regressions for missing/extra scope, wrong seller, replay, token swap with unchanged row ID/timestamp/scope, pre-CAS directory-sync failure, post-COMMIT crash recovery, COMMIT error after durable apply, exact-baseline and unknown COMMIT classification, target-first evidence/lock archive sync, exchange ambiguity, explicit reconciliation reset, post-commit state failure, live/stale lock recovery, hostile XML, streamed response overflow, schema/trigger drift, concurrent ledger drift, exact Railway identity, path/secret arguments, and runtime/source isolation.

Closure requirements:

1. Independent review finds no blocking defect and all repository checks pass from a clean worktree.
2. The reviewed revision is intentionally committed, deployed to the exact service, and independently matched to runtime.
3. A human revokes the prior seller consent before the old Cert is reset, then stores the new Cert without disclosure.
4. One new consent/install/verify cycle succeeds against exact seller `usedcameragear`; the mounted read catalog is updated to the new Cert and observed read-only.
5. Provider state, private backup, ledger binding, public health quarantine, signed-in listing reads, and removal of temporary maintenance authority are reconciled without enabling a commerce writer.

Runbook: `docs/EBAY_CREDENTIAL_ROTATION.md`.
