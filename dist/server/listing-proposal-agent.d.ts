import type { ListingDraftDto } from './listing-draft-service.js';
import { LISTING_PROPOSAL_RESPONSE_SCHEMA, type ListingProposalDecision } from './listing-proposal-contract.js';
export declare const LISTING_PROPOSAL_DEFAULT_MODEL: "gpt-5.6-terra";
export declare const LISTING_PROPOSAL_ALLOWED_MODELS: readonly ["gpt-5.6-terra"];
export type ListingProposalModel = (typeof LISTING_PROPOSAL_ALLOWED_MODELS)[number];
export declare const LISTING_PROPOSAL_TIMEOUT_MS: 30000;
export declare const LISTING_PROPOSAL_MAX_OUTPUT_TOKENS: 1600;
export declare const LISTING_PROPOSAL_MAX_RETRIES: 0;
export type ListingProposalAgentFailureCode = 'AI_PROPOSAL_NOT_CONFIGURED' | 'AI_PROPOSAL_CONFIG_INVALID' | 'AI_PROPOSAL_INPUT_INVALID' | 'AI_PROPOSAL_PROVIDER_FAILED' | 'AI_PROPOSAL_REFUSED' | 'AI_PROPOSAL_INCOMPLETE' | 'AI_PROPOSAL_OUTPUT_INVALID';
export declare class ListingProposalAgentError extends Error {
    readonly code: ListingProposalAgentFailureCode;
    constructor(code: ListingProposalAgentFailureCode);
}
export type ListingProposalAgentReadiness = Readonly<{
    ready: true;
    code: 'ready';
    model: ListingProposalModel;
} | {
    ready: false;
    code: 'missing_api_key' | 'invalid_api_key' | 'model_not_allowed';
    model: ListingProposalModel | null;
}>;
export type ListingProposalUsage = Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}>;
export type ListingProposalTransportRequest = Readonly<{
    apiKey: string;
    timeoutMs: typeof LISTING_PROPOSAL_TIMEOUT_MS;
    maxRetries: typeof LISTING_PROPOSAL_MAX_RETRIES;
    body: Readonly<{
        model: ListingProposalModel;
        instructions: string;
        input: string;
        max_output_tokens: typeof LISTING_PROPOSAL_MAX_OUTPUT_TOKENS;
        store: false;
        truncation: 'disabled';
        text: Readonly<{
            format: Readonly<{
                type: 'json_schema';
                name: 'listing_proposal_v1';
                strict: true;
                schema: typeof LISTING_PROPOSAL_RESPONSE_SCHEMA;
            }>;
        }>;
    }>;
}>;
export type ListingProposalTransportResponse = Readonly<{
    status: 'completed' | 'failed' | 'incomplete' | 'refused';
    responseModel: string;
    outputText: string | null;
    usage: ListingProposalUsage | null;
}>;
export type ListingProposalTransport = (request: ListingProposalTransportRequest) => Promise<ListingProposalTransportResponse>;
export type ListingProposalAgentResult = Readonly<{
    decision: ListingProposalDecision;
    generator: Readonly<{
        provider: 'openai';
        requestedModel: ListingProposalModel;
        responseModel: string;
        store: false;
        usage: ListingProposalUsage | null;
        modelOutputDigest: `sha256:${string}`;
    }>;
}>;
export type ListingProposalAgentDependencies = Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    transport?: ListingProposalTransport;
    log?: (code: ListingProposalAgentFailureCode) => void;
}>;
export declare const LISTING_PROPOSAL_AGENT_METADATA: Readonly<{
    agentVersion: "listing-proposal-agent-v1";
    policyVersion: "verified-candidate-lanes-v1";
    promptVersion: "listing-proposal-prompt-v1";
    promptDigest: `sha256:${string}`;
    schemaVersion: "listing-proposal-response-schema-v1";
    schemaDigest: `sha256:${string}`;
    modelPolicyVersion: "listing-proposal-model-allowlist-v1";
    modelDigest: `sha256:${string}`;
}>;
declare function parseTransportResponse(value: unknown): ListingProposalTransportResponse;
/** Returns configuration readiness without exposing or falling back to any credential. */
export declare function getListingProposalAgentReadiness(env?: Readonly<Record<string, string | undefined>>): ListingProposalAgentReadiness;
export declare function createListingProposalAgent(dependencies?: ListingProposalAgentDependencies): Readonly<{
    readiness(): ListingProposalAgentReadiness;
    generate(input: ListingDraftDto): Promise<ListingProposalAgentResult>;
}>;
export type ListingProposalAgent = ReturnType<typeof createListingProposalAgent>;
export declare const LISTING_PROPOSAL_AGENT_TESTING: Readonly<{
    instructions: string;
    parseTransportResponse: typeof parseTransportResponse;
}>;
export {};
