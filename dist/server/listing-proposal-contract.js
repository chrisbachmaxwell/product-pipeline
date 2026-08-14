import { createHash } from 'node:crypto';
export const LISTING_PROPOSAL_FIELDS = [
    'title',
    'category',
    'condition',
    'conditionDescription',
    'description',
    'images',
    'fulfillmentPolicyId',
    'paymentPolicyId',
    'returnPolicyId',
    'merchantLocation',
];
export const LISTING_PROPOSAL_CHOICES = [
    'keep_ebay',
    'use_shopify',
    'use_saved_draft',
    'omit',
    'needs_human',
];
export const LISTING_PROPOSAL_REASON_CODES = [
    'keep_verified_ebay',
    'use_verified_shopify',
    'use_operator_saved_draft',
    'omit_optional_field',
    'source_conflict',
    'verified_candidate_missing',
    'policy_choice_required',
    'required_field_cannot_be_omitted',
];
export const LISTING_PROPOSAL_RISK_CODES = [
    'shopify_ebay_conflict',
    'saved_draft_differs',
    'verified_candidate_missing',
    'human_decision_required',
    'required_value_omitted',
];
export class ListingProposalContractError extends Error {
    code;
    constructor(code) {
        super('Listing proposal contract failed');
        this.code = code;
        this.name = 'ListingProposalContractError';
    }
}
const MAX_PREVIEW_CODE_POINTS = 2_048;
const MAX_CANDIDATE_CODE_POINTS = 500_000;
const MAX_CANDIDATE_UTF8_BYTES = 2_000_000;
const MAX_EVIDENCE_UTF8_BYTES = 96_000;
const MAX_MODEL_OUTPUT_UTF8_BYTES = 32_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const GID_PRODUCT = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const SKU = /^[\x20-\x7e]{1,128}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const RAW_HTML = /<\/?[A-Za-z][^>]*>/u;
const PROHIBITED = [
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
    /\bshpat_[A-Za-z0-9_-]{16,}\b/i,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/i,
    /(?:v\^|v%5e)1\.1(?:#|%23)[^\s"']{8,}(?:t\^|t%5e)/i,
    /\b(?:access|refresh|identity)[_-]?token\s*[:=]/i,
    /\b(?:api[_-]?key|client[_-]?secret|authorization|set-cookie)\s*[:=]/i,
];
const FIELD_SET = new Set(LISTING_PROPOSAL_FIELDS);
const CHOICE_SET = new Set(LISTING_PROPOSAL_CHOICES);
const REASON_SET = new Set(LISTING_PROPOSAL_REASON_CODES);
const RISK_SET = new Set(LISTING_PROPOSAL_RISK_CODES);
const REASONS_BY_CHOICE = Object.freeze({
    keep_ebay: Object.freeze(['keep_verified_ebay']),
    use_shopify: Object.freeze(['use_verified_shopify']),
    use_saved_draft: Object.freeze(['use_operator_saved_draft']),
    omit: Object.freeze(['omit_optional_field']),
    needs_human: Object.freeze(['source_conflict', 'verified_candidate_missing',
        'policy_choice_required']),
});
const invalidEvidence = () => {
    throw new ListingProposalContractError('LISTING_PROPOSAL_EVIDENCE_INVALID');
};
const evidenceLimit = () => {
    throw new ListingProposalContractError('LISTING_PROPOSAL_EVIDENCE_LIMIT');
};
const prohibitedEvidence = () => {
    throw new ListingProposalContractError('LISTING_PROPOSAL_EVIDENCE_PROHIBITED');
};
const invalidOutput = () => {
    throw new ListingProposalContractError('LISTING_PROPOSAL_OUTPUT_INVALID');
};
function exactKeys(value, expected) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const actual = Object.keys(value).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}
function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value === null || typeof value !== 'object')
        return invalidEvidence();
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
function digest(value) {
    return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
function utf8Length(value) {
    return Buffer.byteLength(value, 'utf8');
}
function safeCandidate(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string')
        return invalidEvidence();
    const points = Array.from(value);
    if (points.length > MAX_CANDIDATE_CODE_POINTS
        || utf8Length(value) > MAX_CANDIDATE_UTF8_BYTES)
        return evidenceLimit();
    if (CONTROL.test(value) || RAW_HTML.test(value) || PROHIBITED.some((pattern) => pattern.test(value))) {
        return prohibitedEvidence();
    }
    return value;
}
function candidateEvidence(value) {
    const points = value === null ? [] : Array.from(value);
    const previewTruncated = points.length > MAX_PREVIEW_CODE_POINTS;
    return Object.freeze({
        state: value === null ? 'missing' : 'available',
        digest: digest({ state: value === null ? 'missing' : 'available', value }),
        preview: value === null ? null : points.slice(0, MAX_PREVIEW_CODE_POINTS).join(''),
        previewTruncated,
    });
}
function validateField(value, editable) {
    if (!exactKeys(value, ['shopify', 'ebay', 'draft', 'editable'])
        || value.editable !== editable)
        return invalidEvidence();
    return Object.freeze({
        shopify: safeCandidate(value.shopify),
        ebay: safeCandidate(value.ebay),
        draft: safeCandidate(value.draft),
        editable,
    });
}
function draftFields(value) {
    if (!exactKeys(value.sections, ['listing', 'content', 'delivery']))
        return invalidEvidence();
    const sections = value.sections;
    if (!exactKeys(sections.listing, [
        'title', 'category', 'condition', 'conditionDescription', 'price', 'quantity',
    ]) || !exactKeys(sections.content, [
        'description', 'images', 'itemSpecifics', 'identifiers',
    ]) || !exactKeys(sections.delivery, [
        'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId', 'merchantLocation',
    ]))
        return invalidEvidence();
    validateField(sections.listing.price, false);
    validateField(sections.listing.quantity, false);
    validateField(sections.content.itemSpecifics, false);
    validateField(sections.content.identifiers, false);
    return Object.freeze({
        title: validateField(sections.listing.title, true),
        category: validateField(sections.listing.category, true),
        condition: validateField(sections.listing.condition, true),
        conditionDescription: validateField(sections.listing.conditionDescription, true),
        description: validateField(sections.content.description, true),
        images: validateField(sections.content.images, true),
        fulfillmentPolicyId: validateField(sections.delivery.fulfillmentPolicyId, true),
        paymentPolicyId: validateField(sections.delivery.paymentPolicyId, true),
        returnPolicyId: validateField(sections.delivery.returnPolicyId, true),
        merchantLocation: validateField(sections.delivery.merchantLocation, true),
    });
}
function parseDraftDto(input) {
    if (!exactKeys(input, [
        'schemaVersion', 'mode', 'catalogId', 'identity', 'base', 'revision', 'sections',
        'capabilities', 'externalWritesPerformed',
    ]) || input.schemaVersion !== 1 || input.mode !== 'local_draft_only'
        || typeof input.catalogId !== 'string' || !CATALOG_ID.test(input.catalogId)
        || input.externalWritesPerformed !== 0
        || !exactKeys(input.identity, [
            'shopifyProductGid', 'shopifyVariantGid', 'rawSku', 'ebaySellerId',
            'ebayMarketplaceId', 'managementModel', 'ebayInventorySku', 'ebayOfferId',
            'ebayListingId',
        ]))
        return invalidEvidence();
    if (PROHIBITED.some((pattern) => pattern.test(String(input.catalogId)))) {
        return prohibitedEvidence();
    }
    const identity = input.identity;
    if (typeof identity.shopifyProductGid !== 'string'
        || !GID_PRODUCT.test(identity.shopifyProductGid)
        || typeof identity.shopifyVariantGid !== 'string'
        || !GID_VARIANT.test(identity.shopifyVariantGid)
        || typeof identity.rawSku !== 'string' || !SKU.test(identity.rawSku)
        || identity.rawSku.trim() !== identity.rawSku
        || !['inventory_api', 'trading_api', 'unmanaged'].includes(String(identity.managementModel))
        || typeof identity.ebaySellerId !== 'string' || identity.ebaySellerId.length === 0
        || identity.ebaySellerId.length > 128 || CONTROL.test(identity.ebaySellerId)
        || identity.ebayMarketplaceId !== 'EBAY_US'
        || ![identity.ebayInventorySku, identity.ebayOfferId, identity.ebayListingId].every((entry) => entry === null || (typeof entry === 'string' && entry.length > 0
            && entry.length <= 128 && !CONTROL.test(entry))))
        return invalidEvidence();
    if (PROHIBITED.some((pattern) => pattern.test(canonicalJson(identity)))) {
        return prohibitedEvidence();
    }
    if (!exactKeys(input.base, [
        'catalogObservedAtUtc', 'detailObservedAtUtc', 'sourceDigest', 'ebayDigest',
    ]) || typeof input.base.catalogObservedAtUtc !== 'string'
        || input.base.catalogObservedAtUtc.length > 64
        || !Number.isFinite(Date.parse(input.base.catalogObservedAtUtc))
        || (input.base.detailObservedAtUtc !== null
            && (typeof input.base.detailObservedAtUtc !== 'string'
                || input.base.detailObservedAtUtc.length > 64
                || !Number.isFinite(Date.parse(input.base.detailObservedAtUtc))))
        || typeof input.base.sourceDigest !== 'string' || !DIGEST.test(input.base.sourceDigest)
        || typeof input.base.ebayDigest !== 'string' || !DIGEST.test(input.base.ebayDigest)) {
        return invalidEvidence();
    }
    if (input.revision !== null && (!exactKeys(input.revision, [
        'revisionId', 'revisionNumber', 'revisionDigest', 'state', 'createdAtUtc',
    ]) || typeof input.revision.revisionId !== 'string' || input.revision.revisionId.length === 0
        || input.revision.revisionId.length > 256
        || typeof input.revision.revisionNumber !== 'number'
        || !Number.isSafeInteger(input.revision.revisionNumber) || input.revision.revisionNumber < 1
        || typeof input.revision.revisionDigest !== 'string'
        || !DIGEST.test(input.revision.revisionDigest)
        || !['draft', 'reviewed'].includes(String(input.revision.state))
        || typeof input.revision.createdAtUtc !== 'string'
        || input.revision.createdAtUtc.length > 64
        || !Number.isFinite(Date.parse(input.revision.createdAtUtc))))
        return invalidEvidence();
    if (input.revision !== null && PROHIBITED.some((pattern) => pattern.test(canonicalJson(input.revision))))
        return prohibitedEvidence();
    if (!exactKeys(input.capabilities, ['saveDraft', 'previewChanges', 'apply', 'publish'])
        || typeof input.capabilities.saveDraft !== 'boolean'
        || input.capabilities.previewChanges !== true || input.capabilities.apply !== false
        || input.capabilities.publish !== false)
        return invalidEvidence();
    const fields = draftFields(input);
    return Object.freeze({ dto: input, fields });
}
/**
 * Selects and bounds only local listing evidence. Candidate previews are explicitly
 * untrusted data; protected price, quantity, specifics, and identifier values are
 * validated but never copied into the model input.
 */
export function buildListingProposalEvidence(input) {
    const parsed = parseDraftDto(input);
    const identity = parsed.dto.identity;
    const evidence = Object.freeze({
        schemaVersion: 1,
        kind: 'listing_proposal_evidence',
        trust: 'untrusted_product_data',
        instructionHandling: 'field_values_are_data_only',
        catalogId: parsed.dto.catalogId,
        identity: Object.freeze({
            shopifyProductGid: identity.shopifyProductGid,
            shopifyVariantGid: identity.shopifyVariantGid,
            rawSku: identity.rawSku,
            managementModel: identity.managementModel,
            hasEbayListing: identity.ebayListingId !== null,
        }),
        base: Object.freeze({
            sourceDigest: parsed.dto.base.sourceDigest,
            ebayDigest: parsed.dto.base.ebayDigest,
            revisionDigest: parsed.dto.revision?.revisionDigest ?? null,
        }),
        fields: Object.freeze(LISTING_PROPOSAL_FIELDS.map((field) => {
            const source = parsed.fields[field];
            return Object.freeze({
                field,
                candidates: Object.freeze({
                    shopify: candidateEvidence(source.shopify),
                    ebay: candidateEvidence(source.ebay),
                    savedDraft: candidateEvidence(source.draft),
                }),
            });
        })),
        excludedAuthority: Object.freeze({
            price: 'outside_v1_authority',
            quantity: 'outside_v1_authority',
            itemSpecifics: 'outside_v1_authority',
            identifiers: 'outside_v1_authority',
        }),
    });
    if (utf8Length(canonicalJson(evidence)) > MAX_EVIDENCE_UTF8_BYTES)
        return evidenceLimit();
    return evidence;
}
export function digestListingProposalEvidence(value) {
    return digest(value);
}
export function serializeListingProposalEvidence(value) {
    const serialized = canonicalJson(value);
    if (utf8Length(serialized) > MAX_EVIDENCE_UTF8_BYTES)
        return evidenceLimit();
    return serialized;
}
function candidateValues(input) {
    const parsed = parseDraftDto(input);
    return Object.freeze(Object.fromEntries(LISTING_PROPOSAL_FIELDS.map((field) => {
        const value = parsed.fields[field];
        return [field, Object.freeze({
                shopify: value.shopify,
                ebay: value.ebay,
                savedDraft: value.draft,
            })];
    })));
}
function modelOutput(value) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    }
    catch {
        return invalidOutput();
    }
    if (utf8Length(serialized) > MAX_MODEL_OUTPUT_UTF8_BYTES
        || !exactKeys(value, ['schemaVersion', 'fields']) || value.schemaVersion !== 1
        || !Array.isArray(value.fields) || value.fields.length !== LISTING_PROPOSAL_FIELDS.length) {
        return invalidOutput();
    }
    const seen = new Set();
    const fields = value.fields.map((entry) => {
        if (!exactKeys(entry, ['field', 'choice', 'reasonCode', 'riskCodes'])
            || typeof entry.field !== 'string' || !FIELD_SET.has(entry.field) || seen.has(entry.field)
            || typeof entry.choice !== 'string' || !CHOICE_SET.has(entry.choice)
            || typeof entry.reasonCode !== 'string' || !REASON_SET.has(entry.reasonCode)
            || !Array.isArray(entry.riskCodes) || entry.riskCodes.length > 4)
            return invalidOutput();
        seen.add(entry.field);
        const choice = entry.choice;
        const reasonCode = entry.reasonCode;
        if (!REASONS_BY_CHOICE[choice].includes(reasonCode))
            return invalidOutput();
        const risks = entry.riskCodes.map((risk) => {
            if (typeof risk !== 'string' || !RISK_SET.has(risk))
                return invalidOutput();
            return risk;
        });
        if (new Set(risks).size !== risks.length)
            return invalidOutput();
        return Object.freeze({
            field: entry.field,
            choice,
            reasonCode,
            riskCodes: Object.freeze(risks),
        });
    });
    if (seen.size !== LISTING_PROPOSAL_FIELDS.length)
        return invalidOutput();
    return Object.freeze({ schemaVersion: 1, fields: Object.freeze(fields) });
}
function laneForChoice(choice) {
    if (choice === 'keep_ebay')
        return 'ebay';
    if (choice === 'use_shopify')
        return 'shopify';
    if (choice === 'use_saved_draft')
        return 'savedDraft';
    return null;
}
function orderedRisks(values) {
    const unique = new Set(values);
    return Object.freeze(LISTING_PROPOSAL_RISK_CODES.filter((risk) => unique.has(risk)));
}
function decisionRisks(candidates, requestedChoice, supplied, missingCandidate, requiredOmission) {
    const risks = new Set(supplied);
    if (candidates.shopify !== null && candidates.ebay !== null
        && candidates.shopify !== candidates.ebay)
        risks.add('shopify_ebay_conflict');
    if (candidates.savedDraft !== null
        && [candidates.shopify, candidates.ebay].some((candidate) => candidate !== null && candidate !== candidates.savedDraft))
        risks.add('saved_draft_differs');
    if (missingCandidate)
        risks.add('verified_candidate_missing');
    if (requiredOmission)
        risks.add('required_value_omitted');
    if (missingCandidate || requiredOmission || requestedChoice === 'needs_human') {
        risks.add('human_decision_required');
    }
    return orderedRisks(risks);
}
function omissionAllowed(field, managementModel) {
    return field === 'conditionDescription'
        || (field === 'merchantLocation' && managementModel === 'trading_api');
}
/**
 * Independently validates model JSON and resolves every choice only through the
 * exact server-known DTO candidates. A missing selected lane is downgraded to
 * needs_human; the model can never supply or synthesize a field value.
 */
