# Pipeline Test Sandbox Price and Inventory Ceremony

The standalone `sandbox-price-inventory-admin` CLI proves the eBay Inventory/Offer
price and quantity path against one unmistakable eBay **Sandbox** listing. It is
not a Production G11/G12 takeover and it never changes Shopify. The server,
webhooks, schedulers, workers, Production migration store, and legacy CLI do not
import or invoke this slice.

## Immutable boundary

- Shopify source: product `10345525412131`, variant `55519196250403`, title
  `Pipeline Test`, SKU `PIPELINE-TEST-20260826`, tag
  `product-pipeline-test-lane`, Active but unpublished from the Online Store,
  USD `99.99`, aggregate quantity `1`.
- Shopify identity: exact Used Camera Gear shop and ProductPipeline app with the
  four canonical read scopes. The CLI reads the existing protected Shopify token
  from the application database; it never prints or stores it.
- eBay target: only Sandbox hosts, exact test user
  `testuser_ppcanary-3c55629b`, `EBAY_US`, location `pp-test-lane`, exact SKU,
  one numeric offer ID, and one numeric active listing ID. The offer must be
  `FIXED_PRICE`, `GTC`, and `PUBLISHED`.
- Sandbox authority uses the same reviewed bounded stdin credential packet as
  `sandbox-listing-canary-admin`: exact access token, seller, three-scope array,
  issuance, and expiry. Use a separately reviewed ephemeral broker and pipe it
  directly to commands that read Sandbox. Never place the packet or token in an
  argument, environment variable, file, log, chat, or control store.
- The listing must first be created and terminally reconciled by the separately
  reviewed Sandbox listing canary. Its exact create-manifest digest is required
  as `--listing-provenance-digest`; this is the explicit integration boundary
  with that slice. Do not invent a digest or use an unresolved/partial listing.
- State is recorded in a separate schema-v1 Sandbox control store under a
  service-owned mode-`0700` directory. The file is exact mode `0600`, single-link,
  and hash-chain verified. Never point this CLI at the Production migration store.

Successful local tests prove only the compiled contract. A successful Sandbox
exercise proves only the Sandbox Inventory/Offer path; it does not prove
Production credentials, Marketplace Connect ownership, legacy Trading behavior,
or G11/G12 readiness.

## One-time store initialization

Create the dedicated private parent directory outside this CLI, then print and
review the immutable scope digest:

```sh
node dist/sandbox-price-inventory-admin/index.js scope
```

Initialize exactly one new store using that printed digest:

```sh
node dist/sandbox-price-inventory-admin/index.js init \
  --store /data/product-pipeline-sandbox/sandbox-price-inventory-v1.sqlite \
  --confirm-scope <exact-scope-digest>

node dist/sandbox-price-inventory-admin/index.js verify \
  --store /data/product-pipeline-sandbox/sandbox-price-inventory-v1.sqlite
```

`init` refuses an existing file. Neither command contacts a provider.

## Required order

Run the three actions in this order. Each action has its own fresh preflight,
exact approval, one no-retry dispatch, and reconciliation:

1. `price-align`: requires both Offer and Trading price at USD `1.00`; aligns
   the Offer to fresh Shopify price USD `99.99` without a quantity key and
   verifies the Trading listing follows.
2. `quantity-seed`: requires Inventory item, Offer, and Trading quantity at `1`;
   changes the item and offer to `2` without a price key and verifies the Trading
   listing follows. This deliberate drift is its own approved test action.
3. `quantity-align`: requires all three Sandbox quantity facets at `2`; aligns
   the Inventory item and Offer back to the fresh Shopify quantity `1` without a
   price key and verifies the Trading listing follows.

For each action, first run:

```sh
<sandbox-credential-broker> | node dist/sandbox-price-inventory-admin/index.js preflight \
  --store /data/product-pipeline-sandbox/sandbox-price-inventory-v1.sqlite \
  --sku PIPELINE-TEST-20260826 \
  --offer-id <exact-sandbox-offer-id> \
  --listing-id <exact-sandbox-listing-id> \
  --action <price-align|quantity-seed|quantity-align> \
  --listing-provenance-digest <terminal-create-manifest-digest> \
  --listing-manifest-file <same-private-0600-create-manifest> \
  --shopify-evidence-digest <same-create-manifest-shopify-evidence-digest>
```

Preflight makes fresh Shopify and Sandbox identity/item/offer reads, records one
intent, and first recomputes the claimed create provenance from the same bounded
mode-`0600` manifest used by the listing canary. It prints only deterministic
nonsecret evidence, performs zero provider writes, and exits `2` with
`approval-required`. Review `before`, `after`, and the manifest digest. Then
issue the one-action approval:

```sh
node dist/sandbox-price-inventory-admin/index.js approve \
  --store /data/product-pipeline-sandbox/sandbox-price-inventory-v1.sqlite \
  --manifest-digest <exact-preflight-manifest-digest> \
  --confirm-action <same-exact-action>
```

The command prints a one-use `approvalToken` and its bound `approvalDigest`.
Neither is provider authority. The approval expires after ten minutes and is
consumed once. Dispatch with the same exact target and both exact approval values:

```sh
<sandbox-credential-broker> | node dist/sandbox-price-inventory-admin/index.js dispatch \
  --store /data/product-pipeline-sandbox/sandbox-price-inventory-v1.sqlite \
  --sku PIPELINE-TEST-20260826 \
  --offer-id <exact-sandbox-offer-id> \
  --listing-id <exact-sandbox-listing-id> \
  --manifest-digest <exact-preflight-manifest-digest> \
  --approval-token <exact-approval-token> \
  --approval-digest <exact-approval-digest>
```

Dispatch repeats all fresh source/account/target/state checks, consumes the
approval durably, issues at most one exact Sandbox
`bulk_update_price_quantity` request, and never retries. It immediately reads
the exact Inventory, Offer, and Trading state and resolves only when the complete
after-state is observed.

## Unknown outcome recovery

If dispatch reports `unresolved` or the process stops after consuming approval,
do not dispatch again. A lost response may mean the one write already landed.
Use only the zero-write reconciliation path:

```sh
<sandbox-credential-broker> | node dist/sandbox-price-inventory-admin/index.js reconcile \
  --store /data/product-pipeline-sandbox/sandbox-price-inventory-v1.sqlite \
  --sku PIPELINE-TEST-20260826 \
  --offer-id <exact-sandbox-offer-id> \
  --listing-id <exact-sandbox-listing-id> \
  --manifest-digest <exact-dispatched-manifest-digest>
```

The exact after-state resolves as `resolved-existing`. The exact before-state
remains unresolved because absence immediately after an unknown response is not
proof that no write will appear. Any third value or item/offer quantity split is
`partial` and remains unresolved. Terminal replay is denied before any provider
read or write. There is no accept-absent shortcut and no write-capable recovery.

After all three actions reconcile, use the separately approved Sandbox listing
cleanup ceremony. This CLI cannot withdraw, delete, publish, relist, touch a
Production endpoint, change Shopify, import an order, or alter Marketplace
Connect.
