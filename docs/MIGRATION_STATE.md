# Durable Migration State

This document defines the persistence boundary required before ProductPipeline can assume any Marketplace Connect responsibility. The migration store is a separate control-plane database; it is not the legacy application ledger, a commerce writer, or a cutover authorization.

## Implemented state

Schema version 1 and its repository are implemented under `src/migration-store/` but are not imported by webhooks, schedulers, the legacy CLI, platform clients, or writer services. A narrow projection facade is the only server import, and it opens state read-only only when the authenticated migration-status request explicitly names a strict configuration. The separate `migration-admin` command can preview one local initialization, initialize only after an exact scope-digest confirmation, and verify read-only; it exposes no ownership, watermark, job, import, or platform action. Application startup still does not open, create, or migrate this database. The adjacent `src/shadow-read/` code is fixture-only contract test infrastructure and likewise has no live transport.

The focused persistence suite covers filesystem publication/reopen behavior, production inertness, watermark boundaries, deterministic order intents, approval/job reservation, delayed incumbent links, outcome-unknown reconciliation, direct-SQL replacement and relationship attacks, schema/audit tampering, and the compiled-artifact boundary. Passing these local tests does not initialize a production database, establish a watermark, prove parity, or authorize a writer.

## Safety boundary

- The mounted server imports only the redacted read-only projection facade through a request-time reader. Webhook handlers, schedulers, the legacy CLI, Shopify/eBay adapters, and writer services do not import the migration store.
- Creation or migration is explicit. Merely starting ProductPipeline, viewing the five-page UI, or running offline reconciliation must not create or alter this database.
- Records contain stable platform identities, policy/evidence digests, state-machine metadata, and timestamps only. Tokens, cookies, secrets, buyers, names, email, phone, addresses, line items, notes, and raw platform payloads are forbidden.
- The canonical store API opens an exact 0600 regular file, enables its required SQLite constraints, verifies the complete schema/catalog and audit chain, and uses immediate transactions. A process with direct filesystem/SQLite administration can still replace the file or drop its schema and is outside this local threat boundary. The database is not an externally immutable audit service and does not prove production parity.
- Every current writer remains quarantined. Persisting a row never enables an external write, establishes a production watermark, transfers ownership, or authorizes a canary.
- The first implementation is deliberately asymmetric: a production-scoped store may record the Marketplace Connect v1 incumbent baseline and shadow evidence only. Outside the schema-v2 listing-revise, schema-v3 replacement, and schema-v4 fulfillment slices below, it rejects a ProductPipeline ownership transfer, production watermark, approval consumption, or execution reservation. Future-state behavior for every other responsibility is exercised only against an explicitly scoped sandbox store.

## Schema version 2 — production listing-revise slice (2026-08-14, goal G4)

Version 2 narrows exactly four production denials to admit one reviewed responsibility and nothing else:

- `idempotency_intents_deny_production` admits only `action = 'revise_ebay_listing'`; every other production writer intent stays denied by the same trigger.
- The ownership transition trigger and store guard admit a `listingRevise` chain whose genesis is `paused` (there is no verified Marketplace Connect listing owner to record — a `marketplace_connect` owner for `listingRevise` is permanently rejected in every environment) and whose later versions move only between `paused` and `product_pipeline` under the existing staged-transition pairs.
- Production reconciliation admits, in addition to shadow zero-write runs, `production_canary` runs for `listingRevise` with `external_writes_observed = 0` — the exact-target post-dispatch verification read.
- Attempt resolution gains a `listingRevise` branch bound to the new append-only `listing_revise_observations` table: a resolution requires a passed, authoritative, exception-free reconciliation run whose recorded observation effect (`revised_state_observed` / `revised_state_absent`) exactly matches the claimed resolution. The orderImport branch and its `order_links` predicates are unchanged.

The order watermark, historical-backfill, order-creation, price, inventory, mapping, fulfillment, and feedback denials are untouched. Upgrading an existing verified v1 store is an explicit operator action only: `migration-admin upgrade --config … --applied-at … --confirm-scope <exact scope digest>`, backed by `upgradeMigrationStore`, which verifies the complete v1 history and catalog digest before applying v2 in one immediate transaction and re-verifying. Runtime never upgrades; a v1 store fails every ordinary open until the operator upgrades it.

## Schema version 3 — Marketplace Connect replacement slice (2026-08-19)

Version 3 extends the exact v2 pattern to the remaining writer responsibilities — `listingCreate`, `listingEndRelist`, `price`, `inventory`, and `orderImport` — while keeping `mapping`, `fulfillment`, and `feedback` denied in production exactly as before:

