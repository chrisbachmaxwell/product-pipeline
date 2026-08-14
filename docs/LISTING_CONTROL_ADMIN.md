# Listing-Control Store Administration

This runbook governs the local-draft SQLite store only. It does not authorize an eBay/Shopify write, approval, publish, ownership transfer, Marketplace Connect change, or order action.

## Release state

PR #11 repair `bab71a5` merged to `main` as `789dc7782cea5da33a5fddd8617d1c364cbb783e`. Railway serves that repair on the existing one-replica `/data` deployment, the dedicated Production store remains verified, and the long-description listing-workspace incident is closed. This proves the observed read/mapping flow with the Edit control visible; no Save or provider write was exercised.

## Fixed Production scope and path

- Shopify store: `usedcameragear.myshopify.com`
- eBay environment/seller/marketplace: `production` / `usedcameragear` / `EBAY_US`
- Railway project: `f8c050c9-11c3-4611-8805-092289941aa4`
- Railway environment: `544d8896-b900-48ad-b42e-95272e1ad397`
- Railway service: `32ef14cc-2c85-447d-a890-53c422d81de1`
- Railway volume mount: `/data`
- Private parent: `/data/product-pipeline` with mode `0700`
- Database: `/data/product-pipeline/listing-control.sqlite` with mode `0600`
- Required configuration: `LISTING_CONTROL_DATABASE_PATH=/data/product-pipeline/listing-control.sqlite`
- Save-enable acknowledgement: `LISTING_CONTROL_SINGLE_WRITER_ACK=product-pipeline-local-draft-v1`

The acknowledgement is an operator assertion, not a lock or proof. Do not set it until the topology gate below passes.

## Verified Production initialization — 2026-08-14

- Topology: one ProductPipeline replica on the exact service above, using the `/data` persistent volume.
- Store: `/data/product-pipeline/listing-control.sqlite`, regular mode-`0600` file, canonical schema version 2, fixed Used Camera Gear scope, `local_draft_only`, admin `verify` successful, `externalWritesPerformed: 0`.
- Baseline backup: `/data/product-pipeline/backups/listing-control-initial-e0d59cd.sqlite`, regular mode-`0600` file, 114,688 bytes, admin `verify` successful.
- Backup SHA-256: `40c89f9e9beeac1ac36c33822ca59b3cc9057b99d062811b79cb00c6e88b4fc7`.
- Remote/provider effects: zero. Initialization and backup changed only the dedicated Railway volume.

Do not overwrite or reinitialize this Production path. All future administration follows the verification/backup gates below.

## Verified post-repair state — 2026-08-14

- Merge: PR #11 repair commit `bab71a5`, merged as `789dc7782cea5da33a5fddd8617d1c364cbb783e` at `2026-08-14T16:11:47Z`.
- Railway: deployment `623f7eca-74ae-4ff8-8bec-99a761767793` succeeded with one replica and the `/data` volume.
- Health: public `/health` served the exact merge at `2026-08-14T16:13:06.046Z` with shadow read-only mode, external writes false, and historical backfill false.
- Store: admin `verify` returned schema version 2, `local_draft_only`, and `externalWritesPerformed: 0`.
- Signed-in proof: Shopify variant `gid://shopify/ProductVariant/54881767358755`, SKU `APD0170A3B-OB`, and eBay listing `147232036779` opened complete Mapping, Listing, Content, and Delivery sections with a description summary and Edit control.
- Mutation boundary: no Save was clicked and no provider write occurred.

## Preconditions

Before initialization or every release that can save drafts:

1. Confirm the exact Railway project, environment, and ProductPipeline service.
2. Confirm exactly one application replica and one active deployment can mount the persistent volume. No worker, scheduler, one-off process, old service, or second region may open this database writable.
3. Confirm the volume is mounted at `/data` and will remain attached to this service. Railway services with a volume cannot use multiple simultaneous active deployments for that mount; still verify the actual replica/deployment state rather than treating platform behavior as proof.
4. Confirm the exact target and parent are not symlinks, hard links, shared writable paths, or aliases to the legacy application ledger.
5. Confirm there are no `-wal` or `-shm` sidecars and no pre-existing target before `init`.
6. Confirm a documented, restorable volume-backup procedure. Before the first Production draft is saved, take a baseline backup and verify restoration to a separate offline path with `verify`. Never copy a live open SQLite file as a backup.

