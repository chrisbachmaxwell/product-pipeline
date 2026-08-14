# G5 — Trading-vs-Inventory Listing Management-Model Strategy

Status: reviewed strategy, analysis only. This document authorizes no listing
mutation, no migration, and no Marketplace Connect change. Every provider
action referenced here requires its own reviewed slice with approval,
idempotency, reconciliation, observation, and rollback evidence.

## 1. The problem

The 2026-08-13 live census captured 112 active eBay Trading listings but only
5 Inventory items and 5 Offers. That means **107 of 112 active listings are
legacy Trading-model objects** with no Inventory-API management surface:

- The catalog classifies a mapped listing as `inventory_offer` only when an
  exact-SKU offer exists; otherwise it is `legacy_trading`
  (`src/server/listing-workspace-reader.ts`, `projectMapping`).
- The current repository contains **no Trading write call of any kind** — no
  `ReviseItem`, `ReviseFixedPriceItem`, `AddItem`, `EndItem`, or
  `RelistItem`. The only revise implementation ever built
  (`updateProductOnEbay`, quarantined legacy) is Inventory-API-based.
- The one proven ProductPipeline listing write — the CAN3570-U119 canary —
  used the Inventory/Offer model (`offer 234942877011`, listing
  `147502608418`).

So ProductPipeline's managed path (Inventory/Offer) covers 5 listings today,
while the incumbent-created majority is Trading-managed. A listing-management
product must decide how those 107 listings are revised, ended, relisted, and
eventually owned.

## 2. Options considered

### Option A — Revise Trading listings in place (Trading API writes)

Build bounded `ReviseFixedPriceItem` support and revise legacy listings
without changing their management model.

- Pro: no migration risk; listing identity, history, watchers untouched;
  works for every listing immediately.
- Con: requires building and safety-hardening a *second* write adapter (XML
  Trading) with its own field semantics, in-place revision semantics
  (partial revise vs full), and its own reconciliation reader mapping; keeps
  ProductPipeline permanently dual-model; Trading is eBay's legacy surface
  and the long-term migration target is the Inventory API.

### Option B — Migrate Trading listings to Inventory/Offer, then manage one model

Use eBay's listing-migration capability (`bulkMigrateListing`, Inventory API)
to convert Trading listings into Inventory items + Offers, preserving the
live listing id, then manage everything through one model.

- Pro: single write adapter, single reconciliation model, alignment with
  eBay's strategic API; the migrated listing keeps its listing id and
  history.
- Con: **migration is not reversible** — there is no supported
  un-migration; the only fallback is end + relist via Trading, which mints a
  new listing id and loses history/watchers. Eligibility is not universal
  (SKU required per listing/variation; variation and feature constraints
  apply). Most importantly, **Marketplace Connect currently owns price and
  inventory sync for these listings**; whether its writer keeps functioning
  against a migrated (seller-managed-inventory) listing is unverified. A
  bulk migration that silently broke the incumbent price/inventory writer
  would be a production incident on up to 107 live customer-facing listings.
- Platform-fact caveat: the migration endpoint's exact current constraints
  (batch size, category/feature exclusions, variation handling) must be
  re-verified against current eBay documentation in the slice that proposes
  to use it. Nothing in this repository proves them.

### Option C — Hybrid, migration deferred behind explicit gates (recommended)

Manage what is already Inventory/Offer-managed now; leave Trading listings
untouched under the incumbent; migrate later, one listing at a time, only
after the blocking unknowns are resolved.

## 3. Recommendation: Option C, with these stages

**Stage 1 — now (G4 scope).** The first provider listing-revise slice
operates on `inventory_offer`-managed listings only (today: 5, including the
proven CAN3570-U119 canary item). Rationale:

- It continues the exact responsibility and management model proven by the
  listing-create canary.
- It requires no new provider surface beyond the already-bounded Inventory
  API paths, and no Trading write adapter.
- It cannot touch the 107 Marketplace-Connect-era Trading listings at all —
  the workspace's `eligibleBasis` and the dispatch preflight both fail
  closed on `legacy_trading` targets, so the blast radius excludes the
  incumbent-managed majority by construction.

