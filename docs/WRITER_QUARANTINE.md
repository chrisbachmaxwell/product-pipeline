# ProductPipeline Writer Quarantine

This document describes the Marketplace Connect incumbent phase enforced by the current source. It is an application safety boundary, not evidence that ProductPipeline has production parity and not authorization to transfer a live responsibility.

## Effective ownership

The accepted production ownership baseline keeps Marketplace Connect as the writer for:

- eBay-to-Shopify order import;
- eBay offer price;
- eBay inventory quantity.

ProductPipeline listing-lifecycle and fulfillment writes are quarantined too. Their current production owners remain `unverified` in the immutable source policy; quarantine is not a claim that Marketplace Connect owns those responsibilities. Assigning either responsibility requires explicit reconciliation evidence and a later authorization.

ProductPipeline is in hard-coded `shadow-read-only` mode. External commerce writes are denied, historical backfill is denied, and no order cutover watermark exists. There is no environment variable, database setting, request flag, `TEST_MODE` exception, or confirmation parameter that can enable a writer in this phase.

The ownership transfer contract remains unchanged: one responsibility at a time, separately authorized, after accepted parity, idempotency, reconciliation, canary, audit, observation, and rollback evidence. Marketplace Connect must not be disabled by ProductPipeline or by this quarantine slice.

## Enforcement layers

| Layer | Enforced behavior |
|---|---|
| Runtime policy | `src/safety/writer-quarantine.ts` contains the immutable incumbent baseline and throws `WRITER_QUARANTINED` for every attempted external write. Denials identify the responsibility, operation, incumbent owner, and required cutover decision. |
| HTTP API | Every non-read request beneath `/api` is stopped by middleware before a legacy handler can load credentials, initialize its work, or contact a commerce platform. The response is HTTP `423` with the structured quarantine status. `GET`, `HEAD`, and `OPTIONS` remain available. |
| Startup | The server does not mount the legacy mutation scheduler or cloud watcher. Startup logs that shadow read-only mode is active. |
| Authentication | Shopify and eBay authentication routes are not mounted in the shadow application. The retained Shopify helper requests read scopes only and no longer registers webhooks during an OAuth callback. Existing credential records are never reported as proof of remote connectivity. |
| Webhooks | Shopify and eBay webhook endpoints acknowledge receipts and may append redacted local metadata. They do not retain the payload and do not dispatch order, listing, price, inventory, fulfillment, pipeline, or watcher work. Shopify receipts still require HMAC verification before local evidence is recorded. |
| Legacy CLI | The `ebaysync` executable exposes only `status`. Former authentication, sync, import, publish, republish, watcher, pipeline, image, settings, and other action commands are not registered. |
| eBay adapter | The base eBay client denies every method except `GET` and `HEAD`. Individual inventory, offer, listing, notification-preference, and fulfillment mutators also deny at their entry points. |
| Shopify adapters | Shopify order creation and inventory-setting functions deny before credential loading or network access. |
| Service functions | Legacy order, price, inventory, listing, fulfillment, draft-listing, image-upload, and related mutation services deny before their former external work. This prevents direct imports from bypassing HTTP or CLI controls. |

The API middleware intentionally denies benign application POST/PUT/DELETE operations too. This broad posture prevents a forgotten route, chat-generated request, test endpoint, or legacy helper from becoming an alternate commerce-write path. A future narrower API must be introduced only with an explicit responsibility-specific design and authorization.

### Local state that can still change

`shadow-read-only` means no external Shopify/eBay commerce mutation. It does not mean the process is byte-for-byte read-only locally:

- normal server startup can initialize or migrate the local SQLite schema and seed help content;
- verified webhooks can append redacted receipt metadata to the local notification log;
- operator `preflight`, `ownership`, and `reconcile` commands append redacted hash-chained audit records beneath `.local/`; and
- an operator may place an explicitly prepared reconciliation snapshot beneath `.local/operator-reconciliation/`.

None of those local writes creates or changes a Shopify order, eBay order, listing, price, inventory level, fulfillment, Marketplace Connect setting, or cutover watermark.

