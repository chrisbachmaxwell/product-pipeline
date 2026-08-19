# G3 — Local Draft Save Path Exercise

Goal-board G3 requires one authenticated bounded local draft append with
verification of the stored revision, stale-base rejection, and the admin
`verify` result, recorded as proof. This document records that exercise and
states exactly what it proves and what it does not.

## What was exercised

The committed regression `src/server/routes/listing-draft-save-exercise.test.ts`
drives the complete mounted request path exactly as `src/server/index.ts`
composes it:

1. the real in-memory rate limiter;
2. the real API authentication middleware with **no** test-mode bypass and
   **no** operator API key — the production branch that accepts only a
   cryptographically verified Shopify App Bridge HS256 session token for the
   pinned client id and `usedcameragear.myshopify.com`;
3. the real writer-quarantine middleware (noncanonical siblings still return
   `423`);
4. the real bounded JSON parser and error handler;
5. the real `createListingDraftService` and a real on-disk
   `listing-control.sqlite` store initialized by the real
   `listing-control-admin init` and verified afterward by the real
   `listing-control-admin verify`.

The only substituted dependency is the live workspace read (`readWorkspace`),
replaced with the canonical CAN3570-U119 inventory-offer workspace fixture,
because a live Shopify/eBay capture requires production credentials that must
never enter tests. The session-signing secret is a random local value; the
verification code path is the production one, the signing authority is not.

## Recorded result — 2026-08-14

One run with `LISTING_DRAFT_EXERCISE_TRANSCRIPT_TARGET` produced this
transcript (values are from the recorded run; revision ids are random per
run):

```json
{
  "exercise": "g3-local-draft-append",
  "performedAtUtc": "2026-08-14T22:56:19.718Z",
  "catalogId": "shopify-variant:gid://shopify/ProductVariant/55396000563491",
  "actor": "shopify-user:g3-exercise-operator",
  "base": {
    "sourceDigest": "sha256:c6b53be984ce44f83763429bdeaaf03060e790d03bb16f54c8e8f3a881b389f7",
    "ebayDigest": "sha256:2535c549f0218cb1d7500536c44caa10089a63f385c34289ad670c5ed8177265"
  },
  "firstRevision": {
    "revisionId": "listing-draft:dba15450-c2f1-4dca-bb83-211042b2e010",
    "revisionNumber": 1,
    "revisionDigest": "sha256:a6a529241a8c86100a239c46c5252b0e49a3e21285f84edb4b1b7af6c5eb7ca2",
    "state": "draft",
    "createdAtUtc": "2026-08-14T22:56:19.654Z"
  },
  "staleReplayStatus": 409,
  "staleBaseStatus": 409,
  "secondRevisionNumber": 2,
  "adminVerify": {
    "status": "verified",
    "schemaVersion": 2,
    "mode": "local_draft_only",
    "externalWritesPerformed": 0
  },
  "externalWritesPerformed": 0
}
```

Verified behaviors, each asserted by the regression:

- Missing, forged-signature, and wrong-audience session tokens are rejected
  with `401` before any service work.
- A verified session opened the workspace with
  `capabilities: { saveDraft: true, previewChanges: true, apply: false,
  publish: false }`.
- One bounded append returned `201` with revision number 1; the stored
  revision carries the operator override, the server-derived actor
  `shopify-user:<sub>`, and a revision digest that matches the read-back
  store row.
- Replaying the identical save returns `409 LISTING_DRAFT_STALE` and appends
  nothing.
- After a simulated remote eBay change, a save carrying the correct latest
  revision digest but the previously observed base digests returns
  `409 LISTING_DRAFT_STALE` — the semantic base binding, not just revision
  CAS, gates the append.
- Reopening against current facts restores the save path; the CAS chain
  accepted revision 2 only with the exact latest revision digest.
- `POST /api/listing-drafts` (noncanonical sibling) stays quarantined with
  `423` even for the verified session.
- The audit chain verifies (`valid: true`) and `listing-control-admin verify`
  accepts the exercised store unchanged.

## Proof boundary

- This is local end-to-end proof of the exact deployed code path — source
  behavior plus local runtime verification. It is **not** a signed-in
  Production save: the deployed instance requires a session minted by
  Shopify's admin for the real app secret, which only the operator's browser
  session can produce.
- No provider write of any kind occurred; `externalWritesPerformed` is 0 in
  every store record and response.

## Remaining one-click Production confirmation (operator)

The deployed workspace already shows the Edit control (Section 13 signed-in
proof). To complete the live half of G3, the operator performs exactly one
bounded save in the signed-in embedded app:

1. Open the ProductPipeline app in the Shopify admin, open the Listings
   workspace for an eligible item (the Aputure item
   `gid://shopify/ProductVariant/54881767358755` / SKU `APD0170A3B-OB` was
   the Section 13 proof item, or CAN3570-U119).
2. Edit exactly one field (for example, append a marker to the title), and
   Save. Expect a success response showing revision number 1 (or the next
   number) and no error banner.
3. Afterward, on the Railway service, run
   `node dist/listing-control-admin/index.js verify` and record the output in
   `PROJECT.md`. Expect `status: "verified"`, `schemaVersion: 2`,
   `externalWritesPerformed: 0`.
4. If the save returns `409`, the workspace facts changed mid-edit — reopen
   the item and repeat; this is the stale-base gate working as designed.

This save is a local-store append only. It has no provider, price,
inventory, order, or Marketplace Connect effect.
