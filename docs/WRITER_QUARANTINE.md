# ProductPipeline Writer Quarantine

This document describes the Marketplace Connect incumbent phase enforced by the current source. It is an application safety boundary, not evidence that ProductPipeline has production parity and not authorization to transfer a live responsibility.

## Effective ownership

The accepted production ownership baseline keeps Marketplace Connect as the writer for:

- eBay-to-Shopify order import;
- eBay offer price;
- eBay inventory quantity.

ProductPipeline listing-lifecycle and fulfillment writes are quarantined too. Their current production owners remain `unverified` in the immutable source policy; quarantine is not a claim that Marketplace Connect owns those responsibilities. Assigning either responsibility requires explicit reconciliation evidence and a later authorization.

ProductPipeline is in hard-coded `shadow-read-only` mode for every external commerce effect. External commerce writes are denied, historical backfill is denied, and no order cutover watermark exists. There is no environment variable, database setting, request flag, `TEST_MODE` exception, or confirmation parameter that can enable a Shopify, eBay, Marketplace Connect, or Lightspeed writer in this phase.

The sole state-changing API exception is exact `POST /api/listing-draft`. It appends a bounded local draft revision only after exact-store Shopify-session authentication, optimistic base/revision checks, and store-integrity verification. It has no Apply, Approve, Publish, provider client, credential write, ownership transfer, price/inventory/order action, or external side effect. Sibling, trailing-slash, query-string, encoded, case-variant, and all other non-read API requests remain quarantined.

The ownership transfer contract remains unchanged: one responsibility at a time, separately authorized, after accepted parity, idempotency, reconciliation, canary, audit, observation, and rollback evidence. Marketplace Connect must not be disabled by ProductPipeline or by this quarantine slice.

## Enforcement layers

| Layer | Enforced behavior |
|---|---|
| Runtime policy | `src/safety/writer-quarantine.ts` contains the immutable incumbent baseline and throws `WRITER_QUARANTINED` for every attempted external write. Denials identify the responsibility, operation, incumbent owner, and required cutover decision. |
| HTTP API | Every non-read request beneath `/api`, except exact `POST /api/listing-draft`, is stopped before a legacy handler can load credentials, initialize work, or contact a commerce platform. The exception parses at most 64 KiB only after authentication/quarantine and can append only to the dedicated local draft store. Legacy GET routes remain unmounted and return `404`. |
| Startup | The server does not mount the legacy mutation scheduler or cloud watcher. Startup logs that shadow read-only mode is active. |
| Authentication | Shopify and eBay authentication routes are not mounted in the shadow application. Production API reads require a canonical cryptographically verified Shopify App Bridge session JWT for the exact app and Used Camera Gear store. During a bounded client-secret rotation window, inbound JWT and webhook verification accepts the current secret plus one distinct previous secret for at most one hour; at cutoff only the current secret remains valid. Production and ambiguous environments never use credential-file fallback. Origin, Referer, query keys, and production API keys never authorize. Existing credential records are never reported as proof of remote connectivity. |
| Webhooks | Shopify and eBay webhook endpoints acknowledge receipts and dispatch no order, listing, price, inventory, fulfillment, pipeline, or watcher work. HMAC-valid Shopify receipts produce only a sanitized process log. Unauthenticated eBay receipts are not parsed and receive a static no-op acknowledgement. Neither route persists payload or receipt evidence. |
| Legacy CLI | The `ebaysync` executable exposes only `status`. Former authentication, sync, import, publish, republish, watcher, pipeline, image, settings, and other action commands are not registered. |
| eBay adapter | The base eBay client denies every method except `GET` and `HEAD`. Individual inventory, offer, listing, notification-preference, and fulfillment mutators also deny at their entry points. |
| Shopify adapters | Shopify order creation and inventory-setting functions deny before credential loading or network access. |
| Service functions | Legacy order, price, inventory, listing, fulfillment, draft-listing, image-upload, and related mutation services deny before their former external work. This prevents direct imports from bypassing HTTP or CLI controls. |

The API middleware intentionally denies every other benign application POST/PUT/DELETE operation too. This broad posture prevents a forgotten route, chat-generated request, test endpoint, or legacy helper from becoming an alternate commerce-write path. Mounted authenticated reads cover migration status, listing catalog/workspace projections, local listing drafts, and capability metadata; customer/order/log/settings/test readers and remote token-refresh readers are not reachable. A future wider API or any provider mutation must be introduced only with an explicit responsibility-specific design and authorization.

