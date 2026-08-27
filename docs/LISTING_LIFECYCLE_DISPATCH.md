# Listing-Lifecycle Dispatch (Create and End Slice)

The isolated `listing-lifecycle-admin` CLI performs exactly one listing
CREATE (publish a new eBay listing from an approved local draft of a
not-listed Shopify item, Inventory/Offer model — the pattern proven by the
CAN3570-U119 canary) or exactly one listing END (end an active listing,
either management model), with a server-independent one-action, exact-target
operator approval at execution time, durable idempotent dispatch through the
migration-state store (schema v4), immediate post-action reconciliation, an
observation window, and a defined recovery path.

**Building this slice authorizes no dispatch.** Every actual dispatch is a
separate operator decision executed through the ceremonies below. Price and
inventory ownership never move: a create takes its initial price and quantity
from the draft revision's Shopify source values (a new listing needs them and
Marketplace Connect has no claim on a listing it never knew), and after
publish those responsibilities remain with the incumbent exactly as for every
other listing. **Relist is not a separate code path**: relisting an ended
item is a re-run of the create ceremony once the item is a clean not-listed
workspace row.

## Boundary

- The CLI is a standalone compiled entrypoint
  (`node dist/listing-lifecycle-admin/index.js`). The server never imports or
  mounts it; the web workspace keeps `apply: false, publish: false`.
- Provider writes exist only in the bounded dispatch adapters:
  - create: exactly `PUT /sell/inventory/v1/inventory_item/{sku}`,
    `POST /sell/inventory/v1/offer`, and
    `POST /sell/inventory/v1/offer/{offerId}/publish` on `api.ebay.com`;
  - end (inventory model): exactly
    `POST /sell/inventory/v1/offer/{offerId}/withdraw`;
  - end (trading model): exactly one `POST https://api.ebay.com/ws/api.dll`
    with call name `EndFixedPriceItem`, carrying only the ItemID and the
    fixed `EndingReason` `NotAvailable`, structurally asserted to contain no
    StartPrice or Quantity element.
  Each is dispatched only from inside a reserved migration-store job under a
  live approval. Requests/responses are bounded (2 MB / 20 s), redirects are
  errors, and failures are fixed redacted codes.
- The dispatch token is the same transient in-memory user token as the
  listing-revise slice, minted from the existing eBay refresh grant
  (`sell.inventory` covers all inventory calls; the Trading call uses the IAF
  header); it is never persisted, logged, or returned.
- The migration store (schema v4) enforces durably: production intents for
  `create_ebay_listing` and `end_or_relist_ebay_listing`, Class-A
  paused-genesis ownership chains for `listingCreate` and `listingEndRelist`,
  a single-use exact-target approval expiring in at most 10 minutes, one job
  per intent, one dispatch attempt, and a resolution that must match a
  recorded `target_effect_observations` row. See `docs/MIGRATION_STATE.md`.
- Required-or-deny create fields: title, category, condition, description, canonical
  item-specifics JSON, price,
  quantity ≥ 1, all three policy IDs, merchant location, and at least one
  image (`CREATE_REQUIRED_FIELD_MISSING` names the field; values stay
  redacted). The draft's numeric eBay condition ID maps through a fixed
  table (1000→NEW … 7000→FOR_PARTS_OR_NOT_WORKING); any other value is
  `CREATE_CONDITION_UNSUPPORTED`.

## Prerequisites (once)

1. A verified schema-v4 migration store for the exact production scope
   (`migration-admin init`, or `migration-admin upgrade` for an existing
   v1/v2 store, each with the exact `--confirm-scope` digest).
2. The ownership chain for each lifecycle responsibility you will use:

   ```
   node dist/listing-lifecycle-admin/index.js establish-ownership \
     --migration-store <path> --confirm-scope <exact scope key> \
     --evidence-digest <sha256 of the reviewed single-writer evidence> \
     --responsibility listingCreate   # and/or listingEndRelist
   ```

   This records the `paused` genesis and the `product_pipeline` transfer for
   that responsibility only — it transfers no price, inventory, or order
   ownership, which remain Marketplace Connect's.
