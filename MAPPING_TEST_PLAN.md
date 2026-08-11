# Mapping System Test Plan

> **Historical and quarantined.** The former file contained executable mapping, product-sync, and production-auth examples. They were removed because the mapping routes are unmounted from the shadow-read runtime and no mapping write or live product test is authorized.

## Historical implementation coverage

The retired plan intended to verify:

- the local mapping schema and seeded condition, category, field, and inventory-location values;
- grouped and category-specific mapping reads;
- mapping create, update, delete, bulk, import, and export behavior;
- exact, partial, default, and custom mapping resolution;
- condition and category propagation into the legacy eBay product-sync path; and
- malformed request and missing-resource behavior.

Those intentions are not current proof. The historical documents disagree about table names and expected seeded counts, and the current local database remains an application ledger rather than authoritative Shopify, eBay, or Marketplace Connect state.

## Current safe test contract

Do not test mappings against a deployed environment or an ordinary saleable product. Current verification is limited to source review, pure fixtures, and non-network tests.

A future mapping implementation test must first provide:

1. authoritative Shopify, eBay, Marketplace Connect, and ProductPipeline source evidence for the exact mapping target;
2. an accepted mapping owner and an explicit one-responsibility, one-target scope;
3. a synthetic or platform-supported sandbox product and listing, never an ordinary production SKU;
4. a proposed before/after mapping result with deterministic rule fixtures;
5. a single-use approval, durable idempotency, audit destination, reconciliation, observation window, and immediate rollback; and
6. explicit proof that no order import, price, inventory, listing, or other responsibility is implicitly authorized.

The currently mounted runtime exposes no mapping API. The pure canary-readiness evaluator is unwired and always returns `canaryAuthorized: false` and `externalWritesAllowed: false`; satisfying a synthetic packet does not authorize a live test.
