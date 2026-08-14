import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  displayProposalValue,
  humanizeProposalCode,
  proposalChangedFields,
} from '../components/ListingProposalReview';
import type { ListingDraftResponse } from './useListingDraft';
import {
  buildApproveListingProposalInput,
  buildGenerateListingProposalInput,
  isApproveListingProposalInput,
  isGenerateListingProposalInput,
  isListingProposalBoundToDraft,
  isListingProposalResponse,
  listingProposalGenerationAttemptKey,
  shouldAutomaticallyGenerateListingProposal,
  type ListingProposalField,
  type ListingProposalResponse,
} from './useListingProposal';

const sourceDigest = `sha256:${'a'.repeat(64)}` as const;
const ebayDigest = `sha256:${'b'.repeat(64)}` as const;
const policyDigest = `sha256:${'c'.repeat(64)}` as const;
const proposalDigest = `sha256:${'d'.repeat(64)}` as const;
const eventDigest = `sha256:${'e'.repeat(64)}` as const;
const revisionDigest = `sha256:${'f'.repeat(64)}` as const;

const identity = {
  shopifyProductGid: 'gid://shopify/Product/1',
  shopifyVariantGid: 'gid://shopify/ProductVariant/2',
  rawSku: 'SKU-1',
  ebaySellerId: 'usedcameragear' as const,
  ebayMarketplaceId: 'EBAY_US' as const,
  managementModel: 'inventory_api' as const,
  ebayInventorySku: 'SKU-1',
  ebayOfferId: 'offer-1',
  ebayListingId: '123456789012',
};

const titleField = (): ListingProposalField => ({
  key: 'title',
  section: 'listing',
  label: 'Title',
  editable: true,
  currentShopify: 'Shopify title',
  currentEbay: 'eBay title',
  proposed: 'Clear agent title',
  source: 'agent_selection',
  decision: 'change',
  confidence: 'high',
  reasonCode: 'TITLE_WITHIN_LIMIT',
});

const lockedField = (key: 'price' | 'quantity'): ListingProposalField => ({
  key,
  section: 'listing',
  label: key === 'price' ? 'Price' : 'Quantity',
  editable: false,
  currentShopify: key === 'price' ? '100.00 USD' : '1',
  currentEbay: key === 'price' ? '100.00 USD' : '1',
  proposed: null,
  source: 'ebay',
  decision: 'observe_only',
  confidence: 'high',
  reasonCode: 'MARKETPLACE_CONNECT_OWNER',
});

const response = (): ListingProposalResponse => ({
  schemaVersion: 1,
  mode: 'local_ai_proposal_only',
  catalogId: 'shopify-variant:gid://shopify/ProductVariant/2',
  identity: { ...identity },
  base: {
    catalogObservedAtUtc: '2026-08-14T16:00:00.000Z',
    detailObservedAtUtc: '2026-08-14T16:00:01.000Z',
    sourceDigest,
    ebayDigest,
    policyDigest,
  },
  state: 'ready',
  eventDigest,
  proposal: {
    id: 'proposal-1',
    digest: proposalDigest,
    generatedAtUtc: '2026-08-14T16:01:00.000Z',
    generator: {
      agentVersion: 'listing-agent-v1',
      policyVersion: 'listing-policy-v1',
      model: 'gpt-5.1',
    },
    summary: { changedFieldCount: 1, blockedFieldCount: 0 },
    fields: [titleField(), lockedField('price'), lockedField('quantity')],
    warnings: [],
    review: { status: 'unreviewed', reviewedAtUtc: null },
  },
  capabilities: {
    generate: false,
    review: true,
    adjustLocal: true,
    approveLocal: true,
    apply: false,
    publish: false,
  },
  externalCommerceWritesPerformed: 0,
  aiRequestsPerformed: 0,
});

const draft = (): ListingDraftResponse => ({
  catalogId: response().catalogId,
  identity: { ...identity },
  base: {
    catalogObservedAtUtc: '2026-08-14T16:05:00.000Z',
    detailObservedAtUtc: '2026-08-14T16:05:01.000Z',
    sourceDigest,
    ebayDigest,
  },
  revision: {
    revisionId: 'revision-1',
    revisionNumber: 1,
    revisionDigest,
    state: 'draft',
    createdAtUtc: '2026-08-14T15:59:00.000Z',
  },
} as ListingDraftResponse);

