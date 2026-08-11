# Read-Only Parity Evidence

This document defines the evidence boundary for replacing Shopify Marketplace Connect. It is an observation and review workflow only. It cannot enable a ProductPipeline writer, establish an order cutover watermark, import an order, change a listing, or transfer ownership.

## Current evidence baseline

The signed-in Shopify walkthrough on 2026-08-11 established these operator-attested facts for Used Camera Gear:

- The active store was `usedcameragear` and the eBay seller context was `eBay.com / usedcam-0`.
- Marketplace Connect showed recent eBay rows linked to Shopify order numbers. Its order setting was `All orders` at `Complete`; it is the accepted incumbent eBay-to-Shopify importer.
- Marketplace Connect had price and inventory synchronization enabled.
- Its listing and mapping surfaces exposed link, grid-edit, status, SKU, quantity, price, title, category, condition, shipping, payment, and item-specific controls. Quantity used all Shopify locations in the visible mapping baseline.
- ProductPipeline remained shadow read-only and did not show authoritative cross-platform parity.

No control, setting, mapping, order, listing, price, inventory, token, or credential was changed. Customer names, addresses, line items, order values, and raw payloads are intentionally excluded from this evidence.

The walkthrough is a dated browser attestation, not a direct API export. It proves the visible incumbent configuration at that time; it does not prove current per-item coverage, recent-writer attribution for every listing, fulfillment or feedback behavior, or production parity.

### Current blocked parity packet

At `2026-08-11T18:49:51.000Z`, the version-2 operator workflow recorded the browser-attested Marketplace Connect settings and represented ProductPipeline, Shopify, and eBay source snapshots as explicitly unavailable. The command exited `2` with `exceptions-found`, as designed:

- Marketplace Connect: partial operator attestation, three responsibility settings, incomplete coverage.
- ProductPipeline: normalized ledger snapshot unavailable.
- Shopify: authoritative direct snapshot unavailable.
- eBay: authoritative no-refresh direct snapshot unavailable.
- Every responsibility: `unverified` or `blocked`; `canaryReady: false`.
- Guarantees: `liveProof: false`, `productionParity: false`, `externalWrites: 0`, `applicationDatabaseAccess: false`, `historicalBackfill: false`, and `orderCreationEligible: false`.

The ignored local packet had snapshot digest `sha256:7550799cea86c431d56d874e919bc74dcba13c304bf1f919b748736fdb61d608` and result digest `sha256:aa1600479772b6797fcda799bef53aca77f2cdf8c37ef73fc86fe4517498da02`. Audit verification passed with three records and head `sha256:18854953ad8af8afed622b2e1bec0de0cbff39dcd72c6640b9036d3e514a770f`. These hashes make the local packet reviewable; they do not authenticate an external source or establish live parity.

## Source trust matrix

| Source | Accepted evidence class | Current status | Important limit |
|---|---|---|---|
| Shopify | Bounded direct read or platform-generated redacted export | Unavailable | No complete, provenance-bearing product/variant/inventory/order snapshot has been captured |
| eBay | Bounded GET/HEAD-only direct read or platform-generated redacted export | Unavailable | Existing token helper can refresh and write; it is forbidden for capture |
| Marketplace Connect | Supported export or operator-attested signed-in admin observation | Partial browser baseline | No repository client/API exists; per-item coverage is unknown |
| ProductPipeline | Read-only existing-ledger export | Partial local counts/listing projection only | The web runtime opens the existing ledger query-only; no normalized provenance bundle has been captured and the ledger is not authoritative Shopify or eBay state |

An unavailable or partial source is valid evidence of a gap. It must block the affected responsibility; it must never be silently replaced by a configuration declaration or request-time timestamp.

## Evidence bundle contract

The operator reconciler accepts a strict version-2 evidence bundle beneath `.local/operator-reconciliation/`. The bundle carries normalized, redacted observations plus independent provenance for ProductPipeline, Shopify, eBay, and Marketplace Connect.

Every source records:

- exact system, store/account/environment subject, acquisition method, collector/version, and evidence class;
- independent start, completion, and as-of times;
- API/query version and an explicit bounded window where applicable;
- page count, record count, reported total, terminal-cursor evidence, and whether pagination completed;
- normalization and redaction policy versions;
- a SHA-256 digest of the normalized source data;
- whether the source is complete, partial, or unavailable; source-specific limitations remain documented in the reviewed packet, outside the strict normalized provenance object.

For direct Shopify/eBay evidence, completeness additionally requires an explicit API version, an observed terminal page/cursor digest, and exact normalized versus platform-reported totals. A complete empty result still needs terminal proof and reported total zero; an empty array alone is never coverage proof.

The parser rejects unknown fields, identity mismatches, malformed stable IDs, secret- or customer-shaped data, inconsistent counts, digest mismatches, and unsafe paths. Partial or unavailable sources remain parseable but block readiness. A single top-level timestamp cannot make a stale source current.

