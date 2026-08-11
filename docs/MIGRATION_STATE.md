# Durable Migration State

This document defines the persistence boundary required before ProductPipeline can assume any Marketplace Connect responsibility. The migration store is a separate control-plane database; it is not the legacy application ledger, a commerce writer, or a cutover authorization.

## Implemented state

Schema version 1 and its repository are implemented under `src/migration-store/` but are not imported by the server, webhooks, schedulers, legacy CLI, platform clients, or writer services. The database can be created only through an explicit absolute-path API; no mounted command or application startup path calls it in this release. The adjacent `src/shadow-read/` code is fixture-only contract test infrastructure and likewise has no live transport.

The focused persistence suite covers filesystem publication/reopen behavior, production inertness, watermark boundaries, deterministic order intents, approval/job reservation, delayed incumbent links, outcome-unknown reconciliation, direct-SQL replacement and relationship attacks, schema/audit tampering, and the compiled-artifact boundary. Passing these local tests does not initialize a production database, establish a watermark, prove parity, or authorize a writer.

## Safety boundary

- Nothing imports the migration store from the mounted server, webhook handlers, schedulers, legacy CLI, Shopify/eBay adapters, or writer services in the current phase.
- Creation or migration is explicit. Merely starting ProductPipeline, viewing the five-page UI, or running offline reconciliation must not create or alter this database.
- Records contain stable platform identities, policy/evidence digests, state-machine metadata, and timestamps only. Tokens, cookies, secrets, buyers, names, email, phone, addresses, line items, notes, and raw platform payloads are forbidden.
- The canonical store API opens an exact 0600 regular file, enables its required SQLite constraints, verifies the complete schema/catalog and audit chain, and uses immediate transactions. A process with direct filesystem/SQLite administration can still replace the file or drop its schema and is outside this local threat boundary. The database is not an externally immutable audit service and does not prove production parity.
- Every current writer remains quarantined. Persisting a row never enables an external write, establishes a production watermark, transfers ownership, or authorizes a canary.
- The first implementation is deliberately asymmetric: a production-scoped store may record the Marketplace Connect v1 incumbent baseline and shadow evidence only. It rejects a ProductPipeline ownership transfer, production watermark, approval consumption, or execution reservation. Future-state behavior is exercised only against an explicitly scoped sandbox store.

## Canonical responsibility vocabulary

Every control-plane record uses the exact values exported by `src/safety/responsibilities.ts`:

`orderImport`, `price`, `inventory`, `listingCreate`, `listingRevise`, `listingEndRelist`, `mapping`, `fulfillment`, `feedback`, and `reconciliation`.

`reconciliation` is an ownership/evidence responsibility but never a writer action. Legacy names such as `orders`, `listing_update`, and `listingLifecycle` are rejected rather than translated. This prevents a permissive mapping layer from authorizing a different responsibility than the operator reviewed.

## Account-scoped identities

Every external identity must include the account boundary that gives it meaning:

- Shopify resources: exact `*.myshopify.com` store plus canonical Product, ProductVariant, or Order GID.
- eBay resources: environment, seller account, marketplace, and the resource ID. Listing links retain inventory-item SKU, offer ID, and listing ID; order links retain eBay order ID.
- A bare SKU, listing ID, order ID, or local integer is not a globally durable identity.

The store must reject an attempt to reuse an identity across a conflicting account or link two different source identities to one supposedly unique remote effect.

## Order incident invariants

The following rules specifically prevent a repeat of the historical-order import incident:

