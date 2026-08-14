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

It is not a free-form AI product-enrichment application or an autonomous commerce writer. AI description generation, image processing, chat-driven commands, StyleShoots ingestion, TradeInManager enrichment, and related automated publishing are legacy scope slated for staged removal. A separate bounded listing-proposal selector may choose only among verified Shopify, eBay, and saved-draft values for human local approval; it cannot invent facts, Apply, Publish, or write a commerce provider.

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
- Middleware denies every non-read request beneath `/api` with HTTP `423` before a legacy handler can run, except exact `POST /api/listing-draft` and exact `POST /api/listing-proposal`. The first may append one bounded local revision. The second may request one bounded OpenAI selection and append proposal/review state, including a human-approved local revision. Both require exact-store Shopify-session authentication and stale-base/revision checks; neither has a commerce-provider write, Apply, Publish, price, inventory, order, or ownership effect. Other legacy API reads return `404`.
- Production API authentication requires a cryptographically verified Shopify App Bridge session JWT for the exact app and Used Camera Gear store. Origin, Referer, query-string keys, and production API keys never authorize; test mode is available only when `NODE_ENV` is explicitly `test` or `development`.
- Shopify and eBay authentication routes are not mounted in the shadow application. The live listing catalog reads the existing Shopify offline authority and uses the existing eBay refresh grant only to mint an in-memory, short-lived user token requesting the base Trading and `sell.inventory` scopes; it never returns, logs, or updates credential material.
- The server does not mount the legacy scheduler or cloud watcher. Shopify and eBay webhooks dispatch no sync, pipeline, listing, order, price, inventory, fulfillment, or watcher work. HMAC-valid Shopify receipts produce only a sanitized process log; unauthenticated eBay notifications receive a static no-op acknowledgement. Neither path parses or persists an evidence payload.
- Shadow server startup does not initialize, migrate, or seed SQLite. Legacy-ledger reads and the listing catalog's authority lookup require an existing database, open it read-only with SQLite `query_only`, and close it. The separate listing-control store is the sole runtime-local write boundary. The AI-proposal source candidate requires canonical schema version 3 and runtime never creates, migrates, repairs, or replaces it; the last verified Production store remains version 2 pending an explicit stopped-writer administrative migration.
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
- Every non-read `/api` request except exact local appends to `/api/listing-draft` and `/api/listing-proposal` is denied before route logic, so direct import/sync endpoints cannot initiate work. The first stores a bounded draft; the second stores a bounded AI proposal or human local-review event. Neither exception has order, Apply, Publish, or commerce-provider capability.
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

This legacy-removal boundary does not include the new listing-control proposal selector. That selector is isolated from the enrichment pipeline: it receives bounded candidate previews and digests, selects only verified source/eBay/saved-draft lanes through a strict schema, has no tools or commerce credentials, and requires a human to approve the result locally. It cannot generate product claims or authorize Apply/Publish.

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

On an eligible listing detail, the bounded agent may automatically prepare one local proposal. Keep the surface sparse: proposal status, changed fields, warnings, **Adjust**, and one **Approve draft** action. Approval is local content review only; the UI must continue to say that eBay is unchanged and must not imply Apply or Publish authority.

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
- Implement the five-page operator control plane and a listing-owned draft model independent of legacy AI enrichment. A bounded evidence-selection assistant may sit on that deterministic draft model, but it cannot own facts or commerce actions.
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
- Current source hard-codes ProductPipeline to shadow read-only for external commerce, rejects every non-read `/api` call except exact local-draft and local-proposal/review actions, unmounts the scheduler/cloud watcher, prevents webhook dispatch/payload persistence, exposes only legacy CLI `status`, and gates the low-level external writer boundaries described above.
- The mounted server does not initialize/seed the application database. Legacy ledger/authority lookups are file-must-exist, read-only, and query-only. The AI-proposal source candidate requires a separately administered schema-version-3 listing-control append boundary; missing, incompatible, unsafe, wrong-scope, or tampered state fails unavailable. Version 3 adds local proposal/review evidence, not a commerce writer. Production remains verified only at version 2 until the explicit migration is run and proven.
- The bounded proposal agent uses a dedicated key and strict structured response to select among verified values for ten content/control fields. It has no tools or commerce credentials, cannot invent values, and leaves price, quantity, item specifics, and identifiers locked. A human approval appends a reviewed local revision; Apply and Publish remain absent.
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
- Whether the schema-version-3 listing-control migration, dedicated `AI_PROPOSAL_OPENAI_API_KEY`, reviewed deployment, and signed-in automatic proposal/local-approval workflow have been completed in Production. The current source candidate is not that proof.
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

