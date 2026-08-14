# ProductPipeline — PROJECT.md

> **Last updated: 2026-08-14. Any agent working on this project MUST update this file before finishing.**
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

DB location: `src/db/product-pipeline.db` (dev), `~/.clawdbot/ebaysync.db` (production)

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

### Credentials (file-based)

All stored in `~/.clawdbot/credentials/`:

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
| `SHOPIFY_CLIENT_ID` | Shopify Client ID | From file |
| `SHOPIFY_CLIENT_SECRET` | Shopify Client Secret | From file |
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
| **File-based credentials** | Predates env vars; supports both now (env overrides files) |
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

### 2026-08-14: Local Draft Production Initialization and Open Description-Cap Incident

- PR #10 merged the local listing-draft workspace to `main` as `e0d59cd904209c30e815f6cf6a2e4e784208efc5`. Railway deployed that exact revision, and public `/health` served it at `2026-08-14T15:55:08.152Z` with `shadow-read-only`, external writes disabled, historical backfill disabled, and a null order watermark.
- On the existing one-replica Railway service, the `/data/product-pipeline` parent was created mode `0700`; `/data/product-pipeline/listing-control.sqlite` was explicitly initialized and verified as schema version 2, `local_draft_only`, mode `0600`, with `externalWritesPerformed: 0`. Runtime did not initialize, migrate, or repair it.
- Created and verified the pre-draft baseline backup `/data/product-pipeline/backups/listing-control-initial-e0d59cd.sqlite` (mode `0600`, 114,688 bytes, SHA-256 `40c89f9e9beeac1ac36c33822ca59b3cc9057b99d062811b79cb00c6e88b4fc7`). This proves a verified local-store baseline only, not Shopify/eBay state.
- Live signed-in verification then found an open read-path incident: the exact listing workspace returned `503` after successful eBay reads because a local artificial 100,000-byte description validator rejected valid Production descriptions of 147,595 and 144,209 bytes. The failure occurred during local response parsing; it performed zero provider writes and did not change the initialized draft store.
- Local repair candidate is complete and independently reviewed: description parsing and store validation now share an exact 500,000-Unicode-code-point / 2,000,000-UTF-8-byte limit while the separate total-response bound remains fail-closed. Regressions preserve a 150 KiB description, accept the exact 500,000-code-point boundary, reject overflow/control input, preserve a 300 KB inherited description through save/reopen/audit/integrity checks, and retain the smaller non-description caps. The full 48-file / 504-test suite, `npm run build`, and `git diff --check` pass.
- Production repair remains **pending**. No repair commit, merge, deployment, exact health revision, signed-in affected-item proof, or post-deploy store re-verification exists yet. The durable incident checklist and handoff are in `docs/LISTING_WORKSPACE_INCIDENTS.md`; do not call the incident fixed from local evidence alone.

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