describe('local AI listing proposal UI contract', () => {
  it('accepts the exact local-only proposal and rejects write-capable or inconsistent data', () => {
    const valid = response();
    expect(isListingProposalResponse(valid, valid.catalogId)).toBe(true);
    expect(isListingProposalResponse({
      ...valid,
      capabilities: { ...valid.capabilities, publish: true },
    }, valid.catalogId)).toBe(false);
    expect(isListingProposalResponse({
      ...valid,
      externalCommerceWritesPerformed: 1,
    }, valid.catalogId)).toBe(false);
    expect(isListingProposalResponse({
      ...valid,
      aiRequestsPerformed: 2,
    }, valid.catalogId)).toBe(false);
    expect(isListingProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal!,
        summary: { changedFieldCount: 0, blockedFieldCount: 0 },
      },
    }, valid.catalogId)).toBe(false);
    expect(isListingProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal!,
        fields: [
          { ...lockedField('price'), editable: true, decision: 'change' },
          lockedField('quantity'),
        ],
        summary: { changedFieldCount: 1, blockedFieldCount: 0 },
      },
    }, valid.catalogId)).toBe(false);
  });

  it('accepts fixed warning metadata and requires blocking counts to be coherent', () => {
    const blocked = response();
    blocked.state = 'blocked';
    blocked.proposal = {
      ...blocked.proposal!,
      summary: { changedFieldCount: 1, blockedFieldCount: 1 },
      warnings: [{
        code: 'CATEGORY_REVIEW_REQUIRED',
        severity: 'blocking',
        fieldKey: 'category',
        message: 'Choose the eBay category before approval.',
      }],
    };
    expect(isListingProposalResponse(blocked, blocked.catalogId)).toBe(true);
    blocked.proposal.summary.blockedFieldCount = 0;
    expect(isListingProposalResponse(blocked, blocked.catalogId)).toBe(false);
    blocked.proposal.summary.blockedFieldCount = 2;
    expect(isListingProposalResponse(blocked, blocked.catalogId)).toBe(false);
  });

  it('accepts one fixed warning code for multiple affected fields', () => {
    const blocked = response();
    blocked.state = 'blocked';
    blocked.proposal = {
      ...blocked.proposal!,
      summary: { changedFieldCount: 1, blockedFieldCount: 2 },
      warnings: [
        {
          code: 'missing_required',
          severity: 'blocking',
          fieldKey: 'category',
          message: 'Choose a verified value for Category.',
        },
        {
          code: 'missing_required',
          severity: 'blocking',
          fieldKey: 'condition',
          message: 'Choose a verified value for Condition.',
        },
      ],
    };
    expect(isListingProposalResponse(blocked, blocked.catalogId)).toBe(true);
    blocked.proposal = {
      ...blocked.proposal,
      warnings: [blocked.proposal.warnings[0], { ...blocked.proposal.warnings[0] }],
    };
    expect(isListingProposalResponse(blocked, blocked.catalogId)).toBe(false);
  });

  it('binds semantic identity and digests while allowing observation timestamps to advance', () => {
    const valid = response();
    const currentDraft = draft();
    expect(valid.base.catalogObservedAtUtc).not.toBe(currentDraft.base.catalogObservedAtUtc);
    expect(isListingProposalBoundToDraft(valid, currentDraft)).toBe(true);
    expect(isListingProposalBoundToDraft({
      ...valid,
      base: { ...valid.base, sourceDigest: proposalDigest },
    }, currentDraft)).toBe(false);
    expect(isListingProposalBoundToDraft({
      ...valid,
      identity: { ...valid.identity, ebayOfferId: 'other-offer' },
    }, currentDraft)).toBe(false);
  });

  it('builds exact generation and approval CAS payloads', () => {
    const valid = response();
    const currentDraft = draft();
    const generation = buildGenerateListingProposalInput(valid, currentDraft);
    expect(generation).toEqual({
      schemaVersion: 1,
      action: 'generate_local_proposal',
      catalogId: valid.catalogId,
      expectedRevisionDigest: revisionDigest,
      base: { sourceDigest, ebayDigest, policyDigest },
    });
    expect(isGenerateListingProposalInput(generation)).toBe(true);

    const approval = buildApproveListingProposalInput(valid);
    expect(approval).toEqual({
      schemaVersion: 1,
      action: 'approve_local_proposal',
      catalogId: valid.catalogId,
      proposalId: 'proposal-1',
      proposalDigest,
      expectedEventDigest: eventDigest,
      base: { sourceDigest, ebayDigest, policyDigest },
    });
    expect(isApproveListingProposalInput(approval)).toBe(true);
    expect(isApproveListingProposalInput({ ...approval, unexpected: true })).toBe(false);
    expect(buildApproveListingProposalInput({ ...valid, state: 'stale' })).toBeNull();
  });

  it('automates only fresh eligible not-prepared or stale states and keys each attempt once', () => {
    const currentDraft = draft();
    const notPrepared: ListingProposalResponse = {
      ...response(),
      state: 'not_prepared',
      eventDigest: null,
      proposal: null,
      capabilities: { ...response().capabilities, generate: true, review: false, approveLocal: false },
      aiRequestsPerformed: 0,
    };
    expect(shouldAutomaticallyGenerateListingProposal(notPrepared, currentDraft, true)).toBe(true);
    expect(shouldAutomaticallyGenerateListingProposal(notPrepared, currentDraft, false)).toBe(false);
    expect(shouldAutomaticallyGenerateListingProposal(response(), currentDraft, true)).toBe(false);

    const firstKey = listingProposalGenerationAttemptKey(notPrepared, currentDraft);
    expect(firstKey).toBe(listingProposalGenerationAttemptKey(notPrepared, currentDraft));
    const nextDraft = {
      ...currentDraft,
      revision: { ...currentDraft.revision!, revisionDigest: proposalDigest },
    };
    expect(listingProposalGenerationAttemptKey(notPrepared, nextDraft)).not.toBe(firstKey);
  });

  it('shows changed fields and full values as safe plain text', () => {
    const fields = response().proposal!.fields;
    expect(proposalChangedFields(fields).map((field) => field.key)).toEqual(['title']);
    expect(displayProposalValue('images', JSON.stringify([
      'https://cdn.shopify.com/one.jpg',
      'https://i.ebayimg.com/two.jpg',
    ]))).toBe('https://cdn.shopify.com/one.jpg\nhttps://i.ebayimg.com/two.jpg');
    expect(displayProposalValue('description', '<script>plain text only</script>'))
      .toBe('<script>plain text only</script>');
    expect(humanizeProposalCode('MARKETPLACE_CONNECT_OWNER'))
      .toBe('MARKETPLACE CONNECT OWNER');
  });

  it('keeps approval local, preserves the existing freshness gate, and never renders HTML', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../pages/ListingDetail.tsx', import.meta.url)),
      'utf8',
    );
    const component = readFileSync(
      fileURLToPath(new URL('../components/ListingProposalReview.tsx', import.meta.url)),
      'utf8',
    );
    const hook = readFileSync(
      fileURLToPath(new URL('./useListingProposal.ts', import.meta.url)),
      'utf8',
    );
    expect(page).toContain('automaticGenerationAttempts.current.has(attemptKey)');
    expect(page).toContain('isListingDraftBoundToWorkspace(refreshed.data, trustedWorkspace)');
    expect(page).toContain('buildApproveListingProposalInput(currentProposal)');
    expect(component).toContain('Approve draft');
    expect(component).toContain('Approved locally · eBay unchanged');
    expect(component).toContain('Price');
    expect(component).toContain('Quantity');
    expect(component).toContain('Marketplace Connect');
    expect(component).not.toContain('dangerouslySetInnerHTML');
    expect(component).not.toMatch(/>\s*(Apply|Publish)\s*</u);
    expect(hook).toContain("state === 'preparing' ? 30_000 : false");
    expect(hook).not.toContain("state === 'preparing' ? 2_000 : false");
  });
});
