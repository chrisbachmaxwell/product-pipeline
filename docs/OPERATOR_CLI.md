# ProductPipeline Operator CLI Foundation

The operator CLI is a local-only migration safety tool. It validates declared shadow-mode configuration, reports responsibility ownership, compares redacted offline reconciliation snapshots, and verifies its local audit chain. It does not connect to Shopify, eBay, Marketplace Connect, Railway, the ProductPipeline server, or the application database.

This foundation does not prove remote identity, configuration, listing parity, or production readiness. It implements no sync, import, publish, save, approval, or mutation command.

## Safety boundary

The executable at `src/operator-cli/index.ts` is separate from the legacy `ebaysync` CLI. Its runtime import tree is limited to:

- Node.js built-ins;
- Commander for argument parsing; and
- modules within `src/operator-cli/`.

Do not import from `src/cli`, `src/server`, `src/db`, `src/config`, `src/shopify`, `src/ebay`, `src/sync`, or `src/watcher`. Those legacy trees can read credentials, initialize or seed the application database, start timers/workers, contact configured services, or expose mutations.

The only write this CLI performs is appending a redacted decision record to a repository-local JSONL audit file for `preflight`, `ownership`, and `reconcile`. `audit verify` does not write. Runtime audit files and reconciliation snapshots live under `.local/` and are ignored by Git.

## Configuration contract

Every inspection requires an explicit repository-local JSON config. The validator rejects unknown fields and fails closed unless all of the following are explicit:

- schema version `1` and project `product-pipeline`;
- lane `development`, `sandbox`, or `production-shadow` with a matching eBay environment;
- mode `read-only`, `dryRun: true`, and `writesEnabled: false`;
- declared nonsecret Shopify, eBay, and Marketplace Connect identities;
- one current owner and ProductPipeline access mode for every responsibility;
- `orders.importEnabled: false`, `historicalBackfill: false`, and no active cutover watermark;
- an empty, inactive Test Lane in this no-action foundation; and
- the fixed ignored audit path `.local/operator-audit/operator-cli.jsonl`.

Credential-like keys or values are rejected recursively. Never put tokens, passwords, API keys, cookies, authorization headers, credentials, customer data, or order payloads in the config.

`config/operator-shadow.example.json` records the currently verified facts: Marketplace Connect owns price, inventory, and order import; ProductPipeline is read-only. Listing lifecycle, mapping, fulfillment, feedback, and reconciliation owners remain `unverified`, so the example deliberately returns a blocked preflight until those owners are established with evidence. Its identities are configuration declarations, not a remote check.

## Commands

Install the locked dependencies locally, without changing the lockfile:

```sh
npm ci --ignore-scripts
```

Inspect the example configuration:

```sh
npm run operator -- preflight --config config/operator-shadow.example.json
```

Print the ownership matrix:

```sh
npm run operator -- ownership --config config/operator-shadow.example.json
```

Compare one redacted offline snapshot:

```sh
npm run operator -- reconcile \
  --config config/operator-shadow.example.json \
  --snapshot .local/operator-reconciliation/snapshot.json
```

`reconcile` accepts one strict JSON bundle with schema version `2`, kind `product-pipeline-shadow-reconciliation`, identities matching the operator config exactly, and four independently provenance-bearing source bundles:

- ProductPipeline listing links and order observations;
- Shopify variant price/inventory and eBay-source order links;
- eBay inventory/offer/listing state and order identities; and
- Marketplace Connect order-import, price-sync, and inventory-sync settings.

Each source is explicitly `complete`, `partial`, or `unavailable` and records its system-specific subject, acquisition method and attestation class, collector name/version/build, capture and as-of window, bounded query scope, pagination completion, page/record/reported totals, normalization/redaction versions, and normalized dataset digest. Partial and unavailable sources are valid evidence of a gap: they parse but block every dependent responsibility. The command evaluates freshness per source, rejects future timestamps and excessive cross-source skew, and never substitutes the bundle-generation time for source observation time.

Direct Shopify/eBay evidence also requires an explicit API version and terminal-cursor digest. A complete source needs at least one terminal page, exact normalized/reported counts (including an explicitly proven zero result), complete pagination, terminal proof, and a matching dataset digest. Version 2 intentionally marks all nine operational responsibilities with `model-coverage-incomplete`: it does not yet represent listing policies/aspects/conditions, Marketplace Connect per-item links, price transformation rules, inventory location/reservation semantics, fulfillment, or feedback. Only the meta reconciliation responsibility can be internally consistent under this schema, and that still is not live proof or parity.