The fixed-purpose compiled `credential-admin` executable is a release-maintenance boundary, not an application writer. Its npm script is deliberately absent; only the direct compiled `node dist/credential-admin/index.js ...` invocation is supported so a package wrapper cannot print raw argv before redaction. It is never imported or mounted by the server and accepts no path or identity options. Its exceptional database diagnostic requires the exact Production Railway/app binding and an absent listing-control writer acknowledgement, keeps one verified read-only descriptor open, and lets SQLite inspect only a bounded private in-memory snapshot rather than the filesystem path. It selects no token values and emits only fixed booleans/stages with explicit zero database/provider/commerce effects. The incident-only permission repair is a distinct mode-metadata boundary: with listing/rotation authority absent, explicit one-replica/one-volume assertions, and the exact effective-UID-`0` contract proved by the no-`USER` Dockerfile/runtime fence, it can issue exactly one descriptor-bound `fchmod(0600)` plus file/parent sync against the same verified inode and UID/GID, then prove bounded content/mtime unchanged. It has no automatic rollback, restore, or second metadata-write path; any post-invocation error, close ambiguity, third mode, owner/group, identity, growth, content, parent/path, or sidecar drift is an unknown outcome requiring the read-only diagnostic, health, and a DB-backed read without retry. It has no raw/path chmod, SQL, token-value, network, provider, or database-content-write capability. The separately gated rotation command can update only the one exact legacy Shopify token row after Production identity/scope verification, the same exact mutation-compatible schema/CAS proof, a complete private backup, and a single no-retry provider credential request. None of these commands has a listing, order, price, inventory, fulfillment, policy, mapping, Marketplace Connect, or Lightspeed write adapter. See `docs/SHOPIFY_CREDENTIAL_ROTATION.md`.

### Local state that can still change

The mounted web runtime may change only the dedicated listing-control store:

- startup does not initialize, migrate, or seed the application database;
- local-ledger views open only an existing SQLite file with `readonly`, `fileMustExist`, and `query_only` enforced, then close it;
- `GET /api/listing-draft` reads one exact current workspace and latest local revision; exact-store `POST /api/listing-draft` may append one immutable local revision after semantic stale-base and expected-revision checks;
- the listing-control store must already exist as canonical schema version 2 under an exact account scope; runtime never creates, migrates, repairs, or replaces it;
- draft save is unavailable unless `LISTING_CONTROL_DATABASE_PATH` names that verified store and `LISTING_CONTROL_SINGLE_WRITER_ACK=product-pipeline-local-draft-v1` asserts the reviewed single-writer topology; the acknowledgement is not topology proof;
- operator `preflight`, `ownership`, and `reconcile` commands may append redacted hash-chained audit records beneath `.local/`; and
- an operator may place an explicitly prepared reconciliation snapshot beneath `.local/operator-reconciliation/`.

The dedicated local draft store and operator-owned `.local/` files are outside the legacy application ledger. None creates or changes a Shopify order, eBay order, listing, price, inventory level, fulfillment, Marketplace Connect setting, application-ledger row, or cutover watermark. See `docs/LISTING_CONTROL_ADMIN.md` for explicit initialization, verification, topology, volume, and recovery gates.

## Operator-visible status

The following surfaces report the effective policy:

- `GET /health` includes the migration phase, effective mode, responsibility ownership, quarantine channels, and build commit when Railway supplies it.
- `GET /api/migration/status` combines the immutable policy with local-only ledger counts and flags stale legacy settings as exceptions. A stale database toggle is reported as `effectiveBehavior: quarantined`; it does not override the policy.
- The Overview, Listings, Orders, Reconciliation, and Settings pages show the Marketplace Connect owner, shadow status, missing watermark, and absence of remote parity proof. Listings may additionally preview and save a local draft; it cannot apply, approve, publish, or otherwise send that draft to a provider.
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

`reconcile` reads one strict, redacted, repository-local version-2 snapshot with independent provenance for ProductPipeline, Shopify, eBay, and Marketplace Connect. It has no Shopify, eBay, Marketplace Connect, Railway, credential, application-database, sync, import, or publish adapter. The snapshot must:

- be a regular, non-symlink JSON file beneath `.local/operator-reconciliation/`;
- be at most 4 MiB, with at most 5,000 records in any collection;
- be no more than 24 hours old, with identities exactly matching the operator config;
- contain only normalized stable platform IDs, SKU, price/inventory values, statuses, owners, and canonical UTC timestamps; and
- exclude tokens, cookies, authorization material, buyers, customers, names, email, phone, addresses, notes, tags, line items, and raw payloads.
- bind each normalized dataset to its digest, source subject, bounded query, capture/as-of time, and pagination/count evidence; partial or unavailable sources remain blockers.
- reject ambiguous duplicate Shopify/eBay SKUs rather than silently choosing a row for price or inventory comparison.

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

Also verify that the built legacy CLI lists only `status`, exact local-draft append is the sole non-read `/api` exception, every other non-read API request returns `423`, the health/migration surfaces expose the incumbent policy, webhook tests dispatch zero writers, and no test contacts an external system.
