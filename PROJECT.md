# ProductPipeline — PROJECT.md

> **Last updated: 2026-08-24. Any agent working on this project MUST update this file before finishing.**
>
> **Current direction:** `PROJECT_BRAIN.md` is the canonical project orientation and safety boundary. This file retains detailed architecture, historical intent, decisions, and changelog context. Where they conflict, follow the brain and verify current source.

## 1. Project Overview

**ProductPipeline** (formerly "ebay-sync-app" / "Product Bridge") currently contains a broad listing, order-sync, AI-enrichment, image-processing, and ingestion application for **Pictureline's UsedCameraGear.com** store. Its authorized target is a safe, simple replacement for Shopify Marketplace Connect's Used Camera Gear eBay integration. Marketplace Connect is the verified current order importer and price/inventory synchronizer; it remains the incumbent until ProductPipeline passes the per-responsibility gates in `PROJECT_BRAIN.md`. AI/product-enrichment scope is slated for staged removal.

**Enforced current-source posture:** ProductPipeline is hard-coded to `shadow-read-only` for external commerce. Exact `POST /api/listing-draft` is the sole non-read exception and can append only a bounded local revision after exact-store Shopify-session authentication and stale-base checks. Every other non-read `/api` request is denied; provider writers, background writers, and webhook dispatch remain quarantined. See `docs/WRITER_QUARANTINE.md`. This is source behavior, not deployment or live-parity proof.

**What it does:**
- Watches a StyleShoots network drive for new product photos → auto-uploads to Shopify
- Generates AI product descriptions via OpenAI GPT
- Processes product images (background removal, templates) via self-hosted service or PhotoRoom API
- Syncs products, inventory, prices, and orders between Shopify and eBay
- Provides a web dashboard for review, approval, and management
- Integrates TradeInManager condition data into listings
- Draft/staging system with review queue before publishing

**Business context:** Pictureline photographs used camera gear on a StyleShoots machine. Products flow from Lightspeed POS → Shopify → need AI descriptions + processed photos → eBay listings. This app automates that entire pipeline.