Snapshots are capped at 4 MiB and 5,000 rows per collection. The file must be a regular, non-symlink file beneath `.local/operator-reconciliation/`. Unknown fields, identity/subject mismatches, count or digest mismatches, ambiguous duplicate Shopify/eBay SKUs, and secret-like or personal-data fields are rejected or reported as critical blockers. A snapshot contains only stable platform IDs, SKU, normalized price/inventory, status, owner, and timestamps—never names, titles, buyers, customers, email, phone, addresses, notes, tags, line items, raw payloads, tokens, cookies, or authorization material.

This command has no snapshot exporter and no live adapter. A trusted, separately reviewed process must create the redacted bundle. Reconciliation never reads the application database or credential files and never contacts a platform. An unlinked eBay order is reported as an incumbent-owned exception; it is never an import candidate. See `docs/READ_ONLY_PARITY.md` for the current source matrix, verified ownership gaps, and live-collector gate.

Verify the local audit chain:

```sh
npm run operator -- audit verify --file .local/operator-audit/operator-cli.jsonl
```

Add `--json` for one machine-readable JSON object. `--dry-run` is accepted and always defaults on; `--no-dry-run`, `--live`, `--write`, and unknown options are rejected because no such mode exists.

Exit codes:

- `0`: local config is configuration-safe, supplied snapshots are internally consistent, or the audit chain verified;
- `1`: config, repository identity, argument, or audit integrity denial;
- `2`: structurally safe input, but unresolved ownership, stale evidence, or reconciliation exceptions block readiness.

The legacy `npm run cli` / `ebaysync` entrypoint is status-only in shadow mode. Its status output does not replace the stricter operator preflight, supplied-snapshot reconciliation, or audit verification described here.

## Audit properties and limits

Each record includes a sequence, UTC timestamp, random run ID, command, lane/mode, approved nonsecret identity fields, config/ownership digests, check results, previous hash, and record hash. Reconciliation audit records add only snapshot/result digests as check IDs; raw SKU, listing IDs, order IDs, snapshot rows, and discrepancy details are not copied into the audit. Before append, the CLI verifies the entire existing chain, obtains an exclusive lock, appends with filesystem sync, and verifies the new head. It refuses to append to a corrupt or concurrently locked log.

This local file is append-only by tool behavior and tamper-evident for edits, reordered records, and broken links. It is not immutable against a host administrator, and a standalone hash chain cannot prove that its final records were not truncated. Production audit durability requires a separately designed append-only store and external checkpoint/anchor.

## Verification

The focused local checks are:

```sh
npx vitest run src/operator-cli/__tests__
npx tsc --noEmit
```

Coverage includes unsafe-mode, writer, backfill, cutover, secret, personal-data, unknown-field, wildcard, identity/subject, snapshot path, per-source stale/future/skew, pagination/count/digest, duplicate ID/SKU, duplicate order, observed price/inventory difference, unavailable-source, no-network/no-database, command-boundary, audit-link, tamper, incomplete-write, and concurrent-lock denials.

## Next gate

The offline reconciliation result is deliberately limited to `consistent-with-supplied-snapshots` or `exceptions-found`. It reports per-source blockers and per-responsibility evidence state. Every result states `liveProof: false`, `productionParity: false`, `externalWrites: 0`, `historicalBackfill: false`, and `orderCreationEligible: false`.

The pure evaluator in `src/safety/canary-readiness.ts` models the evidence, one-target/one-responsibility, exact Shopify/eBay account scope, ownership-version binding, observation window, expected before/after digests, single-writer proof, approval chronology, durable account-scoped idempotency, watermark, audit, reconciliation, and rollback facts a future canary packet would need. It is intentionally not imported by the runtime and returns `canaryAuthorized: false` and `externalWritesAllowed: false` even when a synthetic packet satisfies every modeled prerequisite.

This slice does not authorize a live adapter, sandbox/live write, order or listing creation, ownership cutover, Marketplace Connect change, or production-parity claim. A future live read adapter requires its own credential boundary, read-only transport, redaction contract, and deployment review.
