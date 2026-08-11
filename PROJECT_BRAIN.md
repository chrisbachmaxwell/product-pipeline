# Product Pipeline Project Brain

> Canonical orientation and handoff document for the Product Pipeline repository.
> Verified against `main` at `e6914f5657bf1d074dd8900ac7b6513f96654922` on 2026-08-11.
> This describes repository state, not current Shopify, eBay, Railway, or Marketplace Connect state.

## 1. Authorized Product Direction

Product Pipeline is to become a focused, Marketplace Connect-style application for managing UsedCameraGear Shopify products as eBay listings.

The target product owns listing work:

- Connect Shopify products to eBay listings.
- Prepare, create, revise, publish, end, relist, and reconcile eBay listings.
- Keep listing inventory and price aligned with an explicit source-of-truth policy.
- Expose operator-visible status, exceptions, approvals, and audit history.

It is not an AI-agent product-enrichment application. AI description generation, image processing, chat-driven commands, StyleShoots ingestion, TradeInManager enrichment, and related automated publishing are legacy scope slated for staged removal.

Order creation is outside the target product. Marketplace Connect is the presumed owner of eBay-to-Shopify order creation until a separately approved, verified cutover says otherwise. Product Pipeline must not create, backfill, or replay Shopify orders.

The repository name remains `product-pipeline`. A future rename is anticipated but is not authorized by this document.

## 2. Sources of Truth

Use this precedence when sources disagree:

1. Explicit current human authorization and production ownership decisions.
2. Directly observed Shopify/eBay state for facts about those systems.
3. Current source code and tests for implemented behavior.
4. This project brain for direction, safety boundaries, verified findings, and handoff.
5. `AGENTS.md` for engineering rules and incident context.
6. `PROJECT.md`, architecture documents, README, reports, and plans for historical context.

The SQLite database is an application ledger/cache, not an authoritative catalog. Shopify is the source for Shopify product data; eBay is the source for actual eBay listing state. A `product_mappings` row alone does not prove that a live listing exists or is correct.

## 3. Non-Negotiable Safeguards

### Order ownership and historical data

- Do not import or sync historical eBay orders.
- Do not run an eBay-to-Shopify order backfill.
- Do not let Product Pipeline and Marketplace Connect concurrently own order creation.
- Before any future order work, document one owner, reconciliation behavior, cutover time, rollback, and proof that the other writer is disabled.
- Persist an immutable lower-bound cursor/cutoff before enabling any importer. Never infer the boundary from an empty database or process start.
- Treat Shopify order creation as a downstream Lightspeed mutation with real operational consequences.

### Idempotency and cursors

- Persist cursors, idempotency keys, remote IDs, attempt state, and final outcomes durably.
- Replays, retries, restarts, and multiple workers must not duplicate a remote mutation.
- Check-create-map sequences need a durable concurrency strategy; process memory is not sufficient.
- Reconciliation must compare local records to current Shopify and eBay state.

### Approval and auditability

- Remote listing mutations default to dry-run or preview.
- Publishing, ending, bulk revising, price changes, and inventory changes require an explicit operator action or a separately approved automation policy.
- A dry-run flag must be enforced server-side; a UI or CLI label alone is not a safety control.
- Record actor, trigger, inputs, ownership mode, before/after remote identifiers, result, and error for every attempted mutation.
- Webhooks must be authenticated, replay-resistant, idempotent, and observable before they can trigger writes.

### Change safety

- Separate source verification, build/test results, deployment, and live-system verification.
- Do not claim an integration is working from code presence, local mappings, or historical documentation.
- Do not remove legacy code until its route, scheduler, webhook, watcher, UI, CLI, import, database, and deployment dependencies are mapped.
- Do not delete legacy database columns/tables during initial decommission; first stop writers and retain read-only evidence.

## 4. Verified Current Architecture

The repository contains a TypeScript/Node application with Express 5, React 19/Vite, Shopify Polaris, SQLite through better-sqlite3/Drizzle, eBay and Shopify clients, a Commander CLI, and Railway/Docker configuration. It also includes committed `dist/` output, a Python/FastAPI `image-service/`, and a small `sync-agent/`.

Principal source areas:

- `src/ebay/`: authentication and eBay REST/Trading clients.
- `src/shopify/`: Shopify products, orders, and webhook helpers.
- `src/sync/`: product, order, inventory, price, fulfillment, listing, and AI pipeline logic.
- `src/server/`: Express application and API routes.
- `src/web/`: operator interface.
- `src/db/`: shared SQLite schema and initialization/migrations.
- `src/services/`: drafts, image processing, photo templates, eBay draft listing, TradeInManager, and related services.
- `src/watcher/`: StyleShoots/local/cloud photo ingestion.
- `image-service/`: separate image-processing service.
- `sync-agent/`: companion sync process.

The current application is not cleanly divided into listing and enrichment modules. Notable shared seams include:

- `src/server/routes/api.ts` mixes listing, order, mapping, image, test, and operational endpoints.
- `src/server/index.ts` mounts mixed routes and starts schedulers/watchers.
- `src/db/client.ts` creates and migrates both retained and legacy tables.
- `src/web/App.tsx`, navigation, settings, stores, and API hooks span both product directions.
- `product_drafts` supports both enrichment review and manual eBay listing preparation.
- `product_mappings` contains essential Shopify/eBay links plus automation metadata.

## 5. Listing Capabilities to Retain

“Built” below means a code path exists and is wired. It does not prove credentials, deployment, remote state, or production fitness.

| Capability | Verified implementation | Current qualification |
|---|---|---|
| eBay authentication | Auth routes and token manager | Wired; live validity unknown |
| Listing inventory view | Listings API, UI, and CLI | Reads local mappings, not authoritative eBay inventory |
| Shopify catalog/detail | Shopify clients, routes, UI | Built; live connectivity unknown |
| Create/publish listing | `src/sync/product-sync.ts` and product sync route | Single-variant; remote-write defaults need hardening |
| Manual listing preparation | eBay listing prep UI, draft routes, `ebay-draft-lister.ts` | Built but coupled to enrichment drafts and has correctness gaps |
| Revise listing | `updateProductOnEbay`, APIs, UI, webhook path | Built; no current end-to-end proof |
| End listing | `endEbayListing`, APIs, UI, webhook path | Built; remote-write confirmation policy is incomplete |
| Inventory delist/relist | Inventory sync, API, webhook path | Built; durable job/idempotency controls are incomplete |
| Price update | Price sync logic and API path | Built; standalone scheduled ownership was not verified |
| Fulfillment update | Fulfillment sync logic and Shopify fulfillment webhook | Webhook path exists; standalone function appears unused |
| Mappings/categories/aspects/conditions | Services, APIs, and parts of UI | Core listing foundation; needs reconciliation and tests |
| Stale listing/price-drop/promotion tools | `listing-manager.ts`, API, CLI, optional scheduler | Deterministic automation despite “AI” labels; business policy and safety need validation |

### Material listing gaps and defects

- There is no authoritative discovery/reconciliation loop over current eBay listings. Browse/inventory-list helpers exist but were not found wired into a complete operator workflow.
- Manual mapping exists as an API but no UI or CLI caller was found.
- The bulk “Relist” UI calls the ordinary update endpoint; it does not prove an ended listing is republished.
- There is no true bulk-edit transaction model with per-item results and rollback/retry semantics.
- Product sync is single-variant.
- Product creation can remove existing eBay offers for a SKU before publishing a replacement.
- Draft listing quantity uses a minimum of one, which can list a zero-stock item as quantity one.
- Draft image edits can be ignored when Shopify CDN images exist; condition-description edits are not sent by the observed UI path.
- Reusing an existing offer does not clearly revise all price, quantity, category, and policy fields before publish.
- The draft publish action lacks a server-enforced confirmation contract.
- Listing description HTML contains hard-coded warranty, shipping, and return claims that require business validation.
- The CLI `listings republish --dry-run` sends a flag that the observed server endpoints do not enforce.
- Automated sales attribution used for price-drop decisions is not robust.
- Several APIs acknowledge background work before its final result is known.
- The promoted-listings CLI path does not appear to supply the required listing IDs.
- No dedicated listing-management test suite was found in current source tests.

## 6. Order-Sync Incident and Current Code

### Incident

On 2026-02-11, an order sync without a safe date boundary imported the eBay order history into Shopify. Those orders cascaded into Lightspeed. Repository documentation reports 259 duplicates and identifies overlap with historical Marketplace Connect/Codisto-created orders.

### Safeguards now present in source