- `idempotency_intents_deny_production` now admits exactly six production actions: `revise_ebay_listing`, `create_ebay_listing`, `end_or_relist_ebay_listing`, `update_ebay_price`, `update_ebay_inventory`, and `import_shopify_order`. `update_mapping`, `sync_fulfillment`, and `sync_feedback` stay denied by the same trigger.
- Ownership recognizes two responsibility classes. Class A ("no verified incumbent": `listingCreate`, `listingEndRelist`, joining `listingRevise`) uses the truthful `paused` genesis, permanently rejects a `marketplace_connect` owner in every environment, and transitions only between `paused` and `product_pipeline` under the existing staged pairs. Class B ("verified Marketplace Connect incumbent": `orderImport`, `price`, `inventory`) keeps the v1 `marketplace_connect` genesis, and production now additionally permits exactly the staged transitions `marketplace_connect -> paused`, `paused -> product_pipeline`, and `product_pipeline -> paused` for those three responsibilities. A production rollback `paused -> marketplace_connect` is not part of this slice. The in-flight-job transition block is unchanged.
- **The production order watermark is no longer blanket-denied but is doubly clamped.** `order_watermarks_enforce_ownership_evidence` (and the matching store guard) permits a production insert only when the current `orderImport` ownership at the latest version is `product_pipeline` with verified single-writer evidence — the operator-recorded proof chain that Marketplace Connect order import is disabled — **and** the no-backfill clamp holds: `boundary_exclusive_epoch_ms >= created_epoch_ms - 3600000`. The exclusive boundary may be at most one hour before the moment the watermark is established, so it can never reach into order history and a repeat of the 2026-02-11 backfill incident is structurally impossible. One watermark per scope forever (`order_watermarks_deny_second_insert`), the strictly-greater eligibility CHECK, and the `creationDate`/`exclusive` semantics are unchanged; orders at or before the boundary remain permanently `WATERMARK_REQUIRED`-denied.
- Production reconciliation admits, in addition to shadow zero-write non-authoritative runs, `production_canary` runs with `external_writes_observed = 0` for any of the six enabled writer responsibilities.
- Attempt resolution adds one append-only table, `target_effect_observations` (`effect_observed`/`effect_absent`, bound to exactly one run, one intent, one target, and one of `listingCreate`/`listingEndRelist`/`price`/`inventory`), mirroring `listing_revise_observations` including its deny-update/deny-delete/deny-conflicting-insert and binding triggers. `attempt_resolutions_require_authoritative_target_reconciliation` now branches per responsibility: `orderImport` keeps its `order_links` predicates, `listingRevise` keeps `listing_revise_observations`, and the four new responsibilities require a matching `target_effect_observations` row whose recorded effect exactly matches the claimed resolution.

The approval 15-minute TTL, single use, one-attempt ordinal, append-only trigger set, audit hash chain, deterministic order intent uniqueness, and every sandbox-only behavior are unchanged. The read-only projection and server reader accept a production watermark only when the same projection shows current `product_pipeline` single-writer `orderImport` ownership; any other production watermark makes the whole projection fail closed as invalid. Upgrading is the same explicit operator action as v2 (`migration-admin upgrade`), regression-tested for both v1→v3 and v2→v3; runtime never upgrades, and a v1 or v2 store fails every ordinary open until the operator upgrades it. Persisting any of this state still enables no external write: dispatch remains gated on the execution-time one-action exact-target operator approval, and no adapter for listing-create, end/relist, price, inventory, or order import is wired.

## Schema version 4 — fulfillment/tracking slice (2026-08-25, goal G17)

Version 4 widens the v3 production boundary for exactly one responsibility:
`fulfillment`. `mapping` and `feedback` remain denied.

- `sync_fulfillment` joins the exact production action allowlist.
- `fulfillment` joins Class B. Its truthful genesis is
  `marketplace_connect`; Production permits only the staged
  `marketplace_connect -> paused -> product_pipeline` chain (and
  `product_pipeline -> paused`) with single-writer evidence at every version.
- Zero-write authoritative `production_canary` reconciliation is admitted for
  fulfillment.
- `target_effect_observations` is rebuilt by the explicit migration to admit
  fulfillment effects, preserving every v3 row. Attempt resolution requires
  the matching fulfillment observation and cannot borrow another
  responsibility's run, intent, or target.

The standalone `fulfillment-tracking-admin` is the only consumer. It supports
one complete Shopify fulfillment to one eBay shipping fulfillment, denies
partial/split shipments, and is not imported by the server, webhook,
scheduler, worker, or legacy CLI. Schema upgrade, ownership, and every
dispatch remain explicit operator actions; migration alone performs no
provider write. See `docs/FULFILLMENT_TRACKING_DISPATCH.md`.

## Canonical responsibility vocabulary

Every control-plane record uses the exact values exported by `src/safety/responsibilities.ts`:

`orderImport`, `price`, `inventory`, `listingCreate`, `listingRevise`, `listingEndRelist`, `mapping`, `fulfillment`, `feedback`, and `reconciliation`.

`reconciliation` is an ownership/evidence responsibility but never a writer action. Legacy names such as `orders`, `listing_update`, and `listingLifecycle` are rejected rather than translated. This prevents a permissive mapping layer from authorizing a different responsibility than the operator reviewed.

## Account-scoped identities

Every external identity must include the account boundary that gives it meaning:

- Shopify resources: exact `*.myshopify.com` store plus canonical Product, ProductVariant, or Order GID.
- eBay resources: environment, seller account, marketplace, and the resource ID. Listing links retain inventory-item SKU, offer ID, and listing ID; order links retain eBay order ID.
- A bare SKU, listing ID, order ID, or local integer is not a globally durable identity.

The store must reject an attempt to reuse an identity across a conflicting account or link two different source identities to one supposedly unique remote effect.

## Order incident invariants

The following rules specifically prevent a repeat of the historical-order import incident:

1. **Explicit immutable watermark.** An order watermark is inserted for one exact eBay environment, seller, marketplace, stream, and event-time field. It uses an exclusive boundary. It cannot be inferred, updated, replaced, or deleted.
2. **Permanent historical ineligibility.** An order whose source event time is at or before the watermark can never receive an import intent. A null/missing watermark makes every order ineligible.
3. **One business identity, one intent.** The order-import idempotency identity is stable across approvals, deployments, retries, workers, payload formatting, and ownership-version changes. A new approval cannot create a second intent for the same eBay order and Shopify store.
4. **Reserve before dispatch.** Ownership, evidence, approval, watermark eligibility, intent uniqueness, and job reservation are checked in one immediate transaction before any future adapter could be called.
5. **Unknown is not retryable.** Once a future attempt crosses the dispatch boundary, a timeout or crash becomes `outcome-unknown`. ProductPipeline must reconcile Shopify by the stable external identity before any further decision; it must never automatically create again.
6. **Cursor is not watermark.** A polling cursor may advance monotonically for resumability, but it cannot move or substitute for the immutable lower-bound cutover watermark.

## Control-plane records

The dedicated store is expected to retain:

- platform accounts and account-scoped listing/order links;
- versioned ownership decisions and evidence references;
- immutable order watermarks and separate monotonic stream cursors;
- deterministic idempotency intents, durable jobs, and append-only attempts;
- exact-target, responsibility-scoped, expiring, single-use approvals;
- reconciliation runs and immutable exception observations;
- append-only audit events with a verifiable hash chain.

Mutable workflow state must use constrained transitions. Immutable evidence and attempt history must reject `UPDATE`, `DELETE`, and replace-style writes. Multi-worker reservation must use a transaction and a uniqueness constraint rather than process memory.

## Canary relationship

The pure canary-readiness evaluator and this persistence layer have different jobs:

- the store proves that required state exists under durable constraints;
- reconciliation proves the observed before state and later the remote outcome;
- an operator approval names exactly one responsibility, one target, one expected action, one ownership version, and an expiry;
- a future writer adapter still requires a separately reviewed authorization boundary.

The current evaluator always returns `canaryAuthorized: false` and `externalWritesAllowed: false`. A complete local packet can at most become ready for a later explicit authorization; it is not that authorization.

## Verification requirements

Before this persistence layer can be connected to runtime code, tests must cover:

- schema creation only through an explicit initializer and safe reopening without destructive migration;
- account and stable-ID uniqueness, foreign keys, exact timestamps, and strict enums;
- watermark insert-once behavior, update/delete/replace rejection, missing-watermark denial, and boundary equality denial;
- cursor compare-and-swap and regression denial, with no effect on watermark state;
- concurrent idempotency reservation yielding one intent and one runnable job;
- approval scope/version/evidence/expiry checks and single consumption;
- allowed job/attempt transitions, append-only history, crash/outcome-unknown behavior, and reconcile-before-retry;
- reconciliation/audit append behavior and tamper detection;
- no network, credential, legacy database, server, scheduler, webhook, or commerce-adapter import.

Production wiring additionally requires backup/restore rehearsal, durable-volume verification, one-process/multi-worker locking tests, an external audit anchor, current authoritative parity evidence, and a responsibility-specific canary plan. None is implied by local unit tests.

Production execution also requires one authoritative store location for the exact account scope and a trusted runtime clock. A copied or independently initialized database must never be treated as sharing idempotency state, and caller-supplied timestamps must not be used to extend an expired approval. Immediately before any future order-create request, the writer must re-read the authoritative target for the account-scoped eBay order identity; durable local reservation is necessary but does not replace that last remote duplicate check.

Schema version 1 is intentionally one-shot: one intent has one job and one dispatch attempt, and only order-import uncertainty has a modeled reconciliation resolution. It does not provide a production retry path for a confirmed-missing order or responsibility-specific recovery for listing, price, inventory, fulfillment, or feedback outcomes. A later reviewed schema version must add those recovery state machines without weakening the permanent business-identity idempotency key; until then `externalWritesSupported` remains false.

The first mounted consumer is now a projection-only, read-only facade, paired with a separate inert `init`/`verify` administration command. It does not expose the writable store handle, tokens, approval values, raw rows, customer data, or any action command. See `docs/MIGRATION_ADMIN.md`. Production volume placement, backup/restore, topology fencing, trusted time, and an external audit anchor remain separate deployment gates.
