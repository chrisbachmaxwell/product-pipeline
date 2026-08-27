# Product Pipeline Project Brain

> Canonical orientation and handoff document for the Product Pipeline repository.
> Initial architecture behavior was verified against `main` at `e6914f5657bf1d074dd8900ac7b6513f96654922` on 2026-08-11.
> The inert migration-administration and read-only-projection revision `550cf2384a16e6f57f03d315643f3cc1337b4b7d` was source/build/test verified and observed on the public Railway health endpoint on 2026-08-11; remote Shopify/eBay parity remains separate evidence.
> Time-specific Shopify and embedded-app facts were verified in a read-only browser walkthrough on 2026-08-11.
> This is the canonical target and safety plan; it does not claim production parity or authorize a cutover.

## 1. Authorized Product Direction

ProductPipeline will replace Shopify Marketplace Connect for Used Camera Gear's eBay integration, while improving it with a simpler, operator-safe control plane.

The end-state product is responsible for:

- Connect Shopify products to eBay listings.
- Prepare, create, revise, publish, end, relist, and reconcile eBay listings.
- Synchronize price and inventory under explicit, single-writer ownership.
- Import new eBay orders into Shopify after a controlled cutover, then reconcile fulfillment and order state.
- Expose owner, status, exceptions, approvals, rollback state, and audit history to operators.

It is not an AI-agent product-enrichment application. AI description generation, image processing, chat-driven commands, StyleShoots ingestion, TradeInManager enrichment, and related automated publishing are legacy scope slated for staged removal.

Replacement is an outcome, not the current state. Marketplace Connect is presently the verified owner of eBay-to-Shopify order import and has price and inventory sync enabled. ProductPipeline must remain read-only/shadow for those responsibilities until each responsibility passes its own parity, canary, reconciliation, approval, and rollback gates. It must not create, backfill, or replay Shopify orders before the order cutover.

Marketplace Connect may be disabled only after verified parity and explicit operator approval. Retiring or uninstalling it requires a specific later user authorization.

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
- Marketplace Connect remains the sole live order importer until the order-responsibility cutover is separately approved.
- Do not let ProductPipeline and Marketplace Connect concurrently own order creation.
- Before any order canary or cutover, document the one writer, reconciliation behavior, exact UTC cutover time, eBay event-time semantics, rollback, and proof that the incumbent writer is disabled for that scope.
- Persist an explicit, immutable lower-bound watermark before enabling any importer. Never infer it from an empty database, deployment, process start, or most-recent local row.
- Orders at or before the watermark are permanently ineligible for creation by ProductPipeline, including the 277 historical eBay records visible in its local UI on 2026-08-11.
- A test must never create a real Shopify order unless it uses an isolated platform-supported test environment or a separately approved live canary.
- Treat Shopify order creation as a downstream Lightspeed mutation with real operational consequences.

### Idempotency and cursors

- Persist cursors, idempotency keys, remote IDs, attempt state, and final outcomes durably.
- Use stable external identities. For orders, the uniqueness boundary must include marketplace/account plus eBay order ID and retain the resulting Shopify order GID. For listings, retain Shopify variant GID, SKU, eBay inventory-item SKU, offer ID, and listing ID.
- Replays, retries, restarts, and multiple workers must not duplicate a remote mutation.
- Check-create-map sequences need a durable concurrency strategy; process memory is not sufficient.
- Reconciliation must compare local records to current Shopify and eBay state.

### Approval and auditability

- Remote listing mutations default to dry-run or preview.
- Publishing, ending, bulk revising, price changes, and inventory changes require an explicit operator action or a separately approved automation policy.
- A dry-run flag must be enforced server-side; a UI or CLI label alone is not a safety control.
- Record actor, trigger, inputs, ownership mode, before/after remote identifiers, result, and error for every attempted mutation.
- Webhooks must be authenticated, replay-resistant, idempotent, and observable before they can trigger writes.

### Ownership, canaries, and rollback

- Maintain one explicit owner for each responsibility: listing creation, listing revision/end/relist, mapping, price, inventory, order import, fulfillment, feedback, and reconciliation.
- Transfer one responsibility at a time. A one-SKU listing canary does not authorize order import, and an inventory canary does not authorize price writes.
- Every canary needs an allowlist, one-action approval, expected before/after state, immutable audit record, post-action reconciliation, observation window, and immediate disable path.
- Break-glass defaults to stopping ProductPipeline writes. It must not replay, backfill, delete, or silently hand control to another writer.
- Rollback is complete only when the intended incumbent owner is restored or the responsibility is explicitly paused, remote state is reconciled, and the event is recorded.
- Marketplace Connect can be disabled for a responsibility only after ProductPipeline parity for that responsibility is evidenced and accepted. Full retirement requires all responsibilities to be transferred and a later explicit approval.

### Change safety

- Separate source verification, build/test results, deployment, and live-system verification.
- Do not claim an integration is working from code presence, local mappings, or historical documentation.
- Do not remove legacy code until its route, scheduler, webhook, watcher, UI, CLI, import, database, and deployment dependencies are mapped.
- Do not delete legacy database columns/tables during initial decommission; first stop writers and retain read-only evidence.

### Enforced incumbent quarantine in current source

- `src/safety/writer-quarantine.ts` hard-codes ProductPipeline to `shadow-read-only`. Marketplace Connect remains the accepted production owner for eBay-to-Shopify order import, price, and inventory. There is no runtime flag, request confirmation, database setting, or test-mode exception that can enable those ProductPipeline writers.
- Middleware denies every non-read request beneath `/api` with HTTP `423` before a legacy handler can run, except exact `POST /api/listing-draft`. That sole exception may append one bounded local revision after exact-store Shopify-session authentication and stale-base/revision checks; it has no provider, approval, Apply, Publish, price, inventory, order, or ownership effect. Other legacy API reads return `404`.
- Production API authentication requires a cryptographically verified Shopify App Bridge session JWT for the exact app and Used Camera Gear store. Origin, Referer, query-string keys, and production API keys never authorize; test mode is available only when `NODE_ENV` is explicitly `test` or `development`.
- Shopify and eBay authentication routes are not mounted in the shadow application. The live listing catalog reads the existing Shopify offline authority and uses the existing eBay refresh grant only to mint an in-memory, short-lived user token requesting the base Trading and `sell.inventory` scopes; it never returns, logs, or updates credential material.
- The server does not mount the legacy scheduler or cloud watcher. Shopify and eBay webhooks dispatch no sync, pipeline, listing, order, price, inventory, fulfillment, or watcher work. HMAC-valid Shopify receipts produce only a sanitized process log; unauthenticated eBay notifications receive a static no-op acknowledgement. Neither path parses or persists an evidence payload.
- Shadow server startup does not initialize, migrate, or seed SQLite. Legacy-ledger reads and the listing catalog's authority lookup require an existing database, open it read-only with SQLite `query_only`, and close it. The separate listing-control store is the sole runtime-local write boundary: it must be explicitly initialized as canonical schema version 2, and runtime never creates, migrates, repairs, or replaces it.
- The legacy CLI registers only `status`. Low-level eBay requests other than `GET`/`HEAD`, Shopify order creation, and Shopify inventory mutation fail closed at their adapter boundaries; legacy mutation services also deny at entry.
- The isolated operator CLI can reconcile only strict, redacted local version-2 evidence bundles and append local hash-chained audit evidence. Each source carries independent subject, method, bounded query, capture/as-of, pagination/count, freshness, and dataset-digest evidence; missing/partial sources block dependent responsibilities. It has no remote client or application-database adapter and cannot establish live parity.
- The isolated evidence-capture CLI is a separate live-read boundary. It can validate a clean reviewed build and ephemeral authority without network access, then collect one exact-account Shopify or eBay snapshot inside a recent half-open order window and publish one signed private local artifact. It has no OAuth acquisition/refresh, platform writer, order import, historical backfill, watermark, or ownership-transfer path. No live capture has occurred yet; fixture proof and signed-file integrity do not establish parity.
- The mounted listing catalog is a separate bounded read-only boundary. Each completed capture verifies the exact Shopify store/GID and read scopes, exact Production eBay seller `usedcameragear` through Trading `GetUser`, complete paginated Shopify variants, complete Trading active listings, and complete Inventory items/offers. Its union includes positive-stock Shopify variants, zero/unknown-stock variants that retain eBay state, and unmatched or SKU-less active eBay listings. The server refreshes one immutable completed capture every 60 seconds, verified Shopify webhooks trigger an additional read-only refresh, and browser views poll every 30 seconds. Evidence older than five minutes is projected only as Unknown, and a known failed refresh downgrades the prior snapshot to Unknown immediately. A source warning, partial page, wrong account, duplicate identity, malformed response, missing authority, or ambiguous SKU/artifact fails closed; filters never trigger separate remote censuses. Commerce Identity is not claimed by this release. No listing, order, inventory, price, policy, mapping, Marketplace Connect, or credential write is mounted.
- The cutover watermark remains unset, historical order backfill remains forbidden, and no current-source behavior authorizes a ProductPipeline order creation.

See `docs/WRITER_QUARANTINE.md` for the operator-facing contract, enforcement layers, and proof limits.

## 4. Test Lane

The Test Lane exists to accelerate safe implementation without turning production commerce into a test harness.

### Common controls

- Use isolated credentials and configuration where the platforms support them. Credentials remain outside the repository and must never appear in logs, fixtures, screenshots, or audit payloads.
- Default every tool and environment to read-only. A missing or ambiguous environment, store, seller account, ownership record, or allowlist entry must fail closed.
- Require explicit dry-run for every preflight and preview. Future mutation-capable code must treat absence of a scoped approval as denial, even when a caller passes `dryRun: false`.
- Allowlist the exact store, eBay environment/account, Shopify product/variant, SKU, listing/offer, responsibility, and permitted action. Wildcards and “all products/orders” are forbidden in test-write mode.
- Use one dedicated, unmistakably named test product/SKU and its test listing. Do not reuse an ordinary saleable SKU merely because its inventory is low or the listing is inactive.
- Approve one action at a time with a single-use, target-scoped, expiring approval record. Approval for create does not authorize revise, end, relist, inventory, price, order, or cleanup.
- Never backfill historical orders. Test fixtures and replay data are ineligible for Shopify order creation.
- No test may write a real Shopify order during the current migration phase.
- Append every preflight, denial, approval, attempt, result, and reconciliation to a durable append-only, hash-verifiable audit stream. Redact secrets and customer data.
- Re-read Shopify/eBay state after every permitted action and compare it with the expected result before the action is considered successful.
- Provide an immediate fail-closed disable that stops ProductPipeline writes without deleting evidence or replaying queued work.

### Sandbox/development tests

- Prefer an eBay Sandbox account and a Shopify development/test store isolated from Used Camera Gear production, if the required APIs and workflows are supported there.
- Use fixtures, recorded redacted responses, local databases, contract tests, and fake adapters for order creation, webhook replay, retries, duplicate detection, and failure recovery.
- A platform-supported sandbox listing/order may be exercised only after preflight proves the sandbox endpoints, store/account identity, allowlist, and zero route to production.
- Sandbox success proves code behavior in that environment; it does not prove production credentials, policies, inventory locations, webhooks, rate limits, or Marketplace Connect parity.

### Live-canary tests

- A real eBay listing or order is not intrinsically a harmless test. It is a live customer-facing object unless it is in an isolated platform-supported test environment.
- A live canary requires separate explicit approval naming the production responsibility, exact SKU/listing/order scope, expected mutation, observation window, owner being displaced, rollback action, and operator.
- Begin with one SKU and one responsibility. Listing creation, listing revision, price, inventory, order import, and fulfillment are separate canaries.
- Do not run a live order canary until the explicit cutover watermark, durable external-ID idempotency, single-writer proof, reconciliation, audit, and rollback gates have passed. Only a post-watermark order can be eligible.
- No live canary is authorized by this document or by successful local/sandbox tests.

## 5. Verified Current Architecture

The repository contains a TypeScript/Node application with Express 5, React 19/Vite, Shopify Polaris, SQLite through better-sqlite3/Drizzle, eBay and Shopify clients, a Commander CLI, and Railway/Docker configuration. It also includes committed `dist/` output, a Python/FastAPI `image-service/`, and a small `sync-agent/`.

Principal source areas:

