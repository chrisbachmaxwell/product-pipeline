# Order Import — New Orders Only

This document is the operator contract for the isolated `order-import-admin`
CLI (`src/order-import-admin/`, compiled to
`node dist/order-import-admin/index.js`). It imports **new** post-watermark
eBay orders into Shopify, one order per invocation.

**HISTORICAL ORDERS MUST NEVER BE IMPORTABLE.** That is the one absolute
prohibition of this slice (2026-02-11 incident: an unbounded backfill created
259 duplicate Shopify orders that cascaded into Lightspeed POS). Every layer
below is built so that a repeat is structurally impossible, not merely
procedurally avoided.

The CLI is never imported or mounted by the server, webhooks, schedulers, or
any legacy sync path, and it never touches `src/sync/order-sync.ts` or any
other legacy order code. There is **no batch mode**: one order, one
invocation, one single-use expiring approval.

---

## Prerequisites — in this exact order

1. **Marketplace Connect order import OFF, with evidence.** The operator must
   FIRST turn off order import in Marketplace Connect's own settings and
   capture proof (screenshots/attestation packet). Compute a sha256 digest of
   that evidence; it becomes `--mc-disabled-evidence`. Nothing in this slice
   can run against production until the ownership chain records that
   Marketplace Connect is disabled — the schema enforces it; this step makes
   it true in the real world first. Two concurrent order writers are never
   permitted.
2. **`establish-ownership`.** Records the `orderImport` chain in the
   migration store: `marketplace_connect` genesis (the verified incumbent
   baseline, `--baseline-evidence`), then `marketplace_connect -> paused`
   (Marketplace Connect disabled, `--mc-disabled-evidence`), then
   `paused -> product_pipeline` (same evidence digest). The command is an
   idempotent continuation: it resumes a partial chain and reports
   `already-established` when ProductPipeline already owns `orderImport`.
3. **A Shopify app version with `write_orders`, released and merchant
   approved.** The current production app version
   (`productpipeline-read-only-8`, exactly the four canonical read scopes)
   **CANNOT create orders**. Until a new app version carrying `write_orders`
   is released and approved, every `import` fails closed at the scope
   preflight with `IMPORT_SHOPIFY_WRITE_SCOPE_MISSING` — before any intent,
   approval, job, or provider call exists.
4. **`establish-watermark` at the go-live moment.** One immutable exclusive
   boundary, one per scope, forever. The store enforces the production
   **one-hour no-backfill clamp**: the boundary may be at most one hour
   before the moment it is established (`boundary >= now - 1h`), so it can
   never reach into order history. Establish it at the cutover moment with a
   boundary at (or minutes before) "now" — a canonical UTC instant such as
   `2026-08-19T18:00:00.000Z`. It cannot be updated, replaced, or deleted.
5. **`poll`.** Read-only against eBay; records order observations durably.
6. **Per-order `import` with `--confirm-lightspeed`.** Exactly one order per
   invocation; the literal flag acknowledges the Lightspeed POS cascade.

## Commands

```
order-import-admin establish-ownership \
  --migration-store /data/product-pipeline/migration-state.sqlite \
  --confirm-scope <exact scope key digest> \
  --baseline-evidence <sha256> \
  --mc-disabled-evidence <sha256>

order-import-admin establish-watermark \
  --migration-store <path> --confirm-scope <key> \
  --boundary 2026-08-19T18:00:00.000Z --accepted-evidence <sha256>

order-import-admin poll --migration-store <path> --max-orders <n<=50>

order-import-admin import --migration-store <path> \
  --order-id <exact eBay orderId> --confirm-lightspeed

order-import-admin reconcile --migration-store <path> \
  --order-id <id> --job-id <id> --attempt-id <id> [--accept-absent]
```

### `poll` (read-only, no PII)

