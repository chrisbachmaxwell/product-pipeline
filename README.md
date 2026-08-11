# ProductPipeline

**Shopify ↔ eBay listing automation for UsedCameraGear.com**

> **Current direction (2026-08-11):** ProductPipeline is the intended safe, simple replacement for Shopify Marketplace Connect's Used Camera Gear eBay integration. Marketplace Connect remains the incumbent during a gated migration; ProductPipeline must not perform live writes or historical order backfill until the per-responsibility parity, canary, reconciliation, rollback, and approval requirements in `PROJECT_BRAIN.md` pass. AI/product-enrichment is legacy scope. Agents and maintainers must read `AGENTS.md` and `PROJECT_BRAIN.md` before making changes.

> **Enforced application state:** ProductPipeline is hard-coded in shadow read-only mode. Marketplace Connect owns production order import, price, and inventory; every non-read `/api` request is denied, background writers are unmounted, and low-level commerce writers fail closed. See [`docs/WRITER_QUARANTINE.md`](docs/WRITER_QUARANTINE.md) for operator behavior, enforcement layers, and proof limits.

> **Evidence state:** The embedded runtime exposes only authenticated, redacted shadow reads. The operator reconciler accepts strict version-2 offline evidence with independent Shopify, eBay, Marketplace Connect, and ProductPipeline provenance. No authoritative Shopify/eBay snapshot or current Marketplace Connect export has been captured yet, so parity and every canary remain blocked. See [`docs/READ_ONLY_PARITY.md`](docs/READ_ONLY_PARITY.md).

> Formerly "ebay-sync-app" / "Product Bridge". The current GitHub repository name is `product-pipeline`; a future product rename is anticipated but not authorized yet.

Legacy implementation currently present: Lightspeed → Shopify → AI description → PhotoRoom images → eBay, plus Shopify/eBay sync functions. This does not define the target architecture or prove replacement of any live Marketplace Connect function.

## Safe Operator CLI and Reconciliation

The migration operator CLI is an isolated, local-only foundation for shadow configuration, responsibility ownership, strict offline snapshot reconciliation, and tamper-evident audit checks. It has no Shopify/eBay/Marketplace Connect client, application-database import, sync, publish, or mutation command.

```bash
npm run operator -- preflight --config config/operator-shadow.example.json
npm run operator -- ownership --config config/operator-shadow.example.json
npm run operator -- reconcile --config config/operator-shadow.example.json --snapshot .local/operator-reconciliation/snapshot.json
npm run operator -- audit verify --file .local/operator-audit/operator-cli.jsonl
```

The checked-in example intentionally reports unresolved ownership blockers outside the accepted order/price/inventory baseline. Passing a check proves only the declared local configuration or internally consistent supplied evidence—not remote identity, parity, deployment, or cutover readiness. See [`docs/OPERATOR_CLI.md`](docs/OPERATOR_CLI.md).

## Features

> The commands below describe historical implementation surfaces, not current CLI commands or approved migration actions. The current-source `ebaysync` entrypoint registers only `status`; former sync, import, publish, republish, and price-drop commands are unmounted.

| Feature | Direction | Command |
|---------|-----------|---------|
| **Order sync** | eBay → Shopify | `ebaysync orders sync` |
| **Product listing** | Shopify → eBay | `ebaysync products sync` |
| **Inventory sync** | Shopify → eBay | `ebaysync inventory sync` |
| **Price sync** | Shopify → eBay | `ebaysync sync` |
| **Fulfillment sync** | Shopify → eBay | `ebaysync sync` |
| **Full sync** | Both directions | `ebaysync sync` |
| **Watch mode** | Continuous polling | `ebaysync sync --watch 10` |

## Quick Start

> Historical application setup follows for repository context. In the current shadow phase, use only `npm run cli -- status` and the local operator commands above; action commands shown below are no longer registered.

```bash
# Install dependencies
npm install

# Build
npm run build

# Authenticate
ebaysync auth shopify    # Get Shopify access token
ebaysync auth ebay       # eBay OAuth consent flow (one-time)

# Check status
ebaysync status

# Run full sync
ebaysync sync

# Dry run (preview without changes)
ebaysync sync --dry-run

# Sync only orders since a date
ebaysync orders sync --since 2026-02-01

# Watch mode — poll every 10 minutes
ebaysync sync --watch 10

# --- New Commands (v0.2) ---

# Image Pipeline
ebaysync pipeline trigger <productId>   # Trigger image pipeline
ebaysync pipeline status [jobId]        # Check job status
ebaysync pipeline cancel <jobId>        # Cancel a running job
ebaysync pipeline history               # Recent pipeline runs
ebaysync pipeline clear-stuck           # Clear stuck jobs

# Drafts / Review Queue
ebaysync drafts list                    # List drafts (--status pending|approved|rejected)
ebaysync drafts review                  # Pending count
ebaysync drafts approve <id>            # Approve a draft
ebaysync drafts reject <id>             # Reject (--reason "...")
ebaysync drafts approve-all             # Approve all pending
ebaysync drafts settings                # View auto-publish settings

# Images & Templates
ebaysync images list <productId>        # List product images
ebaysync images process <productId>     # Process images (bg removal)
ebaysync images reprocess <productId>   # Reprocess all images
ebaysync images templates               # List photo templates
ebaysync images set-template <id>       # Set default template
ebaysync images status                  # Image service status

# eBay Listings
ebaysync listings list                  # List listings (--search, --status)
ebaysync listings stale                 # Show stale listings
ebaysync listings health                # Listing health check
ebaysync listings republish             # Republish stale listings
ebaysync listings price-drops           # Apply price drops
ebaysync listings promote               # Promote listings

# Analytics
ebaysync analytics summary              # Sales summary (eBay order stats)
ebaysync analytics orders               # Recent eBay orders

# TIM Integration
ebaysync tim items                      # List TIM items
ebaysync tim condition <productId>      # Get condition data
ebaysync tim tag <productId>            # Apply condition tag

# Health & Config
ebaysync health                         # Full health check
ebaysync config show                    # Show configuration
ebaysync config set <key> <value>       # Update server setting

# Feature Requests
ebaysync features list                  # List feature requests
ebaysync features add "Title"           # Submit a feature request

# Global flags: --json, --dry-run, --verbose
```

