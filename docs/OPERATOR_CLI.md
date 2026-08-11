# ProductPipeline Operator CLI Foundation

The operator CLI is a local-only migration safety tool. It validates declared shadow-mode configuration, reports responsibility ownership, and verifies its local audit chain. It does not connect to Shopify, eBay, Marketplace Connect, Railway, the ProductPipeline server, or the application database.

This foundation does not prove remote identity, configuration, listing parity, or production readiness. It implements no sync, import, publish, save, approval, or mutation command.

## Safety boundary

The executable at `src/operator-cli/index.ts` is separate from the legacy `ebaysync` CLI. Its runtime import tree is limited to:

- Node.js built-ins;
- Commander for argument parsing; and
- modules within `src/operator-cli/`.

Do not import from `src/cli`, `src/server`, `src/db`, `src/config`, `src/shopify`, `src/ebay`, `src/sync`, or `src/watcher`. Those legacy trees can read credentials, initialize or seed the application database, start timers/workers, contact configured services, or expose mutations.

The only write this CLI performs is appending a redacted decision record to a repository-local JSONL audit file for `preflight` and `ownership`. `audit verify` does not write. Runtime audit files live under `.local/` and are ignored by Git.

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

Verify the local audit chain:

```sh
npm run operator -- audit verify --file .local/operator-audit/operator-cli.jsonl
```

Add `--json` for one machine-readable JSON object. `--dry-run` is accepted and always defaults on; `--no-dry-run`, `--live`, `--write`, and unknown options are rejected because no such mode exists.

Exit codes:

- `0`: local config is configuration-safe, or the audit chain verified;
- `1`: config, repository identity, argument, or audit integrity denial;
- `2`: structurally safe config, but unresolved ownership blocks readiness.

Do not use `npm run cli` or the legacy `ebaysync` commands as migration preflight. Those commands are outside this safety boundary.

## Audit properties and limits

Each record includes a sequence, UTC timestamp, random run ID, command, lane/mode, approved nonsecret identity fields, config/ownership digests, check results, previous hash, and record hash. Before append, the CLI verifies the entire existing chain, obtains an exclusive lock, appends with filesystem sync, and verifies the new head. It refuses to append to a corrupt or concurrently locked log.

This local file is append-only by tool behavior and tamper-evident for edits, reordered records, and broken links. It is not immutable against a host administrator, and a standalone hash chain cannot prove that its final records were not truncated. Production audit durability requires a separately designed append-only store and external checkpoint/anchor.

## Verification

The focused local checks are:

```sh
npx vitest run src/operator-cli/__tests__
npx tsc --noEmit
```

Coverage includes unsafe-mode, writer, backfill, cutover, secret, unknown-field, wildcard, lane mismatch, repository/path, no-network/no-database, command-boundary, audit-link, tamper, incomplete-write, and concurrent-lock denials.

## Next gate

This foundation is ready for code review. It should remain on a non-default branch until the user approves a merge/deployment decision because this repository documents `main` as Railway-auto-deployed.

The next implementation slice is not authorized by this CLI itself. It requires an accepted ownership baseline and an explicit scope for repository application changes: hard writer quarantine, durable external-ID idempotency, the order watermark model, and read-only reconciliation adapters. No live/sandbox access, credential use, test listing/order, or Marketplace Connect change follows from passing this local preflight.
