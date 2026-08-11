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

`reconcile` accepts one strict JSON bundle with schema version `1`, kind `product-pipeline-shadow-reconciliation`, a canonical UTC capture time, identities matching the operator config exactly, and these normalized sections:

- ProductPipeline listing links and order observations;
- Shopify variant price/inventory and eBay-source order links;
- eBay inventory/offer/listing state and order identities; and
- Marketplace Connect order-import, price-sync, and inventory-sync status.

Snapshots are capped at 4 MiB and 5,000 rows per collection. The file must be a regular, non-symlink file beneath `.local/operator-reconciliation/`. Unknown fields and secret-like or personal-data fields are rejected. A snapshot must contain only stable platform IDs, SKU, normalized price/inventory, status, owner, and timestamps—never names, titles, buyers, customers, email, phone, addresses, notes, tags, line items, raw payloads, tokens, cookies, or authorization material.

This command has no snapshot exporter and no live adapter. A trusted, separately reviewed process must create the redacted bundle. Reconciliation never reads the application database or credential files and never contacts a platform. An unlinked eBay order is reported as an incumbent-owned exception; it is never an import candidate.

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

Coverage includes unsafe-mode, writer, backfill, cutover, secret, personal-data, unknown-field, wildcard, identity, snapshot path, stale evidence, duplicate-order, observed price/inventory difference, no-network/no-database, command-boundary, audit-link, tamper, incomplete-write, and concurrent-lock denials.

## Next gate

The offline reconciliation result is deliberately limited to `consistent-with-supplied-snapshots` or `exceptions-found`. Every result states `liveProof: false`, `productionParity: false`, `externalWrites: 0`, `historicalBackfill: false`, and `orderCreationEligible: false`.

This slice does not authorize a live adapter, sandbox/live write, order or listing creation, ownership cutover, Marketplace Connect change, or production-parity claim. A future live read adapter requires its own credential boundary, read-only transport, redaction contract, and deployment review.
