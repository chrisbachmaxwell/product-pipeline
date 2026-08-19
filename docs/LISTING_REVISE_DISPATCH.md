# Listing-Revise Dispatch (Goal G4 Slice)

The isolated `listing-revise-admin` CLI takes exactly one approved local draft
revision to eBay for exactly one SKU, with a server-independent one-action,
exact-target operator approval at execution time, durable idempotent dispatch
through the migration-state store, immediate post-action reconciliation, an
observation window, and a defined rollback path.

**Building this slice authorizes no dispatch.** Every actual dispatch is a
separate operator decision executed through the ceremony below. The slice
covers `inventory_offer`-managed listings only; legacy Trading-managed
listings are structurally rejected (see
`docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md`). Price, quantity, order, and
Marketplace Connect state are never written: price/quantity are preserved
byte-for-byte and any drift in them makes the draft stale and denies
dispatch.

## Boundary

- The CLI is a standalone compiled entrypoint
  (`node dist/listing-revise-admin/index.js`). The server never imports or
  mounts it; the web workspace keeps `apply: false, publish: false`.
- Provider writes exist only in the bounded dispatch adapter: exactly
  `PUT /sell/inventory/v1/inventory_item/{sku}` and
  `PUT /sell/inventory/v1/offer/{offerId}` on `api.ebay.com`, dispatched only
  from inside a reserved migration-store job under a live approval.
- Dispatchable fields: title, condition description, description, images,
  category, fulfillment/payment/return policy, merchant location.
  `condition` is excluded until its enum mapping passes review; price,
  quantity, item specifics, and identifiers are never dispatchable.
- The dispatch token is a transient in-memory user token minted from the
  existing eBay refresh grant with the same two scopes as the read path; it
  is never persisted, logged, or returned.
- The migration store (schema v2) enforces durably: production intents for
  `revise_ebay_listing` only, a single-use exact-target approval expiring in
  at most 15 minutes, one job per intent, one dispatch attempt, and a
  resolution that must match a recorded post-dispatch target observation.
  See `docs/MIGRATION_STATE.md`.

## Prerequisites (once)

1. A verified schema-v2 migration store for the exact production scope
   (`migration-admin init`, or `migration-admin upgrade` for an existing v1
   store, each with the exact `--confirm-scope` digest).
2. The listingRevise ownership chain:
   `listing-revise-admin establish-ownership --migration-store <path>
   --confirm-scope <exact scope key> --evidence-digest <sha256 of the
   reviewed single-writer evidence>`. This records `paused` genesis and the
   `product_pipeline` transfer for **listingRevise only** — it transfers no
   price, inventory, or order ownership, which remain Marketplace Connect's.
3. An approved local draft revision saved through the workspace
   (`POST /api/listing-draft`), and its exact revision digest.
4. G3 proof (the draft save path exercise) recorded.

## Dispatch ceremony (per action)

1. **Preflight** — derive and review the exact manifest:

   ```
   node dist/listing-revise-admin/index.js preflight \
     --catalog-id <row id> --sku <sku> --listing-id <id> --offer-id <id> \
     --revision-digest <sha256>
   ```

   It prints the field-level change set (before/after previews), the
   preserved price/quantity, and the **manifest digest**. It denies on any
   identity mismatch, non-inventory management model, unsupported field,
   or remote drift since the draft was saved (`REVISE_BASE_STALE` —
   reopen and re-save the draft).

2. **Dispatch** — the one action. Passing the exact target plus the manifest
   digest from preflight *is* the operator approval:

   ```
   node dist/listing-revise-admin/index.js dispatch \
     --catalog-id <row id> --sku <sku> --listing-id <id> --offer-id <id> \
     --revision-digest <sha256> --manifest-digest <sha256> \
     --migration-store <path>
   ```

   One invocation performs: fresh re-preflight, intent creation (idempotent —
   the same manifest can never dispatch twice), approval issue + consume, job
   reservation, raw resource round-trip with binding and price/quantity
   preservation assertions, the dispatching/attempt record, at most two
   bounded PUTs, the reconciliation-required record, an immediate
   post-action verification read, the reconciliation run + target
   observation, and (when the revised state is observed) the terminal
   resolution. The output includes the job id, attempt id, effect, and
   resolution.

3. **Observation window** — during the following hours, re-run `preflight`
   (expect `REVISE_BASE_STALE`, which now proves the revised state is the
   observed base) or view the item in the Listings workspace, and confirm
   Marketplace Connect price/inventory sync still behaves normally on the
   target listing.

## Outcomes and recovery

- `dispatched-and-reconciled` / `resolved_existing`: the revise is verified
  on the target. Done.
- Provider dispatch failed (`providerDispatchReported: false`) with
  `confirmed_missing`: nothing changed remotely; the intent is spent. To
  retry, save a **fresh** draft revision (new revision digest → new manifest
  digest) and run a new ceremony.
- `dispatched-unresolved` with effect not yet observed: the job stays in
  `reconciliation_required`. Re-run reconciliation later:

  ```
  node dist/listing-revise-admin/index.js reconcile \
    --catalog-id … --sku … --listing-id … --offer-id … \
    --revision-digest <sha256> --migration-store <path> \
    --job-id <id> --attempt-id <id>
  ```

  A still-absent effect never auto-terminalizes (propagation delay must not
  fabricate a `confirmed_missing`); after the observation window the
  operator may pass `--accept-absent` to record that terminal outcome
  explicitly. A `PARTIAL_REVISE_STATE` critical exception means some but not
  all fields landed — investigate before any further action.

- **Rollback**: the manifest embeds the exact before-values of every changed
  field. To roll back, save a draft revision restoring those values and run
  a new full ceremony for it. Rollback is a first-class dispatch with its own
  approval, never an automatic or implicit action.
- **Break-glass**: stop running the CLI. No schedule, webhook, or server
  path can dispatch; with no operator invocation there are zero writes.

## What this slice does not do

No listing create/end/relist, no price or inventory write, no order path, no
Marketplace Connect change, no Trading-model revise, no bulk or wildcard
targets, no automatic retry, and no UI Apply/Publish. Each of those remains
a separately gated future slice.