1. **Explicit immutable watermark.** An order watermark is inserted for one exact eBay environment, seller, marketplace, stream, and event-time field. It uses an exclusive boundary. It cannot be inferred, updated, replaced, or deleted.
2. **Permanent historical ineligibility.** An order whose source event time is at or before the watermark can never receive an import intent. A null/missing watermark makes every order ineligible.
3. **One business identity, one intent.** The order-import idempotency identity is stable across approvals, deployments, retries, workers, payload formatting, and ownership-version changes. A new approval cannot create a second intent for the same eBay order and Shopify store.
4. **Reserve before dispatch.** Ownership, evidence, approval, watermark eligibility, intent uniqueness, and job reservation are checked in one immediate transaction before any future adapter could be called.
5. **Unknown is not retryable.** Once a future attempt crosses the dispatch boundary, a timeout or crash becomes `outcome-unknown`. ProductPipeline must reconcile Shopify by the stable external identity before any further decision; it must never automatically create again.
6. **Cursor is not watermark.** A polling cursor may advance monotonically for resumability, but it cannot move or substitute for the immutable lower-bound cutover watermark.

## Control-plane records

The dedicated store is expected to retain:

- platform accounts and account-scoped listing/order links;
- versioned ownership decisions and evidence references;
- immutable order watermarks and separate monotonic stream cursors;
- deterministic idempotency intents, durable jobs, and append-only attempts;
- exact-target, responsibility-scoped, expiring, single-use approvals;
- reconciliation runs and immutable exception observations;
- append-only audit events with a verifiable hash chain.

Mutable workflow state must use constrained transitions. Immutable evidence and attempt history must reject `UPDATE`, `DELETE`, and replace-style writes. Multi-worker reservation must use a transaction and a uniqueness constraint rather than process memory.

## Canary relationship

The pure canary-readiness evaluator and this persistence layer have different jobs:

- the store proves that required state exists under durable constraints;
- reconciliation proves the observed before state and later the remote outcome;
- an operator approval names exactly one responsibility, one target, one expected action, one ownership version, and an expiry;
- a future writer adapter still requires a separately reviewed authorization boundary.

The current evaluator always returns `canaryAuthorized: false` and `externalWritesAllowed: false`. A complete local packet can at most become ready for a later explicit authorization; it is not that authorization.

## Verification requirements

Before this persistence layer can be connected to runtime code, tests must cover:

- schema creation only through an explicit initializer and safe reopening without destructive migration;
- account and stable-ID uniqueness, foreign keys, exact timestamps, and strict enums;
- watermark insert-once behavior, update/delete/replace rejection, missing-watermark denial, and boundary equality denial;
- cursor compare-and-swap and regression denial, with no effect on watermark state;
- concurrent idempotency reservation yielding one intent and one runnable job;
- approval scope/version/evidence/expiry checks and single consumption;
- allowed job/attempt transitions, append-only history, crash/outcome-unknown behavior, and reconcile-before-retry;
- reconciliation/audit append behavior and tamper detection;
- no network, credential, legacy database, server, scheduler, webhook, or commerce-adapter import.

Production wiring additionally requires backup/restore rehearsal, durable-volume verification, one-process/multi-worker locking tests, an external audit anchor, current authoritative parity evidence, and a responsibility-specific canary plan. None is implied by local unit tests.

Production execution also requires one authoritative store location for the exact account scope and a trusted runtime clock. A copied or independently initialized database must never be treated as sharing idempotency state, and caller-supplied timestamps must not be used to extend an expired approval. Immediately before any future order-create request, the writer must re-read the authoritative target for the account-scoped eBay order identity; durable local reservation is necessary but does not replace that last remote duplicate check.

Schema version 1 is intentionally one-shot: one intent has one job and one dispatch attempt, and only order-import uncertainty has a modeled reconciliation resolution. It does not provide a production retry path for a confirmed-missing order or responsibility-specific recovery for listing, price, inventory, fulfillment, or feedback outcomes. A later reviewed schema version must add those recovery state machines without weakening the permanent business-identity idempotency key; until then `externalWritesSupported` remains false.

The first mounted consumer must be a projection-only, read-only facade and a separate inert `init`/`verify` administration command. It must not expose the writable store handle, tokens, approval values, raw rows, customer data, or any action command. Production volume placement, backup/restore, topology fencing, trusted time, and an external audit anchor remain separate deployment gates.