The normalized records contain only stable operational fields needed for comparison. Order observations never contain buyer, email, phone, address, notes, tags, line items, totals, or raw JSON and are always creation-ineligible.

## Reconciliation workflow

1. Capture each source through an approved read boundary. Do not use the legacy server GET routes, credential loaders, token-refresh manager, generic application database initializer, or a browser response containing raw orders.
2. Normalize and redact in memory. Store the final bundle only beneath `.local/operator-reconciliation/`; never commit it.
3. Run the isolated operator CLI:

   ```bash
   npm run operator -- reconcile \
     --config config/operator-shadow.example.json \
     --snapshot .local/operator-reconciliation/<bundle>.json
   ```

4. Review per-source freshness/completeness, stable-ID exceptions, duplicate SKU/ID blockers, and responsibility-specific readiness.
5. Verify the local tamper-evident audit chain:

   ```bash
   npm run operator -- audit verify \
     --file .local/operator-audit/operator-cli.jsonl
   ```

6. Keep the bundle, result digest, audit head, exception disposition, reviewer, and decision reference together as the parity packet.

Even a clean run means only `consistent-with-supplied-snapshots` for the supplied evidence. The result continues to state `liveProof: false`, `productionParity: false`, `externalWrites: 0`, `historicalBackfill: false`, and `orderCreationEligible: false`. Observation cannot transfer ownership.

Version 2 deliberately carries a model-coverage blocker for every operational responsibility. It can compare stable links, statuses, order mappings, and raw normalized price/inventory observations, but it cannot claim listing, mapping, price, inventory, order-import, fulfillment, or feedback parity until responsibility-specific policy and semantic fields are added and reviewed.

## Current ownership gaps

| Responsibility | Accepted baseline | Evidence state | Gate still required |
|---|---|---|---|
| Order import | Marketplace Connect | Dated browser observation; direct coverage unknown | Exact source semantics, durable watermark, account-scoped idempotency, post-watermark proof, single writer, audit, rollback |
| Price | Marketplace Connect | Enabled in dated browser observation | Authoritative offer coverage, currency/variation rule, source price field, reconciliation |
| Inventory | Marketplace Connect | Enabled in dated browser observation | Location aggregation, reservations/available semantics, per-offer coverage, reconciliation |
| Listing create/revise/end/relist | Unverified | Controls visible; recent writer attribution unknown | Owner decision, stable links, policy/aspect/condition coverage, one-SKU canary |
| Mapping | Unverified | Marketplace Connect mapping UI visible; full link coverage unknown | Authoritative link export and reviewed mapping rules |
| Fulfillment | Unverified | No current proof | Owner, event semantics, idempotency, retry/reconciliation behavior |
| Feedback | Unverified | Marketplace Connect setting visible; behavior unverified | Owner and observed outcome proof |
| Reconciliation | ProductPipeline supplies offline comparison only | Local tool verified; sources not authoritative yet | Trusted source capture, durable evidence storage, reviewed exceptions |

## Live collector gate

No live collector is mounted in the web application. The legacy remote GETs are unmounted because they lack provenance and include an eBay path that can refresh OAuth and update the token database.

Before a live snapshot can be captured, the operator must choose and approve one trusted execution boundary, such as an isolated local command or Railway one-off command, and provide read credentials that:

- identify the exact Used Camera Gear store and `usedcam-0` account;
- have verified read scopes and no capture-time OAuth exchange or refresh;
- remain outside repository files, output, errors, and audit payloads;
- fail closed when missing, expired, near expiry, over-scoped, or identity-mismatched;
- enforce exact HTTPS hosts, GET/HEAD-only transport, bounded pagination, redirect denial, deadlines, and row/page limits.

Marketplace Connect also needs a supported redacted export or a reviewed operator attestation for its configuration and link coverage. Until those inputs exist, the correct parity result is blocked—not inferred.

## Future canary gate

The repository can test canary readiness with pure, unwired domain rules. A future canary must still prove one responsibility, one exact target, an accepted parity packet, incumbent-disable evidence, ownership-version precondition, single-use approval, audit destination, post-action reconciliation, observation window, and immediate rollback.

Order canaries additionally require an immutable account-scoped watermark and durable account-scoped idempotency. An order at or before the watermark is permanently ineligible; a null watermark makes every order ineligible. None of these checks is a writer, approval, or cutover authorization.

## Credential remediation

The legacy mapping smoke test and historical mapping documentation contained a committed API key. Current files are redacted and the script is network-inert. Production API authorization in this release rejects the legacy API-key path and requires a verified Shopify App Bridge session token for the exact app and Used Camera Gear store.

The old credential remains exposed in Git history. Rotation is still recommended through the authorized deployment owner, but this repository task does not rotate or otherwise access it.