## Operator-visible status

The following surfaces report the effective policy:

- `GET /health` includes the migration phase, effective mode, responsibility ownership, quarantine channels, and build commit when Railway supplies it.
- `GET /api/migration/status` combines the immutable policy with local-only ledger counts and flags stale legacy settings as exceptions. A stale database toggle is reported as `effectiveBehavior: quarantined`; it does not override the policy.
- The Overview, Listings, Orders, Reconciliation, and Settings pages show the Marketplace Connect owner, shadow status, missing watermark, and absence of remote parity proof. Their primary actions are read-only refresh or review operations.
- The Reconciliation page reports local-ledger evidence only. Zero local exceptions is not cross-platform parity.

If the status endpoint is unavailable, the UI fails closed and continues to describe ProductPipeline as observation-only. Conflicting old settings or historical rows are evidence to investigate, not permission to write.

## Safe operator CLI

The legacy CLI can show the enforced state:

```sh
npm run cli -- status
```

Migration inspection and offline reconciliation use the isolated operator CLI:

```sh
npm run operator -- preflight --config config/operator-shadow.example.json
npm run operator -- ownership --config config/operator-shadow.example.json
npm run operator -- reconcile \
  --config config/operator-shadow.example.json \
  --snapshot .local/operator-reconciliation/snapshot.json
npm run operator -- audit verify \
  --file .local/operator-audit/operator-cli.jsonl
```

`reconcile` reads one strict, redacted, repository-local snapshot. It has no Shopify, eBay, Marketplace Connect, Railway, credential, application-database, sync, import, or publish adapter. The snapshot must:

- be a regular, non-symlink JSON file beneath `.local/operator-reconciliation/`;
- be at most 4 MiB, with at most 5,000 records in any collection;
- be no more than 24 hours old, with identities exactly matching the operator config;
- contain only normalized stable platform IDs, SKU, price/inventory values, statuses, owners, and canonical UTC timestamps; and
- exclude tokens, cookies, authorization material, buyers, customers, names, email, phone, addresses, notes, tags, line items, and raw payloads.

The result is either `consistent-with-supplied-snapshots` or `exceptions-found`. It always records:

- `liveProof: false`;
- `productionParity: false`;
- `externalWrites: 0`;
- `historicalBackfill: false`; and
- `orderCreationEligible: false`.

Only snapshot and result digests, checks, counts, and the decision outcome enter the hash-chained audit. Raw entities and discrepancy details do not. The audit is tamper-evident by tool behavior but is not a production-immutable audit store and cannot prove that a local administrator did not truncate the file.

See `docs/OPERATOR_CLI.md` for the complete snapshot schema, limits, exit codes, and audit properties.

## What remains unproved and unauthorized

This slice does not prove:

- which source commit is running in Railway until deployment evidence identifies it;
- that a successful build or deployment serves healthy live runtime behavior;
- current Shopify, eBay, or Marketplace Connect credentials, scopes, webhooks, settings, or state;
- cross-platform listing, price, inventory, order, or fulfillment parity;
- durable production idempotency, job concurrency, watermark behavior, or an immutable external audit store;
- sandbox or live-canary success; or
- readiness to disable Marketplace Connect.

The cutover watermark remains `null`, all historical eBay orders remain permanently ineligible for ProductPipeline creation, and no live or historical order may be imported by this phase. Any future live read adapter, test action, writer reintroduction, responsibility transfer, or Marketplace Connect change requires a separately reviewed and authorized slice.

## Verification checklist

For changes to this quarantine, run the focused suites plus the full repository checks documented by the handoff:

```sh
npx vitest run src/safety/__tests__ src/server/routes/migration.test.ts src/operator-cli/__tests__
npx tsc --noEmit
npm test
npm run build
```

Also verify that the built legacy CLI lists only `status`, all non-read `/api` requests return `423`, the health/migration surfaces expose the incumbent policy, webhook tests dispatch zero writers, and no test contacts an external system.