export function resolveListingProposalOutput(raw, evidence, input) {
    const rebuiltEvidence = buildListingProposalEvidence(input);
    if (canonicalJson(rebuiltEvidence) !== canonicalJson(evidence))
        return invalidOutput();
    const output = modelOutput(raw);
    const values = candidateValues(input);
    const byField = new Map(output.fields.map((field) => [field.field, field]));
    const resolved = LISTING_PROPOSAL_FIELDS.map((field) => {
        const requested = byField.get(field);
        if (!requested)
            return invalidOutput();
        const lane = laneForChoice(requested.choice);
        const value = lane === null ? null : values[field][lane];
        const missingCandidate = lane !== null && value === null;
        const requiredOmission = requested.choice === 'omit'
            && !omissionAllowed(field, evidence.identity.managementModel);
        const resolvedChoice = missingCandidate || requiredOmission
            ? 'needs_human' : requested.choice;
        const reasonCode = missingCandidate
            ? 'verified_candidate_missing'
            : requiredOmission ? 'required_field_cannot_be_omitted' : requested.reasonCode;
        return Object.freeze({
            field,
            requestedChoice: requested.choice,
            resolvedChoice,
            value,
            reasonCode,
            riskCodes: decisionRisks(values[field], requested.choice, requested.riskCodes, missingCandidate, requiredOmission),
            requiresHuman: resolvedChoice === 'needs_human',
        });
    });
    const draft = Object.freeze(Object.fromEntries(resolved.map((field) => [field.field, field.value])));
    const evidenceDigest = digestListingProposalEvidence(evidence);
    const proposalCore = Object.freeze({
        schemaVersion: 1,
        outcome: resolved.some((field) => field.requiresHuman)
            ? 'needs_human' : 'ready_for_review',
        evidenceDigest,
        draft,
        fields: Object.freeze(resolved),
    });
    return Object.freeze({ ...proposalCore, proposalDigest: digest(proposalCore) });
}
export function digestListingProposalDecision(value) {
    const { proposalDigest, ...core } = value;
    const calculated = digest(core);
    if (proposalDigest !== calculated)
        return invalidOutput();
    return calculated;
}
export function parseListingProposalModelJson(value) {
    if (typeof value !== 'string' || utf8Length(value) > MAX_MODEL_OUTPUT_UTF8_BYTES
        || CONTROL.test(value))
        return invalidOutput();
    try {
        return JSON.parse(value);
    }
    catch {
        return invalidOutput();
    }
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
export const LISTING_PROPOSAL_RESPONSE_SCHEMA = deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'fields'],
    properties: {
        schemaVersion: { type: 'integer', const: 1 },
        fields: {
            type: 'array',
            minItems: LISTING_PROPOSAL_FIELDS.length,
            maxItems: LISTING_PROPOSAL_FIELDS.length,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['field', 'choice', 'reasonCode', 'riskCodes'],
                properties: {
                    field: { type: 'string', enum: [...LISTING_PROPOSAL_FIELDS] },
                    choice: { type: 'string', enum: [...LISTING_PROPOSAL_CHOICES] },
                    reasonCode: { type: 'string', enum: [...LISTING_PROPOSAL_REASON_CODES] },
                    riskCodes: {
                        type: 'array',
                        maxItems: 4,
                        uniqueItems: true,
                        items: { type: 'string', enum: [...LISTING_PROPOSAL_RISK_CODES] },
                    },
                },
            },
        },
    },
});
export const LISTING_PROPOSAL_CONTRACT_TESTING = Object.freeze({
    canonicalJson,
    modelOutput,
    maximumPreviewCodePoints: MAX_PREVIEW_CODE_POINTS,
    maximumEvidenceUtf8Bytes: MAX_EVIDENCE_UTF8_BYTES,
    maximumModelOutputUtf8Bytes: MAX_MODEL_OUTPUT_UTF8_BYTES,
});
