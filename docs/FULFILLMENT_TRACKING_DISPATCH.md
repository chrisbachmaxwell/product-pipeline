# Fulfillment and Tracking Dispatch

## Status and safety boundary

G17 is a standalone, operator-run ceremony for one exact full-order Shopify
fulfillment and one exact eBay order. It is not mounted in the server, webhook,
scheduler, worker, or legacy CLI. Deploying it performs no action.

Marketplace Connect remains the fulfillment owner until an operator records its
fulfillment behavior off and runs `establish-ownership`. Do not infer that order
import being off also disables fulfillment. The two facts require separate
evidence. Every dispatch requires a fresh, one-action approval generated and
consumed inside the command.

The ceremony supports only:

- one Shopify order GID and one eBay order ID;
- exactly one successful Shopify fulfillment;
- that fulfillment containing the complete quantity of every Shopify order line;
- exactly one tracking number;
- one eBay `POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment`;
- all eBay order lines at their complete ordered quantities.

Partial shipments, split/multiple fulfillments, missing or multiple tracking
numbers, already-recorded tracking, identity drift, stale manifests, and absent
ownership are denied before the provider write. Tracking values remain transient:
they are never printed or stored as raw migration-state data.

## Prerequisites

1. G10 is still an independent operator gate and should be completed before
   production fulfillment activation.
2. The production migration store is explicitly upgraded to schema v4 and
   verified. Runtime never upgrades it.
3. Marketplace Connect order import has already been cut over under G13.
4. The operator separately records:
   - the reviewed Marketplace Connect fulfillment baseline evidence digest;
   - evidence that Marketplace Connect fulfillment/tracking behavior is off.
5. The Shopify app retains `read_orders` and `read_fulfillments`; the eBay
   refresh grant can mint exactly `api_scope + sell.fulfillment`.

No Shopify write scope is needed. This slice reads Shopify and writes only one
eBay shipping fulfillment.

## 1. Upgrade and verify the store

Follow `docs/MIGRATION_ADMIN.md` with the exact production config:

```sh
node dist/migration-admin/index.js verify --config <config>
node dist/migration-admin/index.js upgrade \
  --config <config> \
  --applied-at <canonical-UTC> \
  --confirm-scope <scope-digest>
node dist/migration-admin/index.js verify --config <config>
```

Expect schema version 4. This local database migration performs no provider write.

## 2. Establish fulfillment ownership

Only after Marketplace Connect fulfillment behavior is recorded off:

```sh
node dist/fulfillment-tracking-admin/index.js establish-ownership \
  --migration-store /data/migration-state/product-pipeline-migration-v1.sqlite \
  --confirm-scope <scope-digest> \
  --baseline-evidence <sha256-digest> \
  --mc-disabled-evidence <sha256-digest>
```

This records the Class-B chain
`marketplace_connect -> paused -> product_pipeline`. It performs zero provider
writes. If Marketplace Connect is not actually off, stop; the evidence digest is
not a substitute for the operator action.

## 3. Preflight one complete shipment

```sh
node dist/fulfillment-tracking-admin/index.js preflight \
  --shopify-order-gid gid://shopify/Order/<id> \
  --ebay-order-id <id>
```

Exit code `2` means preview. Review the exact order identities, fulfillment GID,
ship time, mapped carrier, line count, and manifest digest. Output states only
that tracking is present; it never echoes the tracking number. A partial or split
shipment is deliberately unsupported and must remain manual in eBay.

## 4. Dispatch one action

Re-run with the exact digest printed by the fresh preflight:

```sh
node dist/fulfillment-tracking-admin/index.js dispatch \
  --shopify-order-gid gid://shopify/Order/<id> \
  --ebay-order-id <id> \
  --manifest-digest sha256:<digest> \
  --migration-store /data/migration-state/product-pipeline-migration-v1.sqlite
```

The command re-reads both providers before creating the durable intent, consumes
one approval, crosses the dispatch boundary once, then immediately re-reads eBay
and records a target-effect observation. Success is
`dispatched-and-reconciled`.

Never re-run `dispatch` after an uncertain result. The attempt is durable and
outcome-unknown until reconciliation.

## 5. Reconcile an uncertain attempt

```sh
node dist/fulfillment-tracking-admin/index.js reconcile \
  --shopify-order-gid gid://shopify/Order/<id> \
  --shopify-fulfillment-gid gid://shopify/Fulfillment/<id> \
  --ebay-order-id <id> \
  --manifest-digest sha256:<digest> \
  --migration-store /data/migration-state/product-pipeline-migration-v1.sqlite \
  --job-id <job-id> \
  --attempt-id <attempt-id>
```

This performs an eBay provider read only and can recover a job left at the
`dispatching` boundary after a process interruption. It reconstructs each
observed eBay effect and requires its complete manifest digest (tracking,
carrier, shipped date, and all line quantities) to equal the approved digest;
later Shopify edits cannot rewrite the historical attempt. If the exact effect
is not yet visible, the job stays `reconciliation_required`. Use
`--accept-absent` only
after the documented observation window and direct eBay review; it terminalizes
the attempt as `confirmed_missing` but does not retry.

## Rollback and pause

An eBay shipping fulfillment is not treated as safely reversible. If behavior is
wrong, record fulfillment ownership back to `paused`, investigate the exact
order in eBay, and do not dispatch another effect. Restore Marketplace Connect
only after ProductPipeline is paused and the operator has established that
restoring it cannot duplicate the tracking update. Never run both writers.

## Remaining production gates

- Marketplace Connect fulfillment-off evidence;
- ProductPipeline fulfillment ownership in schema v4;
- G10 first listing revise if it remains incomplete;
- one supervised real full-order shipment, then at least three clean shipments
  before the Phase 4 exit check;
- G18 explicit automation authorization before any webhook, scheduler, or worker
  may call this behavior.
