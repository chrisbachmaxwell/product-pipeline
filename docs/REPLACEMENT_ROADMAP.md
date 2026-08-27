# Marketplace Connect Replacement — Master Roadmap

The ordered path from today's state to uninstalling Marketplace Connect, with the checks that gate each phase. Goal IDs refer to `PROJECT_BRAIN.md` Section 14. Ceremony details live in `docs/ACTIVATION_RUNBOOK.md` and the per-slice runbooks — this document is the sequence and the exit criteria, not the commands.

**Rules that hold through every phase:** never import or backfill historical orders (Brain §17 L11); one writer per responsibility, with Marketplace Connect recorded off (evidence) before ProductPipeline takes it; every write ceremonial until G18 automation is explicitly enabled per responsibility; a phase is not done until its checks are checked.

Legend: ☐ = pending · [USER] = only the user/operator can do it · [AGENT] = buildable by a directed agent · [BOTH] = agent builds, user executes.

---

## Phase 0 — Foundation (DONE, 2026-08-19/20)

- [x] All writer slices built and deployed (revise both models, create, end/relist, price, inventory, new-order import)
- [x] Schema-v3 migration store on `/data` (survives deploys); listingRevise ownership established
- [x] Embedded-app auth repaired (L1); draft editor rebuilt; branded description template + preview
- [x] Shadow order-parity mode available; project brain v2 with router and learnings

## Phase 1 — Listing management proof (G10, G16, G15)

Prove every listing lifecycle write end-to-end while MC still owns price/inventory/orders. No MC changes in this phase.

- [x] [USER] G10: save a draft on one live listing; run preflight → dispatch (description revise with `ucg-branded-v1`); verify on ebay.com; reconcile the exact attempt
- **Current gate (2026-08-26):** Production is schema v4. Draft 1 for listing `147232036779` is publicly live and byte-identical to the approved raw HTML; eBay still shows price `$164.95` and quantity `5`. The existing job/attempt is authoritatively `revised_state_observed` / `resolved_existing`, with exactly one provider write and a valid migration-store audit chain. Brain L14 records the recovered comparator incident; L15 records the harmless denied replay.
- ☐ [USER] Confirm MC price/quantity sync still behaves on that listing over 24h
- ☐ [USER] G16a: create one new SKU end-to-end (branded template) via `listing-lifecycle-admin`; verify live listing
  - 2026-08-27 state: v1 and v2 each stopped at the first Inventory PUT,
    reconciled `confirmed_missing`, and left no eBay artifact; neither intent
    can replay. Before another operator attempt, deploy the bounded diagnostic
    and exact-header correction, explicitly omit the test-only condition
    description in a newly reviewed draft, then preflight its genuinely new
    manifest. Diagnostics or an identical draft re-save are not retry authority.
- ☐ [USER] G16b: end (or end+relist) one low-stakes listing; verify
- **Exit check:** three dispatch types each `dispatched-and-reconciled` in the migration store; zero unexplained reconciliation exceptions; MC untouched.

## Phase 2 — Price and inventory takeover (G11, G12)

One responsibility at a time. Reversible (ownership back to `paused` + MC toggle back on — never both writers at once).