- Mints a transient in-memory eBay user token requesting **exactly**
  `api_scope` + `sell.fulfillment`; the exchange fails closed if the provider
  echoes any other scope set. The refresh grant is never rewritten, logged,
  or persisted.
- Fetches `GET /sell/fulfillment/v1/order` filtered
  `creationdate:[<watermark>..]` — the filter starts **at the watermark**, so
  history is never even requested. Bounded 2 MB / 20 s / redirect-error, at
  most 3 pages, at most 50 orders.
- Captures ONLY: orderId, creationDate, fulfillment/payment status, line
  items (sku, quantity, lineItemId, title), pricing total. Buyer data is
  never read on this path.
- Registers each order identity (`ebay-order:<orderId>`) and records one
  durable order page; **the store derives eligibility** (strictly greater
  than the boundary). Anything at-or-before the boundary is immediately and
  permanently resolved `excluded_by_watermark`.
- Already-recorded observations are skipped and reported
  `SKIPPED_ALREADY_OBSERVED`. A previous page with unresolved eligible
  observations blocks new pages (`POLL_PREVIOUS_PAGE_UNRESOLVED`) — import or
  dedup-resolve those orders first; the next poll then advances the cursor.
- No Shopify call, no write of any kind to either platform.

### `import` (exactly one order)

Steps, all fail-closed, in order:

1. The observation for `--order-id` must exist, be post-watermark eligible,
   unresolved, and unlinked.
2. **Shopify dedup pre-check**: bounded Admin GraphQL
   `orders(first: 5, query: "tag:'eBay-<orderId>'")` against the pinned
   store/app/apiVersion. If any order carries the tag, the CLI registers its
   identity, records `linkObservedExistingOrder`, resolves the observation
   `linked_existing`, prints `DEDUP_LINKED_EXISTING`, and STOPS — no intent
   is created, and the schema then denies any future intent for that eBay
   order forever.
3. One fresh `GET /sell/fulfillment/v1/order/<orderId>` for current line
   items and shipping.
4. Payload build: every line item is resolved by exact SKU via
   `productVariants(first: 1, query: "sku:'<sku>'")`; any unresolvable SKU
   denies `IMPORT_SKU_UNRESOLVED` before any write. Tags
   `['eBay', 'eBay-<orderId>']`, a note referencing the eBay order id,
   financial status from the eBay payment status, `sourceName: 'ebay'`.
   Buyer shipping details pass through to the provider call ONLY — never
   persisted, never logged, never in any stored payload (the store holds
   digests of a PII-free manifest only).
5. **Scope preflight**: `currentAppInstallation { accessScopes { handle } }`
   must include `write_orders`, else `IMPORT_SHOPIFY_WRITE_SCOPE_MISSING`
   (see prerequisite 3) — before any intent exists.
6. Store ceremony in the durable migration store: one
   `import_shopify_order` intent (natural key = the eBay order identity — a
   different payload can never create a second intent), one single-use
   10-minute approval, one reserved job bound to the exact observation
   (`reserveExecutionJob` + `orderObservationId`), one
   `outcome_unknown` dispatch attempt — then ONE bounded Shopify
   `orderCreate` mutation.
7. Mandatory post-dispatch reconciliation: re-query Shopify by the tag.
   Found → register the Shopify order identity, record a zero-write
   `production_canary` reconciliation run targeting the eBay order identity,
   and resolve `resolved_existing` with the order link `link:<orderId>`.
   Not found (or ambiguous) → the job stays `reconciliation_required` with a
   critical exception; run `reconcile`.
8. `reconcile` re-runs the post-verify. A still-absent order becomes the
   terminal `confirmed_missing` **only** under the explicit
   `--accept-absent` flag — never automatically. `orderCreate` userErrors
   therefore leave the job unresolved for operator review; nothing ever
   auto-retries a dispatch whose outcome crossed the provider boundary.

## Structural no-backfill guarantees (layered)

