# Listing Workspace Incident Register

Every Production listing-workspace failure gets a credential-free record, a safe handling rule, and explicit prevention evidence before it can be called fixed. A successful provider read or healthy `/health` response does not by itself prove the item workspace works.

## LWI-2026-08-14-001 — Valid long eBay descriptions rejected

**Status:** Closed on 2026-08-14. Source, regressions, review, merge, deployment, exact health revision, signed-in affected-item proof, and Production store re-verification are complete.

### Impact

- The authenticated exact listing workspace returned HTTP `503` with its generic unavailable response for affected listings.
- The affected detail/local-draft flow could not proceed. No local draft was appended.
- Shopify, eBay, Marketplace Connect, Lightspeed, price, inventory, orders, listings, mappings, policies, credentials, and tokens were not written.

### Evidence and cause

- eBay identity/detail reads completed successfully before the local failure.
- Two valid Production eBay descriptions observed in the failing path were 147,595 and 144,209 bytes.
- `src/server/enriched-listing-detail.ts` imposed `MAX_DESCRIPTION_BYTES = 100_000` and classified any longer description as `INVALID_RESPONSE`.
- The route translated that local validation failure to the credential-safe generic `503`. The artificial content limit—not provider availability, authentication, seller identity, mapping, or the schema-version-2 local store—caused the outage.

### Handling used while open

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
- [x] Repair commit `bab71a5` merged through PR #11 as `789dc7782cea5da33a5fddd8617d1c364cbb783e` at `2026-08-14T16:11:47Z`.
- [x] Railway deployment `623f7eca-74ae-4ff8-8bec-99a761767793` succeeded with one replica and `/data`; public `/health` served the exact merge at `2026-08-14T16:13:06.046Z` with shadow read-only mode, external writes false, and historical backfill false.
- [x] A signed-in operator opened Aputure variant `gid://shopify/ProductVariant/54881767358755`, SKU `APD0170A3B-OB`, eBay listing `147232036779`, and observed complete Mapping, Listing, Content, and Delivery sections with a description summary and Edit control.
- [x] No Save was clicked and no provider write occurred. Post-deploy admin `verify` returned schema version 2, `local_draft_only`, and `externalWritesPerformed: 0`.

All closure gates have evidence. The incident is closed; its prevention limits and regressions remain required for future listing-workspace changes.

### Handoff for the next Codex task

```text
Objective: Continue bounded provider-control work from the deployed read/mapping/local-draft foundation.
Verified deployment: PR #11 repair bab71a5 merged as 789dc7782cea5da33a5fddd8617d1c364cbb783e; Railway deployment 623f7eca-74ae-4ff8-8bec-99a761767793 SUCCESS; public health served the exact merge at 2026-08-14T16:13:06.046Z.
Verified workspace: Aputure variant gid://shopify/ProductVariant/54881767358755; SKU APD0170A3B-OB; eBay listing 147232036779; complete Mapping, Listing, Content, and Delivery with description summary. Edit control visible but not opened; no Save clicked.
Store baseline: one replica; /data volume; /data/product-pipeline/listing-control.sqlite; schema 2; local_draft_only; mode 0600; admin verified; externalWritesPerformed 0.
Backup: /data/product-pipeline/backups/listing-control-initial-e0d59cd.sqlite; mode 0600; 114688 bytes; SHA-256 40c89f9e9beeac1ac36c33822ca59b3cc9057b99d062811b79cb00c6e88b4fc7.
Ownership boundary: Marketplace Connect remains the sole order, price, and inventory owner. Listing and mapping ownership remain unverified.
Authorized next scope: one exact provider-control responsibility and target at a time, beginning with read/compare/propose/preview and the required ownership, approval, audit, idempotency, reconciliation, observation, and rollback design. No provider write is authorized by this handoff.
Forbidden shortcuts: no generic two-way sync, Apply/Publish action, ownership transfer, Marketplace Connect change, historical order import, or broad retry/backfill without a separate reviewed and explicitly approved slice.
External effects in the closed incident: bounded reads and local store administration only; zero provider writes.
Safest next action: select one listing responsibility and exact target, prove the current owner and both eBay management paths, then prepare a proposal-only control slice and its approval/reconciliation/rollback packet before requesting any mutation authority.
```