- `src/safety/`: immutable migration ownership policy and centralized writer-quarantine controls.
- `src/ebay/`: authentication and eBay REST/Trading clients.
- `src/shopify/`: Shopify products, orders, and webhook helpers.
- `src/sync/`: product, order, inventory, price, fulfillment, listing, and AI pipeline logic.
- `src/server/`: Express application, read-only migration status, a strict shadow-read API, and non-dispatching webhooks.
- `src/operator-cli/`: isolated local preflight, ownership, snapshot reconciliation, and audit verification.
- `src/evidence-capture/`: isolated operator-run Shopify/eBay read collectors, strict network allowlists, signed local artifacts, and Marketplace Connect attestation verification. It is not imported by the mounted server, offline operator CLI, or commerce writers.
- `src/web/`: operator interface, including the read-only five-page migration control plane.
- `src/db/`: shared SQLite schema and initialization/migrations.
- `src/services/`: drafts, image processing, photo templates, eBay draft listing, TradeInManager, and related services.
- `src/watcher/`: StyleShoots/local/cloud photo ingestion.
- `image-service/`: separate image-processing service.
- `sync-agent/`: companion sync process.

The current application is not cleanly divided into listing and enrichment modules. Notable shared seams include:

- `src/server/routes/api.ts` mixes listing, order, mapping, image, test, and operational endpoints.
- The mixed legacy route modules remain in source, but `src/server/index.ts` does not mount them. It exposes only the shadow-read router plus health and non-dispatching/non-persisting webhooks; startup does not mount the scheduler or cloud watcher.
- `src/db/client.ts` creates and migrates both retained and legacy tables.
- `src/web/App.tsx`, navigation, settings, stores, and API hooks span both product directions.
- `product_drafts` supports both enrichment review and manual eBay listing preparation.
- `product_mappings` contains essential Shopify/eBay links plus automation metadata.

### Read-only Shopify walkthrough baseline — 2026-08-11

These facts were visible in the signed-in Shopify admin for `usedcameragear`. They are a time-specific operational snapshot, not a promise that the configuration remains unchanged.

**Marketplace Connect**

- The app was installed and reachable and displayed `eBay.com / usedcam-0`. This is dated UI evidence and is now a prior/stale label, not the current Production API identity; the 2026-08-13 identity incident below verified `usedcameragear` as the current seller.
- Its navigation exposed Listings, Mapping, Orders, Settings, and FAQ.
- The Listings grid exposed mapping, link-listings, bulk-edit, status, price, and inventory controls across a much broader catalog than ProductPipeline's local listing ledger.
- `Sync price` and `Sync inventory` were checked.
- New-listing `Auto categorization` was checked; `Auto-list products` was unchecked.
- Order import was set to `All orders` at status `Complete`, and recent eBay rows had Shopify order numbers. Marketplace Connect is therefore the verified current order importer.
- Its mapping surface covered sales, listing, payment, shipping, identifiers, condition, categories, and item specifics. Visible defaults included all inventory locations, condition `Used`, condition description from Shopify's `condition` field, and UPC from barcode.

**ProductPipeline**

- The unlisted Shopify app was installed and reachable.
- Shopify's app activity surface showed recent product view/edit activity and order-read activity; the dashboard showed repeated `products-update` events.
- The dashboard reported Shopify and eBay connected, while ProductPipeline Settings reported Shopify connected and eBay disconnected. The conflicting status indicators are not a safe ownership or connectivity gate.
- Products showed 191 catalog records: 137 active, 54 draft, 168 with descriptions, 29 with images, and one marked on eBay.
- The eBay Listings surface showed only two local records: one ended listing and one draft. It still exposed `Sync all products`.
- The Orders surface showed zero imported orders. The separate eBay Orders surface showed 277 historical local records, last imported February 18, 2026, zero synced to Shopify, and automatic import marked off for the Marketplace Connect cutover. It still exposed import and enable controls.
- The Pipeline surface showed 100 completed AI/image/draft jobs, including recent activity, and exposed a manual pipeline action.
- Settings showed auto-sync off, price and inventory selections on, AI description and image automation off, and OpenAI/PhotoRoom configured.
- The mapping UI overlapped Marketplace Connect across status, SKU, quantity, price, listing, payment, and shipping fields.
- The AI assistant exposed product sync, order sync, republish, and price-drop actions throughout the UI.

No control was changed and no sync, import, listing, mapping, save, or external mutation was triggered during the walkthrough.

## 6. Listing Capabilities to Retain

“Built” below means a code path exists and is wired. It does not prove credentials, deployment, remote state, or production fitness.

| Capability | Verified implementation | Current qualification |
|---|---|---|
| eBay authentication | Auth route source and token manager | Route is intentionally unmounted in shadow mode; existing-token validity is unknown |
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

## 7. Order-Sync Incident and Current Code

### Incident

On 2026-02-11, an order sync without a safe date boundary imported the eBay order history into Shopify. Those orders cascaded into Lightspeed. Repository documentation reports 259 duplicates and identifies overlap with historical Marketplace Connect/Codisto-created orders.

### Legacy order defenses retained behind quarantine

The legacy implementation still contains a 24-hour default lookback, a seven-day clamp, a persisted-cutoff check, dry-run default, local mapping checks, Shopify tag/note searches, heuristic duplicate matching, and process-local rate limiting. Regression tests cover cutoff behavior and one duplicate lookup path.

Those defenses are historical defense-in-depth, not the active authorization boundary and not evidence that ProductPipeline is ready to own orders. Their inner semantics still have known weaknesses: a caller can select `dryRun: false` without the stronger documented confirmation, some duplicate lookup failures fail open, rate limiting is process-local, and remote creation plus local mapping is not atomic.

### Current hard quarantine

- `syncOrders` denies at entry and `createShopifyOrder` independently denies before credential loading or network access.
- Every non-read `/api` request except the exact local-draft append is denied before route logic, so direct import/sync endpoints cannot initiate work. The exception has no order or provider capability.
- The scheduler is not mounted, the eBay notification endpoint is a non-parsing/non-persisting no-op acknowledgement, and the legacy CLI exposes no order action.
- The immutable policy has `historicalBackfillAllowed: false`, `cutoverWatermarkUtc: null`, and `externalWritesAllowed: false`.

These source controls neutralize the previously identified entry points while the quarantine is present, but they do not make the legacy importer cutover-ready. The replacement order module still requires a persisted explicit watermark, durable external-ID idempotency, one-writer proof, approval, remote reconciliation, immutable production audit evidence, and rollback before any separately authorized canary. Marketplace Connect subscription state, deployed commit/processes, and cross-system state remain unknown until read-only live verification.

## 8. Legacy AI and Product-Enrichment Scope

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

## 9. Target Architecture and Simple Operator UI

```text
Overview | Listings | Orders | Reconciliation | Settings
                         |
        owner + status + one primary action
             preview -> approval -> result
                         |
        fail-closed responsibility ownership gate
                         |
 durable jobs + external-ID idempotency + watermark + audit
                         |
       +-----------------+-----------------+
       |                                   |
Shopify adapter                         eBay adapter
       |                                   |
Shopify product/order truth            eBay listing/order truth

Marketplace Connect remains the incumbent owner for each
responsibility until that responsibility passes cutover gates.
```

Suggested module boundaries:

- `catalog`: read Shopify products/variants/images/inventory.
- `listings`: prepare, validate, publish, revise, end, and relist.
- `orders`: import only post-watermark eBay orders, retain external identities, and reconcile Shopify outcomes.
- `mappings`: explicit, reviewed Shopify-variant to eBay-offer/listing relationships.
- `reconciliation`: discover remote listings, compare state, queue exceptions.
- `ownership`: fail-closed, per-responsibility writer selection and cutover state.
- `sync-policy`: explicit price/inventory/fulfillment ownership and transformations.
- `jobs`: durable, retryable, idempotent mutations with per-item outcomes.
- `audit`: append-only, hash-verifiable operator/system event history.
- `platforms`: isolated Shopify and eBay authentication/API adapters.

### Proposed operational control plane

Every page must show the current owner, observed remote status, last reconciliation, unresolved exceptions, one primary action, any required review/approval, and a link to the audit history. Avoid dashboards that say “connected” without showing the evidence and timestamp behind the claim.

| Page | Operator purpose | One primary action | Safety behavior |
|---|---|---|---|
| **Overview** | See migration phase, connection evidence, owner by responsibility, health, and exceptions | Review exceptions | No quick-sync or bulk-write buttons |
| **Listings** | Compare Shopify products with authoritative eBay listing/offer state; prepare single-item changes | Review proposed change | Preview first; show owner, allowlist, before/after, approval, and result |
| **Orders** | See current importer, watermark, eligible post-cutover orders, duplicates, and reconciliation | Review pending imports | Historical rows are visibly ineligible; no arbitrary lookback or “import all” |
| **Reconciliation** | Resolve Shopify/eBay/Marketplace Connect/local-ledger discrepancies | Resolve selected discrepancy | One discrepancy/action at a time with post-action verification |
| **Settings** | View connections, ownership matrix, policies, Test Lane, audit, and break-glass state | Request ownership change | No secrets; ownership changes require gated workflow, not a bare toggle |

Remove or hide from the migration target: AI chat, AI prompts, description/image enrichment, PhotoRoom controls, pipeline execution, order-sync shortcuts, `Sync all products`, republish-all, price-drop-all, and any bulk action without preview, allowlist, approval, per-item result, audit, and rollback.

## 10. Staged Replacement and Decommission Plan

### Stage 0 — Baseline and ownership

- Export or record, read-only, the current Shopify products/orders, eBay listings/orders/offers, Marketplace Connect settings/mappings, and ProductPipeline ledgers needed for comparison. Redact customer data and secrets.
- Record the production owner for listing create/revise/end/relist, mapping, price, inventory, order import, fulfillment, feedback, and reconciliation.
- Inventory Railway services/processes, webhooks, schedules, Shopify app subscriptions, eBay notification subscriptions, credentials/configuration locations, and worker counts without changing them.
- Freeze baseline counts, external IDs, settings, exceptions, timestamps, and evidence locations so later parity claims are reproducible.

### Stage 1 — ProductPipeline shadow mode and writer quarantine

- Maintain one fail-closed shadow mode in which ProductPipeline can read or reconcile supplied evidence but cannot mutate Shopify or eBay.
- Keep eBay-to-Shopify order creation disabled across webhook, scheduler, chat, CLI, direct API, service, and adapter paths.
- Keep listing, price, inventory, fulfillment, republish, image-upload, and bulk mutation paths denied while Marketplace Connect owns production order import, price, and inventory and before any other responsibility is assigned.
- Keep the legacy scheduler/cloud watcher unmounted and webhook dispatch disabled; preserve only credential-safe process-log/no-op receipt observability.
- Preserve historical database data as evidence and keep every historical order ineligible for creation.

**Implemented in current source:** an immutable incumbent policy, broad non-read `/api` denial, unmounted authentication/scheduler/watcher paths, non-dispatching/non-persisting webhooks, a status-only legacy CLI, and service/adapter write gates. The UI exposes Overview, Listings, Orders, Reconciliation, and Settings as a read-only control plane. See `docs/WRITER_QUARANTINE.md`.

The isolated `product-pipeline-operator` entrypoint provides local `preflight`, `ownership`, `reconcile`, and `audit verify`. Strict config and version-2 evidence validation fail closed; reconciliation reads only normalized local evidence, reports independent source provenance and responsibility blockers, writes only digests/counts/decisions to the local hash-chained audit, and always reports no live proof, no production parity, zero external writes, no historical backfill, and no order-creation eligibility. The local audit is tamper-evident by tool behavior, not production-immutable. See `docs/OPERATOR_CLI.md` and `docs/READ_ONLY_PARITY.md`.

The separate `product-pipeline-evidence-capture` entrypoint provides only `preflight`, `collect`, and `verify`. Shopify collection permits three compiled Admin GraphQL query documents at API version `2026-07`; eBay collection permits only exact identity, Inventory/offer, and bounded Fulfillment `GET` endpoints. Every capture requires an exact scope digest, a clean reviewed source revision, recent `[start,end)` order bounds, ephemeral no-refresh authority, and a pinned signing key. Output is a canonical mode-`0600` local artifact that remains non-authorizing. eBay Inventory coverage excludes Trading-model/unmanaged listings, and Shopify `Order.app` attribution covers only the bounded order evidence. See `docs/AUTHORITATIVE_READ_CAPTURE.md`.

