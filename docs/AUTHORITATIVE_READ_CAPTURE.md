# Authoritative Read Capture

The evidence-capture CLI is an isolated, operator-run boundary for collecting recent, redacted Shopify or eBay source evidence without changing either platform. It is a step toward replacement parity; it is not a sync process, Marketplace Connect control, cutover tool, or production writer.

The command surface is intentionally limited to:

- `preflight`: validate the fixed local configuration, current clean source revision, pinned signing key, and ephemeral authority metadata without making a network request;
- `collect`: perform one explicitly confirmed Shopify or eBay read, then publish one signed local artifact;
- `verify`: re-read and verify one exact local artifact without network access.

There is no OAuth acquisition, token refresh, import, publish, sync, backfill, ownership-transfer, watermark, canary, or write command.

## Fixed local setup

Copy the invalid checked-in template and replace every placeholder with reviewed, exact, nonsecret identity and public-key data:

```sh
cp config/evidence-capture.example.json config/evidence-capture.json
```

`config/evidence-capture.json` is intentionally ignored. The parser accepts only that path and requires:

- the exact Shopify `.myshopify.com` domain, Shop GID, and installed App GID;
- the exact eBay environment, immutable user ID, and `EBAY_US` marketplace identity;
- the exact current Git commit for the collector;
- one pinned Ed25519 public key and nonsecret key ID;
- bounded request, page, record, response, and access-validity limits;
- reads enabled and every write, backfill, OAuth acquisition/refresh, raw/PII persistence, watermark, and ownership-transfer setting explicitly disabled.

The CLI will sign or read remotely only when the configured build commit equals the checked-out `HEAD` and the fixed collector-relevant source/build paths are clean. This binds a capture to reviewed collector source while ignoring unrelated local-only evidence files. It also means later verification currently requires the original configuration, key, and build context; a durable historical verification keyring/context archive is not implemented yet.

Authority is ephemeral and environment-only:

- `PRODUCT_PIPELINE_SHOPIFY_READ_ACCESS_TOKEN`
- `PRODUCT_PIPELINE_EBAY_READ_ACCESS_TOKEN`
- `PRODUCT_PIPELINE_EBAY_READ_ACCESS_SCOPES`
- `PRODUCT_PIPELINE_EBAY_READ_ACCESS_ISSUED_AT_UTC`
- `PRODUCT_PIPELINE_EBAY_READ_ACCESS_EXPIRES_AT_UTC`
- `PRODUCT_PIPELINE_EVIDENCE_SIGNING_KEY_PKCS8_B64`

The eBay scope metadata must equal exactly these three read-only scopes, separated by one space:

```text
https://api.ebay.com/oauth/api_scope/commerce.identity.readonly https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly
```

No authority value is written to configuration, output, an artifact, an error, or audit metadata. Preflight reports presence/validity booleans only and always states that remote authority has not yet been verified.

## Operator flow

Run preflight first from a checkout whose collector-relevant paths are clean:

```sh
npm run evidence-capture -- preflight --repo-root . --json
```

Use the exact scope digest from preflight and a canonical UTC half-open order window `[start, end)`. The window must be no more than seven days and must end within fifteen minutes of the run:

```sh
npm run evidence-capture -- collect \
  --source shopify \
  --confirm-scope sha256:<exact-preflight-scope-digest> \
  --orders-start 2026-08-11T00:00:00.000Z \
  --orders-end 2026-08-11T01:00:00.000Z \
  --repo-root . \
  --json
```

Use `--source ebay` for the separately scoped eBay capture. Each run performs only that source's reads and emits one private, canonical, signed artifact below `.local/evidence-capture/`. Existing artifacts are never overwritten.

Verify the exact returned relative path:

```sh
npm run evidence-capture -- verify \
  --artifact .local/evidence-capture/<exact-returned-filename>.json \
  --repo-root . \
  --json
```

Verification requires a regular, non-symlink, single-link, mode-`0600` canonical file whose name matches its signed digest. It validates the exact source schema, configured identity, record bounds, record digests, request provenance, half-open order membership, signature, and current freshness. A stale artifact can remain cryptographically intact but is not current read evidence. Every result keeps parity use, production parity, cutover readiness, external writes, and historical backfill false.

## Shopify boundary

Shopify Admin GraphQL uses semantic read queries over HTTPS `POST`, because GraphQL queries use that transport. The network adapter allows only the three compiled query documents at the exact configured store and pinned API version `2026-07`:

- shop/app identity and current granted scopes;
- complete cursor traversal of product variants and their first 25 inventory locations;
- complete cursor traversal of recent orders inside the explicit half-open window.

