# Listing Workspace Incident Register

Every Production listing-workspace failure gets a credential-free record, a safe handling rule, and explicit prevention evidence before it can be called fixed. A successful provider read or healthy `/health` response does not by itself prove the item workspace works.

## LWI-2026-08-14-001 — Valid long eBay descriptions rejected

**Status:** Open with a green local repair candidate. Source, regressions, full tests/build/diff check, and independent review are complete; commit, merge, deployment, exact health revision, signed-in affected-item proof, and Production store re-verification are pending.

### Impact

- The authenticated exact listing workspace returned HTTP `503` with its generic unavailable response for affected listings.
- The affected detail/local-draft flow could not proceed. No local draft was appended.
- Shopify, eBay, Marketplace Connect, Lightspeed, price, inventory, orders, listings, mappings, policies, credentials, and tokens were not written.

### Evidence and cause

- eBay identity/detail reads completed successfully before the local failure.
- Two valid Production eBay descriptions observed in the failing path were 147,595 and 144,209 bytes.
- `src/server/enriched-listing-detail.ts` imposed `MAX_DESCRIPTION_BYTES = 100_000` and classified any longer description as `INVALID_RESPONSE`.
- The route translated that local validation failure to the credential-safe generic `503`. The artificial content limit—not provider availability, authentication, seller identity, mapping, or the schema-version-2 local store—caused the outage.

### Immediate handling

1. Keep every provider writer quarantined. Do not publish, revise, retry a mutation, refresh credentials, replace the store, or change Marketplace Connect.
2. Treat the provider read as successful but the local workspace result as unavailable; do not show or infer partial listing state.
3. Preserve only credential-free evidence: route/status, fixed failure class, observed byte lengths, build commit, and UTC time. Never record the description body or authority material.
4. Leave the affected item unavailable until the complete repair gate below passes.

### Required repair and prevention gate

- [x] Local source repair independently reviewed. Parser and store now use the same exact description boundary: at most 500,000 Unicode code points and at most 2,000,000 UTF-8 bytes. The separate total-response/transport limit remains fail-closed.
- [x] Full observed descriptions remain available to inherited-value, semantic normalization/digest, revision reopen, audit, and integrity logic. UI summaries remain separately bounded and provider HTML is not rendered as active content.
- [x] Regressions preserve a 150 KiB valid description, accept the exact 500,000-code-point boundary, reject code-point/UTF-8 overflow and control characters, and retain the existing smaller caps for non-description fields.
- [x] A 300 KB inherited description saves without becoming an override or being truncated, then survives revision reopen, audit, and store-integrity verification.
- [x] Full local verification passed: 48 test files / 504 tests, `npm run build`, and `git diff --check`.
- [x] Independent code review reported no remaining repair-candidate finding.
- [ ] Create and record the exact repair commit; no commit is claimed yet.
- [ ] Merge and deploy that exact commit; verify Railway serves it on `/health`.
- [ ] A signed-in operator opens an affected listing and observes a complete mapping/detail/draft workspace with the expected current description summary.
- [ ] The post-deploy check records zero external/provider writes and confirms the Production local draft store still verifies as schema version 2.

Until every checked item has evidence, the incident remains open. Source changes or green local tests alone are not a Production repair.

### Handoff for a new Codex task

```text
Objective: Repair LWI-2026-08-14-001 without weakening response safety.
Authorized scope: Listing detail/workspace read parsing, focused regressions, required docs, reviewed merge/deploy/live read verification. No provider mutation.
Production baseline: PR #10 merge e0d59cd904209c30e815f6cf6a2e4e784208efc5; public health served that build at 2026-08-14T15:55:08.152Z.
Store baseline: one replica; /data/product-pipeline/listing-control.sqlite; schema 2; local_draft_only; mode 0600; verified; zero external writes.
Backup: /data/product-pipeline/backups/listing-control-initial-e0d59cd.sqlite; mode 0600; 114688 bytes; SHA-256 40c89f9e9beeac1ac36c33822ca59b3cc9057b99d062811b79cb00c6e88b4fc7.
Failure: valid 147595-byte and 144209-byte eBay descriptions pass remote reads but fail the local 100000-byte description cap, producing listing-workspace 503.
Current repair status: local source candidate independently reviewed and green at 48 files/504 tests, npm run build, and diff-check; exact repair commit, merge, deploy, health revision, signed-in affected-item proof, and Production store re-verification pending.
External systems touched by diagnosis: bounded read-only eBay/Shopify and Railway health/administration evidence only; zero provider writes.
Safest next action: freeze and commit the reviewed candidate, merge/deploy that exact commit, verify health, re-open the same affected workspace, then re-verify schema 2 and zero provider writes before closing this incident.
```
