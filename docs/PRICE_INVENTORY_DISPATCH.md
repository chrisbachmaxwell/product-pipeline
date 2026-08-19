# Price and Inventory Alignment Dispatch (Marketplace Connect Replacement Slice)

The isolated `price-inventory-admin` CLI pushes the Shopify source price or
available quantity to exactly one eBay listing for exactly one SKU, one field
at a time, with a server-independent one-action, exact-target operator
approval at execution time, durable idempotent dispatch through the
migration-state store (schema v3), immediate post-action reconciliation, an
observation window, and a defined rollback path. Both listing management
models are covered: `inventory_offer` targets through one bounded
`bulk_update_price_quantity` call and `legacy_trading` targets through one
bounded `ReviseInventoryStatus` call.

**Building this slice authorizes no dispatch.** Every actual dispatch is a
separate operator decision executed through the ceremony below, and no
dispatch is possible at all until the ownership transfer ceremony has been
completed for the specific responsibility (`price` or `inventory`).

## The Marketplace Connect prerequisite — read this first

**Marketplace Connect currently owns price and inventory sync in production.
Two live writers must never coexist. Before running `establish-ownership`
for a responsibility, the operator MUST first uncheck the corresponding
Marketplace Connect setting — 'Sync price' for the `price` responsibility,
'Sync inventory' for the `inventory` responsibility — in the Marketplace
Connect app, verify the toggle is off, and record that proof. The
`--mc-disabled-evidence <sha256>` digest passed to `establish-ownership` is
the record of exactly that proof; supplying it without having disabled the
toggle falsifies the single-writer chain and recreates the dual-writer
hazard this entire migration exists to prevent.**

The migration store's schema v3 enforces the staged chain durably: a
production `price` or `inventory` ownership record must begin at the
truthful `marketplace_connect` incumbent genesis, may pause only through the
staged `marketplace_connect -> paused` transition, and may reach
`product_pipeline` only from `paused`. There is no transition that puts both
writers live at once, and dispatch is denied unless the current owner is
`product_pipeline` with verified single-writer evidence.

## Boundary

- The CLI is a standalone compiled entrypoint
  (`node dist/price-inventory-admin/index.js`). The server never imports or
  mounts it; no webhook, scheduler, or legacy sync path can reach it.
- Provider writes exist only in the two bounded dispatch adapters: exactly
  one `POST /sell/inventory/v1/bulk_update_price_quantity` with exactly ONE
  request entry for inventory-model targets, and exactly one
  `POST https://api.ebay.com/ws/api.dll` with call name
  `ReviseInventoryStatus` carrying exactly ONE `InventoryStatus` element for
  Trading-model targets — each dispatched only from inside a reserved
  migration-store job under a live 10-minute single-use approval.
- **Cross-field contamination is structurally impossible.** A price dispatch
  body is asserted (on the serialized form) to contain no quantity or
  availability key/element; a quantity dispatch body is asserted to contain
  no price key/element. A quantity dispatch on an inventory-model target
  updates the item's `shipToLocationAvailability.quantity` and the offer's
  `availableQuantity` together, in agreement, in the same single entry.
- One dispatch aligns one field on one exact target. `price` maps to the
  `price` responsibility and intent action `update_ebay_price`; `quantity`
  maps to the `inventory` responsibility and `update_ebay_inventory`. An
  established `price` ownership does not authorize a quantity dispatch, and
  vice versa.
- The dispatch token is a transient in-memory user token minted from the
  existing eBay refresh grant with the same scopes as the read path
  (inventory model: OAuth bearer; Trading model: IAF header); it is never
  persisted, logged, or returned.
- The migration store (schema v3) enforces durably: production intents for
  exactly the reviewed actions, a single-use exact-target approval, one job
  per intent, one dispatch attempt, and a resolution that must match a
  recorded `target_effect_observations` row for the same responsibility.
  See `docs/MIGRATION_STATE.md`.

## Prerequisites (once per responsibility)

1. A verified schema-v3 migration store for the exact production scope
   (`migration-admin init`, or `migration-admin upgrade` for an existing
   v1/v2 store, each with the exact `--confirm-scope` digest).
2. **The Marketplace Connect toggle for the responsibility is unchecked**
   ('Sync price' or 'Sync inventory'), the change is verified, and the proof
   is recorded and digested.
3. The ownership transfer ceremony:

   ```
   node dist/price-inventory-admin/index.js establish-ownership \
     --migration-store <path> \
     --confirm-scope <exact scope key> \
     --responsibility price|inventory \
     --baseline-evidence <sha256 of the reviewed Marketplace Connect incumbent baseline> \
     --mc-disabled-evidence <sha256 of the recorded toggle-off proof>
   ```

   With no existing chain this records the truthful v1
   `marketplace_connect` genesis (evidence = `--baseline-evidence`), then
   `marketplace_connect -> paused` and `paused -> product_pipeline` (both
   with evidence = `--mc-disabled-evidence`). With a partial chain it
   continues from the current state; an already-`product_pipeline` chain
   reports `already-established` and changes nothing. It transfers exactly
   the one named responsibility — price and inventory are separate
   ceremonies with separate toggle-off proofs.

