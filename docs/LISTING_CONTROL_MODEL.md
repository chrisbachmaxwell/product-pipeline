# Listing Control Model

This document holds the detail intentionally kept out of the operator UI. The app should show the current state, the mapping, the owner, and the next safe action. It should not expose internal digests, transport details, or migration vocabulary by default.

## Current production boundary

- Shopify is the product and variant source of truth.
- eBay is the source of truth for the actual listing, offer, and public lifecycle.
- Marketplace Connect remains the production writer for price, inventory, and eBay-to-Shopify orders.
- ProductPipeline continuously observes and reconciles. Its remote writers remain quarantined.
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

Advanced audit may expose immutable IDs and timestamps. It must never expose access tokens, refresh tokens, raw provider bodies, buyer data, or credential-shaped errors.

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

## Durable edit model

An editable control plane needs a dedicated versioned store, separate from the legacy application ledger. The current unwired store covers an initial bounded field set only and contains no provider capability.

1. Immutable account-scoped listing binding revisions.
2. Immutable desired-listing specification revisions.
3. One owner and direction for every controlled field.
4. Operator overrides bound to an exact binding revision and optimistic version.
5. Source observations and provider observations with capture time and digest.
6. Explicit approval bound to the exact desired-state digest.
7. Append-only audit events.

An edit first creates a local draft. It does not contact Shopify or eBay. Preview compares:

```text
accepted baseline vs current remote state vs desired state
```

If both the remote value and the desired value changed from the baseline, the field is a conflict. No remote write is allowed until a human resolves it.

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
2. Durable mapping and desired-state drafts.
3. Preview and parity reporting across both eBay management models.
4. One allowlisted listing-revision canary.
5. Listing create/end/relist cutovers, each separately proven.
6. Price cutover.
7. Inventory cutover.
8. Order cutover last, with a permanent lower-bound watermark and no historical backfill.

Marketplace Connect remains enabled for a responsibility until that responsibility's cutover is explicitly approved and verified.
