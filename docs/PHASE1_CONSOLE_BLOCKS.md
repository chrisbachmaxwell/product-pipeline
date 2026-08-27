# Phase 1 — Operator Console Blocks (no-SSH path)

Prepared 2026-08-27 by the delegated agent session after Railway SSH was
re-confirmed unreachable from the remote agent environment (Brain L36, L37).
The operator pastes these blocks into the Railway dashboard **Console** for the
`product-pipeline` production service.

> **Read Brain L38 first.** Raising the cloud environment's network access to
> **Full** does *not* unblock SSH and is not a fix — the access levels control
> which *domains* are reachable, not which *ports*, and all Anthropic-hosted
> egress goes through an HTTPS proxy that carries no raw TCP. The Default
> environment is already `Full` and `ssh.railway.com:22` still times out. The
> alternatives to this document are running Claude Code **locally in a
> terminal** (its own network; `claude --teleport <session-id>` carries an
> existing cloud session over) or a **self-hosted environment**.

Nothing here has been executed. Every block is a provider-write ceremony or a
read; run them **in order** and stop at the first unexpected output.

**Working directory for every block: `/app`.**

Canonical store path (Brain §16 and `config/migration-state.production.json`):

```
/data/migration-state/product-pipeline-migration-v1.sqlite
```

> Note: `docs/ORDER_IMPORT.md` line 61 shows a stale example path
> (`/data/product-pipeline/migration-state.sqlite`). The canonical path above
> is the one in the production config — use it.

---

## Step 1 — Off-volume backup (do this first, retain until Step 2 verifies)

The backup must leave the volume. Print it and save the output locally:

```bash
cd /app
ls -l /data/migration-state/
sha256sum /data/migration-state/product-pipeline-migration-v1.sqlite
```

Then stream a copy off-volume (paste output into a local file, or use the
G20 snapshot tooling if you prefer):

```bash
cd /app
base64 -w0 /data/migration-state/product-pipeline-migration-v1.sqlite
```

Retain that copy and its sha256 until Step 2's final `verify` passes.
Per `docs/MIGRATION_ADMIN.md`: stop all ceremony commands before upgrading,
and never restore a pre-order-cutover backup after real order imports begin.

---

## Step 2 — Schema upgrade v4 → v5 (exact scope digest)

```bash
cd /app
node dist/migration-admin/index.js verify \
  --repo-root /app \
  --config config/migration-state.production.json \
  --json
```

**Expected:** fails closed with `SCHEMA_MISMATCH` (the deployed code requires
v5; the store is v4). That expected mismatch is *not* permission to skip the
backup or the exact-scope confirmation.

Now upgrade. Replace `<fresh-canonical-UTC>` with a fresh timestamp in the
exact form `2026-08-27T21:30:00.000Z`:

```bash
cd /app
node dist/migration-admin/index.js upgrade \
  --repo-root /app \
  --config config/migration-state.production.json \
  --applied-at '<fresh-canonical-UTC>' \
  --confirm-scope sha256:f1f798163d3f7c7042825d998c9f2b6f3f0ad5f75794a9d12dd887daa7e8f54c \
  --json
```

Then re-verify:

```bash
cd /app
node dist/migration-admin/index.js verify \
  --repo-root /app \
  --config config/migration-state.production.json \
  --json
```

**Gate:** the final `verify` must report the current schema (v5), a valid
audit chain, and zero external writes before anything below runs.

---

## Step 3 — `recover-create` for orphaned offer 247267392011

All nine required arguments are now **resolved and verified** (L39). They were
recovered from the off-volume backup, not from lost console output:

| Flag | Value | Source |
| --- | --- | --- |
| `--job-id` | `listing-create-job:ec897152-ad2c-43f9-8d8c-a6942503bfa1` | Brain §16 / L34 |
| `--attempt-id` | `listing-create-attempt:214fc4fe-79c3-416e-ad16-9a2c81117285` | Brain §16 / L34 |
| `--evidence-digest` | `sha256:567bacafad0421ff0545a70fe35b7a3104b38828704f4959342f8d81bc059dbc` | Draft 5 manifest |
| `--offer-id` | `247267392011` | recorded `CREATE_OFFER_UNPUBLISHED` evidence |
| `--intent-key` | `sha256:d81338dee6bac3f8e75600df44e6424ae97f257a16a20ac6aedb04e80da4b675` | `intent_attempts` in the backup |
| `--sku` | `PIPELINE-TEST-20260826` | `external_identities` `ebay-inventory-sku:` binding |
| `--catalog-id` | `shopify-variant:gid://shopify/ProductVariant/55519196250403` | `live-listing-catalog.ts:425` id form |
| `--confirm-scope` | `sha256:f1f798163d3f7c7042825d998c9f2b6f3f0ad5f75794a9d12dd887daa7e8f54c` | production scope key |
| `--migration-store` | `/data/migration-state/product-pipeline-migration-v1.sqlite` | production config |

Run from `/app`:

```bash
cd /app
node dist/listing-lifecycle-admin/index.js recover-create \
  --migration-store /data/migration-state/product-pipeline-migration-v1.sqlite \
  --confirm-scope sha256:f1f798163d3f7c7042825d998c9f2b6f3f0ad5f75794a9d12dd887daa7e8f54c \
  --catalog-id 'shopify-variant:gid://shopify/ProductVariant/55519196250403' \
  --sku PIPELINE-TEST-20260826 \
  --job-id listing-create-job:ec897152-ad2c-43f9-8d8c-a6942503bfa1 \
  --attempt-id listing-create-attempt:214fc4fe-79c3-416e-ad16-9a2c81117285 \
  --intent-key sha256:d81338dee6bac3f8e75600df44e6424ae97f257a16a20ac6aedb04e80da4b675 \
  --evidence-digest sha256:567bacafad0421ff0545a70fe35b7a3104b38828704f4959342f8d81bc059dbc \
  --offer-id 247267392011
```

**Success prints** `recovered-and-reconciled` with two `resolved_residue_removed`
resolutions (recovery job + original job).

Do **not** redispatch the original create, do **not** pass `--accept-absent`
while the artifact exists, and do **not** point the Sandbox recovery CLI at
Production.

### If it does not cleanly succeed

- Deletes succeeded but capture still shows residue
  (`RECOVER_RESIDUE_STILL_PRESENT`) or was ambiguous — re-run later, zero writes:

  ```bash
  cd /app
  node dist/listing-lifecycle-admin/index.js recover-reconcile \
    <the exact same nine flags> \
    --recovery-job-id <id printed by recover-create> \
    --recovery-attempt-id <id printed by recover-create>
  ```

- A provider DELETE failed — the recovery job stays unresolved and its intent
  can never replay (`RECOVER_INTENT_ALREADY_RECORDED`). The reviewed retry is a
  chained ceremony: re-run `recover-create` with the same nine flags plus
  `--prior-recovery-job-id` / `--prior-recovery-attempt-id` naming the failed
  recovery job/attempt.
- `RECOVER_OFFER_PUBLISHED` means a listing exists — the ceremony refuses.
  Stop and reassess.
- `RECOVER_STATE_MISMATCH` is also the idempotent denial *after* success.

---

## Step 4 — Fresh create proof on a genuine low-stakes not-listed SKU

Target selection (Brain L34, eBay Production test-listing policy): use a
**genuine low-stakes physical item**, or eBay's designated Production
test-listing category. A "TEST / DO NOT BUY" listing must never go in a normal
camera category. The target must be clean and not-listed — any existing
listing, offer, inventory item, or unpublished artifact denies as
`CREATE_TARGET_ALREADY_LISTED`.

Omit the operational-test condition description (that is what invalidated
Drafts 1–4). `conditionDescription` may describe only the item's physical
condition.

**4a. Preflight** — review the manifest, capture the printed manifest digest:

```bash
cd /app
node dist/listing-lifecycle-admin/index.js preflight-create \
  --catalog-id <row id> --sku <sku> --revision-digest <sha256> \
  --description-template ucg-branded-v1
```

**4b. Dispatch** — the one action. The exact target plus the preflight manifest
digest *is* the operator approval. The template flag must exactly match 4a:

```bash
cd /app
node dist/listing-lifecycle-admin/index.js dispatch-create \
  --catalog-id <row id> --sku <sku> --revision-digest <sha256> \
  --description-template ucg-branded-v1 \
  --manifest-digest <sha256 from 4a> \
  --migration-store /data/migration-state/product-pipeline-migration-v1.sqlite
```

Record the printed job id, attempt id, **intentKey**, manifest digest,
`offerId`, and `listingId`. (Save the intentKey this time — Step 3 shows what
happens when it is lost.)

If it fails: only a `put_inventory_item` failure classified
`definite_no_effect` plus a fresh absent capture yields
`dispatch-failed-confirmed-missing`. Anything else (timeout, 5xx, abort,
ambiguous response) stays `dispatched-unresolved` — do not redispatch.

---

## Step 5 — Confirm G10 listing 147232036779 still MC-synced

Read-only. Confirm on ebay.com that listing `147232036779` (Aputure, variant
`54881767358755`) still shows the Marketplace-Connect-synced values:

- price `$164.95`
- quantity `5`
- the live `ucg-branded-v1` description still byte-identical to the approved
  10,144-byte HTML

This is the 24-hour MC-behavior observation from the Phase 1 checklist. No
ceremony, no command — public listing view plus (optionally) a raw `GetItem`.

---

## Step 6 — Shadow-poll into /data/shadow-reports

Create the service-owned private directory once:

```bash
cd /app
install -d -m 700 /data/shadow-reports
```

Then run an exact 24-hour poll to a **fresh** filename (the monitoring reader
denies non-absolute or non-service-owned directories, and will not overwrite):

```bash
cd /app
node dist/order-import-admin/index.js shadow-poll \
  --max-orders 50 \
  --lookback-hours 24 \
  --report-file /data/shadow-reports/shadow-report-2026-08-27.json
```

Read-only; needs no ceremony. Target for the clean-day count:
`unmatchedCount: 0` and `blockedCount: 0` after MC's normal import delay.
Pre-fix reports do not count. Investigate any persistent unmatched order
before starting the 7–14 consecutive clean-day count.

---

## What must NOT be done

- Never import or backfill historical orders (Brain §17 L11).
- Never re-attempt the deploy-transport / start-command runner channel
  (Brain L36) — it was correctly refused.
- Never redispatch the original G16 create or pass `--accept-absent`.
- Never run two writers for one responsibility; MC stays on for price,
  inventory, and orders through all of Phase 1.