### Stage 2 — Durable safety foundation

- Replace the current all-writers quarantine with a reviewed per-responsibility ownership gate only when a separately authorized canary slice is ready; every future writer must pass through that gate.
- Persist external IDs, idempotency keys, the order cutover watermark, attempts, outcomes, approvals, and hash-verifiable audit events.
- Make jobs durable and concurrency-safe; retries and multiple workers must preserve exactly-once business effects.
- Assemble signed Shopify/eBay artifacts and a fresh independently signed Marketplace Connect attestation into the strict reconciliation evidence model with a reviewed exception queue. The source collectors and supplied-snapshot reconciler remain separate foundations until that translation is implemented and verified.
- Add contract tests for every denied and future write boundary, including webhook replay, restart, concurrency, and historical-order rejection.

### Stage 3 — Functional parity in shadow

- Split mixed startup/API/UI code into catalog, listings, orders, mappings, ownership, reconciliation, jobs, audit, and platform adapters.
- Implement the five-page operator control plane and a listing-owned draft model independent of AI enrichment.
- Compare ProductPipeline's proposed listing, mapping, price, inventory, order, and fulfillment results with Marketplace Connect and direct remote state without writing.
- Fix known listing defects and prove deterministic transformations with fixtures and contract tests.
- Produce accepted parity evidence and an explicit unresolved-exception list for each responsibility.

### Stage 4 — Sandbox and one-responsibility canaries

- Exercise the Test Lane in isolated sandbox/development environments where supported.
- Run one SKU and one responsibility at a time only after explicit approval, exact allowlisting, one-action approval, before/after capture, and rollback rehearsal.
- Disable Marketplace Connect only for the exact canary responsibility/scope after its parity gate passes; never permit two writers.
- Reconcile Shopify, eBay, ProductPipeline, and Marketplace Connect immediately after the action and through the observation window.
- Order canaries are last: only post-watermark orders, never historical records, and never a real Shopify order without separate live-canary approval.

### Stage 5 — Staged production cutover

- Require an accepted parity packet, clean reconciliation, owner-matrix signoff, support/rollback plan, and operator approval for the named responsibility.
- Transfer one responsibility at a time and record the exact cutover time, configuration evidence, new owner, old-owner disable proof, and observation results.
- Keep break-glass available and stop ProductPipeline on unexpected divergence; do not compensate with a broad replay.
- Disable Marketplace Connect globally only after every responsibility has verified ProductPipeline ownership and explicit approval.

### Stage 6 — Legacy removal and Marketplace Connect retirement

- Verify route, UI, CLI, import, scheduler, watcher, database, deployment, and traffic dependencies before removing AI/enrichment components.
- Remove legacy code and dependencies in small, buildable, reversible changes; retain/export historical audit evidence and defer destructive schema cleanup.
- Retire or uninstall Marketplace Connect only after completed reconciliation, observation, rollback closure, and a specific later user approval.

## 11. Verified Facts Versus Unknowns

### Verified in this repository snapshot

- The listing, order, enrichment, image, watcher, and TradeInManager domains coexist and are coupled.
- Current source hard-codes ProductPipeline to shadow read-only for external commerce, rejects every non-read `/api` call except exact local-draft append, unmounts the scheduler/cloud watcher, prevents webhook dispatch/payload persistence, exposes only legacy CLI `status`, and gates the low-level external writer boundaries described above.
- The mounted server does not initialize/seed the application database. Legacy ledger/authority lookups are file-must-exist, read-only, and query-only. The dedicated local-draft store is an explicitly initialized schema-version-2 append boundary only; missing, incompatible, unsafe, wrong-scope, or tampered state fails unavailable.
- The mounted Listings catalog performs a bounded request-time read of the exact Used Camera Gear Shopify shop and Production eBay seller `usedcameragear`. It completes Shopify variant, Trading active-listing, Inventory-item, and Offer pagination before publishing one 60-second in-memory snapshot; any incomplete or ambiguous source returns unavailable rather than a false status. The eBay refresh token is used read-only to mint a transient base-plus-`sell.inventory` token and is never rewritten. Seller binding is strict Trading `GetUser`; Commerce Identity is not claimed.
- The offline operator reconciler accepts only strict version-2 local evidence, validates source-specific provenance/completeness/freshness/digests, blocks ambiguous duplicate SKUs, appends redacted digest/count/decision evidence to the local hash-chained audit, performs zero external writes, and explicitly cannot prove live parity.
- The evidence-capture source, network, artifact, and CLI contracts remain isolated from writer code. Fixture verification covers exact identities, scopes, methods, hosts, paths, recent windows, pagination, record/byte limits, PII/secret rejection, signing, canonical private-file handling, and source-schema verification. The mounted catalog is not that artifact workflow: it returns a minimized live product/listing projection and performs no evidence-file or commerce write.
- The pure canary-readiness evaluator is not connected to the server, CLI, database, or platform adapters; it models one-target/one-responsibility prerequisites while always returning external writes and canary authorization false.
- Legacy order defenses and their inner failure risks remain in source behind the hard quarantine; they are not cutover-ready and must not be treated as an alternate write path.
- Listing CRUD/sync paths exist but important operator, reconciliation, correctness, and test gaps remain.
- Historical documentation contains stale intent and status claims, including that the repository still needs renaming.
- Existing current tests focus on image factory and order safety/deduplication; listing-management coverage was not found.

### Listing catalog seller-identity incident — 2026-08-13

- Fixed phase: the first complete catalog audit stopped at `LISTING_CATALOG_TRADING_CAPTURE_FAILED`. The reader expected the stale seller label `usedcam-0`, while strict Production Trading `GetUser` returned the current seller `usedcameragear`.
- Safety outcome: the reader failed closed before joining or publishing any partial catalog state. External writes were exactly zero; no listing, order, inventory, price, policy, mapping, Marketplace Connect, token, or credential record was changed, and no credential value entered the response or logs.
- Independent resolution: in the signed-in eBay UI, item `147502608418` showed **Your item is for sale** and **Revise listing**, its public store was **Used Camera Gear**, and its seller messaging URL contained `requested=usedcameragear`. This ownership evidence matches Trading `GetUser`. The older Marketplace Connect `usedcam-0` display is retained only as dated prior/stale evidence.
- Handling and prevention: the mounted catalog now pins exact seller `usedcameragear`; the pin was not relaxed or inferred from a token. Focused source regressions accept only that current seller and explicitly reject both `usedcam-0` and an unrelated account before Trading pagination or catalog projection can succeed. Browser failures remain generic and logs remain fixed-code only.
- Corrected proof: the same-source predeployment audit completed in 7,515 ms with zero external writes. Shopify captured 2,026 variants over 21 pages and retained 176 positive-stock rows; the join classified 111 Active, 44 Not listed, and 21 Needs attention. eBay captured 112 active entries over one Trading page, five Inventory items over one page, and five Offers over five per-SKU pages. These aggregate counts are one timestamped read, not deployment, parity, writer ownership, or cutover evidence.

### Verified in the 2026-08-11 Shopify walkthrough

- Used Camera Gear (`usedcameragear`) was the active Shopify store.
- Marketplace Connect displayed `usedcam-0`, imported all complete eBay orders, and had price and inventory sync enabled. The display value is a dated prior/stale label; it does not override the later verified Production seller identity `usedcameragear`.
- Marketplace Connect auto-listing of new products was off, but its listing grid and mapping controls were active and broad.
- ProductPipeline was installed and reachable, with recent product/pipeline activity, overlapping mapping/sync controls, 277 historical local eBay order records, and zero orders shown as synced to Shopify.
- ProductPipeline showed conflicting eBay connection indicators and exposed AI/pipeline and high-risk sync/bulk actions.
- The walkthrough was read-only and made no external mutation.

### Unknown until separately verified

- The public ProductPipeline Railway health endpoint served application revision `550cf2384a16e6f57f03d315643f3cc1337b4b7d` with the quarantine policy on 2026-08-11; any additional Railway services/processes and their revisions remain unknown.
- Outside the mounted catalog, current Shopify/eBay permissions, webhook registrations, eBay notification subscriptions, and all untested workflows remain unknown. The corrected predeployment catalog audit verified its exact Shopify shop with `read_products` and `read_inventory` and proved effective Production eBay Trading plus `sell.inventory` authority through successful complete reads; it did not inspect or authorize any broader scope. The separate evidence-capture CLI still had no collector configuration or supplied no-refresh ephemeral authority and did not run.
- Marketplace Connect's complete listing/link coverage, per-item exceptions, fulfillment/feedback behavior, and subscription-dependent capabilities.
- Which system currently owns listing creation/revision/end/relist in practice; the walkthrough verified Marketplace Connect's controls but did not audit every recent remote mutation.
- The cause of ProductPipeline's conflicting eBay connection indicators and the exact source of its recent product edits/pipeline jobs.
- The live value of `ebay_order_import_cutoff`, `auto_sync_enabled`, safety mode, drive mode, and scheduler settings.
- Whether local mappings match current eBay listings and Shopify variants.
- Current worker count, restart behavior, pending background jobs, and audit completeness.
- Business-approved listing templates, policies, condition rules, price rules, and inventory rules.
- Whether an eBay Sandbox account and an isolated Shopify development/test store support every required workflow for the Test Lane.
- Whether the reviewed authoritative-read collector can run with the required exact-account, no-refresh ephemeral authority in a clean operator-controlled checkout. Shopify's read-only GraphQL transport is a fixed semantic `POST`; eBay is exact `GET` only. Railway one-off placement is not configured by this release.
- Marketplace Connect has no documented public settings/listing API or complete native export in the official sources reviewed. Current UI/configuration evidence therefore requires a fresh exact-subject packet signed independently by a collector and reviewer, or a supported Shopify export. UI price/inventory toggles alone do not prove actual writer ownership.
- Historical source-artifact verification currently requires the original nonsecret configuration, pinned public key, and signed build context. A durable verification keyring/context archive is still required before these artifacts can serve as long-lived production audit evidence.
- Production parity for any responsibility. No parity or cutover claim is authorized yet.
- The order cutover watermark is deliberately `null`; its future value and event-time semantics require a separately reviewed and authorized order-cutover plan.

Unknowns are not permission to probe or mutate production. Resolve them with an explicitly scoped, read-only environment audit.

## 12. Agent Handoff and Update Protocol

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

## 13. Current Handoff

