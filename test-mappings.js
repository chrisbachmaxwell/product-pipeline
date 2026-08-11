#!/usr/bin/env node

/**
 * The former mapping smoke test called the production application directly,
 * embedded an API key, and issued mapping mutations. It is intentionally
 * quarantined with the rest of ProductPipeline's legacy writer tooling.
 *
 * Use the local-only operator CLI and synthetic fixtures for migration tests.
 * A future mapping canary must use an isolated target, an exact allowlist, a
 * single-use approval, audit evidence, reconciliation, and rollback proof.
 */

process.stderr.write(
  'Denied: the legacy live mapping test is quarantined. Use local fixture-backed operator checks.\n',
);
process.exitCode = 1;
