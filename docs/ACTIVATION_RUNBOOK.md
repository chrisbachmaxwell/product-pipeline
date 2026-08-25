# Marketplace Connect Replacement — Master Activation Runbook

**Status of this document:** ordered operator instructions only. Nothing in this
runbook executes anything, and deploying the code it describes changes no runtime
behavior: every writer below is a standalone compiled CLI that the server never
imports, every dispatch requires a fresh execution-time one-action exact-target
operator approval, and the HTTP writer quarantine (423 middleware, `denyExternalWrite`,
GET/HEAD-only `ebayRequest`) remains fully in force.

**Authorization context (2026-08-19):** the user granted full authority to bring
ProductPipeline to complete Marketplace Connect capability — listing management
(create / revise / end-relist), price sync, inventory sync, and eBay→Shopify order
import — with exactly one absolute prohibition: **never import or backfill historical
orders.** That prohibition is structural, not procedural: the schema-v3 production
order watermark cannot be established more than one hour in the past (SQL trigger and
TypeScript guard), requires current ProductPipeline single-writer orderImport
ownership first, admits strictly-greater order timestamps only, and is
one-watermark-per-scope forever.

**Standing invariant — one writer, ever:** for each responsibility, Marketplace
Connect's corresponding sync must be recorded OFF (with evidence) *before*
ProductPipeline takes ownership of that responsibility. The ownership ceremonies
below refuse to run without that evidence. Never run both writers in parallel.

---

## 0. Where these steps run

All ceremonies run **on the Railway production box** (`railway run` / a shell on the
deployed service), because that is the only place the provider credentials and the
production migration-state database exist. This repository and any agent container
hold no credentials; sessions here are inherently write-safe.

Per-slice runbooks with exact flags, error codes, and rollback procedures:

| Slice | CLI | Runbook |
| --- | --- | --- |
| Store admin | `dist/migration-admin/index.js` | `docs/MIGRATION_ADMIN.md`, `docs/MIGRATION_STATE.md` |
| Listing revise (Inventory + Trading models) | `dist/listing-revise-admin/index.js` | `docs/LISTING_REVISE_DISPATCH.md` |
| Listing create + end/relist | `dist/listing-lifecycle-admin/index.js` | `docs/LISTING_LIFECYCLE_DISPATCH.md` |
| Price + inventory alignment | `dist/price-inventory-admin/index.js` | `docs/PRICE_INVENTORY_DISPATCH.md` |
| New-order-only import | `dist/order-import-admin/index.js` | `docs/ORDER_IMPORT.md` |
| Fulfillment/tracking | `dist/fulfillment-tracking-admin/index.js` | `docs/FULFILLMENT_TRACKING_DISPATCH.md` |

## 1. One-time foundation (do first, in order)

1. **Confirm deploy.** `GET /health` on the production service must report `ok`.
   The deployed revision must include `main` ≥ `2bcadc9` (wave 2).
2. **Initialize or upgrade the production migration-state store to schema v4.**
   - Fresh store: `migration-admin init` (see `docs/MIGRATION_ADMIN.md`).
   - Existing v1/v2 store: `migration-admin verify`, then `migration-admin upgrade`
     with the exact catalog-digest confirmation it prints, then `verify` again.
   - Put the store on the persistent volume so it survives redeploys: set the
     config's `databasePath` to the absolute durable form
     `<volume>/migration-state/product-pipeline-migration-v1.sqlite` (the same
     volume that holds the app database — see the directory of `DATABASE_PATH`),
     and create its parent first with `mkdir -p -m 700 <volume>/migration-state`.
     The repository-local `.local/...` path lives on the ephemeral container
     filesystem and is wiped on every deploy.
3. **Exercise the signed-in draft save once (G3 close-out).** From your signed-in
   embedded-app browser session, follow the one-click step in
   `docs/LISTING_DRAFT_SAVE_EXERCISE.md` (edit any listing draft field and save;
   expect a `201` and a new stored revision). This is the only step performed in a
   browser instead of a shell.

## 2. Listing management (no Marketplace Connect dependency)

Marketplace Connect never owned listing create/revise/end in a verified way, so these
Class A responsibilities activate without touching MC: their ownership chains start
truthfully `paused` and an MC-genesis claim is permanently rejected by the store.

1. `listing-revise-admin establish-ownership` — once per store.
2. Per revision: `preflight` (prints the deterministic manifest and its digest from
   the stored draft revision — nothing else is dispatchable) → `dispatch` with every
   exact identifier (catalog row, SKU, listing id, offer id or `--offer-id none` for
   Trading targets, revision digest, manifest digest) → automatic post-dispatch
   verification → `reconcile` if the job lands in `reconciliation_required`.
3. Listing create and end/relist follow the same shape via `listing-lifecycle-admin`
   (`establish-ownership`, then `preflight-create`/`dispatch-create` or
   `preflight-end`/`dispatch-end`, then `reconcile`). A create interrupted after the
   offer exists but before publish is stored as `CREATE_OFFER_UNPUBLISHED` and is
   resumed, never blindly re-created.
