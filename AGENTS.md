# AGENTS.md — Rules for Working on ProductPipeline

> **MANDATORY: Read this file, `PROJECT_BRAIN.md`, AND `PROJECT.md` before making any changes to this codebase.**
> Any agent working on this project must update `PROJECT.md` changelog before finishing.

---

## 0. Read First

1. Read this file — safety rules, code conventions, what NOT to do
2. Read `PROJECT_BRAIN.md` — canonical direction, source-of-truth rules, verified state, unknowns, and handoff protocol
3. Read `PROJECT.md` — historical architecture, feature status, decision log, and changelog
4. Check `git log --oneline -20` to understand recent changes
5. If touching order sync: re-read the entire **Order Sync Safety** section below

When historical documentation conflicts with `PROJECT_BRAIN.md`, follow the brain and verify the current code. The authorized target is a safe, simple replacement for Marketplace Connect's Used Camera Gear eBay integration. Marketplace Connect remains the incumbent writer during migration; ProductPipeline must stay read-only/shadow for each responsibility until its documented parity, idempotency, canary, reconciliation, approval, and rollback gates pass. AI/product-enrichment is legacy scope for staged removal. No historical order backfill is permitted.

---

## 1. Critical Incidents — Never Repeat These

### 🔴 Incident: 2026-02-11 — Duplicate eBay Orders in Shopify + Lightspeed

**What happened:** A sync without a date filter pulled ALL historical eBay orders into Shopify.
These cascaded automatically into Lightspeed POS (the in-store point-of-sale system).
Result: hours of manual cleanup, reconciliation, and stress.

**Root cause:** `syncOrders()` was called without a `createdAfter` date filter.

**What was built to prevent recurrence:**
- 24h default lookback with 7-day maximum enforced in `syncOrders()`
- Dry-run default — must pass `confirm=true` to create real orders
- Three-layer duplicate detection (DB → Shopify tag → total+date+buyer)
- `SAFETY_MODE=safe` rate limiter (5/hr, 1/10s)
- `src/sync/order-safety.ts` — all safety primitives live here

**The rule:** If you are tempted to bypass ANY of these guards, stop and ask a human first.

---

## 2. Order Sync Safety Rules (CRITICAL)

These are hard rules. Do not change them without explicit approval.

### 2.1 Dry Run is the Default

`syncOrders()` is **dry-run by default**. To create real Shopify orders you MUST:
- Pass `confirm: true` to `runOrderSync()` / `syncOrders()`
- Pass `?confirm=true` query param to `POST /api/sync/trigger`
- Pass `{ confirm: true }` body to `POST /api/ebay/orders/sync-to-shopify`

Omitting `confirm` = no Shopify orders created = safe.

### 2.2 Three Layers of Duplicate Detection

Before ANY Shopify order creation, ALL three checks run in `syncOrders()`:

| Layer | Method | Location |
|-------|--------|----------|
| 1 | `order_mappings` DB lookup | `src/sync/order-sync.ts` |
| 2 | Shopify tag search (`eBay-{orderId}`) | `src/shopify/orders.ts` |
| 3 | Total + date + buyer matching | `src/sync/order-safety.ts` |

If ANY layer finds a match → **REFUSE creation**, log to `safetyBlocks`, save mapping.

Do not remove or skip any of these layers.

### 2.3 SAFETY_MODE Rate Limiter

`SAFETY_MODE` env var (default: `"safe"`) enforces:
- Max **5 Shopify orders per hour** (process-wide, in-memory)
- Min **10 seconds** between consecutive creations

Set `SAFETY_MODE=off` only with explicit human approval and only temporarily.
The rate limiter lives in `src/sync/order-safety.ts` → `assertRateLimit()`.

### 2.4 Date Lookback Guard

`syncOrders()` enforces a **7-day maximum lookback** regardless of what the caller requests.
Default lookback when no date is provided: **24 hours**.
Do not increase either limit without explicit approval.

### 2.5 Lightspeed Cascade

Every Shopify order with `source_name: 'ebay'` automatically flows into **Lightspeed POS**.
This is the in-store point-of-sale system. Duplicates require manual intervention.
Always assume Shopify order creation has real-world POS consequences.

---

## 3. Code Conventions

### General
- **TypeScript ESM** throughout — use `.js` extensions on imports (even for `.ts` files)
- Express 5 + async route handlers — no `next(err)` pattern, just `throw` or `res.status().json()`
- Drizzle ORM for DB queries; raw SQL only for complex queries not expressible in Drizzle
- Logger: `import { info, warn, error } from '../utils/logger.js'` — never `console.log`