- Shopify credential-maintenance checkpoint: PR #15 merged as `579cc077a6ca4930fbfa88d415b80cc04c12d963` with exact-store current/previous-secret JWT and webhook verification plus the standalone compiled credential administrator. Shopify app version `productpipeline-read-only-8` (`1090140569601`) was released with exactly `read_products`, `read_orders`, `read_inventory`, and `read_fulfillments`; the merchant approved Update and the signed-in embedded app loaded afterward. Temporary rotation-ack deployment `77c18d72-e757-41be-8692-284d77f2490c` ran the fixed direct preflight, which returned only `database-denied` before any provider request. The acknowledgement variables were removed, and same-revision deployment `d44e6238-0072-4c8c-bbd3-df6929f6164d` is Active with one replica; public health at `2026-08-14T20:52:35.738Z` reported `ok`, `shadow-read-only`, external writes false, and historical backfill false. No access-token rotation, Production database write, proposal activation, commerce write, Marketplace Connect change, or Lightspeed effect occurred.
- Credential exposure containment: an attempted cutoff-only Railway change unexpectedly redeployed the prior single-secret release, so the operation immediately rolled back before provider dispatch. A broad Shopify credential-settings accessibility capture then exposed the unused staged secondary; it was revoked, replaced with a fresh secondary through value-blind control-plane handling, and the browser clipboard was cleared. No raw secret is retained in repository evidence. This incident remains open until the database gate is diagnosed, the reviewed fixed rotation completes, temporary variables are removed, old authority is revoked, and credential-free closure evidence is recorded.
- Credential-maintenance boundary: `credential-admin` pins the exact Production Railway project/environment/service, store/app, four canonical read-only scopes, `/data/ebaysync.db`, and the private backup directory. The mounted catalog consumes products/inventory reads, bounded evidence/order attribution consumes order reads, and fulfillment read authority is deliberately retained from the existing app/install contract; rotation makes no scope change. Its fixed sequence is current-token read-only verification, complete private logical-content-verified backup, one no-retry provider credential request, fresh-token exact-authority verification, full-row compare-and-swap, read-only reopen, and final provider verification. Output distinguishes one provider credential mutation from zero commerce writes and proves the temporary dashboard refresh token was not persisted to the database; the protected Railway variable remains operator-managed until explicit cleanup. It is not mounted/imported by the server and cannot write listings, orders, price, inventory, fulfillment, policy, mapping, Marketplace Connect, or Lightspeed state.
- Rotation-release proof boundary: the original hotfix passed focused 8-file / 88-test security checks, the full 54-file / 582-test suite, TypeScript no-emit, Production build, compiled command help and malformed-argument redaction checks, whitespace checks, and independent source review before merge. Deployment/health and signed-in embedded-app evidence are separately recorded above; they do not prove the blocked database preflight or token rotation.
- Database diagnostic deployed truth: exact option-free `diagnose-shopify-credential-database` passed fresh independent adversarial review with no P0/P1 on frozen 29-path manifest `c0a55f38073ca52c138c83635464f168e9245cd7a8c2fc58821ff0a31bf26e28`, merged as `a50ecfaa0e06cd4d215aba37c0858bf116b8f17c`, and deployed on `63bce306-5455-4c77-af7e-f441f4684b0b`, one replica. Public health at `2026-08-14T21:40:06.140Z` reported `ok`, `shadow-read-only`, external writes false, and historical backfill false. A direct Production run shortly afterward returned only `file-permissions-denied`: fixed target present, regular, non-symlink, single-link, nonempty, bounded, and not mode `0600`; parent, sidecar, descriptor, schema, integrity, and cardinality checks were not performed. All database/provider/credential/commerce effect counters were zero, and no exact command timestamp was separately captured. This proves only the first permission boundary and authorizes no repair, rotation, retry, rollback, or commerce write.
- Database permission-repair reviewed candidate: commit `c7835a47deae1cc46cb598fadedd06f0d4d26200` on PR #19 adds direct-only option-free `repair-shopify-credential-database-permissions`. It is unmounted and requires the exact Production/app/path binding, absent listing and rotation authority, explicit one-replica/one-volume assertions, fixed target/parent/sidecar proof, and one held `O_RDONLY`/`O_NOFOLLOW` descriptor. A source/runtime fence proves the current Dockerfile has no `USER` override and Railway starts the same image directly; the command requires exact effective UID `0` and stable file/parent UID/GID. Its sole possible mutation is exactly one descriptor-bound `fchmod(0600)`; it then syncs file/parent and proves identity/UID/GID/size/content-digest/mtime/path/sidecars before close. It contains no automatic rollback, restore, or second metadata-write path. Any post-invocation error, close ambiguity, third mode, owner/group change, growth, content drift, parent/path substitution, or sidecar drift remains explicitly unknown and must be classified with the option-free read-only diagnostic, health, and a DB-backed read without retry. Review returned HOLD on frozen manifest `9dea1b13eb22b65bfe79eb72a7f245af4e94c51168dd30bf54892223e85779c0` for missing mode CAS/GID and an enlarged rollback-read bound; both reviewers then returned HOLD on `337381468d3d316b940624e9d94c2f1eafce04f7634a978a11f6a394b298bd37` because the check-then-restore fchmod was still non-atomic. Both fresh independent reviewers returned GO with no P0/P1 on exact no-rollback manifest `fed26023563a49c1f8b4be10dce5d6ea41bad8a5bbf2c7958150af522d073f4c`, confirming the 6-file/142-test focused suite, 56-file/667-test full suite, TypeScript, build, parity, redaction, capability, and diff gates. It has no path chmod, shell/spawn, SQL/token-value, network/provider, credential, database-content, or commerce-write capability. Rebase integration, merge, deployment, repair topology variables, live repair, and post-repair diagnostic/health/DB-backed-read proof remain pending; no Production mutation occurred.
- Continuation checkout: use `/Users/chrismaxwell/Documents/Codex/2026-08-11/project-pipeline/work/product-pipeline-modern`, fetch `origin/main`, and require a clean status before editing. Do not reset, clean, or stage from the sibling `work/product-pipeline` checkout; it contains unrelated user/agent work.
- Latest verified listing result: the isolated, one-action Production canary published only `CAN3570-U119` to eBay listing `147502608418` (offer `234942877011`). Exact post-publish Inventory, Offer, and Trading evidence observed ACTIVE at `2026-08-13T16:43:19.281Z`; there was no create retry, unresolved dispatch, or rollback. This does not transfer order, price, or inventory-sync ownership from Marketplace Connect.
- Current application release slice: the authenticated Listings catalog continuously reconciles the complete exact-account Shopify/eBay capture into a union of in-stock Shopify variants, zero/unknown-stock Shopify variants with eBay state, and unmatched or SKU-less active eBay listings. `Active` requires one exact active listing with a compatible managed offer shape or a legacy Trading-only listing; `Not listed` requires zero exact-SKU active listings, Inventory items, and Offers; incomplete, stale, ambiguous, duplicate, near-collision, non-active-product, and unmatched states fail closed to Needs attention or Unknown. Server refresh is 60 seconds, browser polling is 30 seconds, and evidence older than five minutes cannot remain Active or Not listed.
- Mapping and draft workspace release: PR #10 merged the authenticated local-draft workspace as `e0d59cd904209c30e815f6cf6a2e4e784208efc5`. The source maps Shopify variant -> raw SKU -> management model -> offer -> listing, then allows a verified exact-store Shopify session to preview and append bounded local overrides through `GET`/exact `POST /api/listing-draft`; stale observations or revisions fail closed. The 2026-08-13 census found 112 active Trading listings but only five Inventory items and five Offers, so legacy Trading and Inventory/Offer controls remain separate.
- Scope boundary: the deployed release adds no generic publishing route, provider edit, approval, Apply, Publish, token persistence, order import, inventory or price synchronization, Marketplace Connect mutation, or automatic action. Exact local draft append is the sole non-read API exception; all other non-read API requests remain quarantined. Price and quantity remain visible/read-only under Marketplace Connect, while listing and mapping ownership remain unverified. Any provider action still requires a separate reviewed RBAC, approval/job authority, single-writer cutover, remote reconciliation, and rollback slice.
- Local store operations: on the existing one-replica Railway service and `/data` volume, `/data/product-pipeline` is mode `0700`; `listing-control.sqlite` was explicitly initialized and verified as schema version 2, `local_draft_only`, mode `0600`, with zero external writes. Runtime did not initialize, migrate, repair, or replace it. The verified pre-draft backup is `/data/product-pipeline/backups/listing-control-initial-e0d59cd.sqlite`, mode `0600`, 114,688 bytes, SHA-256 `40c89f9e9beeac1ac36c33822ca59b3cc9057b99d062811b79cb00c6e88b4fc7`. See `docs/LISTING_CONTROL_ADMIN.md`.
- Published application/runtime baseline: PR #11 repair `bab71a5` merged to `main` as `789dc7782cea5da33a5fddd8617d1c364cbb783e` at `2026-08-14T16:11:47Z`. Railway deployment `623f7eca-74ae-4ff8-8bec-99a761767793` succeeded with one replica and `/data`; public `/health` served that exact merge at `2026-08-14T16:13:06.046Z` with shadow read-only mode, external writes false, historical backfill false, and the provider-writer quarantine enabled.
- Closed live incident LWI-2026-08-14-001: the prior 100,000-byte cap rejected valid 147,595-byte and 144,209-byte eBay descriptions. The merged repair uses the reviewed 500,000-code-point / 2,000,000-UTF-8-byte parser/store boundary and passed 48 files / 504 tests, build, diff check, and independent review. Post-deploy admin verification returned schema version 2, `local_draft_only`, and zero external writes. See `docs/LISTING_WORKSPACE_INCIDENTS.md`.
- Signed-in workspace proof: Aputure variant `gid://shopify/ProductVariant/54881767358755`, SKU `APD0170A3B-OB`, and eBay listing `147232036779` opened a complete Mapping, Listing, Content, and Delivery workspace with a description summary and Edit control. No Save was clicked.
- Inspection boundary: repository source/history, exact public Railway health, single-replica `/data` deployment/store evidence, and the exact signed-in Aputure workspace above. This proves the deployed read/mapping/local-draft foundation for that observed item; it does not prove provider-write ownership or authorize a broader workflow.
- External access: this release used bounded read-only Shopify/eBay observations plus GitHub/Railway deployment and local-store administration. No Lightspeed, order, listing, price, inventory, Marketplace Connect, policy, mapping, credential, token, or other provider write occurred; only the dedicated local store initialization and verified baseline backup changed state.
- Prior runtime actions: the authorized PR #4 merge triggered the documented Railway auto-deploy. GitHub reported that deployment successful, and the credential-free public health endpoint served merge `57001ed777e5a75076cb159e306706eb7efd7d68` at `2026-08-11T21:39:11.891Z` with `shadow-read-only`, external writes and historical backfill false, a null cutover watermark, and remote verification not performed. Those statements describe that older release only. The expanded catalog's bounded read-only Shopify/eBay access is recorded separately above and must not be confused with a commerce write or ownership cutover.
- Durable objective: transform ProductPipeline into a safe, simple Marketplace Connect replacement with no historical duplicate-order imports, explicit staged cutover/reconciliation evidence, and operator-approved production migration.
- Accepted ownership baseline: Marketplace Connect remains the sole production owner for eBay-to-Shopify order import, price, and inventory until a separately authorized responsibility cutover. ProductPipeline is fail-closed and observation-only for them.
- Implementation status: the local operator CLI foundation, hard writer quarantine, strict authenticated shadow API, read-only five-page control plane, per-source provenance validation, strict offline snapshot reconciliation, isolated durable migration-state store, fixture-only read-contract harness, separate `migration-admin` init/verify CLI, and request-time redacted migration-state UI projection are merged. The new isolated evidence-capture slice adds exact-account Shopify and eBay readers, bounded recent order windows, no-refresh authority gates, strict redaction and pagination limits, canonical Ed25519-signed private artifacts, Marketplace Connect attestation verification, and an operator CLI with exactly `preflight`, `collect`, and `verify`. It is not mounted in the server or imported by a commerce writer. The full source and compiled build pass 36 test files / 341 tests, TypeScript, build, compiled CLI help, whitespace checks, and independent adversarial review with no slice-level P0/P1 findings. These are local contract proofs only; no source artifact has been collected.
- Local-draft release status: source/merge/deployment identity, single-replica `/data` topology, schema-version-2 initialization and post-repair verification, baseline backup, incident prevention tests, and signed-in affected-item workspace proof are evidenced. The foundation is Production-working for the observed read/mapping flow with the Edit control visible; opening and saving the local draft editor and every provider mutation remain unexercised.
- Corrected predeployment catalog evidence: one same-source live audit completed in 7,515 ms with zero external writes and captured Shopify 2,026 total variants / 21 pages / 176 positive-stock rows; classified 111 Active / 44 Not listed / 21 Needs attention; and captured eBay 112 active entries / one Trading page / five Inventory items / one item page / five Offers / five per-SKU pages. No row content, SKU, URL, seller identifier, credential, or token was emitted by the audit. This remains historical aggregate point-in-time read evidence; the current deployment and exact signed-in proof are recorded above.
- Observability boundary: browser responses remain a generic unavailable state and runtime logs may contain only fixed credential-free listing-catalog phase codes. Durable incident-ledger automation is not wired into this mounted server yet; before any automatic/multi-process incident writer is added, it needs the documented single-writer lock/versioning hardening. Operators must treat a repeated catalog phase code as a release incident and add its handling/regression before enabling a related write workflow.
- Current evidence result: a version-2 operator run generated at `2026-08-11T18:49:51.000Z` recorded the Marketplace Connect browser facts as partial and ProductPipeline/Shopify/eBay source snapshots as unavailable. It exited `2` with every responsibility unverified or blocked, zero external writes, no database access, no historical backfill, and no order eligibility. The hardened local audit verified at three records; reproducibility hashes and proof limits are in `docs/READ_ONLY_PARITY.md`. This is a blocked parity packet, not live proof.
- Durable-state foundation status: the separate store remains unwired to commerce/runtime writers. It models account-scoped external identities, immutable sandbox order watermark, monotonic cursors, idempotency intents and attempts, ownership versions, approvals, jobs, reconciliation exceptions, and tamper-evident audit evidence. Production scope is hard-limited to the accepted Marketplace Connect order/price/inventory baseline plus non-authoritative zero-write shadow evidence; it rejects a ProductPipeline watermark, ownership transfer, writer intent, approval/job, or canary. Fixture-only no-refresh GET/HEAD adapter contracts have no default network or credential path and can never claim live proof. The administration/projection release passed the full 247-test repository suite, TypeScript, production build, compiled artifact parity, and independent adversarial review with no slice-level P0/P1 findings.
- Current safe implementation gate: continue bounded provider-control work from the deployed read/mapping/local-draft foundation, one responsibility and exact target at a time. Marketplace Connect remains the order, price, and inventory owner. No generic two-way sync, Apply/Publish action, ownership transfer, Marketplace Connect change, persisted order watermark, live canary, or historical-order import is authorized without its own reviewed approval, idempotency, reconciliation, observation, rollback, and explicit cutover slice.

