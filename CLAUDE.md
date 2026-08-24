# ProductPipeline — Claude entry point

ProductPipeline is a Shopify-embedded app replacing Marketplace Connect for the Used Camera Gear eBay integration (listings, price, inventory, new-order import). Every provider write sits behind an execution-time operator ceremony; nothing dispatches on deploy.

**Before any work, follow the protocol in `PROJECT_BRAIN.md` Section 12**, then use the **task router in Section 15** to read only what your task needs. `AGENTS.md` holds the safety rules and code conventions; `PROJECT.md` holds the changelog.

Absolutes (never violate, never weaken the enforcement of):
1. **Never import or backfill historical orders** (Brain §17 L11 — structural one-hour watermark clamp, strictly-greater eligibility, one watermark forever).
2. One writer per responsibility, ever: Marketplace Connect's toggle must be recorded off (with evidence) before ProductPipeline takes a responsibility.
3. Every eBay/Shopify write goes through the migration-store ceremony CLIs with a one-action, exact-target operator approval — no server-mounted writers, writer quarantine stays intact.
4. Credentials/PII never in the repo, logs, tests, or the migration store.

Conventions: TypeScript ESM (`.js` import suffixes), Express 5, React 19 + Polaris, better-sqlite3, vitest, no new npm dependencies without explicit approval; `main` auto-deploys to Railway (merging = deploying). Known environmental failures: the 11 `src/credential-admin` tests (Brain §17 L6).

**Self-building duty:** before finishing merged work, update the Brain per Section 15's mandatory list (goal statuses, append-only Learnings, `PROJECT.md` changelog).
