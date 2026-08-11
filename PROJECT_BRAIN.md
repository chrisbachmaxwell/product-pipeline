# Product Pipeline Project Brain

> Canonical orientation and handoff document for the Product Pipeline repository.
> Source behavior verified against `main` at `e6914f5657bf1d074dd8900ac7b6513f96654922` on 2026-08-11.
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

### Read-only Shopify walkthrough baseline — 2026-08-11

These facts were visible in the signed-in Shopify admin for `usedcameragear`. They are a time-specific operational snapshot, not a promise that the configuration remains unchanged.

**Marketplace Connect**

- The app was installed and reachable, connected to `eBay.com / usedcam-0`.
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

## 7. Order-Sync Incident and Current Code

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
- Marketplace Connect's exact webhook/subscription state, ProductPipeline cutoff value, deployed worker count, and cross-system reconciliation state remain unknown.

During migration, every ProductPipeline eBay-to-Shopify order-creation entry point must be unmounted or hard-disabled. A configuration toggle that one caller can bypass is not sufficient. The replacement order module must be rebuilt or isolated behind the watermark, durable external-ID idempotency, single-writer, approval, audit, reconciliation, and rollback gates before any canary.

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

- Add a single fail-closed shadow mode in which ProductPipeline can read/reconcile but cannot mutate Shopify or eBay.
- Hard-disable/unmount eBay-to-Shopify order creation, including webhook, scheduler, chat, CLI, and direct API paths.
- Remove or disable live listing, price, inventory, fulfillment, republish, and bulk mutation entry points while Marketplace Connect owns them.
- Stop unconditional product-create AI pipeline triggers and watcher-triggered publication.
- Unmount chat, AI pipeline, image-processing, and TradeInManager mutation routes before deleting code.
- Preserve historical database data read-only.

**Next owned implementation slice after human review:** build the repository-only operator CLI/preflight foundation for shadow mode. It may validate environment identity, print the ownership matrix, inventory local route/worker capabilities, produce redacted read-only snapshots, and append audit records. It must have no production mutation command. Application behavior changes, environment changes, deployment, and external-system access remain separately gated.

### Stage 2 — Durable safety foundation

- Implement the per-responsibility ownership gate and make every writer pass through it.
- Persist external IDs, idempotency keys, the order cutover watermark, attempts, outcomes, approvals, and hash-verifiable audit events.
- Make jobs durable and concurrency-safe; retries and multiple workers must preserve exactly-once business effects.
- Build authoritative Shopify/eBay discovery and reconciliation with a reviewed exception queue.
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
- The order safeguards and remaining bypass/failure risks described above are present in current source.
- Listing CRUD/sync paths exist but important operator, reconciliation, correctness, and test gaps remain.
- Historical documentation contains stale intent and status claims, including that the repository still needs renaming.
- Existing current tests focus on image factory and order safety/deduplication; listing-management coverage was not found.

### Verified in the 2026-08-11 Shopify walkthrough

- Used Camera Gear (`usedcameragear`) was the active Shopify store.
- Marketplace Connect was reachable on `usedcam-0`, imported all complete eBay orders, and had price and inventory sync enabled.
- Marketplace Connect auto-listing of new products was off, but its listing grid and mapping controls were active and broad.
- ProductPipeline was installed and reachable, with recent product/pipeline activity, overlapping mapping/sync controls, 277 historical local eBay order records, and zero orders shown as synced to Shopify.
- ProductPipeline showed conflicting eBay connection indicators and exposed AI/pipeline and high-risk sync/bulk actions.
- The walkthrough was read-only and made no external mutation.

### Unknown until separately verified

- Which commit is deployed and which Railway services/processes are active.
- Current Shopify/eBay token validity, scopes, webhook registrations, and eBay notification subscriptions.
- Marketplace Connect's complete listing/link coverage, per-item exceptions, fulfillment/feedback behavior, and subscription-dependent capabilities.
- Which system currently owns listing creation/revision/end/relist in practice; the walkthrough verified Marketplace Connect's controls but did not audit every recent remote mutation.
- The cause of ProductPipeline's conflicting eBay connection indicators and the exact source of its recent product edits/pipeline jobs.
- The live value of `ebay_order_import_cutoff`, `auto_sync_enabled`, safety mode, drive mode, and scheduler settings.
- Whether local mappings match current eBay listings and Shopify variants.
- Current worker count, restart behavior, pending background jobs, and audit completeness.
- Business-approved listing templates, policies, condition rules, price rules, and inventory rules.
- Whether an eBay Sandbox account and an isolated Shopify development/test store support every required workflow for the Test Lane.
- Whether the current build/tests pass in the deployment environment.
- Production parity for any responsibility. No parity or cutover claim is authorized yet.

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

- Repository baseline: `main` at documentation commit `7459f614561dfaaafd7e478f0d1905fd1023d88a`; source behavior baseline remains `e6914f5657bf1d074dd8900ac7b6513f96654922`.
- Inspection boundary: repository source/history plus the signed-in Shopify/embedded-app surfaces described above.
- External access: GitHub clone/read and documentation push are authorized. Shopify, Marketplace Connect, and ProductPipeline UI inspection was read-only. No direct eBay, Railway, Lightspeed, token, credential, or configuration access occurred.
- Runtime actions: no order import/sync, product sync, listing mutation, setting change, deployment command, build, or application execution.
- Durable objective: transform ProductPipeline into a safe, simple Marketplace Connect replacement with no historical duplicate-order imports, explicit staged cutover/reconciliation evidence, and operator-approved production migration.
- Current direction: Marketplace Connect remains the incumbent writer while ProductPipeline enters shadow mode, builds durable safety/reconciliation, proves one responsibility at a time, and receives explicit cutover approvals.
- Next owned implementation scope after review: the repository-only, non-mutating operator CLI/preflight foundation described in Stage 1. No application code work or deployment is authorized by this documentation change alone.