## 14. Goal Board — Coordinated Work Queue (2026-08-14)

This board is the coordinator-facing work queue. The user directs an agent to exactly one goal by ID; the agent must first follow the Section 12 protocol, then work only that goal's scope. A goal's presence here authorizes nothing by itself — each goal states its own authorization boundary, and every existing safeguard in Sections 1–13 still applies. When a goal finishes or its facts change, update its status here and record implementation detail in `PROJECT.md`.

### Situation summary as of `main` = `f0ca053` (2026-08-14)

**Done and deployed (evidence in Sections 3, 11, and 13):**

- ProductPipeline runs in enforced shadow read-only mode on Railway. Marketplace Connect remains verified owner of eBay-to-Shopify order import, price, and inventory.
- The authenticated five-page control plane, continuously reconciled live listing catalog (Shopify + eBay Trading/Inventory/Offer union), and local listing-draft workspace are merged and deployed. Exact `POST /api/listing-draft` is the sole non-read API exception.
- One isolated one-action Production listing canary succeeded on 2026-08-13: SKU `CAN3570-U119` published to eBay listing `147502608418` with clean post-publish reconciliation. This proves the one-SKU listing-create path end to end; it transferred no ownership.
- Incident LWI-2026-08-14-001 (description-length cap rejecting valid listings) is closed with a merged, deployed, regression-tested repair.
- The safety scaffolding is in place but not yet fed with live evidence: operator reconciliation CLI, evidence-capture CLI (`preflight`/`collect`/`verify`, fixture-proof only), inert durable migration-state store plus `migration-admin`, and the unwired canary-readiness evaluator.

**In flight / stale-record corrections:**

- Incident `SCR-2026-08-14-001` (Shopify credential rotation) has advanced but remains open. PR #15's dual-verifier release merged as `579cc07` and is deployed; Shopify app version `productpipeline-read-only-8` with exactly the four canonical read scopes was merchant-approved; the fixed rotation preflight ran on a temporary-ACK deployment and stopped at `database-denied` before any provider request; a staged-secondary secret exposure was contained (revoked and replaced value-blind). PR #18 (`a50ecfa`) merged the read-only diagnostic, which was deployed on `63bce306-5455-4c77-af7e-f441f4684b0b` and then returned only `file-permissions-denied`: the fixed target was present, regular, non-symlink, single-link, nonempty, bounded, and not mode `0600`; later checks were unperformed and every database/provider/credential/commerce effect counter was zero. The independently reviewed permission repair is committed as `c7835a4` on PR #19 and awaits integration, merge, deployment, one live run, and post-run proof. Runbook: `docs/SHOPIFY_CREDENTIAL_ROTATION.md` and `docs/RELEASE_MAINTENANCE_INCIDENTS.md`.
- The 2026-08-11 coordinator log records a nearly complete eBay Sandbox `pptest` Test Lane: dedicated Sandbox test user created, OAuth completed with a transient minimum-scope token, exact-SKU absence proven via Inventory and Trading reads, Sandbox policies/location created, an immutable fictional one-SKU manifest fixed, and the Shopify test product (`test product`, SKU `pptest`, Product `10327375642915`, Variant `55457882177827`) isolated as Draft, tagged `product-pipeline-test-lane`, with one labeled placeholder image. The lane paused at the final gates (durable rollback store and one-call Sandbox transport); whether the single Sandbox `listingCreate` ever executed is not recorded in this repository and must be treated as unknown. The Sandbox lane may be superseded by the successful Production listing canary above.
- Historical context: a legacy API key was committed to Git history (neutralized in source; legacy API keys no longer authorize anything), which is part of why the credential-rotation incident work exists.

### Goals

**G1 — Execute and close incident SCR-2026-08-14-001 (Shopify credential rotation).** Status: in progress, blocked at the exact Production file-permission gate; highest priority. The dual-verifier release is deployed and the read-only-scopes app version is merchant-approved, but rotation preflight stopped at fixed `database-denied` before any provider request. The merged read-only diagnostic then ran on deployment `63bce306-5455-4c77-af7e-f441f4684b0b` and returned only `file-permissions-denied` with every effect counter zero; it proved no later database boundary. The independently reviewed, one-fchmod/no-rollback permission repair is committed as `c7835a4` on PR #19 and awaits integration, merge, exact deployment identity, fresh one-replica/one-volume and no-authority gates, one option-free live run, and immediate diagnostic/health/DB-backed-read proof. Only after that proof may a separately reauthorized preflight → rotate → verify sequence, temporary-variable cleanup, old-secret revocation, new-only live proof, and a credential-free closure note proceed exactly per `docs/SHOPIFY_CREDENTIAL_ROTATION.md` and `docs/RELEASE_MAINTENANCE_INCIDENTS.md`. Neither diagnostic nor repair authorizes token rotation, retry, rollback, or commerce writes by itself. Time-sensitive: any cutoff variable must be freshly set at execution time; rollback is allowed only before the provider token-rotation request. Authorization boundary: Railway deployment, one fixed local mode repair, the read-only diagnostic, one provider credential mutation, and the exact stored-token row only; zero commerce writes; requires operator/user participation for Shopify partner and Railway access.

**G2 — Reconcile the Sandbox Test Lane record.** Status: reusable lane BUILT 2026-08-26; no live Sandbox run. The stale `pptest` implementation never landed on current `main` and its ignored local one-shot ledger could not safely prove replay protection. The replacement standalone `sandbox-listing-canary-admin` is target-parameterized, pins only Sandbox hosts, accepts bounded ephemeral authority only on stdin, pseudonymizes seller identity before a separate migration store, requires exact fresh Inventory/Offer/Trading state, and has distinct approval commands for create and cleanup followed by approval-consuming dispatch and post-dispatch reconciliation. Dispatch cannot issue its own approval. No seller ID or historical product is hardcoded. Remaining operator work: obtain fresh Sandbox authority and exact Shopify evidence, select one reviewed Draft test product, run preflight, separately approve create and cleanup, retain/verify the audit store, and record the observed zero-residue result. Any Sandbox write (including cleanup) still needs its own stated approval; never Production. Runbook: `docs/SANDBOX_LISTING_CANARY.md`.

**G3 — Exercise the local draft editor save path.** Status: local end-to-end proof complete (2026-08-14); one signed-in Production save remains as a documented one-click operator step. The committed regression `src/server/routes/listing-draft-save-exercise.test.ts` drives the exact mounted middleware chain — real rate limit, real HS256 App Bridge session verification for the pinned store (locally-minted signing secret), real quarantine, real bounded parser, real service — against a real on-disk store initialized and verified by the real `listing-control-admin`, proving the authenticated bounded append, stored actor-attributed revision, replay and remote-drift stale rejections (both `409`), revision CAS, and clean admin `verify`/audit chain. Proof transcript and the remaining Production step: `docs/LISTING_DRAFT_SAVE_EXERCISE.md`. Authorization boundary unchanged; no provider write occurred.

**G4 — First provider listing-revise slice (Apply/Publish from local draft).** Status: built and locally verified (2026-08-14); no dispatch has executed. The slice comprises: migration-store schema v2 (narrowed production allowances for exactly `revise_ebay_listing`/`listingRevise` — paused-genesis ownership chain, production-canary post-dispatch reconciliation, the append-only `listing_revise_observations` resolution predicate — with every other production denial unchanged and an explicit `migration-admin upgrade` path); and the isolated `listing-revise-admin` CLI (`preflight` / `establish-ownership` / `dispatch` / `reconcile`) with a bounded two-path Inventory-API write adapter, deterministic manifest digests, byte-exact price/quantity preservation, staleness and exact-target gates, durable single-use approvals/jobs/attempts, immediate post-action reconciliation, and a no-premature-`confirmed_missing` propagation policy. The server does not import or mount any of it; the workspace keeps `apply: false, publish: false`. `inventory_offer`-model targets only per the G5 strategy. Runbook: `docs/LISTING_REVISE_DISPATCH.md`; store contract: `docs/MIGRATION_STATE.md`. Remaining before the first live dispatch: merge + deploy of this slice, the G3 Production one-click save, Production migration-store init-or-upgrade plus `establish-ownership`, and the operator's one-action exact-target dispatch ceremony itself. Authorization boundary unchanged: each actual dispatch requires the execution-time one-action exact-target operator approval, and no price, inventory, or order ownership moves from Marketplace Connect.

**G5 — Trading-vs-Inventory listing management-model strategy.** Status: done (2026-08-14) — `docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md`. Recommendation: hybrid with migration deferred behind explicit gates. G4 manages `inventory_offer` listings only; the 107 Trading-model listings stay untouched under the incumbent because no Trading write exists in source, migration is irreversible, and Marketplace Connect's price/inventory behavior against a migrated listing is unverified. Trading-model interim revise (if demanded) and the one-listing migration canary are defined as separate future slices with their own gates and a per-listing risk classification. Authorization boundary respected: analysis only, no listing mutation.

**G6 — First live parity evidence packet.** Status: blocked on user-supplied inputs. Run the merged evidence-capture CLI for real: ephemeral no-refresh Shopify and eBay read authority, the pinned signing key, and a fresh independently signed Marketplace Connect settings/listing-link attestation are required, then assemble the signed artifacts into the strict reconciliation input and produce the first non-blocked parity packet per responsibility. Every parity, canary, and cutover claim downstream depends on this. Authorization boundary: read-only collection exactly as bounded by `docs/AUTHORITATIVE_READ_CAPTURE.md`; report missing authority as a blocker, never widen scope. Related: build the durable verification keyring/context archive (Section 11 unknown) so signed artifacts remain verifiable long-term.

**G7 — Price and inventory responsibility parity and canary readiness.** Status: blocked on G6. With live evidence, compare ProductPipeline's proposed price/inventory behavior against Marketplace Connect's, document divergences, and prepare (not run) the one-SKU price and inventory canary packets. Authorization boundary: no price or inventory write; Marketplace Connect settings untouched.

**G8 — Order-cutover foundation.** Status: blocked on G6 and separate explicit authorization; deliberately last. Produce the reviewed order-cutover plan: exact watermark value and event-time semantics, durable external-ID idempotency proof, single-writer disable proof for Marketplace Connect order import, reconciliation, observation, and rollback. The watermark stays `null` and historical backfill stays forbidden until this plan is separately approved. Authorization boundary: documentation and tests only; no order writer may be enabled by this goal.

**G9 — Legacy AI/enrichment decommission, stage 1.** Status: ready. Per Sections 8 and 10 (Stage 6): produce the verified dependency map (routes, UI, CLI, imports, scheduler, watcher, DB, deployment) for the enrichment components, then remove them in small buildable reversible changes, starting with the two priority quarantine targets (product-create webhook pipeline trigger and cloud-watcher pipeline start — both already unmounted, so removal is source cleanup). Defer destructive schema cleanup. Authorization boundary: repository-only changes; each merged slice must keep the full suite green and the quarantine contract intact.

**User priority (2026-08-14):** the user's stated near-term outcome is using ProductPipeline to push and manage eBay listings. The priority track is therefore **G3 → G4, with G5 alongside** (G5 matters because 107 of the 112 active eBay listings are legacy Trading-model objects the Inventory/Offer path cannot yet manage). G1 remains the outstanding security incident and should be executed as soon as the user can participate; it needs their Shopify/Railway access. Order-responsibility work (G6 → G7 → G8) stays gated and last, per the incident history. G2 and G9 are background housekeeping.

