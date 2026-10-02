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