**Stage 2 — Trading-model interim revise (only if business need demands it
before migration).** If operators need to revise legacy listings through
ProductPipeline before any migration, build a separate reviewed
`ReviseFixedPriceItem` slice: bounded XML writer, in-place delta revision of
exactly the draft-editable fields, before/after `GetItem` reconciliation,
and the same one-action exact-target approval and durable job model as G4.
This slice is deliberately **not** part of G4; Marketplace Connect's revise
behavior on the same listings must be understood first (two writers on one
listing's content is the same hazard as two order importers).

**Stage 3 — Migration canary.** Before any migration:

1. Verify (read-only + vendor documentation + support confirmation if
   needed) how Marketplace Connect syncs price/inventory to a migrated
   listing, or schedule migration after the price/inventory responsibility
   cutover (G7) so the question is moot.
2. Re-verify migration eligibility rules against current eBay docs.
3. Migrate **one** low-risk listing with the full canary protocol:
   allowlist, one-action approval, before/after capture (Trading `GetItem` +
   Inventory item + Offer), observation window across a Marketplace Connect
   price/inventory sync cycle, and a rehearsed fallback (end + relist via a
   prepared draft, accepting the new listing id) documented as the
   non-rollback recovery path.
4. Only then consider batched migration, still in small reviewed cohorts.

**Stage 4 — Convergence.** As migration cohorts complete (or listings
naturally end and are relisted through ProductPipeline's Inventory-API create
path), the Trading population shrinks toward zero and the dual-model support
in the catalog/workspace becomes legacy-compatibility code that can be
retired with evidence.

## 4. Per-listing migration risk classification

The migration canary and cohort selection must classify each Trading listing
by observable risk factors (all readable through existing bounded readers):

| Risk factor | Why it matters | Source |
|---|---|---|
| Missing/blank SKU | Migration requires a SKU; catalog already flags SKU-less listings | Trading `GetMyeBaySelling` / census |
| Duplicate or near-collision SKU | Exact-SKU join is the mapping backbone; ambiguity fails closed today | catalog classifier |
| Variations | Different migration shape (item groups); higher mapping risk | Trading `GetItem` |
| Active best offers / bids | In-flight buyer state during migration | Trading `GetItem` |
| Promoted/enhanced listing features | Feature support differences post-migration | Trading `GetItem` + ads state |
| Oversized/nonstandard description HTML | Known parser boundary (LWI-2026-08-14-001) | enriched detail reader |
| Category/condition/aspect completeness | Inventory model requires explicit condition/aspects | enriched detail reader |
| Marketplace Connect link state | Incumbent writer behavior is the top unknown | Marketplace Connect attestation (G6) |

A migration cohort admits only listings with zero flagged factors until the
canary and first cohorts build evidence.

## 5. Consequences for G4's design (why this informs the build)

1. **Model gate:** the dispatch preflight hard-fails any target whose
   management model is not `inventory_offer` with exact bindings — the 107
   Trading listings are structurally out of scope, not just out of policy.
2. **Field mapping:** the revise payload maps only draft-editable fields
   (title, category, condition, condition description, description, images,
   policies, merchant location) onto the Inventory item / Offer split;
   price and quantity are read back and must be byte-identical to the
   current observed values — Marketplace Connect keeps those pens.
3. **Reconciliation model:** post-dispatch verification re-reads Trading
   `GetItem` + Inventory item + Offer through the existing bounded reader,
   the same triple the workspace baseline used, so before/after comparison
   is digest-to-digest on the identical normalization.
4. **Rollback:** because Stage 1 targets are Inventory-managed, rollback of
   a content revise is a second revise back to the recorded before-state —
   the dispatch manifest embeds the exact before values for that purpose.
   (This is precisely what migration lacks, which is why migration stays
   gated.)

## 6. Explicitly out of scope / unknowns to resolve

- Marketplace Connect's revise/price/inventory mechanics against both
  models: requires the G6 attestation or vendor documentation; until then,
  assume any ProductPipeline write to a Marketplace-Connect-linked Trading
  listing risks writer conflict.
- Current eBay migration-endpoint constraints: verify at Stage 3 slice time.
- Trading write adapter design: deferred to the Stage 2 slice if demanded.
- End/relist and listing-create for Trading-model items: separate
  responsibilities (`listingEndRelist`, `listingCreate`) with their own
  gates.
