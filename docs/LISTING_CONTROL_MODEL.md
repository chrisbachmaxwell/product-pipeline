# Listing Control Model

This document holds the detail intentionally kept out of the operator UI. The app should show the current state, the mapping, the owner, and the next safe action. It should not expose internal digests, transport details, or migration vocabulary by default.

## Current production boundary

- Shopify is the product and variant source of truth.
- eBay is the source of truth for the actual listing, offer, and public lifecycle.
- Marketplace Connect remains the production writer for price, inventory, and eBay-to-Shopify orders.
- ProductPipeline continuously observes and reconciles. Its remote writers remain quarantined.
- ProductPipeline can append a local listing draft after exact-store Shopify-session authentication. A local draft has no provider effect.
- A displayed mapping is evidence, not permission to write.

The live catalog refreshes in the server background, the browser polls that projection, and evidence older than five minutes becomes **Unknown**. A known failed refresh retains the last snapshot for diagnosis but downgrades its rows to **Unknown** immediately.

## Listing universe

The catalog is a union rather than an in-stock Shopify filter:

1. Every Shopify variant with positive available inventory.
2. A zero- or unknown-stock Shopify variant while eBay still has a listing, inventory item, or offer.
3. Every active eBay listing that cannot be joined to a Shopify variant.
4. Every active eBay listing whose SKU is blank.

Blank, duplicate, case-colliding, or whitespace-colliding SKUs never form an automatic mapping. They remain visible as exceptions.

## Stable mapping

The complete identity chain is:

```text
Shopify product GID
  -> Shopify variant GID
  -> exact raw SKU
  -> eBay Inventory SKU, when present
  -> eBay offer ID, when present
  -> eBay listing ID
  -> Production seller + marketplace
```

All identities are account-scoped. A listing ID or SKU from another seller or marketplace is not a match.

The Used Camera Gear account currently contains two management models:

- **Legacy Trading** — the public listing is read and later revised through Trading API operations.
- **Inventory and Offer** — the inventory item and offer are separate control records, with the resulting public listing verified through Trading.

The 2026-08-13 census found 112 active Trading listings but only 5 Inventory items and 5 offers. A control plane must support both models; it must not send a legacy listing through an Inventory-only revision path.

## Operator workspace

Keep the detail page to four primary sections.

### Mapping

- Shopify product and variant
- Exact SKU
- Management model
- Inventory SKU, offer ID, and listing ID when present
- Current owner by responsibility; listing and mapping remain unverified until proven
- Any missing or ambiguous link

### Listing

- Enabled and public lifecycle
- Title and subtitle when supported
- Category and store category
- Condition and condition description
- Price, available quantity, sold quantity, and Best Offer

### Content

- Description
- Images and video/template references when supported
- Item specifics
- Product identifiers, including an explicit omit decision when allowed

### Delivery

- Fulfillment, payment, and return policy
- Domestic and international shipping services
- Merchant location
- Return behavior

The current editor intentionally stays smaller than Marketplace Connect. It can draft title, category, condition, condition description, plain-text description, a bounded image list, fulfillment/payment/return policy IDs, and merchant location. Price and quantity remain visible but read-only under Marketplace Connect. Item specifics and identifiers are comparison evidence only in this slice.

Advanced audit may expose immutable IDs and timestamps. It must never expose access tokens, refresh tokens, raw provider bodies, buyer data, or credential-shaped errors.

### Editor picker metadata

Two read-only sources feed the editor's pickers:

- **Used-facet enrichment sweep** (`GET /api/listing-editor-metadata`). The bulk Trading census omits `PrimaryCategory`/`SellerProfiles` for legacy listings, so a background sweep re-uses the exact per-listing workspace read (Trading `GetItem` plus inventory detail where applicable) to collect the category id and name, the three policy ids, and the merchant location actually in use. The first metadata request starts a sweep when the in-memory aggregate is empty or older than six hours; requests never wait on it — they merge whatever the sweep cache currently holds into the snapshot-derived facets, with sweep data winning on category names. At most 150 listings per sweep, at most 3 detail reads in flight, per-listing failures skipped, no sweep on boot, no idle timers, zero writes.
- **Full category tree search** (`GET /api/ebay-category-search?q=...`). Type-ahead suggestions over eBay's entire EBAY_US category tree via the Taxonomy API (`get_default_category_tree_id` once, then `get_category_suggestions`), using only the already-minted `api_scope` read token. Queries are trimmed 2–100 safe characters (else 400); results are capped at 25 entries of `{ id, name, path, leaf }` with root-first paths; responses are cached in-process per normalized query for one hour (≤500 queries, coalesced in-flight); any failure is one generic 503.