- `src/sync/order-sync.ts` defaults to a 24-hour lookback and clamps requests to seven days.
- A persisted `ebay_order_import_cutoff` is required for live order creation and each pre-cutoff order is skipped.
- Order sync defaults to dry-run.
- Local `order_mappings` are checked.
- Shopify order searches check eBay tags/source identifiers and scan recent order notes/tags.
- `src/sync/order-safety.ts` can match total/date plus buyer or embedded eBay order ID.
- Safe mode defaults to five creations per hour with at least ten seconds between creations.
- Regression tests cover cutoff behavior and one Shopify duplicate lookup path.

### Remaining risks

- `dryRun: false` is accepted as a live-write signal without `confirm: true`, contrary to the stricter documentation.
- The mounted eBay notification route processes XML and calls live order sync with `dryRun: false`.
- The observed notification route does not verify an eBay signature or protect against replay.
- Disabling scheduled import sets `auto_sync_enabled` false, but direct/webhook sync checks the cutoff rather than that flag.
- Duplicate lookup failures can fail open.
- Rate limiting is process-local, resets on restart, and does not coordinate multiple workers.
- Remote creation and local mapping are not one atomic operation.
- The local import endpoint accepts a caller-supplied day range; it writes local data but increases ambiguity around order ownership.
- Current Marketplace Connect configuration, live subscriptions, cutoff value, deployed worker count, and reconciliation state are unknown.

For the listing-only target, the safe design is to unmount or hard-disable every eBay-to-Shopify order-creation entry point. A configuration toggle that one caller can bypass is not sufficient.

## 7. Legacy AI and Product-Enrichment Scope

These components are outside the target product and should be decommissioned in stages:

- OpenAI description/category generation and `auto-listing-pipeline`.
- Pipeline jobs/status/SSE and AI review/auto-publish flows.
- Chat routes, command execution, capability discovery for chat, and `ChatWidget`.
- Photo processing routes, UI, templates, PhotoRoom integration, and the self-hosted image service.
- StyleShoots, Google Cloud Storage, and local drive watchers/upload flows.
- TradeInManager clients, matching, tagging, routes, and CLI workflows.
- Product-enrichment dashboard/pages and bulk image/description editors.
- The standalone image service and sync agent after verified dependency and deployment checks.

Two automatic triggers deserve priority quarantine:

- The Shopify product-create webhook starts the AI listing pipeline regardless of the observed `auto_list` setting.
- Cloud watcher startup can invoke the pipeline when its drive mode is enabled.

Do not remove shared category, aspect, condition, mapping, Shopify catalog, eBay client, authentication, database, logging, or operator-approval code merely because enrichment currently imports it. First extract the listing-owned interface.

Dependency candidates such as OpenAI, Google Cloud, chokidar, multer, sharp, drag/drop, and photo-editor packages should be removed only after import tracing and a clean build/test prove they are no longer shared.

## 8. Narrow Target Architecture

```text
React/Polaris operator UI
        |
Listing API with preview and approval contracts
        |
Durable job + idempotency + audit layer
        |
  +-----+------------------+
  |                        |
Shopify catalog adapter    eBay listing adapter
  |                        |
Shopify product truth      eBay listing truth

Marketplace Connect remains the separate order owner.
No Product Pipeline eBay -> Shopify order writer is mounted.
```

Suggested module boundaries:

- `catalog`: read Shopify products/variants/images/inventory.
- `listings`: prepare, validate, publish, revise, end, and relist.
- `mappings`: explicit, reviewed Shopify-variant to eBay-offer/listing relationships.
- `reconciliation`: discover remote listings, compare state, queue exceptions.
- `sync-policy`: explicit price/inventory ownership and transformations.
- `jobs`: durable, retryable, idempotent mutations with per-item outcomes.
- `audit`: append-only operator/system event history.
- `platforms`: isolated Shopify and eBay authentication/API adapters.

## 9. Staged Implementation and Decommission Plan

### Stage 0 — Baseline and ownership

- Keep this brain current and record the production owners for listings, inventory, price, fulfillment, and orders.
- Inventory Railway services/processes, webhooks, schedules, eBay subscriptions, Shopify app subscriptions, credentials, and current Marketplace Connect settings read-only.
- Capture a current remote listing/mapping reconciliation report without mutation.

### Stage 1 — Quarantine legacy writers

- Add a single fail-closed listing-only operating mode.
- Hard-disable/unmount eBay-to-Shopify order creation, including webhook and direct API paths.
- Stop unconditional product-create AI pipeline triggers and watcher-triggered publication.
- Unmount chat, AI pipeline, image-processing, and TradeInManager mutation routes before deleting code.
- Preserve historical database data read-only.