- Continuation checkout: use `/Users/chrismaxwell/Documents/Codex/2026-08-11/project-pipeline/work/product-pipeline-modern`, fetch `origin/main`, and require a clean status before editing. Do not reset, clean, or stage from the sibling `work/product-pipeline` checkout; it contains unrelated user/agent work.
- AI listing-proposal source candidate: an eligible listing detail automatically requests one evidence-bound proposal; the agent may select only verified Shopify/eBay/saved-draft values for title, category, condition, condition description, description, images, three policy IDs, and merchant location. The operator reviews changed fields and may approve a `reviewed` local revision. Price, quantity, item specifics, and identifiers remain locked; Apply, Publish, commerce-provider writes, and ownership transfer remain absent. Proposal state is append-only, digest-bound, and stale after a source, eBay, or local-revision change. A queued/generating job older than five minutes is shown as failed; only a manual retry may terminalize it and create a new deduplicated job, while recovery polling is bounded to 30 seconds. The agent has no tools or commerce credentials and uses a dedicated OpenAI key plus a strict schema.
- AI proposal rollout gate: current source passed 54 test files / 574 tests, production build, diff check, compiled parity, and independent review with no remaining source P0/P1. It requires listing-control schema version 3 and explicit `upgrade-v2-v3`; the verified Production store remains version 2 and `AI_PROPOSAL_OPENAI_API_KEY` is absent. A stopped-writer backup/migration/verify window, dedicated AI configuration, deployment evidence, and signed-in automatic proposal/local-approval verification have not been performed. See `docs/AI_LISTING_PROPOSALS.md` and `docs/LISTING_CONTROL_ADMIN.md`.
- Latest verified listing result: the isolated, one-action Production canary published only `CAN3570-U119` to eBay listing `147502608418` (offer `234942877011`). Exact post-publish Inventory, Offer, and Trading evidence observed ACTIVE at `2026-08-13T16:43:19.281Z`; there was no create retry, unresolved dispatch, or rollback. This does not transfer order, price, or inventory-sync ownership from Marketplace Connect.
- Current application release slice: the authenticated Listings catalog continuously reconciles the complete exact-account Shopify/eBay capture into a union of in-stock Shopify variants, zero/unknown-stock Shopify variants with eBay state, and unmatched or SKU-less active eBay listings. `Active` requires one exact active listing with a compatible managed offer shape or a legacy Trading-only listing; `Not listed` requires zero exact-SKU active listings, Inventory items, and Offers; incomplete, stale, ambiguous, duplicate, near-collision, non-active-product, and unmatched states fail closed to Needs attention or Unknown. Server refresh is 60 seconds, browser polling is 30 seconds, and evidence older than five minutes cannot remain Active or Not listed.
- Mapping and draft workspace release: PR #10 merged the authenticated local-draft workspace as `e0d59cd904209c30e815f6cf6a2e4e784208efc5`. The source maps Shopify variant -> raw SKU -> management model -> offer -> listing, then allows a verified exact-store Shopify session to preview and append bounded local overrides through `GET`/exact `POST /api/listing-draft`; stale observations or revisions fail closed. The 2026-08-13 census found 112 active Trading listings but only five Inventory items and five Offers, so legacy Trading and Inventory/Offer controls remain separate.
- Scope boundary: current source adds no generic publishing route, provider edit or approval, Apply, Publish, token persistence, order import, inventory or price synchronization, or Marketplace Connect mutation. Its only automatic action is one bounded local proposal attempt for an eligible observed listing, and its human approval creates only a reviewed local revision. Exact local draft and proposal/review appends are the only non-read API exceptions; all other non-read API requests remain quarantined. Price and quantity remain visible/read-only under Marketplace Connect, while listing and mapping ownership remain unverified. Any provider action still requires a separate reviewed RBAC, approval/job authority, single-writer cutover, remote reconciliation, and rollback slice.
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