## Field ownership

Every field has exactly one writer at a time. “Two-way sync” is an outcome of coordinated directional flows, not two systems writing the same field.

| Field group | Current writer | ProductPipeline now | Target direction |
|---|---|---|---|
| Product identity and content | Shopify | Observe and compare | Shopify -> eBay |
| eBay category, condition, aspects, policies | Unverified; eBay holds actual state | Observe and propose | Approved ProductPipeline spec -> eBay |
| Price | Marketplace Connect | Observe only | Shopify rule -> eBay after price cutover |
| Available inventory | Marketplace Connect | Observe only | Shopify available -> eBay after inventory cutover |
| eBay sales and orders | Marketplace Connect | Observe only | eBay -> Shopify after order cutover watermark |
| Listing lifecycle and mapping | Unverified; eBay holds actual state | Observe; one proven canary exists | Approved ProductPipeline action -> eBay after listing cutover |

Price, inventory, and orders are separate cutovers. A listing canary does not authorize any of them.

## Durable local-draft model

The mounted `GET /api/listing-draft?id=...` and exact `POST /api/listing-draft` use a dedicated schema-version-2 store separate from the legacy application ledger. The store covers the initial bounded field set only and contains no provider, approval, Apply, or Publish capability.

1. The server re-reads the exact fresh catalog/workspace and derives the trusted account-scoped Shopify/eBay identity; the browser cannot submit actor or provider identity as authority.
2. Each response carries semantic source and eBay digests plus the latest immutable local revision digest.
3. Preview is client-side only. Save requires those base digests and expected latest revision, then fails stale if either the observed facts or local revision advanced.
4. A null draft field inherits the observed/current value; only explicit differences are retained as operator overrides.
5. Revisions and their field provenance are append-only and audit-linked. Price and quantity are never accepted in the save contract.
6. Only a cryptographically verified Shopify App Bridge session for `usedcameragear.myshopify.com` can append. API-key and test-mode principals cannot use the Production save boundary.
7. Every response reports `apply: false`, `publish: false`, and `externalWritesPerformed: 0`.

An edit creates only a local draft. It does not contact Shopify or eBay. The current Preview compares:

```text
current observed or inherited value vs proposed local value
```

Semantic-source and latest-revision checks reject a save if the trusted facts or local draft changed during the edit. Reopen the item to review and rebase the proposal. A future provider-write preview must add an accepted baseline and explicit three-way conflict handling before any remote action is authorized.

The store is never auto-created or migrated by the web runtime. An operator must explicitly initialize and verify the canonical version-2 store before enabling local saves; missing, legacy, tampered, unsafe-permission, wrong-scope, linked, or sidecar-bearing state fails unavailable. See `docs/LISTING_CONTROL_ADMIN.md`.

## Continuous reconciliation

The safe near-real-time design is:

- authenticated Shopify webhooks invalidate the observation cache;
- authenticated, replay-resistant eBay notifications invalidate the eBay observation cache;
- bounded polling remains the completeness backstop;
- every completed snapshot is account-bound and pagination-complete;
- missing authority, partial pagination, duplicate IDs, or ambiguous mapping makes the affected state Unknown;
- UI polling reads the last completed snapshot and never assembles partial rows.

The current eBay notification endpoint is not authenticated evidence, so it cannot drive state. Background polling is the present eBay backstop until a verified notification contract is implemented.

## Remote write sequence

Each future mutation follows the same sequence:

1. Re-read the exact current Shopify and eBay state.
2. Verify ownership, target identity, and mapping version.
3. Render the exact proposed payload and resulting differences.
4. Obtain one explicit, expiring, single-use approval.
5. Persist the job, lease, idempotency key, and outcome-unknown dispatch before network I/O.
6. Make one remote request.
7. Re-read the remote object and reconcile the exact effect.
8. Append the result to the audit stream.

An unknown outcome is classified before any retry. A rollback or end-listing operation is separately authorized; it is never inferred from a transport failure.

## Cutover order

1. Union catalog, background freshness, and enriched read-only detail.
2. Durable local desired-state drafts (current bounded release).
3. Server-rendered provider-change preview and parity reporting across both eBay management models.
4. One allowlisted listing-revision canary.
5. Listing create/end/relist cutovers, each separately proven.
6. Price cutover.
7. Inventory cutover.
8. Order cutover last, with a permanent lower-bound watermark and no historical backfill.

Marketplace Connect remains enabled for a responsibility until that responsibility's cutover is explicitly approved and verified.
