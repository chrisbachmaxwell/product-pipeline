# Listing-Revise Dispatch (Goal G4 Slice)

The isolated `listing-revise-admin` CLI takes exactly one approved local draft
revision to eBay for exactly one SKU, with a server-independent one-action,
exact-target operator approval at execution time, durable idempotent dispatch
through the migration-state store, immediate post-action reconciliation, an
observation window, and a defined rollback path.

**Building this slice authorizes no dispatch.** Every actual dispatch is a
separate operator decision executed through the ceremony below. The slice
covers `inventory_offer`-managed listings and — since the Trading-model
extension (the Stage 2 slice of
`docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md`) — legacy `legacy_trading`
listings via exactly one bounded `ReviseFixedPriceItem` call; see
"Trading-model dispatch" below. Price, quantity, order, and Marketplace
Connect state are never written: price/quantity are preserved byte-for-byte
and any drift in them makes the draft stale and denies dispatch.

## Boundary

- The CLI is a standalone compiled entrypoint
  (`node dist/listing-revise-admin/index.js`). The server never imports or
  mounts it; the web workspace keeps `apply: false, publish: false`.
- Provider writes exist only in the two bounded dispatch adapters: exactly
  `PUT /sell/inventory/v1/inventory_item/{sku}` and
  `PUT /sell/inventory/v1/offer/{offerId}` for inventory-model targets, and
  exactly one `POST https://api.ebay.com/ws/api.dll` with call name
  `ReviseFixedPriceItem` for Trading-model targets — each dispatched only
  from inside a reserved migration-store job under a live approval.
- Dispatchable fields (inventory model): title, condition description,
  description, images, category, fulfillment/payment/return policy, merchant
  location. `condition` is excluded until its enum mapping passes review;
  price, quantity, item specifics, and identifiers are never dispatchable.
  The Trading model dispatches a reduced set — see below.
- The dispatch token is a transient in-memory user token minted from the
  existing eBay refresh grant with the same two scopes as the read path; it
  is never persisted, logged, or returned.
- The migration store (schema v2) enforces durably: production intents for
  `revise_ebay_listing` only, a single-use exact-target approval expiring in
  at most 15 minutes, one job per intent, one dispatch attempt, and a
  resolution that must match a recorded post-dispatch target observation.
  See `docs/MIGRATION_STATE.md`.

## Trading-model dispatch

The Trading-model extension supersedes the original "`inventory_offer` only"
boundary: a legacy `legacy_trading` listing (eBay listing id set, no
Inventory item, no Offer — 107 of the 112 active listings at the 2026-08-13
census) is now a dispatchable target. **Everything else is identical** — the
same draft workspace, the same manifest digests, the same migration-store
intent/approval/job/attempt ceremony (schema v2 already permits it; no
schema change), the same freshness and exact-target gates, and the same
post-dispatch reconciliation and observation policy. The differences:

- **Reduced field set.** A Trading target may dispatch only: title,
  condition description, description, images, category, and the
  fulfillment/payment/return Seller Business Policy profile ids (observed on
  the Trading item as `SellerProfiles`). `merchant_location` has no Trading
  revise mapping and is denied as `REVISE_UNSUPPORTED_FIELD`; `condition`
  stays excluded for both models; price and quantity remain never
  dispatchable.
- **`--offer-id none`.** A Trading target has no offer, so the exact-target
  ceremony accepts the literal value `none` for `--offer-id` — and accepts it
  *only* when the target really is Trading-managed (`ebayOfferId` null).
  Passing `none` for an inventory-model target, or a numeric offer id for a
  Trading target, is `REVISE_EXACT_TARGET_MISMATCH`.
- **Preservation by omission.** `ReviseFixedPriceItem` changes only the
  fields supplied in the request, so the adapter serializes exactly the
  ItemID plus one element per changed manifest field and nothing else. It
  structurally asserts the outgoing XML contains no `StartPrice` or
  `Quantity` element, every text value is strictly XML-escaped, and the
  transient IAF user token (the same minting path as the inventory adapter)
  is never persisted, logged, or returned.
