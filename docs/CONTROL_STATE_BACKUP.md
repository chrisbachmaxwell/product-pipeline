# Control-state backups and restore rehearsals

`control-state-backup-admin` is a standalone, offline filesystem tool for G20. It snapshots the
legacy app database, listing-control database, migration-state database, and PII-free shadow
reports. It has no provider, credential, server, webhook, scheduler, ownership, order-import, or
commerce-write adapter. Deploying it does nothing.

The destination must already be a private mode-`0700` directory on a different filesystem device
from the source volume. A sibling directory on `/data` is rejected even if it is named `backups`;
that directory would disappear with the volume. Configure a second mounted volume or an
operator-controlled encrypted filesystem whose lifecycle is independent of `/data`. ProductPipeline
does not provision, upload to, retain, or rotate that storage.

## Prepare the exact scope

Copy `config/control-state-backup.example.json` to an ignored mode-`0600` file outside the
repository, replace every placeholder with an absolute normalized path, and keep the four source
paths beneath the exact source-volume root. The current Production source paths are:

- `/data/ebaysync.db`
- `/data/product-pipeline/listing-control.sqlite`
- `/data/migration-state/product-pipeline-migration-v1.sqlite`
- `/data/shadow-reports`

All sources must exist, be regular/private files or a private directory, and contain no symlink or
hard-link substitution. Shadow reports are restricted to bounded top-level JSON files. Database
contents and report bodies are never printed or copied into the repository.

## Snapshot

Run from the reviewed compiled image. First preview the stable config digest; preview writes
nothing:

```sh
node dist/control-state-backup-admin/index.js preview \
  --config /operator/control-state-backup.json \
  --created-at 2026-08-26T20:00:00.000Z
```

After checking the exact roots and digest, run one snapshot with the same canonical UTC instant and
digest:

```sh
node dist/control-state-backup-admin/index.js snapshot \
  --config /operator/control-state-backup.json \
  --created-at 2026-08-26T20:00:00.000Z \
  --confirm-digest sha256:<reviewed-config-digest>
```

The tool creates a new timestamped mode-`0700` directory and never overwrites one. SQLite's online
backup API captures committed state consistently, including committed WAL content, without copying
sidecars. Every artifact is mode `0600`; a deterministic manifest binds logical names, relative
paths, sizes, and SHA-256 digests. It then verifies each SQLite `quick_check`. If a run fails, its
new directory is incomplete and has no trustworthy completion claim; retain it for diagnosis or
move it aside manually. Do not point a later run at the same timestamp.

Verify any completed snapshot independently:

```sh
node dist/control-state-backup-admin/index.js verify \
  --snapshot /off-volume/product-pipeline/snapshot-2026-08-26T20-00-00-000Z
```

For scheduling, configure the infrastructure scheduler outside this repository to invoke exactly
one `snapshot` command with a fresh canonical UTC instant and the pinned reviewed config digest.
The schedule must target the separate mounted destination, alert on every nonzero exit, and apply
an operator-owned retention policy. There is intentionally no in-process timer and no automatic
execution on deploy. Production scheduling remains an operator action and is not proven by source.

## Restore rehearsal only

Rehearsal copies a verified snapshot into a new path beneath an existing private parent. The target
must not exist; no overwrite, swap, delete, `/data` replacement, or live restore exists:

```sh
mkdir -m 700 /rehearsal/product-pipeline
node dist/control-state-backup-admin/index.js rehearse-restore \
  --snapshot /off-volume/product-pipeline/snapshot-2026-08-26T20-00-00-000Z \
  --destination /rehearsal/product-pipeline/rehearsal-2026-08-26
```

Success means the restored file set exactly matches the manifest, all digests match, and every
SQLite database passes `quick_check`. It does not mutate or prove the live application. After a
separately authorized volume recovery, operators must still run the listing-control admin verify,
migration-admin verify (including its hash-chained audit), application health/DB-backed reads, and
order safety checks before any writer can resume. Never restore an older migration store over a
store that may contain a newer permanent order watermark, order links, idempotency state, approvals,
attempts, or reconciliation evidence.