## Dispatch ceremony (per action)

1. **Plan** — read-only: derive and review the exact drift and manifest:

   ```
   node dist/price-inventory-admin/index.js plan \
     --catalog-id <row id> --sku <sku> --listing-id <id> --offer-id <id> \
     --field price|quantity
   ```

   For a Trading-model target pass `--offer-id none` (and only for a
   Trading-model target — `none` never selects an inventory-managed
   listing). It prints the drift (current eBay observed value vs Shopify
   source value), the deterministic alignment manifest
   `{schemaVersion, scope, identity, field, before, after}`, and the
   **manifest digest**, then exits 2. It denies on any identity mismatch, an
   unmanaged or partially-bound target, a null or invalid source value
   (quantity must be a non-negative integer; price must be
   `{amount, currency}` with a positive decimal amount), and — critically —
   on `PLAN_NO_DRIFT` when the values already agree: no drift, no plan, no
   write.

2. **Dispatch** — the one action. Passing the exact target, the field, and
   the manifest digest from plan *is* the operator approval:

   ```
   node dist/price-inventory-admin/index.js dispatch \
     --catalog-id <row id> --sku <sku> --listing-id <id> --offer-id <id> \
     --field price|quantity --manifest-digest <sha256> \
     --migration-store <path>
   ```

   One invocation performs: a fresh re-plan (a digest mismatch means the
   drift moved since plan — `REALIGN_MANIFEST_DIGEST_MISMATCH`, re-plan and
   review again), the ownership precheck
   (`REALIGN_OWNERSHIP_NOT_ESTABLISHED` unless the mapped responsibility is
   currently `product_pipeline` single-writer), intent creation (idempotent —
   the same manifest can never dispatch twice), approval issue + consume,
   job reservation, the dispatching/attempt record, exactly ONE bounded
   provider call for the target's management model, the
   reconciliation-required record, an immediate post-action verification
   read, the reconciliation run + durable target-effect observation, and
   (when the aligned value is observed) the terminal resolution. The output
   includes the job id, attempt id, effect, and resolution.

3. **Observation window** — during the following hours, re-run `plan`
   (expect `PLAN_NO_DRIFT`, which now proves the aligned value is the
   observed state) or view the item in the Listings workspace.

## Outcomes and recovery

- `dispatched-and-reconciled` / `resolved_existing`: the aligned value is
  verified on the target. Done.
- Provider dispatch failed (`providerDispatchReported: false`) with
  `confirmed_missing`: nothing changed remotely; the intent is spent. To
  retry, run a fresh `plan` (the still-present drift yields the same or a
  new digest as the values stand at that moment; if the digest is identical
  the intent uniqueness layer denies the replay — wait for the drift to
  move or investigate) and run a new ceremony.
- `dispatched-unresolved` with the effect not yet observed: the job stays
  in `reconciliation_required`. Re-run reconciliation later:

  ```
  node dist/price-inventory-admin/index.js reconcile \
    --catalog-id … --sku … --listing-id … --offer-id … --field … \
    --manifest-digest <sha256> --before <exact before value|none> \
    --after <exact after value> --migration-store <path> \
    --job-id <id> --attempt-id <id>
  ```

  `--before`/`--after` must reproduce the exact dispatched manifest digest
  (both values are printed by `plan`), which binds the re-verification to
  the dispatched action byte-for-byte. A still-absent effect never
  auto-terminalizes (propagation delay must not fabricate a
  `confirmed_missing`); after the observation window the operator may pass
  `--accept-absent` to record that terminal outcome explicitly.

- **Rollback**: the manifest embeds the exact before-value. To roll back,
  restore the value in Shopify (making the old value the new source), run a
  fresh `plan`, and dispatch a new full ceremony. Rollback is a first-class
  dispatch with its own approval, never an automatic or implicit action.
  Alternatively, ownership can be staged back to `paused` (break-glass) and
  the Marketplace Connect toggle re-enabled — but only after ProductPipeline
  is paused, never while both could write.
- **Break-glass**: stop running the CLI. No schedule, webhook, or server
  path can dispatch; with no operator invocation there are zero writes. To
  hand the responsibility back durably, record `product_pipeline -> paused`
  and only then re-enable the Marketplace Connect toggle.

## What this slice does not do

**Continuous or automatic price/inventory sync is not part of this slice.**
It is a separate future slice gated on canary evidence accumulated through
these exact-target, one-action-at-a-time ceremonies. This slice also has no
listing create/revise/end/relist path, no order path, no bulk or wildcard
targets, no automatic retry, no Marketplace Connect settings mutation, and
no UI surface. Each of those remains a separately gated future slice.