3. For a create: an approved local draft revision saved through the
   workspace (`POST /api/listing-draft`) for the not-listed item, and its
   exact revision digest. An end needs no draft revision.

## Create ceremony (per action)

1. **Preflight** — derive and review the exact manifest:

   ```
   node dist/listing-lifecycle-admin/index.js preflight-create \
     --catalog-id <row id> --sku <sku> --revision-digest <sha256> \
     --description-template ucg-branded-v1
   ```

   The target must be a clean not-listed item: any eBay listing, offer,
   inventory item, or unpublished artifact denies as
   `CREATE_TARGET_ALREADY_LISTED`. The manifest derives from the revision
   alone — every proposed field value, the mapped condition enum, reviewed
   item specifics, fixed `GTC` duration, and the
   Shopify-sourced initial price/quantity — and any Shopify or eBay drift
   since the draft was saved denies as `CREATE_BASE_STALE` (reopen and
   re-save the draft). It prints the manifest summary and the
   **manifest digest**. `--description-template ucg-branded-v1` is the only
   supported template and is opt-in. Manifest schema v2 separately binds the
   exact approved base description (required and at most 4,000 characters) for
   `InventoryItem.product.description` and the complete buyer-facing description
   for `Offer.listingDescription`. The template changes only the latter; it is
   never truncated or copied into the smaller Inventory field. The offer
   description is required, nonempty, and bounded at 500,000 characters. The
   same v2 manifest also binds the approved `product.aspects` object and
   `listingDuration: GTC`. These fields follow eBay's documented publish
   prerequisites: https://developer.ebay.com/api-docs/sell/static/inventory/publishing-offers.html

2. **Dispatch** — the one action. Passing the exact target plus the manifest
   digest from preflight *is* the operator approval:

   ```
   node dist/listing-lifecycle-admin/index.js dispatch-create \
     --catalog-id <row id> --sku <sku> --revision-digest <sha256> \
     --description-template ucg-branded-v1 \
     --manifest-digest <sha256> --migration-store <path>
   ```

   One invocation performs: fresh re-preflight, intent creation (idempotent —
   the same manifest can never dispatch twice), approval issue + consume, job
   reservation, the bounded provider sequence (inventory-item PUT → offer
   POST → publish POST, capturing the returned `offerId` and `listingId`),
   the dispatching/attempt record, the reconciliation-required record, an
   immediate post-action verification read (a fresh workspace capture), the
   reconciliation run + target-effect observation, and (when the new listing
   is visible and bound) the terminal resolution. The output includes the
   job id, attempt id, intent key, manifest digest, offerId, and listingId.
   A provider failure prints only fixed `dispatchFailureStage` and
   `dispatchFailureCode` values. If a failed first write is freshly proven absent,
   status is `dispatch-failed-confirmed-missing`; no provider body, URL, token, or
   exception text is returned, and the terminal intent cannot be replayed.
   The template flag must exactly match the preflight that produced the
   manifest digest. Reconciliation compares the fresh provider's raw
   description HTML byte-for-byte, allowing only CRLF/CR-to-LF normalization;
   missing or altered markup stays unresolved.

3. **Observation window** — during the following hours, view the item in the
   Listings workspace (expect an active listing bound to the returned
   listingId) and confirm Marketplace Connect price/inventory sync behaves
   normally on the new listing.

## End ceremony (per action)

1. **Preflight**:

   ```
   node dist/listing-lifecycle-admin/index.js preflight-end \
     --catalog-id <row id> --sku <sku> --listing-id <id> \
     --offer-id <id|none> --reason not-available
   ```

   The target must be an ACTIVE listing. `--offer-id` follows the
   listing-revise convention: the exact offer id for an Inventory-model
   target, the literal `none` for a Trading-model target (and only then).
   `not-available` is the only supported ending reason. It prints the end
   manifest summary (identity, reason, observed-title digest) and the
   **manifest digest**.