### Update 2026-08-19 — Full-capability authorization and Marketplace Connect replacement waves 1–2

**Authorization change (user, 2026-08-19, supersedes the 2026-08-14 gating above where they conflict):** the user granted full authority to bring ProductPipeline to complete Marketplace Connect capability — listing management, price sync, inventory sync, and eBay→Shopify order import — with exactly one absolute prohibition: **never import or backfill historical orders.** Every writer still sits behind an execution-time one-action exact-target operator ceremony, nothing auto-executes on deploy, and the one-writer-ever rule holds: each Marketplace Connect sync must be recorded off (with evidence) before ProductPipeline takes that responsibility.

**Shipped, merged, and deployed under that authorization (all on `main` = `2bcadc9`):**

- **PR #20** — the G3/G4/G5 track above merged and deployed; G4's listing-revise slice is live in source (no dispatch has ever executed).
- **PR #21 (wave 1)** — migration-store **schema v3** (`marketplace_connect_replacement_v3`): production allowances widened to exactly six actions (`revise/create/end_or_relist ebay listing`, `update_ebay_price`, `update_ebay_inventory`, `import_shopify_order`); Class A listing responsibilities keep paused genesis with marketplace_connect genesis permanently rejected; Class B (orderImport/price/inventory) require staged MC→paused→product_pipeline transitions with MC-disabled evidence; the **structural no-backfill clamp** (production order watermark valid only within one hour of establishment, enforced in SQL trigger and TS guard, strictly-greater eligibility, one watermark per scope forever); new `target_effect_observations` resolution table; every other denial (mapping, fulfillment, feedback) unchanged. Plus a bounded Trading-model revise adapter (ReviseFixedPriceItem with a structural no-StartPrice/no-Quantity assertion) extending G4 to the 107 legacy Trading listings, and transient in-memory eBay user-token providers (exact-scope-echo, fail-closed).
- **PR #22 (wave 2)** — three new standalone ceremony CLIs, never imported by the server: `listing-lifecycle-admin` (create: item PUT → offer POST → publish POST with durable resumable `CREATE_OFFER_UNPUBLISHED` handling; end: Trading EndFixedPriceItem / inventory withdraw), `price-inventory-admin` (MC-disabled-evidence ownership ceremonies, deterministic drift manifests, bulk_update_price_quantity / ReviseInventoryStatus adapters with price↔quantity cross-contamination assertions), and `order-import-admin` (ownership + clamped watermark ceremonies, PII-free observation polling on an exactly-scoped token, one-order-per-invocation import with Shopify `eBay-<id>` tag dedup, `write_orders` scope preflight failing closed, post-verify before link; `confirmed_missing` never automatic). Runbooks: `docs/LISTING_LIFECYCLE_DISPATCH.md`, `docs/PRICE_INVENTORY_DISPATCH.md`, `docs/ORDER_IMPORT.md`.

**Goal-status changes:** G4 is done and extended (revise for both models, create, end/relist all built and deployed; zero dispatches executed). G7's writer slices and G8's order-writer foundation are **built** — their remaining substance is activation evidence and operator ceremonies, not code. G6 (live parity evidence packet) remains blocked on user-supplied read authority and is now the main remaining verification gap rather than a build gap.

**Single activation entry point:** `docs/ACTIVATION_RUNBOOK.md` — the ordered operator sequence (store init/upgrade to v3, G3 one-click signed-in save, listing ceremonies, MC toggle-off evidence → price/inventory takeovers, `write_orders` app version + MC order-import-off → clamped watermark → per-order import) and the checklist of user-only steps. This container holds no provider credentials; every ceremony runs on the Railway box.

## 15. Brain Index — Task Router (read this, not everything)