- ☐ [USER] G11: MC "Sync price" OFF (evidence captured) → establish-ownership (price) → 3+ price alignments via plan → dispatch → reconcile on real price changes
- ☐ [USER] Watch one week: `plan` runs show no unexpected drift; eBay prices match Shopify
- ☐ [USER] G12: MC "Sync inventory" OFF (evidence) → establish-ownership (inventory) → alignments on real stock changes (sales/restocks)
- ☐ [USER] Watch one week: no oversell, quantities match
- **Exit check:** both responsibilities owned by `product_pipeline` in the store; a week of manual alignment with zero drift surprises. (Expect this phase to make G18 automation feel urgent — that's by design; scope it during the watch weeks.)

## Phase 3 — Order shadow and cutover (G13)

- [x] [AGENT] Repair the live shadow join: exact Marketplace Connect `sourceIdentifier` plus ProductPipeline durable tag; block fuzzy, paginated, failed, or ambiguous Shopify reads
- **Current gate (2026-08-26):** first corrected 24-hour report is 10/11 exact matches, one unmatched, zero blocked/ambiguous lookups. A similar Shopify order exists by SKU/time/channel but lacks the exact eBay order ID; it is not accepted as a match. Observe the next report and investigate before starting the clean-day count.
- ☐ [USER] Run `shadow-poll` daily; collect reports in `/data/shadow-reports/`
- ☐ [BOTH] 7–14 consecutive post-fix clean reports (`unmatchedCount: 0`, `blockedCount: 0` after MC's normal import delay); investigate any persistent unmatched order before proceeding
- ☐ [USER] Cutover sitting, one hour, in order: release Shopify app version with `write_orders` → MC order import OFF (evidence) → establish-ownership (orderImport) → establish-watermark (within the one-hour clamp) → import the first arriving orders supervised, one per ceremony
- ☐ [USER] Verify: each new eBay order lands in Shopify, cascades to Lightspeed correctly, and carries the `eBay-<id>` tag; attempt a duplicate import → denied
- **Exit check:** watermark permanent; 3+ real orders imported cleanly; Lightspeed cascade verified; L11 guards all intact.

## Phase 4 — Fulfillment/tracking sync (G17) — REQUIRED before MC removal

- [x] [AGENT] Build the inert fulfillment slice: schema-v4 allowance for exactly `fulfillment`, standalone full-order ceremony CLI (eBay createShippingFulfillment, `sell.fulfillment` scope already held), observations + reconciliation, tests, runbook (source candidate 2026-08-25; no dispatch)
- ☐ [USER] Back up the Production migration store off-volume; run the exact-scope schema-v4 `verify → upgrade → verify` ceremony before any new ownership or dispatch action
- ☐ [USER] Record MC's fulfillment behavior off (with its order sync already off in Phase 3, capture evidence of the residual state) → establish-ownership (fulfillment)
- ☐ [USER] Ship a real order in Shopify → ceremony pushes tracking → verify tracking + carrier visible on the eBay order
- **Exit check:** 3+ real shipments tracked on eBay via ProductPipeline; buyer-visible status correct.

## Phase 5 — Steady-state automation + operations (G18, G19, G20)

The deliberate policy change: routine writes stop requiring a ceremony each. Each worker is enabled only by an explicit recorded user approval; the kill switch and quarantine layers stay.

- [x] [AGENT] G19: monitoring + daily digest (failures, reconciliation exceptions, counts) — read-only dashboard/API/health deployed 2026-08-26; a strict projection-compatibility repair for the first live migration-status observation is source-complete but remains unmerged/unverified in Production
- ☐ [AGENT] G18: bounded workers behind disabled flags: quantity alignment, price alignment, order poll+import, tracking push — delta-only, per-run caps, journaled to the migration store, single kill switch
- ☐ [USER] Enable workers one at a time (suggested order: quantity → price → orders → tracking), each after 2–3 clean supervised days of the previous
- [x] [AGENT] G20: standalone off-volume snapshot and isolated restore-rehearsal tooling built inertly; no schedule or Production restore was enabled
- ☐ [USER] G20: provision protected independent storage, configure and observe the external schedule/retention alerts, and complete one documented restore rehearsal
- **Exit check:** ≥14 consecutive days fully hands-off with green daily digests and zero unexplained exceptions.

## Phase 6 — Decommission Marketplace Connect (G21)

- ☐ [USER] Preconditions: every checklist above complete; all five responsibilities owned by `product_pipeline` with evidence rows; 14 green automated days
- ☐ [USER] Export/archive MC settings and any listing-link data for records
- ☐ [USER] Uninstall Marketplace Connect from Shopify; capture evidence
- ☐ [BOTH] Record the uninstall in the brain (Section 14 + Learnings), close the board's replacement track, final `PROJECT.md` entry
- **Explicit non-goals that remain manual in eBay itself:** refunds/cancellation handling, buyer messages, feedback, promoted listings/ads. Documented so nobody assumes the app covers them.

---

## Standing side-tracks (not on the critical path)

- **G1** credential rotation incident — close when the user can participate (L1 evidence recorded)
- **G14** business-policy management slice — scheduled 2026-09-01
- **G2** reusable Sandbox lane is built but awaits a separately approved create/cleanup run and zero-residue evidence; **G9** enrichment decommission remains background hygiene
