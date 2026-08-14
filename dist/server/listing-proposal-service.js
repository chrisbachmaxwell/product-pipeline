import { randomUUID } from 'node:crypto';
import { LISTING_AI_PROPOSABLE_FIELDS, LISTING_FIELD_NAMES, ListingControlStoreError, deriveListingBaseDigests, deriveListingProposalEvidenceDigest, deriveListingSemanticDigests, openListingControlStore, openListingControlStoreReadOnly, sha256Digest, } from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE, LISTING_DRAFT_SINGLE_WRITER_ACK, } from '../listing-control-config.js';
import { ListingDraftServiceError, createListingDraftService, } from './listing-draft-service.js';
import { LISTING_PROPOSAL_AGENT_METADATA, ListingProposalAgentError, createListingProposalAgent, } from './listing-proposal-agent.js';
import { buildListingProposalEvidence, digestListingProposalDecision, digestListingProposalEvidence, } from './listing-proposal-contract.js';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u;
const LISTING_PROPOSAL_LEASE_MS = 5 * 60_000;
const PROHIBITED = [
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/iu,
    /\bshpat_[A-Za-z0-9_-]{16,}\b/iu,
    /(?:v\^|v%5e)1\.1(?:#|%23)[^\s"']{8,}(?:t\^|t%5e)/iu,
    /\b(?:access|refresh|identity)[_-]?token\s*[:=]/iu,
    /\b(?:api[_-]?key|client[_-]?secret|authorization|set-cookie)\s*[:=]/iu,
];
export const LISTING_PROPOSAL_STATES = [
    'not_prepared',
    'preparing',
    'ready',
    'blocked',
    'no_changes',
    'approved_local',
    'stale',
    'failed',
];
export class ListingProposalServiceError extends Error {
    code;
    constructor(code) {
        super('Listing proposal operation failed');
        this.code = code;
        this.name = 'ListingProposalServiceError';
    }
}
const invalid = () => {
    throw new ListingProposalServiceError('LISTING_PROPOSAL_INVALID');
};
function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function exactDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value))
        return invalid();
    return value;
}
function base(value) {
    if (!exactKeys(value, ['sourceDigest', 'ebayDigest', 'policyDigest']))
        return invalid();
    return Object.freeze({
        sourceDigest: exactDigest(value.sourceDigest),
        ebayDigest: exactDigest(value.ebayDigest),
        policyDigest: exactDigest(value.policyDigest),
    });
}
/** Strict browser contract. Identity, actors, timestamps, and model settings are server-owned. */
export function parseListingProposalRequest(value) {
    let serialized = '';
    try {
        serialized = JSON.stringify(value);
    }
    catch {
        return invalid();
    }
    if (serialized.length > 65_536 || PROHIBITED.some((pattern) => pattern.test(serialized))) {
        return invalid();
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return invalid();
    const input = value;
    if (input.schemaVersion !== 1 || typeof input.catalogId !== 'string'
        || !CATALOG_ID.test(input.catalogId))
        return invalid();
    if (input.action === 'generate_local_proposal') {
        if (!exactKeys(input, [
            'schemaVersion', 'action', 'catalogId', 'expectedRevisionDigest', 'base',
        ]) || !(input.expectedRevisionDigest === null
            || (typeof input.expectedRevisionDigest === 'string'
                && DIGEST.test(input.expectedRevisionDigest))))
            return invalid();
        return Object.freeze({
            schemaVersion: 1,
            action: 'generate_local_proposal',
            catalogId: input.catalogId,
            expectedRevisionDigest: input.expectedRevisionDigest,
            base: base(input.base),
        });
    }
    if (input.action === 'approve_local_proposal') {
        if (!exactKeys(input, [
            'schemaVersion', 'action', 'catalogId', 'proposalId', 'proposalDigest',
            'expectedEventDigest', 'base',
        ]) || typeof input.proposalId !== 'string' || !IDENTIFIER.test(input.proposalId)) {
            return invalid();
        }
        return Object.freeze({
            schemaVersion: 1,
            action: 'approve_local_proposal',
            catalogId: input.catalogId,
            proposalId: input.proposalId,
            proposalDigest: exactDigest(input.proposalDigest),
            expectedEventDigest: exactDigest(input.expectedEventDigest),
            base: base(input.base),
        });
    }
    return invalid();
}
export const LISTING_PROPOSAL_POLICY_VERSION = LISTING_PROPOSAL_AGENT_METADATA.policyVersion;
export const LISTING_PROPOSAL_POLICY_DIGEST = sha256Digest({
    schemaVersion: 1,
    type: 'local_listing_proposal_policy',
    version: LISTING_PROPOSAL_POLICY_VERSION,
    proposableFields: LISTING_AI_PROPOSABLE_FIELDS,
    lockedFields: ['price', 'quantity', 'item_specifics', 'identifiers'],
    approvalMeaning: 'local_content_review_only',
    providerApplyAllowed: false,
    providerPublishAllowed: false,
});
const SUBJECT_WINDOW_MS = 24 * 60 * 60_000;
const SCOPE_HOUR_WINDOW_MS = 60 * 60_000;
const SCOPE_DAY_WINDOW_MS = 24 * 60 * 60_000;
const SUBJECT_DAY_LIMIT = 2;
const SCOPE_HOUR_LIMIT = 20;
const SCOPE_DAY_LIMIT = 100;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u;
const FIELD_BINDINGS = Object.freeze([
    { key: 'title', field: 'title', section: 'listing', label: 'Title', editable: true,
        read: (dto) => dto.sections.listing.title },
    { key: 'category', field: 'category', section: 'listing', label: 'Category', editable: true,
        read: (dto) => dto.sections.listing.category },
    { key: 'condition', field: 'condition', section: 'listing', label: 'Condition', editable: true,
        read: (dto) => dto.sections.listing.condition },
    { key: 'conditionDescription', field: 'condition_description', section: 'listing',
        label: 'Condition details', editable: true,
        read: (dto) => dto.sections.listing.conditionDescription },
    { key: 'price', field: 'price', section: 'listing', label: 'Price', editable: false,
        read: (dto) => dto.sections.listing.price },
    { key: 'quantity', field: 'quantity', section: 'listing', label: 'Quantity', editable: false,
        read: (dto) => dto.sections.listing.quantity },
    { key: 'description', field: 'description', section: 'content', label: 'Description',
        editable: true, read: (dto) => dto.sections.content.description },
    { key: 'images', field: 'images', section: 'content', label: 'Images', editable: true,
        read: (dto) => dto.sections.content.images },
    { key: 'itemSpecifics', field: 'item_specifics', section: 'content',
        label: 'Item specifics', editable: false,
        read: (dto) => dto.sections.content.itemSpecifics },
    { key: 'identifiers', field: 'identifiers', section: 'content', label: 'Identifiers',
        editable: false, read: (dto) => dto.sections.content.identifiers },
    { key: 'fulfillmentPolicyId', field: 'fulfillment_policy', section: 'delivery',
        label: 'Shipping policy', editable: true,
        read: (dto) => dto.sections.delivery.fulfillmentPolicyId },
    { key: 'paymentPolicyId', field: 'payment_policy', section: 'delivery',
        label: 'Payment policy', editable: true,
        read: (dto) => dto.sections.delivery.paymentPolicyId },
    { key: 'returnPolicyId', field: 'return_policy', section: 'delivery',
        label: 'Return policy', editable: true,
        read: (dto) => dto.sections.delivery.returnPolicyId },
    { key: 'merchantLocation', field: 'merchant_location', section: 'delivery',
        label: 'Item location', editable: true,
        read: (dto) => dto.sections.delivery.merchantLocation },
]);
const BINDING_BY_STORE_FIELD = new Map(FIELD_BINDINGS.map((binding) => [binding.field, binding]));
const STORE_FIELD_BY_MODEL_FIELD = Object.freeze({
    title: 'title',
    category: 'category',
    condition: 'condition',
    conditionDescription: 'condition_description',
    description: 'description',
    images: 'images',
    fulfillmentPolicyId: 'fulfillment_policy',
    paymentPolicyId: 'payment_policy',
    returnPolicyId: 'return_policy',
    merchantLocation: 'merchant_location',
});
function exactActor(value) {
    if (!ACTOR.test(value))
        invalid();
    return value;
}
function sameIdentity(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
const fieldDigest = Object.freeze({
    source(value) {
        return sha256Digest({ state: value === null ? 'missing' : 'value', value });
    },
    observed(value) {
        return sha256Digest({ state: value === null ? 'unavailable' : 'value', value });
    },
    empty() { return sha256Digest({ state: 'not_set', value: null }); },
    proposed(value) {
        return sha256Digest({ state: value === null ? 'omitted' : 'value', value });
    },
});
function inheritedValue(dto, leaf) {
    return dto.identity.ebayListingId === null ? leaf.shopify : (leaf.ebay ?? leaf.shopify);
}
function inheritedProvenance(dto, leaf) {
    const inherited = inheritedValue(dto, leaf);
    if (inherited === null)
        return 'omit';
    if (dto.identity.ebayListingId !== null && leaf.ebay !== null)
        return 'observed';
    return 'source';
}
function revisionField(dto, binding, selection) {
    const leaf = binding.read(dto);
    const proposedValue = selection?.value ?? inheritedValue(dto, leaf);
    const proposedSource = selection?.source ?? inheritedProvenance(dto, leaf);
    const overrideValue = proposedSource === 'override' ? proposedValue : null;
    return Object.freeze({
        field: binding.field,
        sourceValue: leaf.shopify,
        sourceDigest: fieldDigest.source(leaf.shopify),
        defaultValue: null,
        defaultDigest: fieldDigest.empty(),
        overrideValue,
        overrideDigest: overrideValue === null
            ? fieldDigest.empty() : sha256Digest({ state: 'value', value: overrideValue }),
        proposedValue,
        proposedDigest: fieldDigest.proposed(proposedValue),
        proposedSource,
        observedValue: leaf.ebay,
        observedDigest: fieldDigest.observed(leaf.ebay),
    });
}
function baseRevisionFields(dto) {
    return Object.freeze(LISTING_FIELD_NAMES.map((field) => {
        const binding = BINDING_BY_STORE_FIELD.get(field);
        if (!binding)
            return invalid();
        return revisionField(dto, binding);
    }));
}
function baseObservationDigests(dto) {
    return deriveListingBaseDigests({
        scope: LISTING_DRAFT_SCOPE,
        identity: dto.identity,
        baseSourceObservedAtUtc: dto.base.catalogObservedAtUtc,
        baseEbayObservedAtUtc: dto.base.detailObservedAtUtc ?? dto.base.catalogObservedAtUtc,
        fields: baseRevisionFields(dto),
    });
}
function semanticDigests(dto) {
    return deriveListingSemanticDigests({
        scope: LISTING_DRAFT_SCOPE,
        identity: dto.identity,
        fields: baseRevisionFields(dto),
    });
}
function semanticDtoIsValid(dto) {
    const derived = semanticDigests(dto);
    return derived.source === dto.base.sourceDigest && derived.ebay === dto.base.ebayDigest;
}
function semanticEvidence(dto) {
    const items = [
        Object.freeze({ source: 'shopify', field: 'listing',
            valueDigest: dto.base.sourceDigest, summary: null }),
        Object.freeze({ source: 'ebay', field: 'listing',
            valueDigest: dto.base.ebayDigest, summary: null }),
        Object.freeze({ source: 'policy', field: 'listing',
            valueDigest: LISTING_PROPOSAL_POLICY_DIGEST, summary: null }),
    ];
    for (const storeField of LISTING_AI_PROPOSABLE_FIELDS) {
        const binding = BINDING_BY_STORE_FIELD.get(storeField);
        if (!binding)
            return invalid();
        const leaf = binding.read(dto);
        items.push(Object.freeze({ source: 'shopify', field: storeField,
            valueDigest: fieldDigest.proposed(leaf.shopify), summary: null }));
        items.push(Object.freeze({ source: 'ebay', field: storeField,
            valueDigest: fieldDigest.proposed(leaf.ebay), summary: null }));
        if (leaf.draft !== null) {
            items.push(Object.freeze({ source: 'draft', field: storeField,
                valueDigest: fieldDigest.proposed(leaf.draft), summary: null }));
        }
    }
    return Object.freeze(items);
}
function jobSemanticDigest(proposal, source) {
    return proposal.job.evidence.find((item) => item.source === source && item.field === 'listing')?.valueDigest ?? null;
}
function proposalIsStale(dto, proposal) {
    const approvedRevision = proposal.latestEvent.eventType === 'approved'
        ? proposal.latestEvent.reviewedRevisionDigest : null;
    const expectedRevision = approvedRevision ?? proposal.job.baseRevisionDigest;
    return proposal.job.catalogId !== dto.catalogId
        || !sameIdentity(proposal.job.identity, dto.identity)
        || expectedRevision !== (dto.revision?.revisionDigest ?? null)
        || proposal.job.baseSourceDigest !== dto.base.sourceDigest
        || proposal.job.baseEbayObservationDigest !== dto.base.ebayDigest
        || jobSemanticDigest(proposal, 'shopify') !== dto.base.sourceDigest
        || jobSemanticDigest(proposal, 'ebay') !== dto.base.ebayDigest
        || proposal.job.policyVersion !== LISTING_PROPOSAL_AGENT_METADATA.policyVersion
        || proposal.job.policyDigest !== LISTING_PROPOSAL_POLICY_DIGEST
        || proposal.job.promptVersion !== LISTING_PROPOSAL_AGENT_METADATA.promptVersion
        || proposal.job.promptDigest !== LISTING_PROPOSAL_AGENT_METADATA.promptDigest
        || proposal.job.schemaVersion !== LISTING_PROPOSAL_AGENT_METADATA.schemaVersion
        || proposal.job.schemaDigest !== LISTING_PROPOSAL_AGENT_METADATA.schemaDigest
        || proposal.job.agentVersion !== LISTING_PROPOSAL_AGENT_METADATA.agentVersion
        || proposal.job.modelDigest !== LISTING_PROPOSAL_AGENT_METADATA.modelDigest;
}
function proposalIsAbandoned(proposal, nowEpochMs) {
    if (proposal === null || !['queued', 'generating'].includes(proposal.latestEvent.eventType)) {
        return false;
    }
    const occurredEpochMs = Date.parse(proposal.latestEvent.occurredAtUtc);
    return Number.isFinite(occurredEpochMs)
        && nowEpochMs - occurredEpochMs >= LISTING_PROPOSAL_LEASE_MS;
}
function stateFor(proposal, stale, abandoned) {
    if (proposal === null)
        return 'not_prepared';
    if (stale)
        return 'stale';
    if (abandoned)
        return 'failed';
    if (proposal.latestEvent.eventType === 'queued'
        || proposal.latestEvent.eventType === 'generating')
        return 'preparing';
    if (proposal.latestEvent.eventType === 'approved')
        return 'approved_local';
    if (proposal.latestEvent.eventType === 'stale')
        return 'stale';
    if (proposal.latestEvent.eventType === 'failed')
        return 'failed';
    if (proposal.latestEvent.eventType === 'no_change')
        return 'no_changes';
    if (proposal.latestEvent.eventType === 'needs_human')
        return 'blocked';
    if (proposal.latestEvent.eventType === 'ready')
        return 'ready';
    return 'failed';
}
function warningMessage(code, label) {
    if (code === 'missing_required')
        return `Choose a verified value for ${label}.`;
    if (code === 'source_conflict')
        return `Shopify and eBay differ for ${label}.`;
    if (code === 'policy_exception')
        return `${label} needs a decision.`;
    if (code === 'low_confidence')
        return `Review ${label}.`;
    return `${label} needs verified evidence.`;
}
function projectedField(dto, binding, proposal) {
    const leaf = binding.read(dto);
    if (!binding.editable) {
        return Object.freeze({
            key: binding.key,
            section: binding.section,
            label: binding.label,
            editable: false,
            currentShopify: leaf.shopify,
            currentEbay: leaf.ebay,
            proposed: inheritedValue(dto, leaf),
            source: dto.identity.ebayListingId !== null && leaf.ebay !== null ? 'ebay' : 'shopify',
            decision: 'observe_only',
            confidence: 'high',
            reasonCode: 'marketplace_connect_owned',
        });
    }
    const decision = proposal.result?.fields.find(({ field }) => field === binding.field);
    if (!decision)
        return invalid();
    const current = inheritedValue(dto, leaf);
    const uiDecision = decision.proposedValue === current
        ? 'keep'
        : current === null && decision.proposedValue !== null ? 'add'
            : current !== null && decision.proposedValue === null ? 'remove' : 'change';
    const source = decision.proposedSource === 'source'
        ? 'shopify' : decision.proposedSource === 'observed' ? 'ebay'
        : decision.proposedSource === 'override' ? 'saved_draft' : 'omit';
    return Object.freeze({
        key: binding.key,
        section: binding.section,
        label: binding.label,
        editable: true,
        currentShopify: leaf.shopify,
        currentEbay: leaf.ebay,
        proposed: decision.proposedValue,
        source,
        decision: uiDecision,
        confidence: decision.confidence === 'high'
            ? 'high' : decision.confidence === 'medium' ? 'review' : 'blocked',
        reasonCode: decision.reasonCode,
    });
}
function proposalWarnings(proposal) {
    if (!proposal.result)
        return Object.freeze([]);
    return Object.freeze(proposal.result.fields.flatMap((decision) => {
        if (decision.warningCode === null && decision.confidence !== 'low')
            return [];
        const binding = BINDING_BY_STORE_FIELD.get(decision.field);
        if (!binding)
            return [];
        const code = decision.warningCode ?? 'low_confidence';
        return [Object.freeze({
                code,
                severity: decision.confidence === 'low' ? 'blocking' : 'warning',
                fieldKey: binding.key,
                message: warningMessage(code, binding.label),
            })];
    }));
}
function projectDto(dto, proposal, localReviewAuthorized, writerReady, agentReadiness, aiRequestsPerformed, nowEpochMs) {
    const stale = proposal !== null && proposalIsStale(dto, proposal);
    const state = stateFor(proposal, stale, proposalIsAbandoned(proposal, nowEpochMs));
    const resultVisible = proposal?.result !== null
        && proposal?.result !== undefined && proposal.result.outcome !== 'failed';
    const fields = resultVisible
        ? Object.freeze(FIELD_BINDINGS.map((binding) => projectedField(dto, binding, proposal)))
        : Object.freeze([]);
    const warnings = resultVisible ? proposalWarnings(proposal) : Object.freeze([]);
    const blockedFieldCount = fields.filter(({ confidence }) => confidence === 'blocked').length;
    const changedFieldCount = fields.filter(({ decision }) => ['add', 'change', 'remove'].includes(decision)).length;
    const canWriteLocal = localReviewAuthorized && writerReady;
    const proposalBody = resultVisible ? Object.freeze({
        id: proposal.job.jobId,
        digest: proposal.result.resultDigest,
        generatedAtUtc: proposal.result.completedAtUtc,
        generator: Object.freeze({
            agentVersion: proposal.job.agentVersion,
            policyVersion: proposal.job.policyVersion,
            model: proposal.job.requestedModel,
        }),
        summary: Object.freeze({ changedFieldCount, blockedFieldCount }),
        fields,
        warnings,
        review: Object.freeze({
            status: state === 'approved_local' ? 'approved_local' : 'unreviewed',
            reviewedAtUtc: state === 'approved_local' ? proposal.latestEvent.occurredAtUtc : null,
        }),
    }) : null;
    return Object.freeze({
        schemaVersion: 1,
        mode: 'local_ai_proposal_only',
        catalogId: dto.catalogId,
        identity: dto.identity,
        base: Object.freeze({
            catalogObservedAtUtc: dto.base.catalogObservedAtUtc,
            detailObservedAtUtc: dto.base.detailObservedAtUtc,
            sourceDigest: dto.base.sourceDigest,
            ebayDigest: dto.base.ebayDigest,
            policyDigest: LISTING_PROPOSAL_POLICY_DIGEST,
        }),
        state,
        eventDigest: proposal?.latestEvent.eventDigest ?? null,
        proposal: proposalBody,
        capabilities: Object.freeze({
            generate: canWriteLocal && agentReadiness.ready
                && ['not_prepared', 'stale', 'failed'].includes(state),
            review: canWriteLocal && state === 'ready' && blockedFieldCount === 0,
            adjustLocal: dto.capabilities.saveDraft,
            approveLocal: canWriteLocal && state === 'ready' && blockedFieldCount === 0,
            apply: false,
            publish: false,
        }),
        aiRequestsPerformed,
        externalCommerceWritesPerformed: 0,
    });
}
function decisionSource(choice) {
    if (choice === 'keep_ebay')
        return 'observed';
    if (choice === 'use_shopify')
        return 'source';
    if (choice === 'use_saved_draft')
        return 'override';
    return 'omit';
}
function reasonCode(reason) {
    if (reason === 'keep_verified_ebay')
        return 'ebay_authoritative';
    if (reason === 'use_verified_shopify')
        return 'shopify_authoritative';
    if (reason === 'use_operator_saved_draft')
        return 'operator_override';
    if (reason === 'omit_optional_field')
        return 'policy_selected';
    if (reason === 'source_conflict')
        return 'conflicting_sources';
    if (reason === 'verified_candidate_missing')
        return 'missing_source';
    return 'unsupported_change';
}
function warningCode(risks) {
    if (risks.includes('required_value_omitted')
        || risks.includes('verified_candidate_missing'))
        return 'missing_required';
    if (risks.includes('shopify_ebay_conflict')
        || risks.includes('saved_draft_differs'))
        return 'source_conflict';
    if (risks.includes('human_decision_required'))
        return 'policy_exception';
    return null;
}
function decisionEvidence(dto, field, source) {
    const binding = BINDING_BY_STORE_FIELD.get(field);
    if (!binding)
        return invalid();
    const leaf = binding.read(dto);
    const references = [];
    const add = (candidateSource, value) => {
        references.push(Object.freeze({ source: candidateSource, field,
            digest: fieldDigest.proposed(value) }));
    };
    if (source === 'source')
        add('shopify', leaf.shopify);
    else if (source === 'observed')
        add('ebay', leaf.ebay);
    else if (source === 'override')
        add('draft', leaf.draft);
    else
        references.push(Object.freeze({ source: 'policy', field: 'listing',
            digest: LISTING_PROPOSAL_POLICY_DIGEST }));
    return Object.freeze(references);
}
function storeDecisions(dto, decision) {
    return Object.freeze(decision.fields.map((field) => {
        const storeField = STORE_FIELD_BY_MODEL_FIELD[field.field];
        const source = decisionSource(field.resolvedChoice);
        return Object.freeze({
            field: storeField,
            proposedValue: field.value,
            proposedDigest: fieldDigest.proposed(field.value),
            proposedSource: source,
            confidence: field.requiresHuman ? 'low'
                : field.riskCodes.length > 0 ? 'medium' : 'high',
            reasonCode: reasonCode(field.reasonCode),
            warningCode: warningCode(field.riskCodes),
            evidence: decisionEvidence(dto, storeField, source),
        });
    }));
}
function proposalOutcome(dto, decision) {
    if (decision.outcome === 'needs_human')
        return 'needs_human';
    const changed = decision.fields.some((field) => {
        const binding = BINDING_BY_STORE_FIELD.get(STORE_FIELD_BY_MODEL_FIELD[field.field]);
        return binding ? field.value !== inheritedValue(dto, binding.read(dto)) : true;
    });
    return changed ? 'ready' : 'no_change';
}
function requestMatchesDto(request, dto) {
    return request.catalogId === dto.catalogId
        && request.base.sourceDigest === dto.base.sourceDigest
        && request.base.ebayDigest === dto.base.ebayDigest
        && request.base.policyDigest === LISTING_PROPOSAL_POLICY_DIGEST;
}
function agentFailureCode(error) {
    if (['AI_PROPOSAL_INPUT_INVALID', 'AI_PROPOSAL_OUTPUT_INVALID'].includes(error.code)) {
        return 'invalid_output';
    }
    if (['AI_PROPOSAL_NOT_CONFIGURED', 'AI_PROPOSAL_CONFIG_INVALID',
        'AI_PROPOSAL_PROVIDER_FAILED', 'AI_PROPOSAL_REFUSED',
        'AI_PROPOSAL_INCOMPLETE'].includes(error.code))
        return 'model_unavailable';
    return 'internal_error';
}
function translate(error) {
    if (error instanceof ListingProposalServiceError)
        throw error;
    if (error instanceof ListingDraftServiceError) {
        if (error.code === 'LISTING_DRAFT_NOT_FOUND') {
            throw new ListingProposalServiceError('LISTING_PROPOSAL_NOT_FOUND');
        }
        if (error.code === 'LISTING_DRAFT_STALE') {
            throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
        }
        if (error.code === 'LISTING_DRAFT_FORBIDDEN') {
            throw new ListingProposalServiceError('LISTING_PROPOSAL_FORBIDDEN');
        }
        return unavailable();
    }
    if (error instanceof ListingControlStoreError) {
        if (error.code === 'NOT_FOUND') {
            throw new ListingProposalServiceError('LISTING_PROPOSAL_NOT_FOUND');
        }
        if (['CONFLICT', 'STALE_BASE'].includes(error.code)) {
            throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
        }
    }
    return unavailable();
}
const unavailable = () => {
    throw new ListingProposalServiceError('LISTING_PROPOSAL_UNAVAILABLE');
};
export function createListingProposalService(dependencies = {}) {
    const draftService = dependencies.draftService ?? createListingDraftService();
    const agent = dependencies.agent ?? createListingProposalAgent();
    const provider = dependencies.provider ?? 'openai';
    const databasePath = dependencies.databasePath
        ?? (() => process.env.LISTING_CONTROL_DATABASE_PATH);
    const openReadOnly = dependencies.openReadOnly ?? openListingControlStoreReadOnly;
    const openWritable = dependencies.openWritable ?? openListingControlStore;
    const now = dependencies.now ?? (() => new Date());
    const uuid = dependencies.uuid ?? randomUUID;
    const writerInstanceReady = dependencies.writerInstanceReady ?? (() => process.env.LISTING_CONTROL_SINGLE_WRITER_ACK === LISTING_DRAFT_SINGLE_WRITER_ACK);
    const path = () => {
        const value = databasePath();
        if (typeof value !== 'string' || value.length === 0)
            return unavailable();
        return value;
    };
    const withStore = (writable, run) => {
        const store = writable
            ? openWritable({ databasePath: path(), expectedScope: LISTING_DRAFT_SCOPE })
            : openReadOnly({ databasePath: path(), expectedScope: LISTING_DRAFT_SCOPE });
        try {
            return run(store);
        }
        finally {
            store.close();
        }
    };
    const readLatest = (dto) => withStore(false, (store) => store.getLatestProposalForCatalog(dto.identity.shopifyVariantGid, dto.catalogId));
    const readiness = () => agent.readiness();
    const recoverAbandoned = (dto, proposal, occurredAtUtc) => {
        if (!proposalIsAbandoned(proposal, Date.parse(occurredAtUtc))
            || (proposal !== null && proposalIsStale(dto, proposal)))
            return proposal;
        try {
            return withStore(true, (store) => {
                const current = store.getLatestProposalForCatalog(dto.identity.shopifyVariantGid, dto.catalogId);
                if (!proposalIsAbandoned(current, Date.parse(occurredAtUtc))
                    || (current !== null && proposalIsStale(dto, current)))
                    return current;
                if (current === null)
                    return null;
                const actor = `ai-agent:${LISTING_PROPOSAL_AGENT_METADATA.agentVersion}`;
                const generating = current.latestEvent.eventType === 'queued'
                    ? store.markProposalGenerating({
                        jobId: current.job.jobId,
                        expectedPreviousEventDigest: current.latestEvent.eventDigest,
                        actor,
                        occurredAtUtc,
                        eventId: `listing-proposal-event:${uuid()}:recovered-generating`,
                    }) : current.latestEvent;
                const completed = store.completeProposal({
                    jobId: current.job.jobId,
                    resultId: `listing-proposal-result:${uuid()}:abandoned`,
                    outcome: 'failed',
                    expectedPreviousEventDigest: generating.eventDigest,
                    parsedOutputDigest: null,
                    fieldDecisions: [],
                    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
                    failureCode: 'internal_error',
                    actor,
                    occurredAtUtc,
                    eventId: `listing-proposal-event:${uuid()}:abandoned`,
                });
                return Object.freeze({
                    job: current.job,
                    result: completed.result,
                    latestEvent: completed.event,
                });
            });
        }
        catch (error) {
            if (error instanceof ListingControlStoreError
                && ['CONFLICT', 'STALE_BASE'].includes(error.code))
                return readLatest(dto);
            throw error;
        }
    };
    async function get(catalogId, localReviewAuthorized = false) {
        if (!CATALOG_ID.test(catalogId))
            invalid();
        try {
            const dto = await draftService.get(catalogId, localReviewAuthorized);
            if (!semanticDtoIsValid(dto))
                unavailable();
            return projectDto(dto, readLatest(dto), localReviewAuthorized, writerInstanceReady(), readiness(), 0, now().getTime());
        }
        catch (error) {
            return translate(error);
        }
    }
    async function generate(request, actorInput) {
        const actor = exactActor(actorInput);
        try {
            if (!writerInstanceReady())
                unavailable();
            const ready = readiness();
            const requestedModel = ready.ready ? ready.model : unavailable();
            const dto = await draftService.get(request.catalogId, true);
            if (!semanticDtoIsValid(dto) || !dto.capabilities.saveDraft
                || !requestMatchesDto(request, dto)
                || request.expectedRevisionDigest !== (dto.revision?.revisionDigest ?? null)) {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
            }
            const modelEvidence = buildListingProposalEvidence(dto);
            const evidence = semanticEvidence(dto);
            const evidenceDigest = deriveListingProposalEvidenceDigest(evidence);
            const createdAtUtc = now().toISOString();
            const latest = recoverAbandoned(dto, readLatest(dto), createdAtUtc);
            const retryOf = latest?.latestEvent.eventType === 'failed'
                && !proposalIsStale(dto, latest) ? latest.latestEvent.eventDigest : null;
            const triggerDigest = sha256Digest({
                schemaVersion: 1,
                type: 'listing_proposal_trigger',
                identity: dto.identity,
                baseRevisionDigest: dto.revision?.revisionDigest ?? null,
                sourceDigest: dto.base.sourceDigest,
                ebayDigest: dto.base.ebayDigest,
                evidenceDigest,
                modelEvidenceDigest: digestListingProposalEvidence(modelEvidence),
                policyDigest: LISTING_PROPOSAL_POLICY_DIGEST,
                promptDigest: LISTING_PROPOSAL_AGENT_METADATA.promptDigest,
                schemaDigest: LISTING_PROPOSAL_AGENT_METADATA.schemaDigest,
                modelDigest: LISTING_PROPOSAL_AGENT_METADATA.modelDigest,
                retryOf,
            });
            const nonce = uuid();
            const prepared = withStore(true, (store) => {
                const latestStored = store.getLatestProposalForCatalog(dto.identity.shopifyVariantGid, dto.catalogId);
                const alreadySameTrigger = latestStored?.job.triggerDigest === triggerDigest;
                if (!alreadySameTrigger && (store.countProposalJobsForSubjectSince(dto.identity.shopifyVariantGid, new Date(Date.parse(createdAtUtc) - SUBJECT_WINDOW_MS).toISOString()) >= SUBJECT_DAY_LIMIT
                    || store.countProposalJobsForScopeSince(new Date(Date.parse(createdAtUtc) - SCOPE_HOUR_WINDOW_MS).toISOString()) >= SCOPE_HOUR_LIMIT
                    || store.countProposalJobsForScopeSince(new Date(Date.parse(createdAtUtc) - SCOPE_DAY_WINDOW_MS).toISOString()) >= SCOPE_DAY_LIMIT)) {
                    throw new ListingProposalServiceError('LISTING_PROPOSAL_RATE_LIMITED');
                }
                const created = store.createProposalJob({
                    jobId: `listing-proposal:${nonce}`,
                    identity: dto.identity,
                    baseRevisionDigest: dto.revision?.revisionDigest ?? null,
                    baseSourceDigest: dto.base.sourceDigest,
                    baseEbayObservationDigest: dto.base.ebayDigest,
                    triggerDigest,
                    catalogId: dto.catalogId,
                    evidence,
                    evidenceDigest,
                    policyVersion: LISTING_PROPOSAL_AGENT_METADATA.policyVersion,
                    policyDigest: LISTING_PROPOSAL_POLICY_DIGEST,
                    promptVersion: LISTING_PROPOSAL_AGENT_METADATA.promptVersion,
                    promptDigest: LISTING_PROPOSAL_AGENT_METADATA.promptDigest,
                    schemaVersion: LISTING_PROPOSAL_AGENT_METADATA.schemaVersion,
                    schemaDigest: LISTING_PROPOSAL_AGENT_METADATA.schemaDigest,
                    agentVersion: LISTING_PROPOSAL_AGENT_METADATA.agentVersion,
                    provider,
                    requestedModel,
                    modelDigest: LISTING_PROPOSAL_AGENT_METADATA.modelDigest,
                    requestedBy: actor,
                    createdAtUtc,
                    eventId: `listing-proposal-event:${nonce}:queued`,
                });
                const current = store.getProposalJob(created.job.jobId);
                if (!current)
                    return unavailable();
                if (created.deduplicated || current.latestEvent.eventType !== 'queued') {
                    return { proposal: current, shouldGenerate: false };
                }
                const generating = store.markProposalGenerating({
                    jobId: created.job.jobId,
                    expectedPreviousEventDigest: current.latestEvent.eventDigest,
                    actor: `ai-agent:${LISTING_PROPOSAL_AGENT_METADATA.agentVersion}`,
                    occurredAtUtc: createdAtUtc,
                    eventId: `listing-proposal-event:${nonce}:generating`,
                });
                return {
                    proposal: Object.freeze({ ...current, latestEvent: generating }),
                    shouldGenerate: true,
                };
            });
            if (!prepared.shouldGenerate) {
                return projectDto(dto, prepared.proposal, true, true, ready, 0, Date.parse(createdAtUtc));
            }
            let agentResult;
            try {
                agentResult = await agent.generate(dto);
            }
            catch (error) {
                const failure = error instanceof ListingProposalAgentError
                    ? agentFailureCode(error) : 'internal_error';
                const completedAtUtc = now().toISOString();
                const failed = withStore(true, (store) => store.completeProposal({
                    jobId: prepared.proposal.job.jobId,
                    resultId: `listing-proposal-result:${uuid()}`,
                    outcome: 'failed',
                    expectedPreviousEventDigest: prepared.proposal.latestEvent.eventDigest,
                    parsedOutputDigest: null,
                    fieldDecisions: [],
                    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
                    failureCode: failure,
                    actor: `ai-agent:${LISTING_PROPOSAL_AGENT_METADATA.agentVersion}`,
                    occurredAtUtc: completedAtUtc,
                    eventId: `listing-proposal-event:${uuid()}:failed`,
                }));
                const failedProposal = Object.freeze({
                    job: prepared.proposal.job,
                    result: failed.result,
                    latestEvent: failed.event,
                });
                return projectDto(dto, failedProposal, true, true, ready, error instanceof ListingProposalAgentError
                    && error.code === 'AI_PROPOSAL_INPUT_INVALID' ? 0 : 1, Date.parse(completedAtUtc));
            }
            const after = await draftService.get(request.catalogId, true);
            const drifted = !semanticDtoIsValid(after) || !requestMatchesDto(request, after)
                || request.expectedRevisionDigest !== (after.revision?.revisionDigest ?? null)
                || !sameIdentity(dto.identity, after.identity);
            const completedAtUtc = now().toISOString();
            if (drifted) {
                const failed = withStore(true, (store) => store.completeProposal({
                    jobId: prepared.proposal.job.jobId,
                    resultId: `listing-proposal-result:${uuid()}`,
                    outcome: 'failed',
                    expectedPreviousEventDigest: prepared.proposal.latestEvent.eventDigest,
                    parsedOutputDigest: null,
                    fieldDecisions: [],
                    usage: agentResult.generator.usage ?? {
                        inputTokens: null, outputTokens: null, totalTokens: null,
                    },
                    failureCode: 'stale_base',
                    actor: `ai-agent:${LISTING_PROPOSAL_AGENT_METADATA.agentVersion}`,
                    occurredAtUtc: completedAtUtc,
                    eventId: `listing-proposal-event:${uuid()}:stale`,
                }));
                const failedProposal = Object.freeze({
                    job: prepared.proposal.job,
                    result: failed.result,
                    latestEvent: failed.event,
                });
                return projectDto(after, failedProposal, true, true, ready, 1, Date.parse(completedAtUtc));
            }
            const outcome = proposalOutcome(after, agentResult.decision);
            const completed = withStore(true, (store) => store.completeProposal({
                jobId: prepared.proposal.job.jobId,
                resultId: `listing-proposal-result:${uuid()}`,
                outcome,
                expectedPreviousEventDigest: prepared.proposal.latestEvent.eventDigest,
                parsedOutputDigest: digestListingProposalDecision(agentResult.decision),
                fieldDecisions: storeDecisions(after, agentResult.decision),
                usage: agentResult.generator.usage ?? {
                    inputTokens: null, outputTokens: null, totalTokens: null,
                },
                failureCode: null,
                actor: `ai-agent:${LISTING_PROPOSAL_AGENT_METADATA.agentVersion}`,
                occurredAtUtc: completedAtUtc,
                eventId: `listing-proposal-event:${uuid()}:complete`,
            }));
            return projectDto(after, Object.freeze({
                job: prepared.proposal.job,
                result: completed.result,
                latestEvent: completed.event,
            }), true, true, ready, 1, Date.parse(completedAtUtc));
        }
        catch (error) {
            return translate(error);
        }
    }
    async function approve(request, actorInput) {
        const actor = exactActor(actorInput);
        try {
            if (!writerInstanceReady())
                unavailable();
            const dto = await draftService.get(request.catalogId, true);
            if (!semanticDtoIsValid(dto) || !dto.capabilities.saveDraft
                || !requestMatchesDto(request, dto)) {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
            }
            const proposal = withStore(false, (store) => store.getProposalJob(request.proposalId));
            if (!proposal || !proposal.result || proposal.job.catalogId !== request.catalogId) {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_NOT_FOUND');
            }
            if (proposalIsStale(dto, proposal)
                || proposal.result.resultDigest !== request.proposalDigest
                || proposal.latestEvent.eventDigest !== request.expectedEventDigest
                || proposal.latestEvent.eventType !== 'ready'
                || proposal.result.outcome !== 'ready'
                || proposal.result.fields.some(({ confidence }) => confidence === 'low')) {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
            }
            const selections = new Map(proposal.result.fields.map((field) => [field.field,
                Object.freeze({ value: field.proposedValue, source: field.proposedSource })]));
            const fields = Object.freeze(LISTING_FIELD_NAMES.map((field) => {
                const binding = BINDING_BY_STORE_FIELD.get(field);
                if (!binding)
                    return invalid();
                return revisionField(dto, binding, selections.get(field));
            }));
            const bases = deriveListingBaseDigests({
                scope: LISTING_DRAFT_SCOPE,
                identity: dto.identity,
                baseSourceObservedAtUtc: dto.base.catalogObservedAtUtc,
                baseEbayObservedAtUtc: dto.base.detailObservedAtUtc ?? dto.base.catalogObservedAtUtc,
                fields,
            });
            const createdAtUtc = now().toISOString();
            const nonce = uuid();
            const approved = withStore(true, (store) => {
                const previous = store.getLatestRevision(dto.identity.shopifyVariantGid);
                if ((previous?.revisionDigest ?? null) !== proposal.job.baseRevisionDigest
                    || (dto.revision?.revisionDigest ?? null) !== proposal.job.baseRevisionDigest) {
                    throw new ListingProposalServiceError('LISTING_PROPOSAL_STALE');
                }
                return store.approveProposal({
                    jobId: proposal.job.jobId,
                    resultDigest: proposal.result.resultDigest,
                    expectedPreviousEventDigest: proposal.latestEvent.eventDigest,
                    revision: {
                        revisionId: `listing-proposal-review:${nonce}`,
                        identity: dto.identity,
                        baseSourceDigest: bases.source,
                        baseSourceObservedAtUtc: dto.base.catalogObservedAtUtc,
                        baseEbayObservationDigest: bases.ebay,
                        baseEbayObservedAtUtc: dto.base.detailObservedAtUtc
                            ?? dto.base.catalogObservedAtUtc,
                        fields,
                        actor,
                        state: 'reviewed',
                        createdAtUtc,
                        expectedPreviousRevisionDigest: previous?.revisionDigest ?? null,
                        expectedLatestBaseSourceDigest: previous?.baseSourceDigest ?? null,
                        expectedLatestBaseEbayObservationDigest: previous?.baseEbayObservationDigest ?? null,
                        auditEventId: `listing-proposal-review-audit:${nonce}`,
                    },
                    actor,
                    occurredAtUtc: createdAtUtc,
                    eventId: `listing-proposal-event:${nonce}:approved`,
                });
            });
            const refreshed = Object.freeze({
                job: proposal.job,
                result: proposal.result,
                latestEvent: approved.event,
            });
            const approvedDto = Object.freeze({
                ...dto,
                revision: Object.freeze({
                    revisionId: approved.revision.revisionId,
                    revisionNumber: approved.revision.revisionNumber,
                    revisionDigest: approved.revision.revisionDigest,
                    state: 'reviewed',
                    createdAtUtc: approved.revision.createdAtUtc,
                }),
            });
            return projectDto(approvedDto, refreshed, true, true, readiness(), 0, Date.parse(createdAtUtc));
        }
        catch (error) {
            return translate(error);
        }
    }
    return Object.freeze({ get, generate, approve });
}
export const LISTING_PROPOSAL_SERVICE_TESTING = Object.freeze({
    FIELD_BINDINGS,
    baseObservationDigests,
    semanticDigests,
    semanticEvidence,
    storeDecisions,
    proposalOutcome,
    proposalIsStale,
    proposalIsAbandoned,
    projectDto,
});