## Architecture

```
src/
├── cli/           # CLI commands (commander)
│   ├── index.ts   # Main entry + top-level sync command
│   ├── auth.ts    # auth shopify / auth ebay / auth status
│   ├── products.ts # products list / products sync
│   ├── orders.ts  # orders sync / orders list
│   ├── inventory.ts # inventory sync
│   └── status.ts  # Dashboard with counts + activity
├── ebay/          # eBay API clients
│   ├── client.ts  # Base HTTP client + token exchange
│   ├── auth.ts    # OAuth consent flow (manual + local server)
│   ├── fulfillment.ts # Fulfillment API (orders + shipping)
│   ├── inventory.ts   # Inventory API (items + offers)
│   ├── browse.ts  # Browse API (search listings)
│   ├── trading.ts # Account API (business policies)
│   └── token-manager.ts # Auto-refresh expired tokens
├── shopify/       # Shopify API clients
│   ├── client.ts  # GraphQL + REST client setup
│   ├── products.ts # Product fetching
│   ├── orders.ts  # Order creation + dedup search
│   └── inventory.ts # Inventory levels + locations
├── sync/          # Sync engines
│   ├── order-sync.ts      # eBay → Shopify order import
│   ├── product-sync.ts    # Shopify → eBay listing creation
│   ├── inventory-sync.ts  # Shopify → eBay quantity sync
│   ├── price-sync.ts      # Shopify → eBay price sync
│   ├── fulfillment-sync.ts # Shopify → eBay shipping updates
│   └── mapper.ts          # Field mapping (condition, category, carrier)
├── db/            # SQLite database (better-sqlite3 + drizzle-orm)
│   ├── client.ts  # DB connection + table init
│   └── schema.ts  # Drizzle schema definitions
├── config/        # Credential loading
│   └── credentials.ts
└── utils/
    ├── logger.ts  # Colored logging
    └── retry.ts   # Retry with backoff
```

## Credentials

Stored in `~/.clawdbot/credentials/`:

- `ebay-api.txt` — eBay App ID, Dev ID, Cert ID, RuName
- `shopify-usedcameragear-api.txt` — Shopify Client ID + Secret

## Database

SQLite at `~/.clawdbot/ebaysync.db` with tables:
- `auth_tokens` — OAuth tokens for both platforms
- `product_mappings` — Shopify product ↔ eBay listing links
- `order_mappings` — eBay order ↔ Shopify order links (dedup)
- `sync_log` — Audit trail of all sync operations

## How It Works

### Order Sync (eBay → Shopify)
1. Fetch orders from eBay Fulfillment API
2. Check local DB for existing mapping (fast dedup)
3. Check Shopify for existing order by tag (belt + suspenders)
4. Create Shopify order with eBay details (customer, items, shipping)
5. Tag order with `eBay,eBay-{orderId}` for future dedup
6. Suppress email notifications (no double emails to customer)

### Inventory Sync (Shopify → eBay)
1. Get all product mappings from DB
2. Fetch current Shopify quantities
3. Fetch current eBay quantities
4. Update eBay if different

### Price Sync (Shopify → eBay)
1. Get all product mappings from DB
2. Compare Shopify variant prices with eBay offer prices
3. Update eBay offers where price differs

### Fulfillment Sync (Shopify → eBay)
1. Get synced (unfulfilled) order mappings
2. Check Shopify for fulfillments with tracking
3. Create eBay shipping fulfillment with carrier + tracking number
4. Mark order mapping as fulfilled

## eBay Account

- **Seller:** usedcam-0 (https://www.ebay.com/usr/usedcam-0)
- **Location:** supplied by the approved eBay listing policy; not embedded in this operator guide
- **Current incumbent:** Marketplace Connect (Codisto); ProductPipeline replacement is gated and not yet complete

## Tech Stack

- TypeScript
- Commander (CLI framework)
- better-sqlite3 + drizzle-orm (local state DB)
- @shopify/shopify-api (Shopify client)
- Native fetch (eBay REST APIs)
- ora (spinners), chalk (colors)

## TEST_MODE (Browser Testing)

Set `NODE_ENV=test` (or `development`) together with `TEST_MODE=true` to run the app locally without Shopify authentication or the admin iframe. Test mode fails closed when `NODE_ENV` is missing or `production`.

```bash
NODE_ENV=test TEST_MODE=true npm run dev
```

What it does:
- **Skips API auth locally** — only the explicit shadow-read API allowlist is reachable
- **Injects a mock Shopify session** — routes that expect a session get `test-store.myshopify.com`
- **Allows localhost CORS** — no origin restrictions for local requests
- **Disables App Bridge** — the frontend renders standalone (no Shopify admin iframe required)
- **`GET /api/test-mode`** — returns `{ testMode: true }` so QA tools can verify the mode

Production rejects test mode regardless of `TEST_MODE`. Never rely on that guard as a substitute for correct environment configuration.
