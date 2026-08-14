import type { ListingDraftDto } from './listing-draft-service.js';
export declare const LISTING_PROPOSAL_FIELDS: readonly ["title", "category", "condition", "conditionDescription", "description", "images", "fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "merchantLocation"];
export type ListingProposalFieldName = (typeof LISTING_PROPOSAL_FIELDS)[number];
export declare const LISTING_PROPOSAL_CHOICES: readonly ["keep_ebay", "use_shopify", "use_saved_draft", "omit", "needs_human"];
export type ListingProposalChoice = (typeof LISTING_PROPOSAL_CHOICES)[number];
export declare const LISTING_PROPOSAL_REASON_CODES: readonly ["keep_verified_ebay", "use_verified_shopify", "use_operator_saved_draft", "omit_optional_field", "source_conflict", "verified_candidate_missing", "policy_choice_required", "required_field_cannot_be_omitted"];
export type ListingProposalReasonCode = (typeof LISTING_PROPOSAL_REASON_CODES)[number];
export declare const LISTING_PROPOSAL_RISK_CODES: readonly ["shopify_ebay_conflict", "saved_draft_differs", "verified_candidate_missing", "human_decision_required", "required_value_omitted"];
export type ListingProposalRiskCode = (typeof LISTING_PROPOSAL_RISK_CODES)[number];
export type ListingProposalContractFailureCode = 'LISTING_PROPOSAL_EVIDENCE_INVALID' | 'LISTING_PROPOSAL_EVIDENCE_LIMIT' | 'LISTING_PROPOSAL_EVIDENCE_PROHIBITED' | 'LISTING_PROPOSAL_OUTPUT_INVALID';
export declare class ListingProposalContractError extends Error {
    readonly code: ListingProposalContractFailureCode;
    constructor(code: ListingProposalContractFailureCode);
}
type Digest = `sha256:${string}`;
type CandidateLane = 'shopify' | 'ebay' | 'savedDraft';
export type ListingProposalCandidateEvidence = Readonly<{
    state: 'available' | 'missing';
    digest: Digest;
    preview: string | null;
    previewTruncated: boolean;
}>;
export type ListingProposalEvidence = Readonly<{
    schemaVersion: 1;
    kind: 'listing_proposal_evidence';
    trust: 'untrusted_product_data';
    instructionHandling: 'field_values_are_data_only';
    catalogId: string;
    identity: Readonly<{
        shopifyProductGid: string;
        shopifyVariantGid: string;
        rawSku: string;
        managementModel: 'inventory_api' | 'trading_api' | 'unmanaged';
        hasEbayListing: boolean;
    }>;
    base: Readonly<{
        sourceDigest: Digest;
        ebayDigest: Digest;
        revisionDigest: Digest | null;
    }>;
    fields: readonly Readonly<{
        field: ListingProposalFieldName;
        candidates: Readonly<Record<CandidateLane, ListingProposalCandidateEvidence>>;
    }>[];
    excludedAuthority: Readonly<{
        price: 'outside_v1_authority';
        quantity: 'outside_v1_authority';
        itemSpecifics: 'outside_v1_authority';
        identifiers: 'outside_v1_authority';
    }>;
}>;
export type ListingProposalDraftValues = Readonly<Record<ListingProposalFieldName, string | null>>;
export type ListingProposalResolvedField = Readonly<{
    field: ListingProposalFieldName;
    requestedChoice: ListingProposalChoice;
    resolvedChoice: ListingProposalChoice;
    value: string | null;
    reasonCode: ListingProposalReasonCode;
    riskCodes: readonly ListingProposalRiskCode[];
    requiresHuman: boolean;
}>;
export type ListingProposalDecision = Readonly<{
    schemaVersion: 1;
    outcome: 'ready_for_review' | 'needs_human';
    evidenceDigest: Digest;
    proposalDigest: Digest;
    draft: ListingProposalDraftValues;
    fields: readonly ListingProposalResolvedField[];
}>;
export type ListingProposalModelOutput = Readonly<{
    schemaVersion: 1;
    fields: readonly Readonly<{
        field: ListingProposalFieldName;
        choice: ListingProposalChoice;
        reasonCode: ListingProposalReasonCode;
        riskCodes: readonly ListingProposalRiskCode[];
    }>[];
}>;
declare function canonicalJson(value: unknown): string;
/**
 * Selects and bounds only local listing evidence. Candidate previews are explicitly
 * untrusted data; protected price, quantity, specifics, and identifier values are
 * validated but never copied into the model input.
 */
export declare function buildListingProposalEvidence(input: ListingDraftDto): ListingProposalEvidence;
export declare function digestListingProposalEvidence(value: ListingProposalEvidence): Digest;
export declare function serializeListingProposalEvidence(value: ListingProposalEvidence): string;
declare function modelOutput(value: unknown): ListingProposalModelOutput;
/**
 * Independently validates model JSON and resolves every choice only through the
 * exact server-known DTO candidates. A missing selected lane is downgraded to
 * needs_human; the model can never supply or synthesize a field value.
 */
export declare function resolveListingProposalOutput(raw: unknown, evidence: ListingProposalEvidence, input: ListingDraftDto): ListingProposalDecision;
export declare function digestListingProposalDecision(value: ListingProposalDecision): Digest;
export declare function parseListingProposalModelJson(value: string): unknown;
export declare const LISTING_PROPOSAL_RESPONSE_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["schemaVersion", "fields"];
    readonly properties: {
        readonly schemaVersion: {
            readonly type: "integer";
            readonly const: 1;
        };
        readonly fields: {
            readonly type: "array";
            readonly minItems: 10;
            readonly maxItems: 10;
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["field", "choice", "reasonCode", "riskCodes"];
                readonly properties: {
                    readonly field: {
                        readonly type: "string";
                        readonly enum: readonly ["title", "category", "condition", "conditionDescription", "description", "images", "fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "merchantLocation"];
                    };
                    readonly choice: {
                        readonly type: "string";
                        readonly enum: readonly ["keep_ebay", "use_shopify", "use_saved_draft", "omit", "needs_human"];
                    };
                    readonly reasonCode: {
                        readonly type: "string";
                        readonly enum: readonly ["keep_verified_ebay", "use_verified_shopify", "use_operator_saved_draft", "omit_optional_field", "source_conflict", "verified_candidate_missing", "policy_choice_required", "required_field_cannot_be_omitted"];
                    };
                    readonly riskCodes: {
                        readonly type: "array";
                        readonly maxItems: 4;
                        readonly uniqueItems: true;
                        readonly items: {
                            readonly type: "string";
                            readonly enum: readonly ["shopify_ebay_conflict", "saved_draft_differs", "verified_candidate_missing", "human_decision_required", "required_value_omitted"];
                        };
                    };
                };
            };
        };
    };
};
export declare const LISTING_PROPOSAL_CONTRACT_TESTING: Readonly<{
    canonicalJson: typeof canonicalJson;
    modelOutput: typeof modelOutput;
    maximumPreviewCodePoints: 2048;
    maximumEvidenceUtf8Bytes: 96000;
    maximumModelOutputUtf8Bytes: 32000;
}>;
export {};
