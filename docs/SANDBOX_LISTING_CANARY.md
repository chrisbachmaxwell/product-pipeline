# eBay Sandbox listing canary

This is an isolated, reusable test lane for one exact Shopify product/variant/SKU. It can create a $1 eBay **Sandbox** listing and, under a second approval, remove every artifact it created. It never reaches Production, Shopify writes, orders, Marketplace Connect, server startup, schedulers, or webhooks.

No Sandbox write has been authorized or executed by shipping this code. Every `dispatch-*` command below is a separate operator approval.

## Fixed safety boundary

- Hosts are compiled as `api.sandbox.ebay.com` and `apiz.sandbox.ebay.com`; redirects and Production hosts are denied.
- The operator names exact `--product-gid`, `--variant-gid`, and `--sku` values on every command. Nothing is hardcoded to a seller or a historical test product.
- OAuth arrives only as a bounded JSON packet on stdin (12 KiB maximum, two-hour maximum lifetime, at least two minutes remaining). It is never accepted in flags, environment variables, files, logs, output, or state.
- The private Sandbox seller ID is live-verified and converted to an opaque scope pseudonym before persistence. It is never printed or stored.
- The manifest must be an absolute, non-symlink, mode-`0600` file outside the repository. It is limited to quantity `1`, price `USD 1.00`, and a title/description containing `PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY`.
- The state database is separate from Production and durable. Its migration-store intent, approval, job, attempt, reconciliation, and hash-chained audit prevent blind replay. A create is one-shot for that exact store/variant/SKU in the retained state even if someone edits the manifest later; use a different reviewed target for another canary.
- Every create preflight/approval/dispatch begins with fresh exact Inventory, Offer, Trading, seller-identity, enabled inventory-location, and three business-policy reads. Pagination, ambiguity, identity drift, residue, disabled/mismatched policy state, and provider errors fail closed. Category IDs and the compiled Inventory condition allowlist are validated locally; final Sandbox category-condition compatibility remains provider-enforced during the one approved dispatch.
- Create is one bounded sequence: inventory item PUT, offer POST, publish POST. Cleanup is a second bounded sequence: withdraw exact offer, delete exact offer, delete exact inventory item. Neither sequence retries.

## Runtime inputs

Create the private manifest outside the checkout with `umask 077`. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "environment": "sandbox",
  "marketplaceId": "EBAY_US",
  "target": {
    "storeDomain": "STORE.myshopify.com",
    "productGid": "gid://shopify/Product/PRODUCT_ID",
    "variantGid": "gid://shopify/ProductVariant/VARIANT_ID",
    "sku": "EXACT-SKU",
    "shopifyEvidenceDigest": "sha256:REVIEWED_EXACT_SHOPIFY_READ_DIGEST"
  },
  "listing": {
    "title": "PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY ...",
    "description": "PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY ...",
    "imageUrls": ["https://..."],
    "categoryId": "...",
    "condition": "USED_EXCELLENT",
    "conditionDescription": "Fictional Sandbox item",
    "quantity": 1,
    "price": { "currency": "USD", "value": "1.00" },
    "merchantLocationKey": "...",
    "fulfillmentPolicyId": "...",
    "paymentPolicyId": "...",
    "returnPolicyId": "..."
  }
}
```

The credential broker must emit exactly one JSON object to stdout: `accessToken`, exact `sellerId`, exact three-item `scopes` array (`commerce.identity.readonly`, `sell.inventory`, `sell.account`), `issuedAtUtc`, and `expiresAtUtc`. The broker must not write the packet to disk or log it. In the commands below, replace `<sandbox-credential-broker>` with that separately reviewed ephemeral source.

Set only nonsecret shell variables:

```sh
CANARY_MANIFEST=/data/sandbox-canary/manifest.json
CANARY_STATE=/data/sandbox-canary/state.sqlite
STORE_DOMAIN=usedcameragear.myshopify.com
PRODUCT_GID='gid://shopify/Product/EXACT_PRODUCT_ID'
VARIANT_GID='gid://shopify/ProductVariant/EXACT_VARIANT_ID'
SKU='EXACT-SKU'
SHOPIFY_EVIDENCE='sha256:EXACT_DIGEST'
COMMON="--store-domain $STORE_DOMAIN --product-gid $PRODUCT_GID --variant-gid $VARIANT_GID --sku $SKU --shopify-evidence-digest $SHOPIFY_EVIDENCE --manifest-file $CANARY_MANIFEST"
```

## Ceremony

1. Initialize the separate state once. `EVIDENCE` is the digest of the reviewed authorization for this Sandbox lane.

```sh
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js init-store $COMMON --state "$CANARY_STATE" --evidence-digest "$EVIDENCE"
```

2. Read-only preflight. Exit `2` means preview/ready, not failure. Record both exact `manifestDigest` and `actionDigest`; the latter binds the create action, exact Shopify target, evidence, and manifest.

```sh
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js preflight $COMMON
```

3. After reviewing the preflight, the human records a short-lived, one-action create approval. This separate command creates the intent and prints `approvalToken`, `approvalDigest`, `intentKey`, and expiry; it performs no provider write.

```sh
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js approve-create $COMMON --state "$CANARY_STATE" --manifest-digest "$MANIFEST_DIGEST" --action-digest "$ACTION_DIGEST"
```

4. Dispatch can only consume that exact approval; it cannot mint one. Record `jobId`, `attemptId`, `intentKey`, `offerId`, and `listingId`. A denied or unknown result is a stop: never rerun dispatch.

```sh
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js dispatch-create $COMMON --state "$CANARY_STATE" --manifest-digest "$MANIFEST_DIGEST" --action-digest "$ACTION_DIGEST" --approval-token "$APPROVAL_TOKEN" --approval-digest "$APPROVAL_DIGEST" --intent-key "$INTENT_KEY"
```

5. If dispatch reports unresolved but the exact IDs are known, use the zero-write `reconcile-create` command shown by `--help`, including the same `--action-digest`. Never redispatch. An expired, unused approval may be replaced by rerunning `approve-create` with the same exact digests; this reuses the original intent. Once any job exists, reapproval is denied.

6. Prepare cleanup with the exact returned IDs, review its `cleanupDigest`, and record a separate cleanup approval before dispatching it.

```sh
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js preflight-cleanup $COMMON --offer-id "$OFFER_ID" --listing-id "$LISTING_ID"
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js approve-cleanup $COMMON --state "$CANARY_STATE" --offer-id "$OFFER_ID" --listing-id "$LISTING_ID" --cleanup-digest "$CLEANUP_DIGEST"
<sandbox-credential-broker> | node dist/sandbox-listing-canary-admin/index.js dispatch-cleanup $COMMON --state "$CANARY_STATE" --offer-id "$OFFER_ID" --listing-id "$LISTING_ID" --cleanup-digest "$CLEANUP_DIGEST" --approval-token "$CLEANUP_APPROVAL_TOKEN" --approval-digest "$CLEANUP_APPROVAL_DIGEST" --intent-key "$CLEANUP_INTENT_KEY"
```

7. If cleanup is unresolved, use zero-write `reconcile-cleanup`; never repeat cleanup writes. Retain the state database, then run `verify-state` with the same exact target/manifest/state arguments and fresh stdin authority. It re-verifies the seller binding and hash-chained audit without a provider write.

Success is `dispatched-and-reconciled` followed by `cleaned-and-reconciled`, with a final fresh state of inventory absent, zero offers, and the exact Trading item ID observed in an ended/completed state. Trading history is retained by eBay; zero historical SKU matches is not expected. A local test or clean audit does not prove that a live Sandbox run occurred.
