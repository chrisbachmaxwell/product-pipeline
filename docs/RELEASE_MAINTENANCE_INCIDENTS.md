# Release Maintenance Incidents

This ledger records credential-free release-maintenance incidents and prevention work. It does not authorize provider commerce writes, credential changes, deployment, or retry.

## SCR-2026-08-14-001 — Shopify secret rotation was not fail-safe

**Status:** source repair candidate; independently reviewed deployment and Production execution are still required.

**Trigger:** planned ProductPipeline Shopify credential maintenance exposed that the existing runtime verified inbound Shopify requests with only one client secret and had no fixed, audited way to rotate the one stored Production Shopify access token after a client-secret change.

**Safety outcome:** work stopped before any provider request, Railway variable change, Production database access, token mutation, secret revocation, or deployment. Marketplace Connect ownership and the provider-writer quarantine were unchanged.

**Failure risks:** changing the primary secret without bounded overlap could reject App Bridge sessions or Shopify webhooks still signed with the oldest unrevoked secret. An ad hoc token exchange could target the wrong shop/app, change scopes, expose a provider error body, mutate the wrong database row, lose unrelated database state, retry an ambiguous credential effect, or persist the one-hour dashboard refresh token into the database/token row.

**Prevention candidate:** the runtime now verifies canonical exact-store HS256 session JWTs and webhook HMACs against the current secret plus one distinct optional previous secret for no more than one hour. At cutoff, the previous secret is ignored while current-secret verification remains available. Production and ambiguous environments are environment-only, and token acquisition remains primary-only with bounded redacted transport.

The separate credential administrator pins the exact Production Railway service, Shopify store/app, legacy database, and four canonical read-only scopes. Rotation requires a dedicated expiring single-writer acknowledgement, an active old/new verifier overlap, and at least 15 minutes remaining immediately before the single no-retry provider request. It performs current-token preflight, a complete verified private backup, fresh-token authority verification, full-row compare-and-swap, read-only reopen proof, and final provider verification. It is not imported or mounted by the server and has no provider commerce-write adapter.

**Regression gates:** dual-secret JWT/webhook tests cover current, previous, malformed, duplicate, overlong, exact-cutoff, and post-cutoff behavior. Credential-admin tests cover exact runtime/DB binding, canonical schema and scope authority, wrong shop/app, timeout/redirect/body bounds, no mutation before provider success, backup integrity/permissions, unrelated-state preservation, dispatch-window expiry, forward commit after a verified remote effect, compare-and-swap races, redacted output, refresh-token non-persistence to the database/token row, and the server/provider-write import boundary.

**Open proof:** source tests and builds do not prove deployment or Production behavior. Before closure, require independent source review, exact commit/deployment evidence, one-replica/one-volume topology proof, successful fixed preflight/rotate/verify results, current-secret inbound health, temporary-variable removal, old-secret revocation, and a credential-free incident closure note. Any ambiguous post-dispatch outcome remains open and must not be retried blindly.