2. **Dispatch**:

   ```
   node dist/listing-lifecycle-admin/index.js dispatch-end \
     --catalog-id <row id> --sku <sku> --listing-id <id> \
     --offer-id <id|none> --reason not-available \
     --manifest-digest <sha256> --migration-store <path>
   ```

   One invocation performs the same store ceremony under
   `listingEndRelist` / `end_or_relist_ebay_listing`, then exactly one
   provider call for the target's model (Trading `EndFixedPriceItem` with
   `EndingReason` `NotAvailable`, or Inventory offer withdraw), followed by
   the fresh post-action verification read: the listing no longer active is
   the observed effect.

3. **Observation window** — confirm the listing stays ended and no incumbent
   behavior regresses. To relist, run a full create ceremony once the item is
   a clean not-listed row.

## Outcomes and recovery

- `dispatched-and-reconciled` / `resolved_existing`: the effect is verified
  on the target. Done.
- Provider dispatch failed (`providerDispatchReported: false`) with
  `confirmed_missing`: nothing durable exists remotely; the intent is spent.
  To retry a create, save a **fresh** draft revision (new revision digest →
  new manifest digest) and run a new ceremony; to retry an end, re-run
  preflight-end (a fresh observed state yields a fresh manifest digest) and a
  new ceremony.
- `dispatched-unresolved` with the effect not yet observed: the job stays in
  `reconciliation_required`. Re-run verification later:

  ```
  node dist/listing-lifecycle-admin/index.js reconcile \
    --action create --catalog-id … --sku … --revision-digest <sha256> \
    --description-template ucg-branded-v1 \
    --migration-store <path> --job-id <id> --attempt-id <id>

  node dist/listing-lifecycle-admin/index.js reconcile \
    --action end --catalog-id … --sku … --listing-id <id> \
    --manifest-digest <sha256> \
    --migration-store <path> --job-id <id> --attempt-id <id>
  ```

  For a templated create, repeat the same `--description-template` flag on
  every reconcile so the CLI derives the original intent and exact expected
  HTML. The flag is rejected for end reconciliation.

  A still-absent effect never auto-terminalizes (propagation delay must not
  fabricate a `confirmed_missing`); after the observation window the operator
  may pass `--accept-absent` to record that terminal outcome explicitly.

- **Created offer but publish failed** (`unresolvedCode:
  "CREATE_OFFER_UNPUBLISHED"`): the dispatch created the inventory item and
  offer but the publish call failed, so a durable unpublished offer artifact
  exists remotely — the output and every later `reconcile --action create`
  report it with that fixed code, name the `offerId`, and the job stays
  unresolved. `--accept-absent` never applies while the artifact exists: the
  state is not absent. The operator decides in a **new ceremony** whether to
  finish (publish) or withdraw the offer out of band; once the fresh capture
  shows either the active listing (→ `reconcile` resolves the job as
  `resolved_existing`) or a clean not-listed row (→ `reconcile
  --accept-absent` records the terminal absence), the job terminates.
- An ambiguous fresh capture (`CREATE_STATE_UNVERIFIED` /
  `END_STATE_UNVERIFIED`) records a critical exception and stays unresolved —
  investigate before any further action.
- **Rollback**: for a create, the rollback of a published listing is an END
  ceremony for the new listing (its own approval, never automatic). For an
  end, the rollback is a relist — a new CREATE ceremony. Each is a
  first-class dispatch with its own approval.
- **Break-glass**: stop running the CLI. No schedule, webhook, or server
  path can dispatch; with no operator invocation there are zero writes.

## What this slice does not do

No listing revise (that is `listing-revise-admin`), no price or inventory
write, no order path, no Marketplace Connect change, no Trading-to-Inventory
migration, no bulk or wildcard targets, no automatic retry, no separate
relist code path, and no UI Apply/Publish. Each of those remains a
separately gated slice.