Every agent starts with the Section 12 protocol (read `AGENTS.md`, this file's Sections 1–2 and 12, `PROJECT.md` changelog head, and `git log --oneline -20`). After that, read ONLY what your task needs:

| Task area | Read | Code |
| --- | --- | --- |
| Full-replacement path / what is next overall | `docs/REPLACEMENT_ROADMAP.md` (phases, exit checks, order) | — |
| Any provider write / activation step | `docs/ACTIVATION_RUNBOOK.md` (master operator sequence) | — |
| Listing revise dispatch (both models) | `docs/LISTING_REVISE_DISPATCH.md` (incl. branded template section) | `src/listing-revise-admin/` |
| Listing create / end / relist | `docs/LISTING_LIFECYCLE_DISPATCH.md` | `src/listing-lifecycle-admin/` |
| Reusable eBay Sandbox listing canary | `docs/SANDBOX_LISTING_CANARY.md` | `src/sandbox-listing-canary-admin/` |
| Price / inventory sync takeover | `docs/PRICE_INVENTORY_DISPATCH.md` | `src/price-inventory-admin/` |
| Orders (poll, shadow parity, import, cutover) | `docs/ORDER_IMPORT.md` — ABSOLUTE: never import historical orders (L11) | `src/order-import-admin/` |
| Migration-state store / schema / ceremonies | `docs/MIGRATION_STATE.md`, `docs/MIGRATION_ADMIN.md` | `src/migration-store/`, `src/migration-admin/` |
| Draft editor UI / workspace / drafts | `docs/LISTING_CONTROL_MODEL.md` (incl. "Editor picker metadata"), `docs/LISTING_CONTROL_ADMIN.md` | `src/web/`, `src/server/listing-draft-service.ts`, `src/server/routes/shadow-api.ts` |
| eBay description template | template section of `docs/LISTING_REVISE_DISPATCH.md` | `src/server/listing-description-template.ts` |
| Live listing census / read paths | `docs/AUTHORITATIVE_READ_CAPTURE.md`, `docs/READ_ONLY_PARITY.md` | `src/server/live-listing-catalog*.ts`, `src/server/enriched-listing-detail.ts` |
| Credentials / auth / 401s | `docs/SHOPIFY_CREDENTIAL_ROTATION.md`, `docs/RELEASE_MAINTENANCE_INCIDENTS.md`, Learnings L1/L8 | `src/shopify/request-verification.ts`, `src/config/credentials.ts` |
| Deploy / ops / "is it live" | Section 16, `docs/ACTIVATION_RUNBOOK.md` §0–1, Learnings L2/L10 | — |
| Goals / what to work on | Section 14 + its updates, Section 16 | — |
| Writer-quarantine invariants | `docs/WRITER_QUARANTINE.md` | `src/server/middleware/` |

**Self-building duty (mandatory):** before finishing any merged work an agent MUST (1) update the Section 14 goal statuses (or append a dated update subsection) if goal state changed, (2) append numbered entries to the Section 17 Learnings Log for anything a future agent would otherwise rediscover the hard way, (3) add a `PROJECT.md` changelog entry, and (4) touch the per-agent entry files (`AGENTS.md`, `CLAUDE.md`, `GROK.md`, `.cursorrules`) only if a safety absolute changed. Learnings are append-only; never rewrite or delete an existing entry.

## 16. State of the System — 2026-08-26

- **Deployed:** Railway auto-deploys `main` (current verified baseline `d195e9e7653ba059001784fe1ee601d48293bc3f`); domain `ebay-sync-app-production.up.railway.app`; volume `/data`; health endpoint reports `buildCommit`. Listing revise (Inventory + Trading), create, end/relist, price, inventory, new-order-only import, and the inert fulfillment/tracking ceremony are built and deployed behind standalone operator CLIs. Nothing dispatches on deploy or through the server.
- **Activated so far:** production migration store is schema v4 at `/data/migration-state/product-pipeline-migration-v1.sqlite`; listingRevise ownership is `product_pipeline` version 2. On 2026-08-26 the human operator executed the first ProductPipeline provider write: one exact Trading `ReviseFixedPriceItem` for Aputure variant `54881767358755` / eBay listing `147232036779`. Public eBay and a fresh raw `GetItem` prove the `ucg-branded-v1` description is live and byte-identical to the approved 10,144-byte HTML; price `$164.95` and quantity `5` remained unchanged. After the exact raw-HTML comparator deployed, the existing attempt reconciled to `revised_state_observed` / `resolved_existing` with zero additional provider writes. The migration-store audit chain verifies. Marketplace Connect still owns price, inventory, and orders.
- **G16 create incident (2026-08-27):** the first exact production create attempt made one Inventory PUT attempt and then freshly proved `created_state_absent` / `confirmed_missing`; eBay has no artifact. It must not be replayed. Source repair uses manifest v2 to keep the approved ≤4,000-character Inventory product description separate from the exact full branded Offer listing description, and binds required aspects plus `GTC`. Merge, deployment, a newly saved exact draft (including item specifics), and a new preflight/digest are required before the operator may retry.
- **Editor (rebuilt 2026-08-19/20):** metadata-driven pickers (condition dropdown, full-eBay-tree category search with used-categories section, policy/location dropdowns fed by a background facet sweep), sanitized rich-text description (shared allowlist `src/shared/listing-html.ts`), 80-char title counter, canonical item-specifics JSON for new-listing publish prerequisites, header-level "Preview eBay description" (branded template `ucg-branded-v1`, digest-bound at dispatch via `--description-template`).
- **Order shadow phase (current):** `order-import-admin shadow-poll` compares observed eBay orders against Marketplace Connect's Shopify imports by exact Shopify `sourceIdentifier`, with ProductPipeline's durable `eBay-<id>` tag as a second marker; it is read-only and needs no ceremony. A 2026-08-26 production probe found 11 recent eBay orders and proved the prior tag-only join invalid because Marketplace Connect uses generic tags but exposes the exact eBay Order ID as Shopify's source identifier. After the repair deployed, the same 24-hour window produced 10 exact matches, one unmatched, and zero blocked/ambiguous lookups (L17); this is not yet a clean parity day. Pre-fix reports do not count as clean days. Cutover checklist when parity holds: Shopify app release with `write_orders` → MC order import OFF (evidence) → ownership → watermark within one hour → per-order imports.
- **Remaining user-only steps:** observe Marketplace Connect price/quantity behavior on the G10 listing for 24 hours. Then G16 create/end lifecycle proof, MC toggle-offs for price and inventory, the order cutover above, and open incident G1 (Shopify credential rotation, Section 14 G1).
- **Deferred/scheduled:** eBay Business Policy management slice (view/edit policies, bulk reassignment; needs `sell.account` scope) — reminder scheduled 2026-09-01.
- **Sandbox test lane:** the reusable standalone create/reconcile/cleanup slice is built but has never been run against eBay Sandbox. Its deterministic create action digest binds the exact Shopify target/evidence and manifest across preflight, approval, dispatch, and recovery. Expired unused approvals can be replaced on the same intent; any attempted intent cannot. Reconciliation exact-compares every approved Inventory/Offer field plus Trading ItemID/SKU/content/commerce/status. Zero-write create recovery discovers response-lost IDs; partial create or cleanup residue can only enter a new separately approved cleanup intent bound to the outstanding source job/attempt/intent, never a replay. Cleanup proves the exact Trading listing ended while Inventory artifacts are absent. Preflight reports `prerequisites-partial` because Sandbox offers no bounded read proving category-condition compatibility before publish. It has no server wiring and no deploy-time effect. A live run remains separately operator-approved per action.

## 17. Learnings Log (append-only)

- **L1 (2026-08-20, auth):** Shopify signs App Bridge session tokens with the app's CURRENT client secret. The stalled rotation left Railway's `SHOPIFY_CLIENT_SECRET` holding a staged-new value Shopify never adopted → every API call 401'd app-wide. Fix: `SHOPIFY_CLIENT_SECRET` must hold the secret Shopify actually signs with; `SHOPIFY_PREVIOUS_CLIENT_SECRET` requires its `_EXPIRES_AT_UTC` pair (≤1h window) or must not exist — a half-set pair fails ALL verification. Diagnose by HMAC-checking a real session token against every env var (never print values).
- **L2 (2026-08-19, ops):** The Railway container filesystem is wiped every deploy; only `/data` persists. Durable state (migration store, reports) must use absolute `/data/...` paths. The deployed image lacks `.git`; `mkdir -p .git` in the app root satisfies the repo-root marker (package-name check is the real identity gate).
- **L3 (2026-08-20, eBay data):** Bulk census calls (GetMyeBaySelling ActiveList, offer pages) omit per-item category names and policy data for legacy Trading listings; per-item `GetItem` carries them. Pattern: bounded background enrichment sweep (≤150 listings, concurrency ≤3, 6h cache, never blocks a request) merged over snapshot facets.
- **L4 (2026-08-20, eBay rules):** eBay listing descriptions ban active content (no scripts/iframes/forms) and require https images. Any generated description must be deterministic so the dispatch manifest digest binds the exact bytes the operator approved.
- **L5 (orders):** Marketplace Connect/Codisto tags imported Shopify orders `eBay-<orderid>` — this is the dedup and shadow-parity join key.
- **L6 (tests):** The 11 `src/credential-admin` test failures are environmental to containers (uid/filesystem-permission assertions) and reproduce on clean bases — never "fix" them, never count them as regressions.
- **L7 (agents):** Parallel worktree agents may be cut from stale bases. Every agent brief must start with `git fetch origin main` + reset-if-behind, and the integrator must check `git merge-base` before merging; hand-graft small diffs when a branch predates a rebuild of the same file.
- **L8 (eBay auth):** Runtime eBay user tokens are minted transiently from the stored refresh grant with exact-scope-echo verification. Taxonomy APIs need only `api_scope` (already held). `sell.account` is NOT held — policy names/contents are unavailable until that scope is added (deferred policy slice). Order polling needs its own exchange with exactly `api_scope + sell.fulfillment`.
- **L9 (contracts):** The server draft validator and the web editor must share one HTML allowlist (`src/shared/listing-html.ts`). Any divergence (e.g. editor emits HTML the server rejects) breaks saves with 400s; change both sides through the shared module only.
- **L10 (ops):** When a merged feature "isn't there", check the Railway dashboard banner (platform incidents queue deploys) and compare `/health` `buildCommit` against the merge SHA before debugging code.
- **L11 (orders, ABSOLUTE):** Never import or backfill historical orders (user's one absolute prohibition; incident 2026-02-11). Enforced structurally: production watermark valid only within one hour of establishment (SQL trigger + TS guard), strictly-greater eligibility, one watermark per scope forever, per-order idempotency intents, `eBay-<id>` tag dedup. Do not weaken any of these layers.

### Update 2026-08-24 — Goal board refresh (G10–G15 added; stale statuses corrected)

**Status corrections to existing goals:** G3 is now fully DONE (the signed-in Production save was exercised 2026-08-20 during activation; auth chain live-proven). G4 is DONE and superseded by the extended slice set (revise both models, create, end/relist — all deployed; the first actual dispatch is now goal G10). G7's writer code is BUILT (see the 2026-08-19 update); its remaining substance folds into G11/G12. G8's order-writer foundation is BUILT; its remaining substance folds into G13 (the reviewed-plan requirement is satisfied by `docs/ORDER_IMPORT.md` + `docs/ACTIVATION_RUNBOOK.md` §5 and the structural clamp). G1 remains OPEN — the 2026-08-20 auth repair (Learnings L1: `SHOPIFY_CLIENT_SECRET` corrected to the provider-current value, stale previous-secret pair removed) is incident evidence, but the provider-side rotation itself never completed. G2, G6, G9 unchanged.

**G10 — First production listing-revise dispatch.** Status: DISPATCHED AND RECONCILED; 24-HOUR MC OBSERVATION PENDING. After a verified Railway volume backup and exact-scope schema v3→v4 upgrade, the human operator dispatched manifest `sha256:a5a3ef5cd453e5a7c2e64baa39595fdcf13900037d2650d11c35d5e588155bd7` for catalog `shopify-variant:gid://shopify/ProductVariant/54881767358755`, SKU `APD0170A3B-OB`, Trading listing `147232036779`. Exactly one provider write was attempted. Public eBay and a credential-free raw-read digest check prove the branded 10,144-byte HTML is live byte-for-byte; price `$164.95` and quantity `5` are unchanged. After the L14 comparator fix deployed, job `listing-revise-job:99ee5413-f8d0-4d8c-a9e8-81fbcaf228de` and its existing attempt reconciled authoritatively to `revised_state_observed` / `resolved_existing`; no second provider write occurred and the audit chain verifies. Remaining G10 observation gate: confirm Marketplace Connect leaves price and quantity correct for 24 hours.

**G11 — Price responsibility takeover.** Status: ready; user-gated. Sequence per `docs/ACTIVATION_RUNBOOK.md` §3: Marketplace Connect "Sync price" recorded OFF with evidence → `price-inventory-admin establish-ownership` (price) with baseline + MC-disabled evidence digests → per-target `plan` → `dispatch` → `reconcile`. Authorization boundary: price field only, one exact target per ceremony; inventory and orders untouched. Recommended after G10 proves the pipeline.

**G12 — Inventory responsibility takeover.** Status: ready; user-gated. Identical shape to G11 with the "Sync inventory" toggle and `--field quantity` (§4 of the runbook). Do separately from G11 — its own toggle, evidence, and ownership ceremony.

**G13 — Order responsibility takeover (shadow → cutover).** Status: shadow phase ACTIVE; production join repaired 2026-08-26; first corrected report NOT CLEAN (10/11 exact, 1 unmatched, 0 blocked). While Marketplace Connect keeps importing, the operator runs `order-import-admin shadow-poll` (read-only, no ceremony, PII-free; reports to `/data/shadow-reports/`) and accumulates parity reports (`unmatchedCount: 0` and `blockedCount: 0` after MC's normal delay = clean day). The first live 24-hour probe exposed that Marketplace Connect stores the eBay order ID as Shopify `sourceIdentifier`, not the ProductPipeline-only durable tag; the standalone adapter now exact-checks both markers, blocks fuzzy/paginated/ambiguous results, and ProductPipeline-created orders carry both. The remaining unmatched sale has a same-SKU/time eBay-channel Shopify order but no exact external ID, so it remains unmatched rather than being linked heuristically (L17). Cutover, only after a sustained clean stretch and in one sitting per runbook §5: Shopify app release with `write_orders` → MC order import OFF (evidence) → `establish-ownership` → `establish-watermark` within the one-hour clamp → per-order `import` ceremonies. ABSOLUTE: Learnings L11 (no historical orders) governs every step; the watermark is permanent. Authorization boundary: observations only until the cutover sitting; then one order per invocation, dual-marker deduped, post-verified.

**G14 — eBay Business Policy management slice.** Status: deferred by user decision (2026-08-20) to on-or-after 2026-09-01 (reminder scheduled). Scope when picked up: add `sell.account` read scope for policy names/contents in the pickers; then, separately gated, policy create/edit and bulk listing-reassignment ceremonies in the established writer pattern. Authorization boundary: nothing until the user re-engages the goal; scope widening needs its own approval.

**G15 — Branded description rollout.** Status: template built and previewable (`ucg-branded-v1`, header-level preview on every listing page); adoption is per-dispatch via `--description-template` (G10 onward). Possible future sub-slice, separately gated: deterministic cross-sell strip (snapshot-at-preflight) and any template revisions (new version string, never mutate `ucg-branded-v1`). Authorization boundary: template output is bound into the approved manifest digest; no independent write path.

**Current priority order (2026-08-24):** G10 → G11 → G12 → G13-cutover (after its shadow evidence), with G1 whenever the user can participate; G14 on its scheduled date; G2/G6/G9 background. Section 16 holds the matching system-state snapshot.

### Update 2026-08-24b — Full-replacement gap audit: G16–G21 added, G6 folded

Audit question: what does Marketplace Connect do that the board did not yet cover? Answers became goals. The ordered master plan with phase gates and checklists lives in **`docs/REPLACEMENT_ROADMAP.md`** — that document, not this list, is the execution order.

**G16 — First production listing-create and end/relist dispatches.** Status: first create attempted and safely terminalized absent; source repair complete pending merge/deploy/operator retry. The exact 2026-08-27 production attempt stopped on the Inventory-item PUT with one attempted write, no provider-reported dispatch, fresh `created_state_absent` / `confirmed_missing`, and no eBay artifact. Manifest v1 had serialized the 4,470-character branded HTML into eBay's 4,000-character Inventory product-description field. Manifest v2 now separately binds the approved base description (Inventory, ≤4,000) and complete branded HTML (Offer, ≤500,000), plus reviewed item specifics and `GTC`; fixed redacted failure stage/code and a truthful terminal status make the next diagnosis operator-visible without provider data. The completed v1 intent remains immutable and cannot replay. Remaining proof is a new exact v2 create after merge/deploy and a deliberate end/relist exercise, each with post-dispatch verification. Authorization boundary: one exact SKU per ceremony; the create target must not already exist on eBay.

**G17 — Fulfillment/tracking sync slice (Shopify → eBay).** Status: BUILT, MERGED in PR #32 (`2b48fcd`), and deployed inertly; not activated and no dispatch executed. Schema v4 widens exactly `fulfillment` as Class B (MC genesis and staged MC-disabled ownership), and standalone `fulfillment-tracking-admin` implements one complete Shopify fulfillment → one eBay shipping fulfillment with durable approval/attempt/target-effect reconciliation. Partial and split shipments are denied; tracking is never printed or stored raw. The server, webhooks, schedulers, and workers do not import it. Runbook: `docs/FULFILLMENT_TRACKING_DISPATCH.md`. Remaining: off-volume backup and explicit Production store upgrade/verification, recorded MC fulfillment-off evidence, ownership ceremony, then supervised full-order dispatches. Authorization boundary: nothing dispatches until those operator gates pass; G18 separately governs automation.

**G18 — Steady-state automation with guardrails.** Status: schema-neutral inert foundation built; no worker, journal, schedule, runtime wiring, authorization store, or provider path exists. The foundation fixes the only four automation responsibilities (`inventory`, `price`, `orderImport`, `fulfillment`), canonical policy bytes/digests, conservative compiled ceilings, explicit Lightspeed acceptance for order automation, and one exact global environment gate that defaults to stopped. It is not imported by the server, CLIs, migration store, credentials, or adapters and grants no authority. Replacing MC's continuous sync still requires relaxing "one operator action per write" for routine operations — a change that must be explicitly authorized per responsibility, never assumed. Remaining scope when authorized: scheduled bounded workers for (a) quantity alignment, (b) price alignment, (c) order poll+import, (d) fulfillment/tracking push — each: delta-only against verified state, per-run caps, rate limits, structural target restrictions identical to the ceremonies, a single kill switch (env flag + quarantine layer stays), full run journaling to the migration store, and daily digest reporting (G19). The no-historical-orders clamp (L11) binds automation exactly as it binds ceremonies. Authorization boundary: ENABLING each worker requires its own recorded user approval; this foundation enables nothing.

**G19 — Operational monitoring and daily digest.** Status: BUILT and deployed; first live migration-status observation exposed a source-level projection compatibility defect, and the strict repair is source-complete but not yet merged, deployed, or Production-verified. The authenticated Issues dashboard and `/api/monitoring/digest` project aggregate-only current job state plus one coherent previous-completed-UTC-day attempt cohort, reconciliation outcomes, and exception severities. That authenticated read warms a bounded redacted in-memory snapshot; public `/health` only reads the snapshot and explicitly reports unavailable before warm-up or stale after five minutes, never synchronously opening SQLite or scanning reports. The shadow reader requires an absolute, service-owned, non-symlinked mode-`0700` directory, then uses descriptor-bound, size-bounded `O_NOFOLLOW` reads and the exact 24-hour CLI contract; its timestamp is `arrivedAtUtc`, only local evidence. Generic catalog-read health uses cache status without triggering a provider read and is never labeled as authentication-specific. Migration blockers use a fixed exhaustive lower-kebab mapping, the strict server allowlist is unchanged, and schema-v4 Production projection recognizes `fulfillment` as Class B. No scheduler, worker, notification, persistence, or commerce/provider write is added. Skipped-write count remains explicitly unavailable until G18 supplies a run journal. Runbook: `docs/OPERATIONAL_MONITORING.md`.

**G20 — Data protection: backups and restore rehearsal.** Status: TOOLING BUILT; Production schedule and rehearsal operator-gated. The standalone `control-state-backup-admin` snapshots the app DB, listing-control store, migration store, and bounded shadow reports with SQLite online backup, exact SHA-256 manifests, private modes, different-device proof, and no-overwrite verification. Its restore command is rehearsal-only into a brand-new path and cannot replace `/data` or restore live state. It is unmounted and inert on deploy. A manual Railway volume backup was created before the 2026-08-26 schema upgrade, but it is not off-volume proof. Remaining: provision independent protected storage, configure and observe the external schedule, retain/alert per operator policy, and document one real restore rehearsal per `docs/CONTROL_STATE_BACKUP.md`. The migration store's hash-chained audit makes tamper evident; backups make loss recoverable.

**G21 — Marketplace Connect decommission.** Status: last, gated on all of G10–G13 + G16–G20 complete. Preconditions checklist in the roadmap: every responsibility owned by ProductPipeline with evidence, ≥14 clean days of automated operation with green digests, fulfillment verified on real shipments. Then: export/archive MC settings for records, uninstall the Marketplace Connect app, record the uninstall evidence here, close the board, and document the explicit NON-GOALS that remain manual in eBay itself (refunds/cancellations handling, buyer messages, feedback, promoted listings). Authorization boundary: the uninstall click is the user's alone.

**G6 folded (2026-08-24):** the formal signed evidence-packet machinery is superseded in practice — parity evidence now accrues per responsibility from operational artifacts (G13 shadow-poll reports, G11/G12 drift manifests, post-dispatch observations and reconciliation records in the migration store). The evidence-capture CLI remains available for extra rigor but is no longer on the critical path.

- **L12 (2026-08-25, fulfillment):** eBay `getShippingFulfillments` reports the returned tracking value as `shipmentTrackingNumber`, while `createShippingFulfillment` accepts `trackingNumber`. Full-order safety cannot be inferred from Shopify's order-level fulfillment status: compare the one successful fulfillment's per-line quantities against every order line, fail closed on pagination, and deny split/multiple fulfillments until a separately reviewed partial-shipment model exists.
- **L13 (2026-08-26, schema activation):** Deploying code that requires a newer migration-store schema is inert but makes ordinary migration-store opens fail closed until the operator upgrades the durable database. Listing preflight can still pass because it does not open the migration store; never mistake that preview for dispatch readiness. Railway Docker builds omit Git history, so package the reviewed mode-`0700` `.git` root marker plus the exact nonsecret production config before asking the operator to run backup → `verify` → exact-scope `upgrade` → `verify`. Never bypass `SCHEMA_MISMATCH` or upgrade after establishing the permanent order watermark without preserving current dedup/link state.
- **L14 (2026-08-26, listing reconciliation incident `REVISE_DESCRIPTION_PROJECTION_MISMATCH`):** A successful branded Trading revise was publicly live and raw `GetItem` returned HTML byte-identical to the approved manifest, but reconciliation reported `revised_state_absent`. Cause: `deriveListingDraftBasis` intentionally flattens provider description HTML for the editor, while `compareDispatchedState` compared that plain text to the manifest's raw HTML. Evidence: one provider write, preserved price/quantity, public branded description, equal raw/expected length and digest, and two append-only false-absence observations; no order path was touched. Recovery: never redispatch or accept absence; deploy exact raw-HTML reconciliation and reconcile the existing job/attempt. Prevention: descriptions compare exact raw provider HTML with XML newline normalization only, the raw digest is bound into the reconciliation result, and any value not provably before or exactly after is `partial`; regressions cover Inventory and Trading branded descriptions plus one-byte drift and `--accept-absent` denial.
- **L15 (2026-08-26, terminal reconcile replay):** Re-running `listing-revise-admin reconcile` after an attempt was already `resolved_existing` could complete a fresh provider read and append a duplicate authoritative reconciliation run/observation before the store rejected the second terminal resolution with `MIGRATION_STORE_CONFLICT`. It performed zero provider writes and did not alter the original resolution, but made an innocent operator retry confusing and added redundant evidence. Prevention: check the durable job state before reconciliation and deny terminal replays as `REVISE_ATTEMPT_ALREADY_RESOLVED`; regression asserts reconciliation counts and audit head remain unchanged.
- **L16 (2026-08-26, Marketplace Connect order identity):** Production disproved L5's assumed parity join: Marketplace Connect's Shopify orders carry generic tags rather than `eBay-<orderId>`, while the exact eBay Order ID is Shopify's originating-platform `sourceIdentifier`. A tag-only 24-hour shadow poll falsely reported 11/11 unmatched. Prevention: shadow parity, pre-import dedup, and post-dispatch verification exact-check both `source_identifier:<orderId>` and ProductPipeline's durable tag, reject pagination/fuzzy echoes/union ambiguity, and set both markers on ProductPipeline-created orders. Pre-fix tag-only reports are not clean-day evidence.
- **L17 (2026-08-26, first corrected G13 production report):** On deployed merge `88ff33a5c4c7c94fc5b0abd7d5bd56a8e62aff77`, the zero-write 24-hour shadow poll observed 11 eBay orders: 10 matched exact Shopify `sourceIdentifier`, one remained unmatched, and `blockedCount`, lookup failures, and ambiguity were all zero. Shopify Admin showed a same-SKU/time eBay-channel order for the unmatched sale but did not expose that eBay order ID anywhere on the order. Do not convert SKU/time/channel similarity into durable identity or dedup proof; leave it unmatched, observe the next report, and investigate Marketplace Connect before counting a clean day. The migration store stayed unchanged: no watermark, order ownership, observation, link, intent, or import.
- **L18 (2026-08-26, branded listing create):** Listing-revise template support does not automatically cover listing create: create has its own deterministic manifest, payload serializer, intent key, and recovery reconciliation. Apply the template before computing the create manifest digest, require the same version flag at preflight/dispatch/reconcile, serialize the identical HTML into both inventory-item and offer payloads, and compare the fresh raw provider HTML exactly with line-ending normalization only. Comparing the editor's flattened description or omitting the template during recovery derives the wrong desired state.
- **L19 (2026-08-26, backups):** A backup directory beside state on `/data` is not off-volume recovery, and raw copying a live SQLite main file can omit committed WAL state. Require the destination root to be on a different filesystem device, use SQLite's online backup API, bind every artifact in a deterministic digest manifest, and rehearse only into a new non-live path. Never overwrite a newer migration store: it may contain a permanent order watermark and dedup/audit state that cannot safely be reconstructed.
- **L20 (2026-08-26, operational monitoring):** A filesystem shadow-report timestamp proves only when that local file arrived, not when Shopify or eBay was observed; label it accordingly, bound its age, and never digest or expose the report's raw order IDs/SKUs. Also, a nonexistent worker skip journal cannot truthfully produce `skipped: 0`: keep it explicitly unavailable until G18 adds durable per-run journaling, then connect that journal before enabling any worker.
- **L21 (2026-08-26, monitoring proof boundaries):** A public liveness probe must not perform full SQLite integrity, audit-chain, and count scans; publish only a bounded redacted cache with explicit unavailable-before-warm-up and stale states, while an authenticated operator read may refresh it. Daily outcome totals must share one attempt cohort and cutoff so `succeeded + failed + unresolved = performed`; a post-midnight resolution cannot rewrite the completed-day classification. For report files, path checks alone do not bind bytes: open `O_NOFOLLOW`, compare descriptor identity before/after a bounded read, require the exact 24-hour CLI contract, and call filesystem mtime `arrivedAtUtc`, never an observation time.
- **L22 (2026-08-26, monitoring classification and directory trust):** A generic catalog-cache refresh failure does not prove authentication failed; label and count it only as `catalogReadFailures` until the cache carries a narrower typed cause. Descriptor binding protects report bytes after open, but directory discovery also needs a trust boundary: require an absolute, non-symlinked, current-service-owned mode-`0700` report directory and mode-`0600` regular single-link files, matching the operator runbook.
- **L23 (2026-08-26, projection vocabulary parity):** Never derive a redacted lower-kebab diagnostic code by interpolating a camel-case responsibility enum. The live G10 schema-v4 store verified through the operator CLI, but dynamic blockers such as `ownership-orderImport-unrecorded` violated the server's intentionally strict redaction allowlist and collapsed the dashboard to `MIGRATION_STATE_STORE_INVALID`; schema and audit values then appeared as safe sentinels rather than evidence of corruption. Use an exhaustive `Responsibility` mapping, keep Production projection responsibility classes synchronized with schema migrations (including schema-v4 `fulfillment`), and regression-test the actual store-to-request-reader path with production-shaped ownership, execution, reconciliation, and no-watermark state.
- **L24 (2026-08-26, automation sequencing):** Do not make the first G18 merge a migration-store schema bump. Per L13, deploying code that expects a newer schema makes current read and ceremony opens fail closed until an operator can back up and upgrade Production. Land the schema-neutral default-stop policy contract first; add the run journal only in a separately coordinated schema release with off-volume backup and exact `verify -> upgrade -> verify` operations.
- **L25 (2026-08-26, reusable Sandbox canaries):** A hardcoded test SKU/seller and an ignored local one-shot ledger do not make a reusable canary safe: a fresh checkout can lose replay history, and copied seller identity silently binds the wrong account. Pin Sandbox hosts in compiled code, require exact product/variant/SKU arguments and fresh identity reads, persist only a seller pseudonym in a separate durable migration store, record outcome-unknown before the first call, and make cleanup a second approved/reconciled action. Source/tests/deployment never prove that a provider run occurred.
- **L26 (2026-08-26, approval ceremony boundary):** A dispatch command that internally issues its own approval is not operator-gated, even when the intent/job/audit rows are durable. Preflight must derive the exact action/target/manifest digest, a distinct human-invoked command must record the short-lived approval, and dispatch may only consume the exact token/digest/intent. Create and cleanup require separate approvals; missing, wrong, expired, or replayed approval fails before any provider write.
- **L27 (2026-08-26, Sandbox exact-effect proof):** A published listing ID is not proof that the approved listing was published: reconcile every manifest effect (Inventory title/description/images/condition/note/quantity; Offer quantity/category/description/policies/location/price/currency/status/listing binding; Trading ItemID/SKU and supplied key values) and leave any one-byte drift unresolved. `GetSellerList` retains ended listings, so cleanup proves the exact ItemID is ended/completed while Inventory objects are absent rather than falsely requiring no historical SKU match. Cleanup approval must also require a successful reconciled create from the same durable state; matching a public Sandbox SKU alone is not deletion authority. Read private manifests through one `O_NOFOLLOW` descriptor with owner/mode/link/stability checks to close path races.
- **L28 (2026-08-26, unknown-outcome Sandbox recovery):** A response-lost offer or publish can succeed remotely while the CLI has no returned ID; requiring operator-supplied IDs makes the safety lane unrecoverable, and blindly repeating create or cleanup risks duplicate effects. Recovery must first rediscover one exact bounded remote projection, resolve only a fully exact create, otherwise report a fixed residue stage, and require a new exact approval bound to the original job/attempt/intent before deleting only the remaining offer/item. Cleanup history remains an ended Trading listing. Also enforce manifest mode exactly `0600` (not merely “no group/world bits”); `0400`, `0500`, and `0700` are not the documented contract.
- **L29 (2026-08-26, reconciliation evidence binding):** Job/attempt/intent/target/responsibility binding is insufficient when a recovery CLI accepts a digest: without comparing the reserved job's `approval_evidence_digest`, a caller can append reconciliation evidence under a different manifest/action/recovery digest. Every reconcile guard must exact-match that fixed job evidence before any reconciliation run is appended. Create intentionally keeps its immutable one-shot desired-state digest for replay prevention while its job approval evidence separately binds the exact action digest; recovery chains carry the source job's evidence digest into the next deterministic recovery digest.
- **L30 (2026-08-27, Inventory versus Offer description contract):** eBay requires `InventoryItem.product.description` before publish but bounds that product field to 4,000 characters, while the buyer-facing branded `Offer.listingDescription` can be larger. Sending one 4,470-character rendered value to both caused the first G16 create to stop at Inventory PUT; fresh reconciliation proved no artifact and terminalized the v1 intent `confirmed_missing`. Never truncate or replay it. Bind the exact approved pre-template product description and the exact full branded offer description separately in a new manifest schema/digest, and include the other documented publish prerequisites (`product.aspects`, `listingDuration`). Provider failures may expose only fixed stage/code enums; a terminal absence must say so truthfully.