4. Model routing per `docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md`: Inventory-model
   listings use the Inventory/Offer path; the 107 legacy Trading-model listings use
   the Trading adapters (ReviseFixedPriceItem / EndFixedPriceItem). No migration
   between models is authorized by this runbook.

## 3. Price sync takeover (user action required first)

1. **USER-ONLY:** in Marketplace Connect, turn **OFF “Sync price.”** Capture evidence
   (screenshot / settings export with timestamp) and compute its sha256 digest.
2. `price-inventory-admin establish-ownership` for the price responsibility with
   `--baseline-evidence` and `--mc-disabled-evidence` digests. The ceremony records
   the staged marketplace_connect → paused → product_pipeline transition.
3. Per target: `plan` (prints the drift manifest `{field, before, after}` and digest;
   `--field price` only — a price dispatch structurally cannot carry quantity) →
   `dispatch` echoing the manifest digest and all exact identifiers → `reconcile`
   with `--before/--after/--manifest-digest`.

## 4. Inventory sync takeover (user action required first)

Identical to §3 with the **“Sync inventory”** toggle, the inventory responsibility,
and `--field quantity`. Do the two takeovers separately — each has its own toggle,
evidence, and ownership ceremony.

## 5. Order import takeover (most-gated; user actions required first)

1. **USER-ONLY:** release and install a Shopify app version that adds `write_orders`
   (current `productpipeline-read-only-8` is read-only). The import command preflights
   `currentAppInstallation.accessScopes` and fails closed
   (`IMPORT_SHOPIFY_WRITE_SCOPE_MISSING`) until this is done.
2. **USER-ONLY:** in Marketplace Connect, turn **OFF order import.** Capture evidence
   as in §3. From this moment until the watermark exists, new eBay orders queue on
   eBay only — do this immediately before the next two steps, not days ahead.
3. `order-import-admin establish-ownership` with both evidence digests.
4. `order-import-admin establish-watermark` **within one hour** — the store rejects
   any boundary older than one hour before establishment (trigger + guard), so a
   stale go-live attempt fails closed rather than admitting old orders. One watermark
   per scope, forever; only orders strictly newer than it are ever eligible.
5. Steady state: `poll` (own token exchange scoped to exactly
   `api_scope + sell.fulfillment`; ≤3 pages / ≤50 orders; records observations only,
   no PII) → `import --order-id <id> --confirm-lightspeed` one order per invocation.
   Import pre-checks Shopify for the `eBay-<id>` dedup tag and links instead of
   creating on a hit; it post-verifies the created order before recording the link.
   `confirmed_missing` is never automatic for orders (`--accept-absent` only).

## 6. What only the user can do (checklist)

- [ ] Marketplace Connect: turn off **Sync price** (§3.1) — evidence captured
- [ ] Marketplace Connect: turn off **Sync inventory** (§4) — evidence captured
- [ ] Marketplace Connect: turn off **order import** (§5.2) — evidence captured
- [ ] Shopify: release/install app version with `write_orders` (§5.1)
- [ ] Marketplace Connect: after order cutover, record fulfillment/tracking behavior OFF
- [ ] Establish fulfillment ownership and approve each exact full-order dispatch
- [ ] Railway shell access for every ceremony in §§1–5
- [ ] Signed-in browser session for the one-click draft save (§1.3)
- [ ] Each individual dispatch approval (the ceremonies mint single-use, ≤15-minute
      approvals; nothing dispatches without an operator at the keyboard)

## 7. Fulfillment/tracking takeover (after order cutover)

1. **USER-ONLY:** record Marketplace Connect's residual
   fulfillment/tracking behavior OFF with evidence. Order import being off is
   not sufficient evidence by itself.
2. Run `fulfillment-tracking-admin establish-ownership` with the baseline and
   MC-disabled evidence digests.
3. For one shipped order at a time: `preflight` with the exact Shopify order
   GID and eBay order ID, review the redacted manifest digest, then `dispatch`.
   Partial or split shipments are denied. See
   `docs/FULFILLMENT_TRACKING_DISPATCH.md`.
4. Do not add a webhook, scheduler, or worker until G18 automation is
   separately authorized.

## 8. Rollback posture

- Ownership transitions are recorded, append-only, and reversible by recording a new
  transition back to `paused`; re-enabling the corresponding Marketplace Connect
  toggle restores the incumbent — but never while a ProductPipeline ownership row is
  current (one writer, ever: pause ProductPipeline’s ownership first).
- A dispatched listing revision is rolled back by dispatching the inverse manifest
  through the same ceremony; price/quantity are byte-preserved on revise, so listing
  revisions cannot drift them.
- The order watermark is deliberately **not** rollbackable: once established it is
  permanent for the scope. If order import must stop, record the ownership transition
  to `paused`; already-imported orders remain (they are real orders), and the
  prohibition on historical import continues to hold structurally.