### Adding New Routes
1. Add route module in `src/server/routes/`
2. Register in `src/server/index.ts` (or wherever routes are mounted)
3. Register capability in `src/server/capabilities.ts` for chat/UI discovery
4. Add frontend page in `src/web/pages/`, route in `App.tsx`

### Adding New DB Tables
1. Legacy application-ledger tables use `src/db/schema.ts` and `src/db/migrate.ts`.
2. Marketplace Connect migration safety state belongs only in the separate `src/migration-store/` schema and repository. Never add its watermarks, idempotency, approvals, jobs, ownership, reconciliation, or audit records to the legacy startup-initialized database.
3. A migration-store schema change requires an explicit versioned migration, schema/catalog verification, incident-specific persistence tests, and documentation in `PROJECT.md` plus `docs/MIGRATION_STATE.md`.
4. Do not import or initialize the migration store from server startup, webhooks, schedulers, legacy CLI, or commerce adapters without a separately reviewed runtime-wiring slice.

### Frontend
- React 19 + Shopify Polaris components — use Polaris for all UI
- TailwindCSS 4 for layout/spacing when Polaris doesn't cover it
- Zustand for global state, React Query / `useMutation` for server state
- All API calls through `useApi.ts` hooks — do not call `fetch()` directly in components

### Error Handling
- API routes: return `{ error: string, detail?: string }` on failure
- Never expose raw stack traces to the client
- Log errors with `logError()` before returning 500

---

## 4. File Map — What Lives Where

| File | Purpose |
|------|---------|
| `src/sync/order-safety.ts` | Rate limiter, duplicate detection, custom errors |
| `src/sync/order-sync.ts` | `syncOrders()` — core eBay → Shopify order sync |
| `src/server/sync-helper.ts` | `runOrderSync()` — wrapper that fetches tokens |
| `src/server/routes/api.ts` | `POST /api/sync/trigger` (requires `?confirm=true` for live) |
| `src/server/routes/ebay-orders.ts` | eBay order import (local DB only) + sync-to-shopify |
| `src/shopify/orders.ts` | `createShopifyOrder`, `findExistingShopifyOrder` |
| `src/web/pages/EbayOrders.tsx` | eBay Orders UI page |
| `src/migration-store/` | Dedicated, explicit migration control-plane persistence; not the legacy app ledger and not runtime-wired |
| `src/shadow-read/` | Unwired fixture-only GET/HEAD, token-policy, order-window, and pagination contracts; never live proof |
| `src/safety/responsibilities.ts` | Canonical responsibility vocabulary shared by policy, evidence, persistence, UI, and canary rules |

---

## 5. What NOT to Do

- ❌ Never call `syncOrders()` or `runOrderSync()` without verifying the date filter
- ❌ Never disable or remove the `assertRateLimit()` call before `createShopifyOrder()`
- ❌ Never remove any of the three duplicate detection layers
- ❌ Never increase the 7-day lookback limit without human approval
- ❌ Never add a "sync all historical orders" feature without an extended review
- ❌ Never call `createShopifyOrder()` directly from a new code path without wiring in all three duplicate checks
- ❌ Never use `console.log` — use `info()`, `warn()`, `error()` from `utils/logger.js`
- ❌ Never skip the `PROJECT.md` changelog update when finishing a task

---

## 6. Testing Checklist for Order Sync Changes

Before shipping any change to order sync code:

- [ ] Run `npm run build` — TypeScript must compile with zero errors
- [ ] Verify `syncOrders()` with no arguments defaults to dry run
- [ ] Verify the 7-day lookback clamp is enforced (test with a date 30 days ago)
- [ ] Verify duplicate detection blocks an order already in `order_mappings`
- [ ] Verify `SAFETY_MODE=safe` rate limiter throws after 5 creations/hr
- [ ] Check the `safetyBlocks` array in the result for any unexpected blocks

---

## 7. Deployment Notes

- Railway auto-deploys from `git push origin main`
- Production DB: `~/.clawdbot/ebaysync.db` (not the dev DB at `src/db/product-pipeline.db`)
- `SAFETY_MODE` defaults to `"safe"` even if the env var is not set
- After any order-sync-related deploy, monitor the Shopify orders page for 30 minutes

---

## 8. Changelog Requirement

**Before finishing any task**, add an entry to `PROJECT.md` under `## Recent Changes`.
Format:

```markdown
### YYYY-MM-DD: Brief Title
Description of what changed and why.
```

This file was last updated: **2026-02-24**

---

## Help Documentation Rule

When shipping a new feature, you MUST add a help article for it:

1. Add an INSERT/upsert to `src/server/seeds/help-articles.ts`
2. Use the appropriate category (Getting Started, Products, eBay, Pipeline, Settings, etc.)
3. Write the answer in clear, concise language. Include step-by-step instructions where relevant.