Schema/store layer (`src/migration-store/`, schema v3 — every one of these is
enforced by SQL triggers and the store guards, not by CLI politeness):

- **One-hour clamp**: a production watermark boundary at most one hour before
  establishment; history is unreachable by construction.
- **Strictly-greater eligibility**: an order at or before the boundary can
  never receive an import intent (`WATERMARK_REQUIRED`), and a missing
  watermark makes every order ineligible.
- **One watermark per scope, forever**: no second insert, no update, no
  delete, no replacement.
- **Per-order natural-key intent uniqueness**: the `import_shopify_order`
  idempotency key is scope + action + eBay order identity; retries, new
  approvals, payload changes, and ownership changes cannot mint a second
  intent.
- **Link-based dispatch denial**: a job cannot begin dispatch when an order
  link (ours or an observed incumbent import) exists for the eBay order.
- **Production watermark requires ownership evidence**: current
  `product_pipeline` single-writer `orderImport` ownership whose chain
  records the Marketplace Connect disable evidence.

CLI belt on top:

- The eBay poll filter **starts at the watermark**; pre-boundary orders are
  not even requested, and any at-or-before order that does arrive is recorded
  permanently `excluded_by_watermark`.
- Shopify dedup pre-check by the durable `eBay-<orderId>` tag before any
  intent; a hit links and stops.
- Write-scope preflight before any intent.
- One order per invocation, `--confirm-lightspeed` required, immediate
  authoritative post-verification, and no automatic `confirmed_missing`.

## Lightspeed cascade warning

**Every Shopify order created by this CLI is a real Lightspeed POS event.**
Orders with `source_name: 'ebay'` flow automatically into the in-store
point-of-sale system; duplicates require manual intervention there. That is
why `--confirm-lightspeed` is a required literal flag, why dedup runs before
any intent, and why an outcome-unknown dispatch is reconciled rather than
retried. Never treat an import as a diagnostic or a test.

## Recovery paths

- **Import printed `dispatched-unresolved`** (userErrors, transport failure,
  or the order not yet visible to the tag search): run
  `reconcile --order-id --job-id --attempt-id`. If the order appears, it is
  linked `resolved_existing`. If it stays absent and you have verified in the
  Shopify admin that no order exists, run `reconcile ... --accept-absent` to
  record the terminal `confirmed_missing`. Either way the eBay order can
  never be dispatched again (natural-key intent + resolved observation) — a
  genuinely missed order is handled by a human decision, never a replay.
- **Poll blocked (`POLL_PREVIOUS_PAGE_UNRESOLVED`)**: eligible observations
  from the previous page are still open. Import or dedup-link each one; the
  next poll advances the durable cursor automatically and resumes.
- **`DEDUP_LINKED_EXISTING`**: the order already exists in Shopify (e.g.
  created by Marketplace Connect before its disable). Nothing to do — the
  link permanently prevents a ProductPipeline duplicate.
- **Break-glass**: record `orderImport` ownership `product_pipeline ->
  paused` (via `migration-admin`/store ceremony). Every approval, job
  reservation, and dispatch marker requires current `product_pipeline`
  single-writer ownership, so pausing stops all new dispatches immediately;
  the watermark and history remain intact and are never replayed. Note: the
  read-only projection fails closed while a production watermark exists
  without `product_pipeline` ownership — expected during a pause.
- **Wrong watermark boundary**: there is no correction path by design. The
  watermark is one-per-scope forever; establishing it is a go-live decision.
  If it was set too early (inside the one-hour clamp) some pre-cutover orders
  may show as eligible — dedup-link the ones Marketplace Connect already
  imported instead of importing them.

## Proof limits

Local tests prove the ceremony against fixture transports only. They do not
prove production credentials, the released app version, Marketplace Connect's
actual state, or parity. Establishing the production watermark and the first
live import each remain separately authorized operator actions under
`PROJECT_BRAIN.md` §3/§10 and the G8 order-cutover plan.