**Current eBay seller:** usedcameragear (https://www.ebay.com/usr/usedcameragear). The older `usedcam-0` label is retained only in dated historical evidence and must not be used as the current API identity pin.
**Shopify store:** usedcameragear.myshopify.com

## 2. Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Express 5 + TypeScript (ESM) |
| **Frontend** | React 19 + Vite 7, Shopify Polaris, TailwindCSS 4, Zustand, React Query |
| **Database** | SQLite via better-sqlite3 + Drizzle ORM |
| **AI** | OpenAI API (GPT for descriptions, category suggestions) |
| **Image Processing** | Self-hosted Python service (FastAPI) OR PhotoRoom API (factory pattern) |
| **CLI** | Commander.js (`ebaysync` binary) |
| **Deployment** | Railway |

### Directory Structure

```
src/
├── cli/            # CLI commands (ebaysync)
├── config/         # Credential loading (~/.clawdbot/credentials/)
├── db/             # SQLite database + Drizzle schema
├── evidence-capture/ # Isolated exact-account Shopify/eBay reads + signed local evidence
├── ebay/           # eBay API clients (REST: fulfillment, inventory, browse, trading)
├── migration-store/ # Explicit, separate migration control-plane persistence (unwired)
├── operator-cli/   # Isolated local preflight, ownership, reconciliation, audit
├── safety/         # Immutable incumbent policy and writer quarantine
├── shadow-read/    # Fixture-only GET/HEAD and bounded-read contract (unwired)
├── server/         # Express server + routes + middleware
│   ├── routes/     # API endpoints (15+ route modules)
│   ├── middleware/  # Auth (API key + rate limiting)
│   └── capabilities.ts  # Auto-discovery registry for chat + UI
├── services/       # Business logic services
│   ├── image-service-factory.ts  # Factory: self-hosted vs PhotoRoom
│   ├── local-photoroom.ts        # Self-hosted image service client
│   ├── photoroom.ts              # PhotoRoom API client
│   ├── draft-service.ts          # Draft/staging/approval workflow
│   ├── tim-service.ts            # TradeInManager API client
│   ├── tim-matching.ts           # Match TIM items to Shopify products
│   ├── tim-tagging.ts            # Auto-tag products with TIM conditions
│   ├── photo-templates.ts        # Photo processing templates
│   └── image-processor.ts        # Image processing orchestration
├── shopify/        # Shopify API (GraphQL + REST)
├── sync/           # Sync engines (orders, products, inventory, prices, fulfillment)
│   ├── auto-listing-pipeline.ts  # Main pipeline: AI desc + images + eBay category
│   ├── category-mapper.ts        # Shopify → eBay category mapping
│   ├── listing-manager.ts        # eBay listing CRUD
│   └── pipeline-status.ts        # Job tracking
├── utils/          # Logger, retry with backoff
├── watcher/        # StyleShoots folder watcher (chokidar)
│   ├── index.ts         # Main watcher loop
│   ├── folder-parser.ts # Parse folder names for product info
│   ├── stabilizer.ts    # Wait for folder to stop changing (30s)
│   ├── shopify-matcher.ts # Fuzzy match folders → Shopify products
│   ├── shopify-uploader.ts # Upload images to Shopify
│   ├── drive-search.ts  # Search StyleShoots drive for product photos
│   └── watcher-db.ts    # Watch log persistence
└── web/            # React frontend
    ├── pages/      # Dashboard, Pipeline, ReviewQueue, ReviewDetail, Listings,
    │               # ShopifyProducts, EbayOrders, Orders, ImageProcessor,
    │               # CategoryMapping, Analytics, Settings, Help*, Feature*
    ├── components/ # PhotoGallery, ChatWidget, TemplateManager, etc.
    └── store/      # Zustand state management
```

### Self-Hosted Image Service

Located at `~/projects/product-pipeline/image-service/` — a separate Python FastAPI app:
- Background removal (rembg or similar)
- Image processing (resize, pad, shadow)
- Template rendering
- Docker-based deployment
- Concurrency-controlled with semaphores
- Health/metrics endpoints

### Database Schema (SQLite)

| Table | Purpose |
|-------|---------|
| `auth_tokens` | OAuth tokens for Shopify + eBay |
| `product_mappings` | Shopify ↔ eBay listing links, cached prices/SKUs |
| `order_mappings` | eBay → Shopify order dedup |
| `sync_log` | Audit trail of all sync operations |
| `product_pipeline_status` | AI description + image processing status per product |
| `pipeline_jobs` | Pipeline job queue with step tracking |
| `product_drafts` | Draft/staging system for review before publish |
| `auto_publish_settings` | Per-product-type auto-publish rules |
| `styleshoot_watch_log` | Folder watcher activity log |
| `field_mappings` | Category, condition, field mappings (Shopify ↔ eBay) |
| `photo_templates` | Saved image processing parameter templates |
| `image_processing_log` | Per-image processing status and results |

DB location: `src/db/product-pipeline.db` (development); `/data/ebaysync.db` is the current Railway Production legacy-database contract. The older `~/.clawdbot/ebaysync.db` path is stale local-era documentation, not a Production target.

## 3. Current State

### Feature Status

> Historical implementation inventory, not proof of current production fitness, ownership, or parity. External mutation features marked “Working” below are legacy code paths currently blocked by the hard writer quarantine; the scheduler/watcher are not mounted, webhooks dispatch no work, and the legacy CLI registers only `status`. The enforced behavior and 2026-08-11 live walkthrough are recorded in `PROJECT_BRAIN.md` and `docs/WRITER_QUARANTINE.md`.

| Feature | Status | Notes |
|---------|--------|-------|
| **StyleShoots Watcher** | ✅ Working | Watches `/Volumes/StyleShootsDrive/UsedCameraGear/`, auto-uploads to Shopify |
| **AI Descriptions** | ✅ Working | OpenAI GPT generates product descriptions with TIM condition data |
| **Image Processing** | ✅ Working | Factory pattern: self-hosted (preferred) or PhotoRoom fallback |
| **Draft/Review System** | ✅ Working | Full approval workflow with review queue UI |
| **eBay Order Import** | ✅ Working | eBay → Shopify with dedup (DB + tag-based) |
| **Product Sync (→ eBay)** | ✅ Working | Shopify → eBay listing creation |
| **Draft → eBay Listing** | ✅ Working | Approve draft → create live eBay listing from review queue |
| **Inventory Sync** | ✅ Working | Shopify → eBay quantity sync |
| **Price Sync** | ✅ Working | Shopify → eBay price sync |
| **Fulfillment Sync** | ✅ Working | Shopify → eBay shipping updates |
| **TIM Integration** | ✅ Working | Fetches condition data, auto-tags Shopify products |
| **Photo Templates** | ✅ Working | Saveable processing presets per category |
| **Chat Widget** | ✅ Working | AI-powered help chat with capability awareness |
| **Category Mapping UI** | ✅ Working | StyleShoots preset → Shopify/eBay category mapping |
| **Manual Pipeline Trigger** | ✅ Working | Drive search + draft product support |
| **Web Dashboard** | ✅ Working | Full React UI with Polaris components |
| **Help Center** | ✅ Working | Built-in help system with admin |
| **Feature Requests** | ✅ Working | User-facing feature request/voting system |
| **eBay Notifications** | ✅ Implemented | Webhook endpoint for eBay platform notifications |
| **Analytics** | ✅ Basic | Recharts-based analytics page |

### Recent Work (git log)

1. **Self-hosted image processing** — Factory pattern for local vs PhotoRoom (latest)
2. **Manual pipeline trigger** — Drive search + draft product support
3. **TIM condition tags** — Auto-tag Shopify products with trade-in condition data
4. **TIM integration** — Fetch condition data from trades.pictureline.com
5. **Review queue redesign** — Full-page Shopify-style review detail
6. **Product dedup fix** — 105 duplicate products from Shopify API
7. **eBay Orders import** — Browse + import eBay orders
8. **Product Notes** — Notes feature for products
9. **Pipeline review modal** — Inline approve description, photos, eBay listing

### Known Issues

- CORS still references old Railway domain (`ebay-sync-app-production.up.railway.app`)
- Logs page disabled (`.tsx.bak`)
- GitHub repo not yet renamed from original name

## 4. Key Integrations

### Shopify API
- **Client:** `@shopify/shopify-api` (GraphQL + REST)
- **Store:** usedcameragear.myshopify.com
- **Auth:** OAuth flow via `/auth/shopify` routes, tokens stored in DB
- **Operations:** Products CRUD, image upload, order creation, inventory management, metafields
- **Webhooks:** Product create/update/delete at `/webhooks/shopify`

### eBay API
- **Auth:** OAuth2 with token auto-refresh (`token-manager.ts`)
- **APIs used:** Fulfillment (orders), Inventory (items + offers), Browse (search), Trading (account/policies)
- **Current seller:** usedcameragear (`usedcam-0` was a prior/stale Marketplace Connect display label)
- **Webhooks:** Platform notifications at `/webhooks/ebay`

### Image Processing
- **Primary:** Self-hosted FastAPI service (`image-service/`) — background removal, processing, templates
  - URL configurable via `IMAGE_SERVICE_URL` (default: `http://localhost:8100`)
  - Docker-based, concurrency-controlled
- **Fallback:** PhotoRoom API (requires `PHOTOROOM_API_KEY`)
- **Selection:** `IMAGE_PROCESSOR` env var: `self-hosted` | `photoroom` | `auto` (default)
- **Factory:** `image-service-factory.ts` handles provider selection with health checks

### StyleShoots Drive
- **Watch path:** `/Volumes/StyleShootsDrive/UsedCameraGear/`
- **Flow:** Folder appears → stabilize 30s → parse folder name → fuzzy match Shopify product → upload images
- **Preset folders** map to product categories (e.g. "Trade-Ins - Small Lenses")
- **SMB mount** with reconnect handling

### TradeInManager (TIM)
- **URL:** https://trades.pictureline.com
- **Auth:** Legacy session-based login; service identity and password must be supplied outside the repository
- **Data:** Condition grades, grader notes, serial numbers, pricing
- **Matching:** SKU-based matching between TIM items and Shopify products
- **Auto-tagging:** Applies condition tags to Shopify products

### OpenAI
- **Purpose:** Generate product descriptions, suggest eBay categories
- **Model:** GPT (via `openai` npm package)
- **Context:** Includes product title, vendor, TIM condition data, product notes

## 5. Configuration & Environment

### Credentials

Legacy local development may read `~/.clawdbot/credentials/` only when `NODE_ENV` is explicitly `development` or `test`. Production and ambiguous environments require Shopify credentials from protected environment variables and never fall back to a file.

| File | Contents |
|------|----------|
| `ebay-api.txt` | App ID, Dev ID, Cert ID, RuName |
| `shopify-usedcameragear-api.txt` | Client ID, Client Secret |
| `tradeinmanager.txt` | TIM login password |

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port | `3000` |
| `OPENAI_API_KEY` | OpenAI API for AI descriptions | Required |
| `PHOTOROOM_API_KEY` | PhotoRoom API key (fallback image processor) | Optional |
| `IMAGE_PROCESSOR` / `IMAGE_SERVICE` | Image provider: `self-hosted`, `photoroom`, `auto` | `auto` |
| `IMAGE_SERVICE_URL` | Self-hosted image service URL | `http://localhost:8100` |
| `EBAY_APP_ID` | eBay App ID (overrides credential file) | From file |
| `EBAY_DEV_ID` | eBay Dev ID | From file |
| `EBAY_CERT_ID` | eBay Cert ID | From file |
| `EBAY_RU_NAME` | eBay Redirect URI Name | From file |
| `SHOPIFY_CLIENT_ID` | Exact ProductPipeline Shopify client ID | Required outside explicit development/test |
| `SHOPIFY_CLIENT_SECRET` | Current/primary Shopify client secret | Required outside explicit development/test |
| `SHOPIFY_PREVIOUS_CLIENT_SECRET` | Optional previous secret for bounded inbound verification only | Unset |
| `SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC` | Canonical previous-secret cutoff, at most one hour | Unset |
| `SAFETY_MODE` | Order sync safety: `safe` (rate-limited) or `off` | `safe` |
| `LISTING_CONTROL_DATABASE_PATH` | Absolute path to the explicitly initialized local-draft store | Unset; draft unavailable |
| `LISTING_CONTROL_SINGLE_WRITER_ACK` | Exact local-draft single-writer assertion `product-pipeline-local-draft-v1` | Unset; save denied |

### Deployment (Railway)

- Server runs `npm run build && npm start`
- Build: `tsc` (server) + `vite build` (frontend)
- Static frontend served by Express from `dist/web/`
- Domain: `ebay-sync-app-production.up.railway.app` (needs rename)
- SQLite DB persists on Railway volume

## 6. How to Continue

### Local Dev Setup

```bash
cd ~/projects/product-pipeline
npm install

# Start dev server (auto-reloads)
npm run dev          # Server at http://localhost:3000

# Or run server + web separately:
npm run dev:server   # Express API
npm run dev:web      # Vite dev server (HMR)

# For image processing, also start the image service:
cd image-service
docker compose up    # or: python server.py
```

### CLI Usage

```bash
npm run cli -- status

npm run operator -- preflight --config config/operator-shadow.example.json
npm run operator -- ownership --config config/operator-shadow.example.json
npm run operator -- reconcile --config config/operator-shadow.example.json --snapshot .local/operator-reconciliation/snapshot.json
npm run operator -- audit verify --file .local/operator-audit/operator-cli.jsonl
```

The legacy CLI exposes no authentication, sync, import, publish, republish, watcher, pipeline, image, settings, or other action command in the current source. Operator reconciliation is strict, local-snapshot-only evidence and never proves live parity.

### Deploy

```bash
# Railway auto-deploys from git push
git push origin main

# Manual: Railway CLI
railway up
```

### Adding New Features

1. Start from the responsibility owner and the immutable policy in `src/safety/writer-quarantine.ts`.
2. Keep new observation or reconciliation routes read-only and return redacted, source-labeled evidence.
3. Add operator controls only to the five-page control plane: Overview, Listings, Orders, Reconciliation, and Settings.
4. Do not add chat-generated internal calls, generic mutation endpoints, or writer-enabling settings.
5. Treat database schema changes, external adapters, and any responsibility-specific writer as separate reviewed stages with idempotency, audit, canary, and rollback evidence.

### Testing

```bash
npm test              # vitest run
npm run test:watch    # vitest watch mode
```

Test files: `src/services/__tests__/`

## 7. Decision Log

| Decision | Rationale |
|----------|-----------|
| **SQLite over Postgres** | Single-user app, Railway volume support, zero-config, fast |
| **Drizzle ORM** | Type-safe, lightweight, great SQLite support |
| **Express 5** | Familiar, async route support, serves both API + static frontend |
| **Factory pattern for images** | Self-hosted service saves PhotoRoom API costs; factory enables seamless fallback |
| **Environment-only Production Shopify credentials** | Local files predate env vars and remain available only in explicit development/test; Production and ambiguous environments fail closed without protected environment credentials |
| **Draft/staging system** | Chris wanted to review AI descriptions before publishing to Shopify |
| **Capability registry** | Chat widget and UI auto-discover features; no manual prompt maintenance |
| **Chokidar watcher** | Reliable cross-platform file watching with debounce/stabilization |
| **Rename from "ebay-sync-app"** | Scope grew far beyond eBay sync; now a full product pipeline |
| **TIM integration** | Condition data from trade-ins improves AI description quality |
| **Replace Marketplace Connect through staged cutover (2026-08-11)** | ProductPipeline is the intended eBay-integration replacement, but Marketplace Connect stays incumbent until each responsibility has parity, single-writer proof, canary, reconciliation, rollback, and operator approval; AI/enrichment is legacy scope |
| **Hard-coded incumbent writer quarantine (2026-08-11)** | Marketplace Connect remains production owner for order import, price, and inventory; ProductPipeline external writes fail closed with no runtime override, no historical backfill, and no cutover watermark until a separately authorized transfer |
| **Dedicated authoritative-read boundary (2026-08-11)** | Live source evidence must use a separate clean-build, exact-account, no-refresh collector with bounded recent order windows and signed private artifacts; it is never a path through the mounted app or legacy integration clients |

## 8. Next Steps

> Historical backlog retained for context. Do not execute this list as current direction; use the staged plan in `PROJECT_BRAIN.md`.

**Prioritized remaining work:**

1. **Rename Railway domain** — Still using `ebay-sync-app-production.up.railway.app`
2. **Rename GitHub repo** — Match new ProductPipeline name
3. **Re-enable Logs page** — Currently `.tsx.bak`, needs fix
4. **eBay listing creation** — Full automated Shopify → eBay listing push (partially implemented in `listing-manager.ts`)
5. **Image service deployment** — Deploy self-hosted image service to Railway alongside main app
6. **Auto-pipeline trigger** — Automatically run pipeline when StyleShoots watcher detects + uploads photos
7. **Batch operations** — Process multiple products through pipeline at once
8. **eBay category mapping improvements** — Better auto-suggestion, more category coverage
9. **Webhook reliability** — Retry/queue for failed Shopify/eBay webhooks
10. **Complete the parity evidence chain** — Run the reviewed local collector only after exact ephemeral read authority and signing context are supplied; obtain a fresh independently signed Marketplace Connect attestation/export; then translate all three source artifacts into reconciliation v2 with an archival verification context

## Recent Changes

### 2026-08-26: G10 Reconciled and G13 Production Identity Repaired

- Completed G10's first live listing-revise ceremony for eBay listing `147232036779`: the approved branded description is live, price and quantity were preserved, and the original job/attempt is durably `revised_state_observed` / `resolved_existing`. Exactly one provider write occurred; the recovery reconciliation performed zero external writes and the migration-store audit chain verifies.
- Added a terminal replay guard so re-running `reconcile` for an already-resolved attempt fails as `REVISE_ATTEMPT_ALREADY_RESOLVED` before another reconciliation run or target observation can be recorded. Regression coverage proves migration-store counts and the audit head remain unchanged.
- Remaining G10 gate is observation-only: confirm Marketplace Connect leaves the listing's price and quantity correct for 24 hours.
- Ran G13's zero-write 24-hour production shadow check: 11 eBay orders were observed, but the tag-only join falsely marked all unmatched. A signed-in Shopify spot check proved Marketplace Connect stores the exact eBay Order ID as Shopify's `sourceIdentifier` and uses only generic tags.
- Shadow parity, import dedup, and post-dispatch verification now exact-check both Shopify `source_identifier:<orderId>` and ProductPipeline's durable `eBay-<orderId>` tag. Fuzzy echoes, unexpected pagination, lookup failures, or conflicting GIDs block the run; ProductPipeline-created orders carry both markers. No watermark, ownership, order observation, order link, Shopify order, or historical import was created during the live check.
- Deployed merge `88ff33a5c4c7c94fc5b0abd7d5bd56a8e62aff77` passed health and the corrected zero-write report: 10 of 11 orders matched exactly, one remained unmatched, and zero lookups were blocked or ambiguous. A same-SKU/time eBay-channel Shopify order lacks the exact eBay external ID, so it remains an investigation item and the report does not start the clean-day count.

### 2026-08-26: Exact Raw-HTML Listing Reconciliation

- Corrected the first production G10 revise's reconciliation defect: the approved branded manifest contains raw HTML, while the draft/editor basis intentionally contains plain text. Listing-revise reconciliation now compares descriptions against the fresh provider's exact raw HTML with XML line-ending normalization only, and binds the raw-description digest into its result evidence.
- Strengthened all changed-field classification to distinguish exact after-state, provable before-state, and unknown drift. Any value matching neither approved state is now `partial`, so even `--accept-absent` cannot terminalize one-byte markup drift. Missing/non-provable raw description state fails closed.
- Added Inventory and Trading end-to-end branded-description reconciliation regressions, XML entity round-trip coverage through the real Trading serializer, one-byte HTML drift coverage, and explicit proof that partial drift remains unresolved. Production recovery reuses the existing job and attempt; it must never redispatch.

### 2026-08-26: Railway-Safe Schema-v4 Activation Path

- Packaged the existing reviewed migration-admin root marker in the Railway Docker image and added one strict nonsecret production configuration pinned to `/data/migration-state/product-pipeline-migration-v1.sqlite`, `usedcameragear.myshopify.com`, seller `usedcameragear`, and `EBAY_US`. The authenticated read-only migration projection now receives that exact config path; server startup still never opens or upgrades the store.
- Preserved every existing configuration, exact-scope confirmation, durable-path, permission, schema/catalog, audit-chain, and provider-isolation check. Added focused coverage for the shipped production config/root marker and for a populated schema-v3 → v4 upgrade that preserves order ownership, watermark, cursor, observation, resolution, link, intent/job/attempt/reconciliation, and target-effect state while retaining the one-hour clamp, strictly-greater eligibility, duplicate denials, and failure atomicity.
- Corrected the migration/order runbooks for schema v4 and documented the Railway backup → verify → exact-scope upgrade → verify ceremony. G10 Draft 1 and its exact branded-description preflight are complete with zero writes; live dispatch remains a separate human operator action after the production store is backed up and verified at v4.
- Verification: focused migration-admin/schema-upgrade tests passed (26/26), `tsc --noEmit` passed, the complete Vitest suite passed (76 files / 832 tests), and the tracked production build completed successfully.

### 2026-08-25: Inert G17 Fulfillment/Tracking Ceremony

- Added explicit migration-store schema v4, widening Production for exactly the Class-B `fulfillment` responsibility while `mapping` and `feedback` remain denied. Fulfillment requires the durable Marketplace Connect → paused → ProductPipeline evidence chain; target-effect observations and attempt resolution now bind fulfillment reconciliation.
- Added standalone `fulfillment-tracking-admin` (`establish-ownership`, `preflight`, `dispatch`, `reconcile`). It reads one exact Shopify order and eBay order, accepts only one successful complete-order Shopify fulfillment with one tracking number, and can issue exactly one eBay `createShippingFulfillment`. Partial/split shipments, pagination, stale or replayed manifests, existing eBay fulfillments, and absent ownership fail closed.
- The CLI is not mounted by the server, webhook, scheduler, worker, or legacy CLI. Tracking remains process-only and is never printed or stored raw. No provider write or Marketplace Connect change was performed. Operator runbook: `docs/FULFILLMENT_TRACKING_DISPATCH.md`; remaining gates include G10 if still pending, schema-v4 Production upgrade, MC fulfillment-off evidence, ownership, and supervised real shipments.
- Verification: focused G17/migration matrix 7 files / 65 tests passed; TypeScript no-emit and production build passed; compiled exact-target CLI help/redaction and source/dist parity passed; independent final safety review returned GO with no P0/P1/P2. Full suite: 820 passed / 9 failed, all in the known environmental `credential-admin` filesystem/permission class (no G17 regression). Preflight, dispatch, and reconcile require the exact Shopify order GID, Shopify fulfillment GID, and eBay order ID. The hardened dispatch and migration-store intent boundary both require the existing durable Shopify/eBay order link; schema v4 admits only one fulfillment intent per exact linked order pair. Deterministic job/attempt IDs make interrupted dispatches recoverable, and reconciliation binds the complete observed eBay effect rather than mutable Shopify tracking.

### 2026-08-24: Replacement Roadmap and Gap-Audit Goals G16–G21

- Audited the goal board against Marketplace Connect's full behavior; three unscoped gaps became goals: **G17 fulfillment/tracking sync** (Shopify shipment → eBay tracking; not built; hard prerequisite for MC removal), **G18 steady-state automation with guardrails** (the explicit policy decision to relax ceremony-per-write for routine ops, per-responsibility user approval, kill switch), and **G16 first production create + end/relist dispatches**. Also added **G19 monitoring/daily digest**, **G20 backups/restore rehearsal**, **G21 MC decommission with preconditions and explicit non-goals**; **G6** folded (parity evidence now accrues from operational artifacts).
- New `docs/REPLACEMENT_ROADMAP.md`: the ordered six-phase master path (listing proof → price/inventory takeover → order shadow/cutover → fulfillment → automation/ops → uninstall MC) with per-phase exit checks and USER/AGENT ownership labels; router entry added. Documentation-only change.

### 2026-08-24: Goal Board Refresh — G10–G15 Added, Stale Statuses Corrected

- `PROJECT_BRAIN.md` Section 14 gained the 2026-08-24 update: G3/G4 marked done (production save exercised, slices deployed), G7/G8 folded into the new activation goals, G1 re-confirmed open with the 2026-08-20 auth-repair evidence noted.
- New directed goals with statuses and authorization boundaries: **G10** first production listing-revise dispatch (ready, operator-gated), **G11** price takeover (ready, user-gated), **G12** inventory takeover (ready, user-gated), **G13** order takeover — shadow phase active, cutover sequence defined, L11 absolute governs, **G14** eBay Business Policy slice (deferred to 2026-09-01, reminder scheduled), **G15** branded description rollout (per-dispatch adoption; versioned template immutability rule).
- Priority order recorded: G10 → G11 → G12 → G13-cutover, G1 when the user can participate. Documentation-only change.

### 2026-08-20: Project Brain v2 — Task Router, State Snapshot, Learnings Log, Per-Agent Entry Files

- `PROJECT_BRAIN.md` gained Section 15 (task router index — agents read only what a task needs, plus the mandatory self-building duty), Section 16 (state of the system as of 2026-08-20), and Section 17 (append-only learnings log L1–L11: auth-secret rotation trap, Railway volume/ephemerality, census facet gaps, eBay active-content rules, `eBay-<id>` dedup key, environmental test failures, agent worktree base-drift, token scopes, shared HTML allowlist, deploy-queue diagnosis, and the structural no-historical-orders guarantee).
- New thin entry files pointing every coding agent into the brain: `CLAUDE.md` (Claude), `GROK.md` (Grok), `.cursorrules` (Cursor); `AGENTS.md` (OpenAI convention) §0 now routes through Section 15 and carries the self-building duty. Identical substance: protocol pointer, four safety absolutes, conventions, self-building rule.
- Documentation-only change; no runtime behavior touched.

### 2026-08-19: Marketplace Connect Replacement Waves 1–2 — Schema v3, Full Writer-Slice Build-Out, Activation Runbook

User authorization (2026-08-19): bring ProductPipeline to complete Marketplace Connect capability — listing management, price sync, inventory sync, and eBay→Shopify order import — with exactly one absolute prohibition: never import or backfill historical orders. All work merged and deployed via PR #21 (wave 1) and PR #22 (wave 2); `main` = `2bcadc9`. **Zero provider dispatches executed; every writer remains behind execution-time operator ceremonies; the HTTP writer quarantine is untouched.**

- **Wave 1 — migration-store schema v3 (`marketplace_connect_replacement_v3`).** Production allowances widened to exactly six actions (`revise_ebay_listing`, `create_ebay_listing`, `end_or_relist_ebay_listing`, `update_ebay_price`, `update_ebay_inventory`, `import_shopify_order`). Class A listing responsibilities (create/revise/end-relist) keep truthful paused genesis with a marketplace_connect genesis permanently rejected; Class B responsibilities (orderImport/price/inventory) require staged marketplace_connect→paused→product_pipeline ownership transitions carrying MC-disabled evidence digests. The no-old-orders prohibition is structural: the production order watermark is valid only within one hour of establishment (enforced in both the SQL trigger and the TypeScript guard), eligibility is strictly-greater, and there is one watermark per scope forever. New append-only `target_effect_observations` table binds attempt resolutions for the four non-order writer responsibilities; mapping/fulfillment/feedback denials unchanged; explicit `migration-admin upgrade` path with catalog-digest confirmation; dist-parity and root-boundary regressions updated deliberately.
- **Wave 1 — Trading-model revise adapter.** `listing-revise-admin` extended with a bounded ReviseFixedPriceItem adapter (IAF token, compat 1349, SITEID 0) carrying a structural no-StartPrice/no-Quantity assertion, extending G4 coverage to the 107 legacy Trading-model listings per the G5 strategy; `--offer-id none` denotes offer-less Trading targets. Transient in-memory eBay user-token providers (refresh-grant exchange, exact-scope-echo, fail-closed) added for all dispatch CLIs.
- **Wave 2 — `src/listing-lifecycle-admin/`.** Create ceremony (inventory item PUT → offer POST → publish POST) with durable `CREATE_OFFER_UNPUBLISHED` artifact handling so an interrupted create is resumed, never re-created blind; end/relist ceremony (Trading EndFixedPriceItem or inventory withdraw by listing model). Runbook: `docs/LISTING_LIFECYCLE_DISPATCH.md`.
- **Wave 2 — `src/price-inventory-admin/`.** `establish-ownership` requires `--baseline-evidence` plus `--mc-disabled-evidence`; `plan` emits a deterministic drift manifest (`{field, before, after}`) whose digest the operator must echo at dispatch; adapters are `bulk_update_price_quantity` (Inventory model) and ReviseInventoryStatus (Trading model) with structural price↔quantity cross-contamination assertions. Runbook: `docs/PRICE_INVENTORY_DISPATCH.md`.
- **Wave 2 — `src/order-import-admin/`.** Ownership and clamped-watermark ceremonies; `poll` uses its own token exchange scoped to exactly `api_scope + sell.fulfillment`, caps at 3 pages / 50 orders, and records PII-free observations only; `import` handles one order per invocation, pre-checks the Shopify `eBay-<id>` dedup tag (linking instead of creating on a hit), preflights the `write_orders` app scope fail-closed (`IMPORT_SHOPIFY_WRITE_SCOPE_MISSING` — the current app version `productpipeline-read-only-8` is read-only), and post-verifies before recording the order link; `confirmed_missing` is never automatic for orders. Runbook: `docs/ORDER_IMPORT.md`.
- **Activation.** New `docs/ACTIVATION_RUNBOOK.md`: the single ordered operator sequence for taking over each responsibility (store init/upgrade to v3, the G3 one-click signed-in save, listing ceremonies, MC toggle-off evidence → price/inventory takeovers, `write_orders` app release + MC order-import-off → watermark within the one-hour clamp → per-order import) and the checklist of user-only steps. All ceremonies run on the Railway box; this repo and agent containers hold no credentials.
- Verification: TypeScript `--noEmit` clean; full suite 66 files, 714 passed / 11 failed, where the 11 are the known pre-existing environmental `src/credential-admin` failures reproduced on the clean base. `PROJECT_BRAIN.md` Section 14 updated with the 2026-08-19 authorization and goal-status changes.

### 2026-08-14: Listings-Management Track — G3 Save-Path Proof, G4 Listing-Revise Dispatch Slice, G5 Management-Model Strategy

Goal-board track G3 → G4 with G5 alongside (user priority: push and manage eBay listings from ProductPipeline). All work is source, local-test, and documentation only: **no provider dispatch executed, no deployment, no Marketplace Connect change, and zero external writes.**

- **G3 — local draft save path exercised end to end.** New committed regression `src/server/routes/listing-draft-save-exercise.test.ts` drives the exact mounted middleware chain (real rate limiter, real HS256 App Bridge session verification for the pinned store using a locally-minted signing secret, real writer-quarantine middleware, real bounded JSON parser, real service) against a real on-disk listing-control store initialized and verified by the real `listing-control-admin`. Proven and recorded in `docs/LISTING_DRAFT_SAVE_EXERCISE.md`: 401 for missing/forged/wrong-audience tokens, one bounded authenticated append (revision 1, server-derived actor, matching store row), `409` stale rejections for both replay and remote-drift-with-correct-CAS, revision-2 CAS chain, `423` for noncanonical siblings, and a clean admin `verify` plus valid audit chain. The only substituted dependency is the live workspace read (provider credentials never enter tests). The one-click signed-in Production save remains a documented operator step.
- **G5 — Trading-vs-Inventory strategy (`docs/LISTING_MANAGEMENT_MODEL_STRATEGY.md`).** 107 of 112 active listings are legacy Trading-model objects with no Inventory-API surface, and no Trading write call exists anywhere in source. Recommendation: hybrid with migration deferred — manage `inventory_offer` listings now (G4 scope), keep Trading listings untouched under the incumbent (migration is irreversible and Marketplace Connect's behavior against a migrated listing is unverified), and gate any migration behind a per-listing risk classification, re-verified platform constraints, and a one-listing canary; an interim Trading revise adapter is a separate future slice if business need demands it.
- **G4 — listing-revise dispatch slice built (not dispatched).** Migration-store **schema v2** narrows exactly four production denials to admit only the reviewed slice: `revise_ebay_listing` intents; a `listingRevise` ownership chain with truthful `paused` genesis (a Marketplace Connect owner for listingRevise is permanently rejected — it was never verified); `production_canary` zero-write post-dispatch reconciliation runs for listingRevise; and a listingRevise attempt-resolution predicate bound to the new append-only `listing_revise_observations` table. Order watermark/backfill/creation and price/inventory/mapping/fulfillment/feedback denials are unchanged, mirrored in TS guards, SQL triggers, the read-only projection, and the server migration-state reader. Upgrading a v1 store is explicit-operator-only via new `migration-admin upgrade` (exact scope-digest confirmation; verified v1 history and catalog digest required; one immediate transaction; full re-verification; tamper-detection regressions). See `docs/MIGRATION_STATE.md`.
- New isolated `src/listing-revise-admin/` CLI (standalone compiled entrypoint, never imported by the server): `preflight` prints the deterministic manifest (field-level before/after, preserved price/quantity, manifest digest) derived purely from the stored draft revision; `establish-ownership` records the paused→product_pipeline listingRevise chain once with an operator evidence digest; `dispatch` is the one action — exact catalog row, SKU, listing id, offer id, revision digest, and manifest digest must all match — running fresh staleness gates, durable intent/single-use approval/job/attempt records, a raw-resource round-trip with binding and byte-exact price/quantity preservation assertions, at most two bounded PUTs (`inventory_item/{sku}`, `offer/{offerId}` on `api.ebay.com` only), an immediate post-action verification read, a reconciliation run + target observation, and terminal resolution; `reconcile` re-runs verification for an outstanding job and never records `confirmed_missing` from mere propagation delay (explicit `--accept-absent` only; provider-reported failure is the one auto-confirm path). Dispatchable fields exclude `condition` (enum mapping unreviewed) and can never include price/quantity/item-specifics/identifiers. Runbook: `docs/LISTING_REVISE_DISPATCH.md`; Help Center article added.
- Verification: new suites `src/migration-store/__tests__/listing-revise-slice.test.ts` (production lifecycle end-to-end, every-other-surface-still-denied matrix, observation/resolution mismatch rejection, v1→v2 upgrade + tamper refusal) and `src/listing-revise-admin/__tests__/listing-revise-admin.test.ts` (happy-path dispatch with payload assertions, stale/wrong-target/no-ownership denials, both replay-denial layers, provider-failure `confirmed_missing`, boundary-import regressions) plus the G3 exercise. Full run in this container: 58 files, 626 passed / 9 failed — the 9 failures are **pre-existing** `credential-admin` failures reproduced identically on clean `f0ca053` (environmental to this container's filesystem; that code is untouched by this work). TypeScript `--noEmit` and the production build pass. Not merged, not deployed; the first live dispatch requires the operator ceremony in the runbook.

### 2026-08-14: Coordinator Goal Board Added to Project Brain

- Added `PROJECT_BRAIN.md` Section 14: a coordinator-facing goal board (G1–G9) synthesizing the 2026-08-11 coordinator/agent session log with the current repository state (updated through `main` = `f0ca053`).
- Recorded stale-record corrections: incident `SCR-2026-08-14-001` (goal G1) has advanced — the merged diagnostic was deployed on `63bce306-5455-4c77-af7e-f441f4684b0b` and returned only `file-permissions-denied` with every database/provider/credential/commerce effect counter zero; reviewed repair commit `c7835a4` is on PR #19 awaiting integration, merge, deployment, and one live run, so the incident remains open. The eBay Sandbox `pptest` Test Lane's final state is unknown in this repository and needs reconciliation or formal retirement (goal G2).
- Recorded the user's stated priority — using ProductPipeline to push and manage eBay listings. G4 (provider listing-revise slice) is authorized to build with the priority track G3 → G4 plus G5; each actual eBay dispatch still requires a one-action exact-target operator approval, and order-responsibility goals remain gated and last.
- Each goal carries its own status, prerequisites, and authorization boundary; the board authorizes no execution by itself. Documentation-only change — no application code, runtime behavior, provider system, or deployment was touched.

### 2026-08-14: Fixed-Purpose Shopify Database Permission Repair Candidate

- Added one direct-only, option-free `repair-shopify-credential-database-permissions` command for the exact Production Railway project/environment/service, ProductPipeline app, and `/data/ebaysync.db`. It remains unmounted and fails before filesystem access unless listing-control and rotation acknowledgements plus the rotation refresh token are absent and exact operator-supplied one-replica/one-volume assertions are both `1`.
- The repair binds the fixed target with `lstat`, one `O_RDONLY`/`O_NOFOLLOW` descriptor, and exact device/inode/type/link/UID/GID/size proof; separately binds and validates the private parent; and denies SQLite sidecars. A source/runtime fence proves the current Dockerfile has no `USER` override and Railway runs the same image directly; the command therefore requires the release's exact effective-UID-`0` contract and keeps file/parent UID/GID stable. It privately retains only the original mode, bounded size, content digest, and mtime.
- Its only intended state change is descriptor-bound `fchmod(0600)`, followed by database and parent descriptor sync. It proves the same identity/owner/size, unchanged content digest/mtime, fixed-path identity, mode `0600`, and sidecar absence before close. It has no raw/path chmod, shell/spawn, SQL/token-value, provider/network, credential, database-content, or commerce-write capability.
- Any pre-change failure reports zero permission metadata writes. The implementation contains exactly one metadata-write call, the descriptor-bound `fchmod(0600)`, and has no automatic rollback or restore path. After that call is invoked, every error, close ambiguity, concurrent mode/owner/group/identity change, growth, content drift, or other boundary change reports an unknown outcome with one or unknown effect truth and leaves later state untouched. Classification requires the option-free read-only diagnostic, health, and an expected DB-backed read; the repair is never blindly retried.
- Added adversarial exact-binding/topology/no-authority, target and parent identity, atomic substitution, UID/GID/effective-UID, concurrent `0666`/`0400` modes, group-bit ownership drift, bounded growth/no-extra-read, sidecar timing, sole-fchmod, fsync, fstat, read/digest/mtime, close, no-rollback, redaction, no-wrapper, import, process, and capability-boundary coverage. Added the operator runbook, incident truth, writer-quarantine statement, and Settings help.
- Independent review returned HOLD on frozen manifest `9dea1b13eb22b65bfe79eb72a7f245af4e94c51168dd30bf54892223e85779c0` because rollback omitted a mode CAS and GID and could hash concurrent growth. The revised `337381468d3d316b940624e9d94c2f1eafce04f7634a978a11f6a394b298bd37` manifest was also HOLD: its userspace `fstat` then `fchmod` restore sequence was still non-atomic and could overwrite a concurrent third mode. The final revision removes every automatic rollback metadata write and state. Both fresh independent reviewers returned GO with no P0/P1 on exact frozen manifest `fed26023563a49c1f8b4be10dce5d6ea41bad8a5bbf2c7958150af522d073f4c`; all prior verdicts remain bound only to their older bytes.
- Local verification passes the complete 6-file / 142-test credential-admin matrix, the full 56-file / 667-test repository suite, TypeScript no-emit, the Production build, independent temporary TypeScript compile parity for credential-admin and Help output, clean direct compiled help and malformed-argv redaction, absent npm wrapper, one-fchmod/no-rollback and no-shell/network/token/SQL/path-chmod/import scans, post-build focused regressions, and whitespace checks. These are local source/build proofs only; earlier snapshot reviews do not apply.
- The independently reviewed candidate was committed and pushed as `c7835a47deae1cc46cb598fadedd06f0d4d26200` on PR #19. Its rebase integration, merge, deployment, repair-only topology variables, one live repair invocation, and post-repair diagnostic/health/DB-backed-read proof remain pending. No provider, Railway, Production database, credential, token, proposal, listing, order, price, inventory, Marketplace Connect, or Lightspeed mutation was performed by this implementation work.

### 2026-08-14: Read-Only Shopify Credential Database Diagnostic Candidate

- Added one option-free `credential-admin diagnose-shopify-credential-database` command for the exact Production Railway project/environment/service, ProductPipeline Shopify app, and fixed legacy database. It requires `NODE_ENV=production`, the exact nonsecret runtime pins, and an absent listing-control writer acknowledgement; it accepts no path, identity, credential, or repair option.
- The diagnostic opens no provider connection and never queries, selects, serializes, or outputs token values. It keeps the fixed file open through one verified `O_RDONLY`/`O_NOFOLLOW` descriptor, copies a bounded snapshot into private memory, and gives SQLite only that memory snapshot rather than a path. It proves source-content, descriptor/path identity, and sidecar stability again after SQLite closes, then closes the descriptor and clears its explicit buffers. A clean WAL-header main database is inspected without filesystem sidecar creation by changing only the private snapshot header.
- The diagnostic and rotation store now share one exact mutation-compatible `auth_tokens` verifier and the exact compare-and-swap SQL. The verifier checks normalized canonical `sqlite_schema.sql`, ordinary rowid/non-STRICT storage, exact `table_xinfo` columns/defaults/visibility, the full ascending `BINARY` unique-platform autoindex shape, no triggers/foreign keys, and compilation of that shared CAS. Token-blocking CHECK constraints, generated/hidden columns, STRICT/rowid changes, and index collation/order changes fail before any provider credential request.
- Output is one frozen redacted object containing booleans, a fixed first-failing stage, and explicit zero database writes, provider network requests, provider credential mutations, and external commerce writes. It returns a nonzero exit for a denied stage and never emits a path, token, secret, row value, digest, provider body, driver error, filename, or sidecar suffix. The command remains standalone and unmounted.
- Removed the unsafe `credential-admin` npm script because npm reflects raw malformed argv before the compiled entrypoint can redact it. The runbook supports only direct option-free compiled `node dist/credential-admin/index.js ...` invocation. Added package-wrapper sentinel coverage alongside direct compiled parser/redaction tests.
- An initial independent review returned HOLD with five P1 findings: path-open SQLite created WAL sidecars, descriptor/path substitution could change the inspected inode, mutation-blocking noncanonical schema could verify, npm reflected raw argv, and descriptor failures used conflated stages. This revision remediates all five with deterministic clean-WAL, atomic-substitution, CHECK/generated/STRICT/index-shape, exact open/fstat/close, package argv, redaction, and no-mutation regressions. Fresh independent adversarial review returned GO with no P0/P1 on frozen 29-path manifest `c0a55f38073ca52c138c83635464f168e9245cd7a8c2fc58821ff0a31bf26e28`.
- Local remediation verification passed the complete 5-file / 98-test credential-admin matrix, the full 55-file / 623-test repository suite, TypeScript no-emit, the Production build, compiled direct-entrypoint help/malformed-argv redaction, absent npm-wrapper sentinel, and whitespace checks. Independent review confirmed those gates plus source/dist parity. The diagnostic was then merged as `a50ecfaa0e06cd4d215aba37c0858bf116b8f17c` and deployed on `63bce306-5455-4c77-af7e-f441f4684b0b`, one replica.
- Public health at `2026-08-14T21:40:06.140Z` reported `ok`, `shadow-read-only`, external writes false, and historical backfill false. A direct Production diagnostic run shortly afterward returned only `file-permissions-denied`: target present, regular, non-symlink, single-link, nonempty, bounded, and not mode `0600`; all later checks were unperformed and every database/provider/credential/commerce effect counter was zero. No exact command timestamp was separately captured. The result identifies only the first local boundary and authorizes neither repair nor token rotation.
- Shopify app version `productpipeline-read-only-8` (`1090140569601`) was released with exact `read_products`, `read_orders`, `read_inventory`, and `read_fulfillments` scopes; the merchant approved Update and the signed-in embedded app loaded. No Shopify access-token rotation, Production database write, proposal activation, listing/order/price/inventory write, Marketplace Connect change, or Lightspeed effect occurred.

### 2026-08-14: Shopify Already-Staged Credential-Recovery Decision

- Recorded the incident-only recovery exception for `SCR-2026-08-14-001`: a clean Shopify secondary secret and protected Railway new-primary/old-previous values were already committed while active deployment `259f4262-0943-4c26-a47b-6b722f73fc75` still runs revision `234e0cb4de8aeafe494492f7039317915969b9aa` with its old-primary snapshot.
- This documentation authorizes no execution. A direct candidate deployment is permitted only after draft PR #15's incident-state documentation is independently reviewed and a fresh canonical cutoff no more than one hour ahead satisfies the exact release, authentication, webhook, topology, quarantine, and dispatch-window gates.
- Rollback to deployment `259f4262-0943-4c26-a47b-6b722f73fc75` is allowed only before the provider token-rotation request. At or after that request, or after old-secret revocation, the runbook requires forward reconciliation rather than rollback, restore, or blind retry.
- Runtime source, compiled output, and package metadata remain unchanged from `3309dfd`; this documentation amendment performed no provider, Railway, database, or commerce mutation.

### 2026-08-14: Shopify Credential-Rotation Safety Candidate

- Added exact-store inbound Shopify request verification with canonical HS256 App Bridge JWT validation and webhook HMAC validation across the primary secret plus one distinct optional previous secret. The previous-secret window is canonical, hard-capped at one hour, and ignored at cutoff without disrupting primary verification. Production and ambiguous environments now use environment credentials only; token acquisition remains primary-only and uses fixed redacted bounded transport.
- Added the standalone compiled `credential-admin` with option-free preflight, rotate, and verify commands pinned to the exact Production Railway project/environment/service, Used Camera Gear store/app, `/data/ebaysync.db`, and the canonical four read-only scopes. It is never imported or mounted by the server and has no provider commerce-write adapter.
- Rotation requires an active dual-verifier overlap and dedicated single-writer acknowledgement with at least 15 minutes remaining at the one no-retry provider dispatch. It verifies the current authority, creates a complete private mode-`0600` SQLite backup with bounded logical whole-database content proof, verifies the fresh authority, compare-and-swaps only the exact Shopify row in an `IMMEDIATE` transaction, reopens read-only, and verifies the committed token. The temporary dashboard refresh token is never persisted to the database or token row; its protected Railway variable remains operator-managed until explicit cleanup.
- Added fixed value-free failure codes, explicit output truth for one provider credential mutation versus zero external commerce writes, adversarial source/compiled tests, the operator runbook, release-maintenance incident `SCR-2026-08-14-001`, and concise Settings help that keeps credential controls out of the app.
- Local verification passed the focused 8-file / 88-test security suite, full 54-file / 582-test suite, TypeScript no-emit check, Production build, compiled command help and malformed-argument redaction checks, and whitespace checks. The source/build candidate was committed and pushed as `3309dfd` on draft PR #15 and independently source-reviewed GO; it is not merged, deployed, or live-verified. The source work performed no provider, Railway, Production database, Marketplace Connect, or Lightspeed mutation.

### 2026-08-14: Local Draft Production Initialization and Description-Cap Incident Closure

- PR #10 merged the local listing-draft workspace to `main` as `e0d59cd904209c30e815f6cf6a2e4e784208efc5`. Railway deployed that exact revision, and public `/health` served it at `2026-08-14T15:55:08.152Z` with `shadow-read-only`, external writes disabled, historical backfill disabled, and a null order watermark.
- On the existing one-replica Railway service, the `/data/product-pipeline` parent was created mode `0700`; `/data/product-pipeline/listing-control.sqlite` was explicitly initialized and verified as schema version 2, `local_draft_only`, mode `0600`, with `externalWritesPerformed: 0`. Runtime did not initialize, migrate, or repair it.
- Created and verified the pre-draft baseline backup `/data/product-pipeline/backups/listing-control-initial-e0d59cd.sqlite` (mode `0600`, 114,688 bytes, SHA-256 `40c89f9e9beeac1ac36c33822ca59b3cc9057b99d062811b79cb00c6e88b4fc7`). This proves a verified local-store baseline only, not Shopify/eBay state.
- Live signed-in verification then found an open read-path incident: the exact listing workspace returned `503` after successful eBay reads because a local artificial 100,000-byte description validator rejected valid Production descriptions of 147,595 and 144,209 bytes. The failure occurred during local response parsing; it performed zero provider writes and did not change the initialized draft store.
- Local repair candidate is complete and independently reviewed: description parsing and store validation now share an exact 500,000-Unicode-code-point / 2,000,000-UTF-8-byte limit while the separate total-response bound remains fail-closed. Regressions preserve a 150 KiB description, accept the exact 500,000-code-point boundary, reject overflow/control input, preserve a 300 KB inherited description through save/reopen/audit/integrity checks, and retain the smaller non-description caps. The full 48-file / 504-test suite, `npm run build`, and `git diff --check` pass.
- PR #11 committed the repair as `bab71a5` and merged it to `main` as `789dc7782cea5da33a5fddd8617d1c364cbb783e` at `2026-08-14T16:11:47Z`. Railway deployment `623f7eca-74ae-4ff8-8bec-99a761767793` succeeded with one replica and the `/data` volume; public `/health` served the exact merge at `2026-08-14T16:13:06.046Z` with shadow read-only mode, external writes false, and historical backfill false.
- Post-deploy admin verification returned schema version 2, `local_draft_only`, and `externalWritesPerformed: 0`. In the signed-in app, Aputure variant `gid://shopify/ProductVariant/54881767358755` / SKU `APD0170A3B-OB` / eBay listing `147232036779` opened a complete Mapping, Listing, Content, and Delivery workspace with a description summary and Edit control. No Save was clicked and no provider write occurred. LWI-2026-08-14-001 is closed; the closure evidence and bounded next-task handoff are in `docs/LISTING_WORKSPACE_INCIDENTS.md`.
- Continue from the clean worktree `/Users/chrismaxwell/Documents/Codex/2026-08-11/project-pipeline/work/product-pipeline-modern`, fetch `origin/main`, and inspect status before editing. The sibling `work/product-pipeline` checkout contains unrelated dirty work and must not be reset, cleaned, or staged into this release line.

### 2026-08-13: Authenticated Local Listing Draft Workspace (Source Candidate)

- Added authenticated `GET /api/listing-draft?id=...` and exact `POST /api/listing-draft` for an append-only local-draft workspace. The server derives trusted Shopify/eBay identity from a fresh exact-account workspace, binds saves to semantic source/eBay digests plus the latest revision, and records the verified Shopify-session actor. Stale facts or concurrent revisions require reopening the item.
- Added concise Edit, Preview, and Save draft controls for title, category, condition, condition description, plain-text description, bounded image URLs, fulfillment/payment/return policy IDs, and merchant location. Price and quantity remain visible but read-only under Marketplace Connect; item specifics and identifiers remain comparison-only.
- Kept Apply, Approve, Publish, provider writes, mapping writes, price/inventory/order sync, token persistence, Marketplace Connect changes, and automatic actions absent. Exact local append is the sole non-read quarantine exception; every other non-read API request remains denied.
- Upgraded the dedicated listing-control store contract to canonical schema version 2 with immutable revision provenance. Runtime requires an existing exact-scope regular `0600` store, never creates/migrates/repairs it, and enables saves only with the explicit single-writer assertion.
- Added explicit `listing-control-admin init|verify` operations and `docs/LISTING_CONTROL_ADMIN.md` for the intended Railway `/data/product-pipeline/listing-control.sqlite` path, private-parent permissions, single-replica/one-volume topology, backup/restore, and fail-closed recovery gates. A read-only Production preflight found the intended parent and database absent and the new environment variables unset; this entry therefore makes no deployment/configuration/UI claim.
- Updated the writer-quarantine, listing-control model, project brain, and Help content to distinguish local draft persistence from external commerce writes. Source/build/tests/deployment and signed-in embedded behavior remain separate release evidence.

### 2026-08-13: Continuous Listing Reconciliation and Mapping Workspace

- Expanded Listings from a positive-stock intersection into a union reconciliation view: positive-stock Shopify variants, zero/unknown-stock Shopify variants with eBay state, and unmatched or SKU-less active eBay listings all remain visible. Blank, duplicate, and near-collision SKUs do not auto-map.
- Added a server background refresh every 60 seconds, verified Shopify webhook invalidation, browser polling every 30 seconds, and a five-minute fail-closed freshness limit. A known refresh failure downgrades the prior snapshot to **Unknown** immediately. The UI now says **Active**, **Not listed**, **Needs attention**, or **Unknown**; stale or failed evidence cannot remain Active or Not listed.
- At that release, added an exact GET-only listing workspace that verifies current eBay Trading detail and, where applicable, the Inventory item and Offer. It shows the Shopify variant -> exact SKU -> management model -> offer -> public listing mapping and current listing/content/delivery fields. Price and inventory identify Marketplace Connect as their verified writer; listing and mapping ownership remain explicitly unverified.
- The live audit found 112 active Trading listings but only five Inventory items and five Offers, so the control model explicitly supports both legacy Trading and Inventory/Offer listings.
- At that release, added a separate, explicitly initialized, append-only listing-control draft store with immutable revisions for the initial bounded field set and audit verification. It was deliberately unwired from routes, credentials, providers, approvals, and commerce writers; no application runtime path could use it to authorize a publish.
- At that release, kept Marketplace Connect as the price, inventory, and order writer and quarantined every non-read `/api` request. The newer source candidate preserves those external-writer boundaries while adding only the exact local-draft append described above.
- PR #8 merged to `main` as `6a8918677478f919aead632b8d885c23cb6ab738`; Railway reported success and `/health` served that exact commit with shadow read-only mode, external writes disabled, historical backfill disabled, and the full writer quarantine enabled at `2026-08-13T23:20:16.302Z`. Signed-in embedded-app data rendering remains a separate operator verification after reload.

### 2026-08-13: eBay Seller Identity Pin Incident and Repair

- During the first complete live-catalog audit, the reader stopped at fixed phase `LISTING_CATALOG_TRADING_CAPTURE_FAILED`: its stale expected seller was `usedcam-0`, while strict Production Trading `GetUser` observed `usedcameragear`. The catalog failed closed before projection, returned no partial status, performed zero external writes, and did not log, return, or persist credential material.
- Independent signed-in eBay evidence resolved the contradiction: item `147502608418` showed **Your item is for sale** and **Revise listing**, the public store was **Used Camera Gear**, and the seller messaging URL identified `requested=usedcameragear`. That proof matches Trading `GetUser`; the earlier `usedcam-0` Marketplace Connect label is now explicitly historical/stale evidence.
- Updated the exact seller pin to `usedcameragear` without weakening the gate. Focused regressions require the corrected seller and explicitly reject both the stale `usedcam-0` identity and an unrelated seller before any catalog result can be published.
- The corrected same-source predeployment audit then completed in 7,515 ms with zero external writes: Shopify captured 2,026 variants across 21 pages and retained 176 positive-stock variants; the exact join classified 111 Active, 44 Not listed, and 21 Needs attention. eBay captured 112 active entries in one Trading page, five Inventory items in one page, and five Offers across five per-SKU pages. These are point-in-time read counts, not deployment or ownership-transfer proof.

### 2026-08-13: Complete Live In-Stock Listing Catalog

- Added an authenticated, read-only catalog that captures a complete timestamped Shopify variant inventory and includes only variants with available inventory above zero.
- Joined exact raw SKUs against complete eBay Trading active listings plus Inventory API items and offers. `Not listed` is returned only when all complete sources prove no active or unpublished eBay artifact; missing, duplicate, near-collision, non-active-product, and ambiguous artifact states require attention.
- Added strict store/seller identity checks, bounded pagination and response limits, short-lived in-memory-only eBay authority, a 60-second single-flight snapshot cache, independent summary/coverage counts, exact-ID lookup, generic redacted failures, and no commerce mutation capability.
- Final predeployment verification passed 39 test files / 393 tests, TypeScript, the production build, and whitespace checks.

### 2026-08-13: Minimal Verified Listings App

- Added a credential-free, digest-bound snapshot of the verified Canon `CAN3570-U119` eBay canary and an authenticated read-only listings API. The API reports that the record is a historical verified snapshot, not a current remote read.
- Replaced the operator shell with five focused pages: Overview, Listings, Orders, Issues, and Settings. Listing rows and detail remain concise, keyboard accessible, responsive, and fail closed when the snapshot is unavailable.
- Kept all commerce writers quarantined. No order import, inventory or price sync, Marketplace Connect change, OAuth storage, or listing mutation is part of this release.
- Verified the complete 38-file / 355-test suite, TypeScript, and production web build before release. Added a concise Listings help entry.

### 2026-08-11: Isolated Authoritative-Read Capture Foundation

- Added an operator-run evidence-capture CLI with exactly `preflight`, `collect`, and `verify`. It requires a fixed ignored exact-identity configuration, an exact scope digest, a clean matching source revision, recent half-open order bounds, ephemeral environment-only read authority, and a pinned Ed25519 signing key.
- Added a pinned Shopify Admin GraphQL `2026-07` reader using three compiled query documents only. It verifies store/app identity and least-privilege scopes, traverses variants/inventory locations and recent orders, retains `Order.app` attribution, and strips customer/order-detail data.
- Added exact eBay identity, Inventory-item/offer, and bounded Fulfillment `GET` readers with no OAuth acquisition or refresh. Evidence explicitly covers Inventory-model records only and never claims a complete all-listings census.
- Added canonical signed mode-`0600` local artifacts, exact source-schema verification, streaming response caps, PII/secret rejection, and a strict independently signed Marketplace Connect attestation verifier. Marketplace Connect UI settings remain configuration evidence; price/inventory ownership requires stronger evidence, and order ownership requires Shopify creator attribution or support evidence.
- No collector configuration, ephemeral authority, or signing key was available in the task environment, so no live Shopify/eBay/Marketplace Connect capture occurred. No runtime route, commerce writer, order import, historical backfill, watermark, or cutover behavior changed. Historical artifact verification still needs an archived original configuration/public-key/build context.
- PR #4 merged as `57001ed777e5a75076cb159e306706eb7efd7d68`; GitHub reported the Railway deployment successful and the public health endpoint served that exact revision with the existing shadow-read-only/no-backfill/null-watermark policy. This is deployment identity and policy evidence, not source connectivity or parity proof.

### 2026-08-11: Inert Migration Administration and Read-Only Projection

- Added a separate `migration-admin` CLI with exactly `init` and `verify`: initialization previews without writing, requires exact account-scope digest confirmation, creates only inert scope/genesis state, and refuses replacement, unsafe paths, sidecars, placeholders, credentials, or non-null cutover intent.
- Added a redacted migration-store projection and request-time status reader. The mounted API/UI can show local control-plane counts and audit state only when explicitly configured; application startup still does not open or create the store, and no platform or writer capability was added.
- Preserved production denial: zero eligible orders, no historical backfill, no watermark, no ProductPipeline ownership transfer, no canary/cutover authorization, and no external-write support. Local verification remains separate from Shopify/eBay/Marketplace Connect parity.

### 2026-08-11: Inert Durable Migration-State and Fixture Read Contracts

- Added a dedicated, explicitly initialized migration-state persistence boundary separate from the legacy application ledger. It models exact platform/account identities, canonical responsibilities, versioned ownership, immutable exclusive order watermarks, separate monotonic cursors, stable idempotency intents, single-use approvals, execution jobs/attempts, reconciliation evidence, and a verified hash-chained audit.
- Made the production-scoped foundation deliberately inert: it may retain the accepted Marketplace Connect incumbent baseline and shadow evidence, but cannot establish a ProductPipeline order watermark, transfer ownership to ProductPipeline, consume an execution approval, reserve a writer job, or authorize an external write.
- Added incident-specific SQL and repository invariants for no historical backfill, one intent per account-scoped eBay order, atomic reservation, linked-order denial, post-dispatch outcome-unknown reconciliation, and tamper-detecting reopen checks. The store remains unwired from server startup, webhooks, schedulers, legacy CLI, credentials, and commerce adapters.
- Added a fixture-only shadow-read contract with exact account/host/path/query policy, HTTPS GET/HEAD-only requests, bounded pages/records/bytes, opaque seven-day order windows, redaction checks, and completeness proof. It has no default network transport or credential source and can never produce live or production-parity evidence.
- Added `docs/MIGRATION_STATE.md`, canonical shared responsibility names, and matching policy/evidence/UI projections. No live Shopify/eBay/Marketplace Connect access, production-data change, order import, listing mutation, watermark, cutover, or writer activation is part of this slice.

### 2026-08-11: Provenance-Bearing Parity Workflow and Shadow API Reduction

- Replaced the single-timestamp offline snapshot with a strict version-2 evidence contract carrying independent ProductPipeline, Shopify, eBay, and Marketplace Connect subjects, collection method, bounded query window, pagination/count proof, capture/as-of time, normalization/redaction versions, and dataset digest. Partial or unavailable evidence parses as a blocker rather than being inferred away.
- Added per-source and per-responsibility readiness, duplicate Shopify/eBay SKU blockers, stable-ID/status comparisons, and a pure unwired canary-readiness evaluator. The evaluator can describe prerequisites but can never authorize or execute a write.
- Reduced the mounted runtime API to authenticated migration status, projected local listings, and capability metadata. Production now requires a verified Shopify App Bridge session JWT for the exact app/store; Referer, Origin, query keys, and production API keys cannot authorize. Legacy order/customer/log/settings/test/remote-reader GETs are unmounted.
- Removed application-database initialization, migrations, settings/help/template seeds, and webhook receipt persistence from the mounted shadow server. Local status/listing views open only an existing SQLite ledger in file-must-exist, read-only, query-only mode.
- Updated the five-page UI to separate accepted ownership policy, source evidence, response time, and parity. Missing/partial/stale evidence is critical; local counts remain non-authoritative; no action beyond GET refresh is mounted.
- Redacted a legacy committed API key from current mapping files, made the former live mapping test network-inert, and reduced the checked-in Shopify app scope request to reads only. History still contains the former key and rotation remains an external owner decision.
- Added `docs/READ_ONLY_PARITY.md`. No live Shopify/eBay evidence collector, database migration, platform write, order import, historical backfill, Marketplace Connect change, credential rotation, or canary is part of this slice.

### 2026-08-11: Hard Writer Quarantine and Offline Reconciliation

- Added an immutable Marketplace Connect incumbent policy: ProductPipeline is hard-coded to shadow read-only, with no runtime override, no historical backfill, no order cutover watermark, and no external commerce writes.
- At that 2026-08-11 release, denied every non-read `/api` request, unmounted the legacy scheduler/cloud watcher, removed webhook dispatch and payload persistence, and reduced the legacy CLI to `status`.
- Gated low-level eBay non-read requests plus Shopify order/inventory adapters and legacy mutation services so direct imports cannot bypass the route and startup controls.
- Added read-only Overview, Listings, Orders, Reconciliation, and Settings migration surfaces with explicit Marketplace Connect ownership, quarantine status, proof limits, and operator-safe refresh/review actions.
- Added strict local snapshot reconciliation and hash-chained audit evidence. It uses no credentials, remote clients, or application database; always records zero external writes/no historical backfill/no order eligibility; and cannot establish live parity.
- Added focused tests and operator/help documentation. The merged application revision and public Railway health evidence are recorded in `PROJECT_BRAIN.md`; remote parity and every responsibility cutover remain separate evidence gates.

### 2026-08-11: Local-Only Operator CLI Foundation

- Added a separate operator entrypoint for local preflight, ownership reporting, and audit verification without importing the legacy CLI, credentials, database, server, platform clients, sync modules, schedulers, or watchers.
- Added strict shadow/read-only configuration validation that rejects writes, order import, historical backfill, an active cutover watermark, ProductPipeline writer ownership, wildcard allowlists, unknown fields, unsafe paths, and credential-like material.
- Added an append-only-by-tool, hash-chained local audit with lock, filesystem sync, full-chain verification, and explicit local immutability limitations.
- Added focused tests and operator documentation. The foundation commit by itself was not deployment, production-parity, or cutover evidence.

### 2026-08-11: Marketplace Connect Replacement Target and Test Lane

- Revised the canonical target from listing-only coexistence to a staged, operator-approved replacement for Marketplace Connect's Used Camera Gear eBay integration.
- Recorded the read-only Shopify walkthrough: Marketplace Connect currently imports all complete eBay orders and syncs price/inventory; ProductPipeline is reachable but exposes overlapping controls, historical local orders, AI/pipeline activity, and conflicting eBay status indicators.
- Added the ownership matrix, explicit order watermark, durable external-ID idempotency, single-writer, audit, reconciliation, canary, break-glass, and rollback gates.
- Defined separate sandbox/development and live-canary Test Lanes, with no historical backfill and no real Shopify-order writes in the current phase.
- Defined the simple five-page operator control plane and staged replacement plan. No application code, configuration, credential, deployment, or commerce-system mutation was made.

### 2026-08-11: Durable Project Brain and Narrowed Product Direction

- Added `PROJECT_BRAIN.md` as the canonical repository-local orientation and handoff document.
- Recorded the narrowed Marketplace Connect-style eBay listing-management purpose.
- Distinguished verified source behavior from deployment and live-system unknowns.
- Inventoried listing capabilities, order-sync safeguards and residual risks, and legacy AI/enrichment scope.
- Defined non-negotiable order-ownership, no-backfill, cursor, idempotency, approval, reconciliation, webhook, and audit safeguards.
- Added a staged architecture and decommission plan; no application code, configuration, runtime behavior, deployment, or commerce system was changed.

### 2026-02-25: End-to-End UI Fixes — Voting, Orders Filters, Sync Status
Improved end-to-end functionality to eliminate dead interactions and mismatches:
- **Feature Requests voting**: added vote tracking and API support; UI now shows vote counts and allows one vote per browser.
- **Orders page accuracy**: orders API now supports search/status/date filters and surfaces totals via eBay order data; UI status filters align with actual sync states.
- **Sync reliability**: order sync trigger now accepts body-provided dates, inventory status can be queried via GET, and background sync uses explicit `confirm=true`.

### 2026-02-24: Help Center — Seed Articles for All Shipped Features

Added a dedicated seed script for Help Center articles covering every shipped feature.

**What changed:**
- **`src/server/seeds/help-articles.ts`** (new): Standalone seed module with 16 articles across 5 categories (Getting Started, Products, eBay, Pipeline, Settings). Uses `INSERT OR IGNORE` so it's safe to run on every startup.
- **`src/server/index.ts`**: Calls `seedHelpArticles(rawDb)` on startup after other seeds.
- **`AGENTS.md`**: Added "Help Documentation Rule" — agents must add a help article whenever shipping a new feature.

**Articles added:**
- Getting Started: What is ProductPipeline?, How do I get started?
- Products: Review Queue workflow, drag-and-drop photo reordering, bulk photo editing, photo editor, image processing pipeline trigger
- eBay: List a product, change eBay category (searchable dropdown), condition descriptions (auto-populated from grades), eBay order sync + safety guards
- Pipeline: Automated pipeline (StyleShoots → Shopify → eBay), AI descriptions, pipeline settings
- Settings: Connect Shopify, connect eBay, edit condition descriptions

### 2026-02-23: eBay Listing Prep Page — Full Visibility Before Listing

Redesigned the "Approve & List on eBay" flow to give full visibility and control before creating a listing.

**What changed:**
- **`src/web/pages/EbayListingPrep.tsx`** (new): Full-page eBay listing preparation view.
  - Fetches system-generated preview data on load (calls existing `preview-ebay-listing` endpoint)
  - **All fields are editable before listing:** eBay title (with 80-char limit badge), price, category ID, condition dropdown (New/Like New/Excellent/Very Good/Good/Acceptable/For Parts), item specifics as key-value pairs (add/remove), condition description, photos (reorder with ↑↓, remove), description (textarea, HTML-aware)
  - **Business policies** displayed with IDs (not editable here — managed in eBay seller account)
  - **Real eBay-style preview:** Mimics the eBay listing page layout (title, price, photo gallery with thumbnail strip, condition badge, item specifics table, description, seller info)
  - **Photo management:** Thumbnail grid with #1 marked as MAIN, reorder/remove controls
  - **Sticky sidebar** with summary of all settings + two action buttons
  - **"List on eBay"** (primary) — sends all edited values as overrides to the API
  - **"Save as Draft"** — saves title/description to draft API + stores eBay-specific overrides (category, condition, aspects, price, image order) in localStorage, keyed by draftId; restored on next visit
  - **"Reload from System"** secondary action — re-fetches system defaults, discarding manual edits
  - Returns to review detail after listing or saving
- **`src/web/pages/ReviewDetail.tsx`**: "Approve & List on eBay" button now navigates to `/review/:id/ebay-prep` (no more small modal). Removed old modal and preview mutation code.
- **`src/web/App.tsx`**: Added route `/review/:id/ebay-prep` → `<EbayListingPrep />`
- **`src/services/ebay-draft-lister.ts`**: `listDraftOnEbay()` now accepts optional `overrides: ListingOverrides` — any field supplied overrides the system-generated value. New `ListingOverrides` export type.
- **`src/server/routes/drafts.ts`**: `POST /api/drafts/:id/list-on-ebay` now accepts optional body `{ title, price, categoryId, condition, aspects, description, imageUrls }` and passes them as overrides to the service.

**Safety:** Still single product, explicit click only. No auto-publish. No batch.

### 2026-02-23: Order Sync Safety Guards

Added multiple layers of protection to prevent duplicate Shopify orders from cascading into Lightspeed POS (repeat of the 2026-02-11 incident):

- **`src/sync/order-safety.ts`** (new): Central safety module — `SAFETY_MODE` rate limiter (default `"safe"`: max 5/hr, min 10s between creations), `findDuplicateByTotalDateBuyer()` third-layer duplicate detection, custom error types.
- **`src/sync/order-sync.ts`**: Dry-run is now the default (`confirm=true` required to create real orders). Three duplicate-detection layers applied before any creation. `SyncResult` now includes `dryRun` flag and `safetyBlocks[]` array.
- **`src/server/sync-helper.ts`**: `confirm` parameter added; dry run documented as default.
- **`src/server/routes/api.ts`**: `POST /api/sync/trigger` requires `?confirm=true` for live runs.
- **`src/server/routes/ebay-orders.ts`**: Safety comments on import endpoint; new `POST /api/ebay/orders/sync-to-shopify` requires `{ confirm: true }`.
- **`src/web/pages/EbayOrders.tsx`**: Critical warning banner about Lightspeed POS downstream impact.
- **`AGENTS.md`** (new at project root): Complete rules for agents/developers working on this codebase.

### 2026-02-23: Approve Draft → Create eBay Listing Flow

Built the end-to-end "list on eBay" workflow from the draft review queue:

**Backend:**
- New service: `src/services/ebay-draft-lister.ts` — single-product eBay lister
  - Builds eBay inventory item from draft content (title, description, images) with Shopify fallback
  - Ensures Pictureline inventory location exists (idempotent)
  - Fetches business policies, maps condition/category/aspects using existing mappers
  - Creates eBay inventory item → offer → publishes → saves `product_mappings` record
  - Updates `product_drafts.status` to `'listed'`, saves `ebay_listing_id` + `ebay_offer_id`
  - Logs success/failure to `sync_log`
  - Dry-run preview mode: builds full payload without calling eBay publish
- Two new API routes in `src/server/routes/drafts.ts`:
  - `POST /api/drafts/:id/list-on-ebay` — creates live eBay listing (single product, explicit click only)
  - `POST /api/drafts/:id/preview-ebay-listing` — dry run preview of what would be sent to eBay
- DB schema: added `ebay_listing_id` and `ebay_offer_id` columns to `product_drafts` table (auto-migrated on startup)

**Frontend (`ReviewDetail.tsx`):**
- "🛍️ Approve & List on eBay" button in the Actions sidebar card
- Confirmation modal with safety warning before listing goes live
- "Preview Listing" option loads dry-run payload inline in the modal
- Shows live eBay listing badge + "View on eBay" link after success
- Pipeline Status card updated with eBay listing step (green when listed)
- `statusBadge()` handles new `'listed'` status

**Safety:** NO batch, NO auto-publish. Single product, explicit user action required.

### 2026-02-18: Product Detail Page Redesign
Redesigned `ShopifyProductDetail` in `src/web/pages/ShopifyProducts.tsx` to match ReviewDetail quality:
- **Single CTA**: "Run Pipeline" appears only in page header (removed from Quick Actions and sidebar)
- **Removed Quick Actions card**: External links moved to page `secondaryActions`
- **Status badges in title**: TIM Condition and eBay status shown as compact badges next to product title
- **Pipeline as sidebar hero**: Pipeline progress tracker is now the top sidebar card
- **Beautiful empty states**: Photos section shows a dashed drop-zone with Drive search CTA when empty
- **Conditional cards**: TIM Condition and eBay cards only render when data exists (no empty cards)
- **Consolidated Details card**: Merged product info into a single compact card, tags shown inline
- **Subtle animations**: Fade-in animation on page load
- **Consistent spacing**: `gap="400"` throughout, matching ReviewDetail patterns
- **All functionality preserved**: No features removed, only visual reorganization