### Stage 2 — Establish listing core

- Split the mixed API/server startup into listing, platform, job, audit, and legacy modules.
- Create a listing-owned draft model independent of enrichment drafts.
- Fix zero-stock, image override, condition description, existing-offer revision, relist, and confirmation behavior.
- Add contract tests for every remote-write boundary and regression tests for current defects.

### Stage 3 — Reconciliation and durable safety

- Implement authoritative eBay listing discovery and a reviewed match/exception queue.
- Add durable cursors, idempotency, job state, concurrency control, and audit events.
- Make price/inventory transformations and automation ownership explicit.
- Require preview/approval for bulk changes and report each remote outcome.

### Stage 4 — Remove enrichment implementation

- Verify route, UI, CLI, import, scheduler, watcher, database, deployment, and traffic dependencies.
- Remove enrichment-only code and dependencies in small, buildable commits.
- Regenerate committed build artifacts only when source removal begins.
- Retain or export historical audit data; defer destructive schema cleanup.

### Stage 5 — Controlled validation

- Validate in an eBay sandbox/test-store path where available.
- Use one-SKU canaries with explicit approval, direct remote-state verification, and rollback.
- Do not declare ownership transferred until Marketplace Connect overlap and reconciliation are resolved.

## 10. Verified Facts Versus Unknowns

### Verified in this repository snapshot

- The listing, order, enrichment, image, watcher, and TradeInManager domains coexist and are coupled.
- The order safeguards and remaining bypass/failure risks described above are present in current source.
- Listing CRUD/sync paths exist but important operator, reconciliation, correctness, and test gaps remain.
- Existing documentation predates the narrowed product direction and contains stale statements, including that the repository still needs renaming.
- Existing current tests focus on image factory and order safety/deduplication; listing-management coverage was not found.

### Unknown until separately verified

- Which commit is deployed and which Railway services/processes are active.
- Current Shopify/eBay token validity, scopes, webhook registrations, and eBay notification subscriptions.
- Whether Marketplace Connect currently owns orders, listings, inventory, price, fulfillment, or some combination.
- The live value of `ebay_order_import_cutoff`, `auto_sync_enabled`, safety mode, drive mode, and scheduler settings.
- Whether local mappings match current eBay listings and Shopify variants.
- Current worker count, restart behavior, pending background jobs, and audit completeness.
- Business-approved listing templates, policies, condition rules, price rules, and inventory rules.
- Whether the current build/tests pass in the deployment environment.

Unknowns are not permission to probe or mutate production. Resolve them with an explicitly scoped, read-only environment audit.

## 11. Agent Handoff and Update Protocol

Every agent must:

1. Read `AGENTS.md`, this file, and `PROJECT.md`; then inspect recent git history and status.
2. State the exact scope, authority, system boundary, and whether remote writes are allowed.
3. Separate documented intent, source-code behavior, local verification, deployed state, and live-system proof.
4. Preserve unrelated work and stage only intended files.
5. Never run order import/sync as a diagnostic or test.
6. Record newly verified facts, decisions, material risks, and unresolved unknowns here when they affect future work.
7. Add implementation detail and changelog entries to `PROJECT.md`; do not turn this brain into a chronological dump.
8. Handoff with commit/branch, files changed, checks run, external systems touched, deployment status, live verification, blockers, and safest next action.

Use this compact handoff template:

```text
Objective:
Authorized scope:
Verified baseline (commit/branch):
Files changed:
Checks run and results:
External systems touched: none / exact list
Deployed: no / exact target and commit
Live verification: not performed / exact evidence
New decisions or risks:
Unknowns/blockers:
Safest next action:
```

## 12. Current Handoff

- Baseline: `main` at `e6914f5657bf1d074dd8900ac7b6513f96654922` before this documentation change.
- Inspection boundary: repository source and history only.
- Inspection access: GitHub repository clone/read. The documentation-only commit represented by this handoff was authorized for push; no Shopify, eBay, Railway, Lightspeed, or Marketplace Connect access occurred.
- Runtime actions: no order import/sync, product sync, listing mutation, deployment, build, or application execution.
- Current direction: preserve listing-management foundations; quarantine writers; hard-disable order creation; separate listing-owned shared code; then remove enrichment in stages.
