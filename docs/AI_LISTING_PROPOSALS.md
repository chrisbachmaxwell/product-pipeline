# AI Listing Proposals

This feature prepares one evidence-bound listing proposal and lets an authenticated operator approve it as local ProductPipeline content. It does not apply or publish anything to Shopify, eBay, Marketplace Connect, or Lightspeed.

## Operator workflow

1. Open an eligible item in **Listings**. ProductPipeline prepares one proposal automatically when the current Shopify/eBay observation and local revision have no current proposal.
2. Open **Review proposal** to see only the changed fields, their verified source, confidence, and any warning.
3. Select **Adjust** to use the local draft editor, or **Approve draft** when every proposed field is correct.
4. Approval appends a reviewed local revision. The screen continues to say that eBay is unchanged because approval is not Apply or Publish permission.

If Shopify, eBay, or the latest local revision changes, the proposal becomes stale. Reopen the item and review a newly prepared proposal; never force, replay, or approve the stale result.

If preparation is interrupted, the screen stops treating the job as active after five minutes. Select **Try again** to record that abandoned attempt as failed and start one new deduplicated proposal. The browser checks at most every 30 seconds during recovery and never retries the model automatically.

## Agent authority

The agent selects among values already present in verified Shopify evidence, verified eBay evidence, or the latest saved local draft. It may preserve a value, choose a verified alternative, omit an allowed optional value, or require a human decision. It cannot generate a new product fact, rewrite a description, follow instructions embedded in product content, or choose a value absent from the evidence.

The proposable fields are:

- title, category, condition, and condition description;
- description and images; and
- fulfillment, payment, and return policy IDs plus merchant location.

Price and quantity remain locked under Marketplace Connect. Item specifics and identifiers remain observation-only. The model receives bounded listing-field previews and digests only; it receives no Shopify/eBay credentials, access tokens, customer/order data, tools, or commerce-write capability.

## Persistence and review boundary

Canonical listing-control schema version 3 stores append-only proposal jobs, results, field decisions, review events, and their audit links. Proposal preparation is deduplicated against the exact subject, source/eBay observations, local revision, and agent policy metadata. A human approval atomically creates a `reviewed` local revision and approval event.

The API always reports `apply: false`, `publish: false`, and `externalCommerceWritesPerformed: 0`. Local approval does not transfer listing, mapping, price, inventory, order, or fulfillment ownership. Marketplace Connect remains the accepted production writer for price, inventory, and eBay-to-Shopify orders.

## Runtime configuration

The feature fails closed unless all of these are true:

- the dedicated listing-control database is canonical schema version 3 and passes admin verification;
- the existing listing-control single-writer topology and acknowledgement remain valid;
- `AI_PROPOSAL_OPENAI_API_KEY` contains the dedicated proposal key; and
- `LISTING_PROPOSAL_MODEL`, when set, is exactly `gpt-5.6-terra`.

The proposal path does not fall back to the legacy `OPENAI_API_KEY`. Never put either key in a repository file, command argument, log, screenshot, browser response, proposal evidence, or support message.

## Existing Production store upgrade

The last verified Production store is schema version 2. The version-3 source must not be treated as deployed or usable until an operator completes a stopped-writer maintenance window:

1. Verify the exact Railway service, one-replica/one-volume topology, `/data/product-pipeline/listing-control.sqlite`, private permissions, and current version-2 integrity using the previously deployed admin build.
2. Stop every process that can open the store writable. Create a consistent provider-supported volume backup, or copy only while every writer is stopped. Record the backup identity, source revision, UTC time, and digest without recording row content.
3. With the reviewed version-3 build, run:

   ```sh
   LISTING_CONTROL_DATABASE_PATH=/data/product-pipeline/listing-control.sqlite \
     node dist/listing-control-admin/index.js upgrade-v2-v3
   LISTING_CONTROL_DATABASE_PATH=/data/product-pipeline/listing-control.sqlite \
     node dist/listing-control-admin/index.js verify
   ```

4. Require redacted output showing `fromSchemaVersion: 2`, `schemaVersion: 3`, `mode: local_draft_only`, and `externalWritesPerformed: 0` for the upgrade, followed by a successful version-3 verification.
5. Configure the dedicated AI key, restart one application replica deliberately, then verify health, the signed-in listing workspace, automatic proposal preparation, local approval, stale-base refusal, and zero commerce writes separately.

Do not run `init` over the existing Production file, retry a failed migration blindly, restore over the live file, or re-enable writers before diagnosis. Runtime never creates, migrates, repairs, or replaces the store.

## Proof boundary

Source, tests, build, store migration, configuration, deployment, signed-in UI behavior, OpenAI inference, and Shopify/eBay state are separate evidence. At the time this runbook was added, the version-3 migration, dedicated AI configuration, deployment, and signed-in Production workflow had not been proven. Nothing in this document authorizes a commerce write or a Marketplace Connect change.