The collector verifies `read_products`, `read_inventory`, and `read_orders`; it rejects `read_all_orders` and every `write_*` scope. Any variant with more than 25 inventory locations makes the capture incomplete and fails closed. Order normalization retains only stable IDs, timestamps, creating app ID/name, source identifiers, status, and test status. It never requests or persists customer, address, line-item, note, total, or payment data.

`Order.app` is useful evidence of which Shopify app created a recent order. It does not by itself prove current Marketplace Connect configuration, listing ownership, or complete parity.

Official references:

- [Shopify Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql/latest)
- [API versioning](https://shopify.dev/docs/api/usage/versioning)
- [`currentAppInstallation`](https://shopify.dev/docs/api/admin-graphql/latest/queries/currentAppInstallation)
- [`productVariants`](https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants)
- [`orders`](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders)
- [`OrderApp`](https://shopify.dev/docs/api/admin-graphql/latest/objects/OrderApp)

## eBay boundary

The eBay adapter allows only HTTPS `GET`, rejects redirects, and has no OAuth acquisition or refresh path. It verifies the immutable eBay identity first, then reads:

- Inventory API inventory-item pages;
- offers associated with each returned inventory SKU for `EBAY_US`;
- Fulfillment orders inside the explicit recent window.

Inventory and offer offsets are page numbers; Fulfillment offsets are row offsets. eBay's order query includes both ends, so the collector deliberately post-filters records at the upper boundary to preserve the internal `[start, end)` contract.

Inventory API coverage is explicitly limited to records managed in eBay's Inventory model and their associated offers. It does not claim to enumerate every seller listing, Trading-model listing, or Active Inventory Report record. Fulfillment output retains only order ID, creation/modification timestamps, and fulfillment status; buyer, address, line-item, value, and raw response data are discarded.

Official references:

- [Get inventory items](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/getInventoryItems)
- [Get offers](https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffers)
- [Get orders](https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders)
- [Get authenticated user](https://developer.ebay.com/api-docs/commerce/identity/resources/user/methods/getUser)
- [Inventory API model](https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-items.html)

## Marketplace Connect evidence

No documented public Marketplace Connect settings/listing API or native full export was found in Shopify's current official documentation. The repository therefore contains a separate strict verifier for a redacted, independently signed Marketplace Connect UI or Shopify-support attestation; it does not scrape the UI, use a browser session, or call Shopify.

The verifier requires exact digest-bound store/seller identity, fresh capture time, bounded attachments, recomputed normalized-record/count digests, terminal metadata bound to a retained attachment for any claimed complete listing coverage, explicit unknowns, and independent collector/reviewer Ed25519 signatures. That is an independently reviewed attestation—not direct API completeness proof. UI settings can show configured order/price/inventory behavior, but price or inventory toggles alone cannot establish actual writer ownership. An order-import ownership claim also requires Shopify order-creator attribution or a Shopify support export. Every verified packet remains evidence-only and cannot transfer ownership, authorize a canary, prove live parity, or enable a write.

Official Marketplace Connect references:

- [Marketplace Connect overview](https://help.shopify.com/en/manual/online-sales-channels/marketplaces/marketplace-connect)
- [Set up Marketplace Connect](https://help.shopify.com/en/manual/online-sales-channels/marketplaces/marketplace-connect/setup)
- [Link existing listings](https://help.shopify.com/en/manual/online-sales-channels/marketplaces/marketplace-connect/products/link-existing)
- [Import marketplace orders](https://help.shopify.com/en/manual/online-sales-channels/marketplaces/marketplace-connect/manage-orders/import)

## What this release proves—and does not

Fixture tests prove the code rejects unsafe methods, hosts, paths, scopes, identities, windows, pagination gaps, duplicate stable IDs, over-limit responses, PII/credential material, artifact tampering, and filesystem escapes. They do not prove live credentials, remote platform state, complete seller-listing coverage, Marketplace Connect configuration, or parity.

No live collector run was performed for this release: the task environment had no configured evidence-capture file, ephemeral read authority, or signing key. No Shopify/eBay/Marketplace Connect data was requested and no commerce state was changed.

The next proof step requires an operator-controlled, clean checkout with the exact nonsecret identity configuration, an ephemeral Shopify read token, a separately issued short-lived eBay token with only the three declared read scopes, a pinned signing key, and a fresh signed Marketplace Connect attestation or supported export. After capture, a later reviewed assembler must translate these source artifacts into the strict reconciliation-v2 evidence model and preserve an archival verification context. Until those inputs and that integration exist, every responsibility remains blocked from canary or cutover.
