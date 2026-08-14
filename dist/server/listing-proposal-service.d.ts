import { openListingControlStore, openListingControlStoreReadOnly, type Digest, type ListingFieldName, type ListingIdentity, type ListingProposal, type ListingProposalEvidenceItem, type ListingProposalFieldDecisionInput } from '../listing-control-store/index.js';
import { type ListingDraftDto, type ListingDraftField, type ListingDraftService } from './listing-draft-service.js';
import { type ListingProposalAgent, type ListingProposalAgentReadiness } from './listing-proposal-agent.js';
import { type ListingProposalDecision } from './listing-proposal-contract.js';
export declare const LISTING_PROPOSAL_STATES: readonly ["not_prepared", "preparing", "ready", "blocked", "no_changes", "approved_local", "stale", "failed"];
export type ListingProposalState = (typeof LISTING_PROPOSAL_STATES)[number];
export type ListingProposalField = Readonly<{
    key: string;
    section: 'listing' | 'content' | 'delivery';
    label: string;
    editable: boolean;
    currentShopify: string | null;
    currentEbay: string | null;
    proposed: string | null;
    source: 'shopify' | 'ebay' | 'saved_draft' | 'business_rule' | 'agent_selection' | 'omit';
    decision: 'keep' | 'add' | 'change' | 'remove' | 'observe_only';
    confidence: 'high' | 'review' | 'blocked';
    reasonCode: string;
}>;
export type ListingProposalWarning = Readonly<{
    code: string;
    severity: 'warning' | 'blocking';
    fieldKey: string | null;
    message: string;
}>;
export type ListingProposalDto = Readonly<{
    schemaVersion: 1;
    mode: 'local_ai_proposal_only';
    catalogId: string;
    identity: ListingIdentity;
    base: Readonly<{
        catalogObservedAtUtc: string;
        detailObservedAtUtc: string | null;
        sourceDigest: Digest;
        ebayDigest: Digest;
        policyDigest: Digest;
    }>;
    state: ListingProposalState;
    eventDigest: Digest | null;
    proposal: null | Readonly<{
        id: string;
        digest: Digest;
        generatedAtUtc: string;
        generator: Readonly<{
            agentVersion: string;
            policyVersion: string;
            model: string;
        }>;
        summary: Readonly<{
            changedFieldCount: number;
            blockedFieldCount: number;
        }>;
        fields: readonly ListingProposalField[];
        warnings: readonly ListingProposalWarning[];
        review: Readonly<{
            status: 'unreviewed' | 'approved_local';
            reviewedAtUtc: string | null;
        }>;
    }>;
    capabilities: Readonly<{
        generate: boolean;
        review: boolean;
        adjustLocal: boolean;
        approveLocal: boolean;
        apply: false;
        publish: false;
    }>;
    aiRequestsPerformed: 0 | 1;
    externalCommerceWritesPerformed: 0;
}>;
type ProposalBase = Readonly<{
    sourceDigest: Digest;
    ebayDigest: Digest;
    policyDigest: Digest;
}>;
export type GenerateListingProposalRequest = Readonly<{
    schemaVersion: 1;
    action: 'generate_local_proposal';
    catalogId: string;
    expectedRevisionDigest: Digest | null;
    base: ProposalBase;
}>;
export type ApproveListingProposalRequest = Readonly<{
    schemaVersion: 1;
    action: 'approve_local_proposal';
    catalogId: string;
    proposalId: string;
    proposalDigest: Digest;
    expectedEventDigest: Digest;
    base: ProposalBase;
}>;
export type ListingProposalRequest = GenerateListingProposalRequest | ApproveListingProposalRequest;
export type ListingProposalFailureCode = 'LISTING_PROPOSAL_INVALID' | 'LISTING_PROPOSAL_FORBIDDEN' | 'LISTING_PROPOSAL_NOT_FOUND' | 'LISTING_PROPOSAL_STALE' | 'LISTING_PROPOSAL_BLOCKED' | 'LISTING_PROPOSAL_RATE_LIMITED' | 'LISTING_PROPOSAL_UNAVAILABLE';
export interface ListingProposalService {
    get(catalogId: string, localReviewAuthorized?: boolean): Promise<ListingProposalDto>;
    generate(request: GenerateListingProposalRequest, actor: string): Promise<ListingProposalDto>;
    approve(request: ApproveListingProposalRequest, actor: string): Promise<ListingProposalDto>;
}
export declare class ListingProposalServiceError extends Error {
    readonly code: ListingProposalFailureCode;
    constructor(code: ListingProposalFailureCode);
}
/** Strict browser contract. Identity, actors, timestamps, and model settings are server-owned. */
export declare function parseListingProposalRequest(value: unknown): ListingProposalRequest;
export declare const LISTING_PROPOSAL_POLICY_VERSION: "verified-candidate-lanes-v1";
export declare const LISTING_PROPOSAL_POLICY_DIGEST: `sha256:${string}`;
type UiFieldKey = ListingProposalField['key'];
declare function baseObservationDigests(dto: ListingDraftDto): Readonly<{
    source: Digest;
    ebay: Digest;
}>;
declare function semanticDigests(dto: ListingDraftDto): Readonly<{
    source: Digest;
    ebay: Digest;
}>;
declare function semanticEvidence(dto: ListingDraftDto): readonly ListingProposalEvidenceItem[];
declare function proposalIsStale(dto: ListingDraftDto, proposal: ListingProposal): boolean;
declare function proposalIsAbandoned(proposal: ListingProposal | null, nowEpochMs: number): boolean;
declare function projectDto(dto: ListingDraftDto, proposal: ListingProposal | null, localReviewAuthorized: boolean, writerReady: boolean, agentReadiness: ListingProposalAgentReadiness, aiRequestsPerformed: 0 | 1, nowEpochMs: number): ListingProposalDto;
declare function storeDecisions(dto: ListingDraftDto, decision: ListingProposalDecision): readonly ListingProposalFieldDecisionInput[];
declare function proposalOutcome(dto: ListingDraftDto, decision: ListingProposalDecision): 'ready' | 'no_change' | 'needs_human';
export type ListingProposalServiceDependencies = Readonly<{
    draftService?: ListingDraftService;
    agent?: Pick<ListingProposalAgent, 'readiness' | 'generate'>;
    provider?: 'openai' | 'fixture';
    databasePath?: () => string | undefined;
    openReadOnly?: typeof openListingControlStoreReadOnly;
    openWritable?: typeof openListingControlStore;
    now?: () => Date;
    uuid?: () => string;
    writerInstanceReady?: () => boolean;
}>;
export declare function createListingProposalService(dependencies?: ListingProposalServiceDependencies): ListingProposalService;
export declare const LISTING_PROPOSAL_SERVICE_TESTING: Readonly<{
    FIELD_BINDINGS: readonly Readonly<{
        key: UiFieldKey;
        field: ListingFieldName;
        section: ListingProposalField["section"];
        label: string;
        editable: boolean;
        read(dto: ListingDraftDto): ListingDraftField;
    }>[];
    baseObservationDigests: typeof baseObservationDigests;
    semanticDigests: typeof semanticDigests;
    semanticEvidence: typeof semanticEvidence;
    storeDecisions: typeof storeDecisions;
    proposalOutcome: typeof proposalOutcome;
    proposalIsStale: typeof proposalIsStale;
    proposalIsAbandoned: typeof proposalIsAbandoned;
    projectDto: typeof projectDto;
}>;
export {};