- **No raw round-trip.** The inventory path GETs and PUTs whole provider
  resources; the Trading path sends one delta-only POST, because the fresh
  workspace read has already verified the current remote state against the
  revision's observed base (`REVISE_BASE_STALE` otherwise). A response `Ack`
  of `Success` or `Warning` is accepted; anything else is the redacted
  `TRADING_DISPATCH_REJECTED` and the job resolves through the same
  `confirmed_missing`/reconciliation rules as an inventory dispatch failure.
  A Trading dispatch records `externalCommerceWritesAttempted: 1`.

The two-writers hazard flagged in the strategy document remains real:
Marketplace Connect still owns price/inventory on these listings, and this
slice writes content fields only. Any drift it causes in price or quantity
still stales the draft and denies dispatch.

## Branded description template

An opt-in `--description-template ucg-branded-v1` flag on `preflight`,
`dispatch`, and `reconcile` wraps the draft's allowlisted description in our
own branded page (replacing the Marketplace Connect/Codisto shell):
usedcameragear.com wordmark header, H1 title, condition badge, the draft's
rich-text body, condition-note section, responsive https-only image gallery,
generic shipping/returns/questions info blocks, and footer — one namespaced
`<style>` block, mobile breakpoint, and zero active content (no scripts,
iframes, forms, event handlers, `javascript:` urls, external styles, or
`url(`/`@import`).

- Rendering is `renderListingDescription` in
  `src/server/listing-description-template.ts`: deterministic (byte-identical
  output for identical input, `<!-- template:ucg-branded-v1 -->` marker),
  fail-closed validated, and bounded to 400,000 bytes.
- The template input derives from the same stored revision the manifest
  derives from (title/condition/condition note/images use the revision's
  proposed values; the body is the description override), so the recomputed
  **manifest digest binds the exact templated HTML** — preflight prints a
  `descriptionTemplate` note with the version and whether it applied, and
  dispatch only accepts the templated digest when the flag is passed (and
  only the untemplated digest when it is not).
- Templating applies only when the manifest carries a `description` change;
  otherwise the manifest passes through unchanged (`applied: false`).
- Without the flag, behavior is byte-identical to the untemplated CLI. Any
  flag value other than the literal `ucg-branded-v1` is denied as
  `REVISE_TEMPLATE_UNSUPPORTED`. Both management models are supported — the
  rendered page is simply a larger description string, still subject to the
  adapters' existing payload bounds (oversized renders deny cleanly, never
  truncate).
- Read-only preview: `GET /api/listing-description-preview?id=<catalog row
  id>` on the shadow API renders the same template from the live workspace
  read plus the latest saved draft revision (observed values fill any
  non-overridden field) and returns `{ templateVersion, html }`.

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
   identity mismatch, unmanaged or partially-bound management model, field
   unsupported for the target's model, or remote drift since the draft was
   saved (`REVISE_BASE_STALE` — reopen and re-save the draft). For a
   Trading-model target pass `--offer-id none`.

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
   reservation, the model's provider step (inventory: raw resource round-trip
   with binding and price/quantity preservation assertions then at most two
   bounded PUTs; trading: one bounded delta-only `ReviseFixedPriceItem`
   POST), the dispatching/attempt record, the reconciliation-required record,
   an immediate
   post-action verification read, the reconciliation run + target
   observation, and (when the revised state is observed) the terminal
   resolution. The output includes the job id, attempt id, effect, and
   resolution.

   Description reconciliation compares the exact raw description HTML
   returned by the provider (with XML line endings canonicalized only) to the
   exact approved manifest HTML. It never compares against the editor's
   plain-text projection or uses visible-text equivalence. A raw description
   that matches neither a provable before-state nor the exact after-state is
   `partial` and cannot be terminalized with `--accept-absent`.

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
Marketplace Connect change, no Trading-to-Inventory migration, no bulk or
wildcard targets, no automatic retry, and no UI Apply/Publish. Each of those
remains a separately gated future slice.