The relevant Railway behavior is documented in [Volumes](https://docs.railway.com/volumes/reference) and [Deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

## One-time initialization

Initialization is an explicit administrative action after the reviewed build is deployed. Runtime startup never creates, migrates, repairs, or replaces the store.

```sh
umask 077
install -d -m 700 /data/product-pipeline
test ! -e /data/product-pipeline/listing-control.sqlite
LISTING_CONTROL_DATABASE_PATH=/data/product-pipeline/listing-control.sqlite \
  node dist/listing-control-admin/index.js init
LISTING_CONTROL_DATABASE_PATH=/data/product-pipeline/listing-control.sqlite \
  node dist/listing-control-admin/index.js verify
```

`init` requires an absent target and creates a fresh canonical version-2 store for the fixed Used Camera Gear scope. It must report only redacted `initialized`, schema version 2, local-draft-only mode, and zero external writes. `verify` requires an existing canonical version-2 store and must report the corresponding redacted verified result.

After verification, configure the two environment variables above only on the exact service. Restart/deploy deliberately, then verify health and the signed-in embedded draft surface separately. A successful build, admin command, or health response does not prove embedded UI behavior.

## Routine verification and fail-closed handling

Run the following before and after a deployment that changes listing-control code and after any volume restore:

```sh
LISTING_CONTROL_DATABASE_PATH=/data/product-pipeline/listing-control.sqlite \
  node dist/listing-control-admin/index.js verify
```

Stop local-draft saving and investigate if verification fails, the service topology is no longer single-writer, the mount/path changes, sidecars appear, permissions drift, or the store scope/schema is unexpected. Do not delete, replace, repair, auto-migrate, or initialize over an existing file. Preserve the file and credential-free error evidence for diagnosis.

| Operator symptom | Safe handling |
|---|---|
| **Listing facts changed; reopen the draft** | Reopen the item, review the new Shopify/eBay/current-draft facts, then prepare a new real change. Never force or replay the stale request. |
| **Local listing drafts are unavailable** | Keep provider writes stopped. Verify the exact version-2 store, fixed scope, absolute path, private parent, regular single-link `0600` file, no sidecars, and the real single-writer topology before restoring the acknowledgement. Never auto-initialize or repair an expected Production file. |
| **Listing is Unknown or Needs attention** | Wait for a successful complete refresh or resolve the exact mapping/identity exception before drafting; do not infer a match or current value. |
| **Request is invalid** | Save only a supported, substantive override that passes field/image limits. A no-op or inheritance-only first revision is intentionally refused. |
| **Access is not allowed** | Reload the exact embedded app in Shopify Admin and obtain a fresh verified session. API keys, test principals, copied URLs, or another store cannot authorize the append. |
| **Verified listing workspace is unavailable** | First distinguish store failure from listing-read parsing. Do not reinitialize the store or rotate credentials merely because a workspace read fails. Follow the handling and regression pattern in `docs/LISTING_WORKSPACE_INCIDENTS.md`; the `e0d59cd` long-description incident is a closed example. |

## Backup and restore gates

- Back up only through a provider-supported consistent volume backup or while every possible writer is stopped.
- Record the backup identity, source revision, UTC time, exact scoped database path, and a file digest without recording row content.
- Restore only to a separate private `0700` parent first; require a regular single-link `0600` file with no sidecars and run `verify` there.
- Never restore over the live target. A replacement/rollback procedure requires its own maintenance window, stopped writer, preserved prior file, exact-path review, post-restore verification, and signed-in UI verification.
- A backup restores local drafts only. It cannot restore or infer Shopify/eBay state and does not authorize retrying a provider action.

## Schema changes

Runtime accepts canonical schema version 2 only and never migrates it. Any future schema version needs a reviewed, explicit, failure-atomic administrative migration plus tamper, rollback, backup/restore, and no-provider-write tests. Do not expose a general upgrade command or silently reinterpret an old file.
