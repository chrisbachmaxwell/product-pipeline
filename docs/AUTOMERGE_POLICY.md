# Pre-Approved Merge Policy (L88)

A pull request merges automatically when **every** changed file is in the
structurally-safe class — documentation (`*.md`) or tests (`*.test.ts`,
`__tests__/`, synced `dist` test copies) — and the secretless `ci` check
passes. These changes are incapable of touching the provider-writer path.

Never auto-merged, by construction: `CLAUDE.md`, `AGENTS.md`, anything in
`.github/` (the policy cannot pre-approve changes to itself), and all
production source — those keep the human merge, which is the one-action
approval for the writer path (Absolute #3).

The judge runs from `main` via `pull_request_target`: a PR cannot rewrite
the rules that evaluate it. Fork PRs are excluded entirely.

## Agent-merged PRs (L91, 2026-10-07)

On the operator's standing instruction, an agent merges the PR it opened
for an operator request once CI is green on the current head and the PR is
mergeable, production source included, and then tells the operator it
merged. Merging deploys (`main` auto-deploys); it never performs a provider
write, since every eBay/Shopify write still runs its per-action ceremony.
A PR that loosens any of the four absolutes or their enforcement (order
watermark clamp, one-writer ownership, ceremony CLIs / writer quarantine,
credential and PII handling) still waits for the operator's explicit merge.
