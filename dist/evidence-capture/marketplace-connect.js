import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { MIGRATION_RESPONSIBILITIES, } from '../safety/responsibilities.js';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_ID_PATTERN = /^evidence:sha256:[a-f0-9]{64}$/;
const UNKNOWN_ID_PATTERN = /^unknown:sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const URL_PATTERN = /(?:https?:\/\/|file:|gid:\/\/|[a-z][a-z0-9+.-]*:\/\/)/i;
const CREDENTIAL_VALUE_PATTERN = /(?:Bearer\s+|shpat_|shpca_|shppa_|gh[pousr]_|sk-[A-Za-z0-9_-]{10,}|v\^1\.)/i;
const FORBIDDEN_KEY_PATTERN = /(?:token|secret|password|credential|cookie|authorization|email|phone|address|customer|buyer|lineitem|line_item|rawpayload|rawresponse|raworder|url|uri)/i;
const MAX_PACKET_BYTES = 512 * 1024;
const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 100_000;
const MAX_EVIDENCE_ATTACHMENTS = 64;
const MAX_LISTING_RECORDS = 5_000;
const MAX_EVIDENCE_REFERENCES = 32;
const MAX_CLAIMS = MIGRATION_RESPONSIBILITIES.length;
const MAX_UNKNOWNS = 128;
const MAX_CAPTURE_SESSION_MS = 4 * 60 * 60 * 1000;
export class MarketplaceConnectAttestationError extends Error {
    constructor(message) {
        super(`Marketplace Connect attestation denied: ${message}`);
        this.name = 'MarketplaceConnectAttestationError';
    }
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function deny(message) {
    throw new MarketplaceConnectAttestationError(message);
}
function exactRecord(value, keys, fieldPath) {
    if (!isRecord(value))
        deny(`${fieldPath} must be an object`);
    const actualKeys = Object.keys(value);
    const allowed = new Set(keys);
    for (const key of actualKeys) {
        if (!allowed.has(key))
            deny(`${fieldPath}.${key} is not supported`);
    }
    for (const key of keys) {
        if (!Object.hasOwn(value, key))
            deny(`${fieldPath}.${key} is required`);
    }
    return value;
}
function literal(value, expected, fieldPath) {
    if (value !== expected)
        deny(`${fieldPath} must use its fail-closed literal`);
    return expected;
}
function enumeration(value, allowed, fieldPath) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        deny(`${fieldPath} is not an accepted enum value`);
    }
    return value;
}
function digest(value, fieldPath) {
    if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
        deny(`${fieldPath} must be an exact sha256 digest`);
    }
    return value;
}
function canonicalUtc(value, fieldPath) {
    if (typeof value !== 'string')
        deny(`${fieldPath} must be a canonical UTC instant`);
    const epochMs = Date.parse(value);
    if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== value) {
        deny(`${fieldPath} must be a canonical UTC instant`);
    }
    return value;
}
function boundedInteger(value, maximum, fieldPath) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        deny(`${fieldPath} is outside the accepted bound`);
    }
    return value;
}
function boundedArray(value, maximum, fieldPath) {
    if (!Array.isArray(value))
        deny(`${fieldPath} must be an array`);
    if (value.length > maximum)
        deny(`${fieldPath} exceeds its accepted bound`);
    return value;
}
function safeIdentifier(value, pattern, fieldPath) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        deny(`${fieldPath} must be an opaque bounded identifier`);
    }
    return value;
}
function canonicalBase64(value, decodedBytes, fieldPath) {
    if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
        deny(`${fieldPath} must be canonical base64`);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.byteLength !== decodedBytes || decoded.toString('base64') !== value) {
        deny(`${fieldPath} must encode the expected byte length`);
    }
    return value;
}
function scanUntrustedTree(value) {
    let nodes = 0;
    const visit = (entry, fieldPath, depth) => {
        nodes += 1;
        if (nodes > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) {
            deny('packet structure exceeds the accepted bound');
        }
        if (typeof entry === 'string') {
            if (entry.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry)) {
                deny(`${fieldPath} contains unsafe text`);
            }
            if (URL_PATTERN.test(entry))
                deny(`${fieldPath} contains a forbidden URL or URI`);
            if (CREDENTIAL_VALUE_PATTERN.test(entry)) {
                deny(`${fieldPath} contains credential-like material`);
            }
            return;
        }
        if (Array.isArray(entry)) {
            entry.forEach((item, index) => visit(item, `${fieldPath}[${index}]`, depth + 1));
            return;
        }
        if (!isRecord(entry))
            return;
        for (const [key, child] of Object.entries(entry)) {
            if (FORBIDDEN_KEY_PATTERN.test(key)) {
                deny(`${fieldPath}.${key} is a forbidden secret, PII, raw-data, or URL field`);
            }
            visit(child, `${fieldPath}.${key}`, depth + 1);
        }
    };
    visit(value, 'packet', 0);
}
export function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            deny('canonical payload contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return deny('canonical payload contains an unsupported value');
}
function sha256Bytes(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function parseEvidenceIds(value, fieldPath, allowEmpty) {
    const entries = boundedArray(value, MAX_EVIDENCE_REFERENCES, fieldPath);
    if (!allowEmpty && entries.length === 0)
        deny(`${fieldPath} must bind at least one evidence item`);
    const result = entries.map((entry, index) => safeIdentifier(entry, EVIDENCE_ID_PATTERN, `${fieldPath}[${index}]`));
    if (new Set(result).size !== result.length)
        deny(`${fieldPath} contains duplicate evidence IDs`);
    return result;
}
function parseSubject(value) {
    const source = exactRecord(value, [
        'shopifyStoreDomainDigest',
        'ebayEnvironment',
        'ebaySellerAccountDigest',
        'ebayMarketplaceId',
    ], 'payload.subject');
    return {
        shopifyStoreDomainDigest: digest(source.shopifyStoreDomainDigest, 'payload.subject.shopifyStoreDomainDigest'),
        ebayEnvironment: enumeration(source.ebayEnvironment, ['sandbox', 'production'], 'payload.subject.ebayEnvironment'),
        ebaySellerAccountDigest: digest(source.ebaySellerAccountDigest, 'payload.subject.ebaySellerAccountDigest'),
        ebayMarketplaceId: literal(source.ebayMarketplaceId, 'EBAY_US', 'payload.subject.ebayMarketplaceId'),
    };
}
function parseCapture(value) {
    const source = exactRecord(value, ['capturedAtUtc', 'method', 'completeness'], 'payload.capture');
    return {
        capturedAtUtc: canonicalUtc(source.capturedAtUtc, 'payload.capture.capturedAtUtc'),
        method: enumeration(source.method, ['operator-ui', 'shopify-support-export'], 'payload.capture.method'),
        completeness: enumeration(source.completeness, ['complete', 'partial'], 'payload.capture.completeness'),
    };
}
function parseSettings(value) {
    const source = exactRecord(value, [
        'connection',
        'orderImport',
        'priceSync',
        'inventorySync',
        'autoListProducts',
        'autoCategorization',
        'inventoryLocation',
    ], 'payload.settings');
    const order = exactRecord(source.orderImport, ['productScope', 'fulfillmentScope', 'importWhen'], 'payload.settings.orderImport');
    const inventoryLocation = exactRecord(source.inventoryLocation, ['mode', 'locationSetDigest'], 'payload.settings.inventoryLocation');
    const mode = enumeration(inventoryLocation.mode, ['all-locations', 'selected-locations', 'per-product', 'unknown'], 'payload.settings.inventoryLocation.mode');
    const locationSetDigest = inventoryLocation.locationSetDigest === null
        ? null
        : digest(inventoryLocation.locationSetDigest, 'payload.settings.inventoryLocation.locationSetDigest');
    if ((mode === 'selected-locations') !== (locationSetDigest !== null)) {
        deny('payload.settings.inventoryLocation location digest does not match its mode');
    }
    const settings = {
        connection: enumeration(source.connection, ['connected', 'disconnected', 'unknown'], 'payload.settings.connection'),
        orderImport: {
            productScope: enumeration(order.productScope, ['all-orders', 'linked-products-only', 'no-orders', 'unknown'], 'payload.settings.orderImport.productScope'),
            fulfillmentScope: enumeration(order.fulfillmentScope, [
                'all-orders',
                'marketplace-fulfilled-only',
                'merchant-fulfilled-only',
                'unknown',
            ], 'payload.settings.orderImport.fulfillmentScope'),
            importWhen: enumeration(order.importWhen, ['pending', 'complete', 'unknown'], 'payload.settings.orderImport.importWhen'),
        },
        priceSync: enumeration(source.priceSync, ['enabled', 'disabled', 'unknown'], 'payload.settings.priceSync'),
        inventorySync: enumeration(source.inventorySync, ['enabled', 'disabled', 'unknown'], 'payload.settings.inventorySync'),
        autoListProducts: enumeration(source.autoListProducts, ['enabled', 'disabled', 'unknown'], 'payload.settings.autoListProducts'),
        autoCategorization: enumeration(source.autoCategorization, ['enabled', 'disabled', 'unknown'], 'payload.settings.autoCategorization'),
        inventoryLocation: { mode, locationSetDigest },
    };
    if (settings.connection === 'disconnected'
        && (settings.priceSync === 'enabled' || settings.inventorySync === 'enabled')) {
        deny('payload.settings cannot assert enabled sync for a disconnected account');
    }
    return settings;
}
function parseAttachments(value, capture) {
    const entries = boundedArray(value, MAX_EVIDENCE_ATTACHMENTS, 'payload.evidenceAttachments');
    if (entries.length === 0)
        deny('payload.evidenceAttachments must not be empty');
    const capturedEpochMs = Date.parse(capture.capturedAtUtc);
    const result = entries.map((entry, index) => {
        const fieldPath = `payload.evidenceAttachments[${index}]`;
        const source = exactRecord(entry, ['evidenceId', 'surface', 'capturedAtUtc', 'contentDigest', 'redacted'], fieldPath);
        const attachmentCapturedAtUtc = canonicalUtc(source.capturedAtUtc, `${fieldPath}.capturedAtUtc`);
        const attachmentEpochMs = Date.parse(attachmentCapturedAtUtc);
        if (attachmentEpochMs > capturedEpochMs
            || capturedEpochMs - attachmentEpochMs > MAX_CAPTURE_SESSION_MS) {
            deny(`${fieldPath}.capturedAtUtc is outside the bounded capture session`);
        }
        return {
            evidenceId: safeIdentifier(source.evidenceId, EVIDENCE_ID_PATTERN, `${fieldPath}.evidenceId`),
            surface: enumeration(source.surface, [
                'account-settings',
                'order-import-settings',
                'listing-settings',
                'listing-grid',
                'link-listings',
                'mapping',
                'inventory-location',
                'shopify-order-attribution',
                'shopify-support-export',
            ], `${fieldPath}.surface`),
            capturedAtUtc: attachmentCapturedAtUtc,
            contentDigest: digest(source.contentDigest, `${fieldPath}.contentDigest`),
            redacted: literal(source.redacted, true, `${fieldPath}.redacted`),
        };
    });
    const ids = result.map((entry) => entry.evidenceId);
    if (new Set(ids).size !== ids.length)
        deny('payload.evidenceAttachments has duplicate evidence IDs');
    return result;
}
function parseListingRecord(value, index) {
    const fieldPath = `payload.listingCoverage.records[${index}]`;
    const source = exactRecord(value, [
        'recordKey',
        'shopifyProductDigest',
        'ebayListingDigest',
        'skuDigest',
        'linkStatus',
        'fieldOwners',
        'evidenceIds',
    ], fieldPath);
    const owners = exactRecord(source.fieldOwners, ['shipping', 'returns', 'title', 'description', 'priceTaxes'], `${fieldPath}.fieldOwners`);
    const owner = (entry, name) => enumeration(entry, ['ebay', 'marketplace-connect', 'unknown'], `${fieldPath}.fieldOwners.${name}`);
    return {
        recordKey: digest(source.recordKey, `${fieldPath}.recordKey`),
        shopifyProductDigest: digest(source.shopifyProductDigest, `${fieldPath}.shopifyProductDigest`),
        ebayListingDigest: digest(source.ebayListingDigest, `${fieldPath}.ebayListingDigest`),
        skuDigest: digest(source.skuDigest, `${fieldPath}.skuDigest`),
        linkStatus: enumeration(source.linkStatus, ['linked', 'unlinked', 'suggested', 'unknown'], `${fieldPath}.linkStatus`),
        fieldOwners: {
            shipping: owner(owners.shipping, 'shipping'),
            returns: owner(owners.returns, 'returns'),
            title: owner(owners.title, 'title'),
            description: owner(owners.description, 'description'),
            priceTaxes: owner(owners.priceTaxes, 'priceTaxes'),
        },
        evidenceIds: parseEvidenceIds(source.evidenceIds, `${fieldPath}.evidenceIds`, false),
    };
}
function parseListingCoverage(value) {
    const source = exactRecord(value, [
        'status',
        'normalizedRecordCount',
        'terminalPageObserved',
        'terminalPageDigest',
        'datasetDigest',
        'records',
    ], 'payload.listingCoverage');
    const status = enumeration(source.status, ['complete', 'partial', 'unavailable'], 'payload.listingCoverage.status');
    const records = boundedArray(source.records, MAX_LISTING_RECORDS, 'payload.listingCoverage.records').map(parseListingRecord);
    const normalizedRecordCount = boundedInteger(source.normalizedRecordCount, MAX_LISTING_RECORDS, 'payload.listingCoverage.normalizedRecordCount');
    const terminalPageObserved = typeof source.terminalPageObserved === 'boolean'
        ? source.terminalPageObserved
        : deny('payload.listingCoverage.terminalPageObserved must be boolean');
    const terminalPageDigest = source.terminalPageDigest === null
        ? null
        : digest(source.terminalPageDigest, 'payload.listingCoverage.terminalPageDigest');
    const datasetDigest = source.datasetDigest === null
        ? null
        : digest(source.datasetDigest, 'payload.listingCoverage.datasetDigest');
    if (normalizedRecordCount !== records.length) {
        deny('payload.listingCoverage record count does not match normalized records');
    }
    if (new Set(records.map((entry) => entry.recordKey)).size !== records.length) {
        deny('payload.listingCoverage contains duplicate record keys');
    }
    if (terminalPageObserved !== (terminalPageDigest !== null)) {
        deny('payload.listingCoverage terminal proof is inconsistent');
    }
    if (status === 'complete' && (!terminalPageObserved || datasetDigest === null)) {
        deny('complete listing coverage requires terminal and dataset digests');
    }
    if (status === 'partial' && records.length > 0 && datasetDigest === null) {
        deny('partial listing records require a dataset digest');
    }
    if (datasetDigest !== null && datasetDigest !== sha256Bytes(canonicalJson(records))) {
        deny('payload.listingCoverage dataset digest does not match normalized records');
    }
    if (status === 'unavailable'
        && (records.length !== 0
            || normalizedRecordCount !== 0
            || terminalPageObserved
            || terminalPageDigest !== null
            || datasetDigest !== null)) {
        deny('unavailable listing coverage cannot contain observations or completeness proof');
    }
    return {
        status,
        normalizedRecordCount,
        terminalPageObserved,
        terminalPageDigest,
        datasetDigest,
        records,
    };
}
function parseClaims(value) {
    const entries = boundedArray(value, MAX_CLAIMS, 'payload.claims');
    if (entries.length === 0)
        deny('payload.claims must bind at least one responsibility observation');
    const result = entries.map((entry, index) => {
        const fieldPath = `payload.claims[${index}]`;
        const source = exactRecord(entry, ['responsibility', 'assertedOwner', 'evidenceClass', 'evidenceIds'], fieldPath);
        return {
            responsibility: enumeration(source.responsibility, MIGRATION_RESPONSIBILITIES, `${fieldPath}.responsibility`),
            assertedOwner: enumeration(source.assertedOwner, ['marketplace_connect', 'unverified'], `${fieldPath}.assertedOwner`),
            evidenceClass: enumeration(source.evidenceClass, ['operator-attested-ui', 'shopify-support-export'], `${fieldPath}.evidenceClass`),
            evidenceIds: parseEvidenceIds(source.evidenceIds, `${fieldPath}.evidenceIds`, false),
        };
    });
    if (new Set(result.map((entry) => entry.responsibility)).size !== result.length) {
        deny('payload.claims contains more than one claim for a responsibility');
    }
    return result;
}
function parseUnknowns(value) {
    const entries = boundedArray(value, MAX_UNKNOWNS, 'payload.unknowns');
    if (entries.length === 0) {
        deny('payload.unknowns must explicitly retain at least one evidence limitation');
    }
    const result = entries.map((entry, index) => {
        const fieldPath = `payload.unknowns[${index}]`;
        const source = exactRecord(entry, ['unknownId', 'responsibility', 'detailsDigest', 'evidenceIds'], fieldPath);
        return {
            unknownId: safeIdentifier(source.unknownId, UNKNOWN_ID_PATTERN, `${fieldPath}.unknownId`),
            responsibility: enumeration(source.responsibility, MIGRATION_RESPONSIBILITIES, `${fieldPath}.responsibility`),
            detailsDigest: digest(source.detailsDigest, `${fieldPath}.detailsDigest`),
            evidenceIds: parseEvidenceIds(source.evidenceIds, `${fieldPath}.evidenceIds`, true),
        };
    });
    if (new Set(result.map((entry) => entry.unknownId)).size !== result.length) {
        deny('payload.unknowns contains duplicate IDs');
    }
    return result;
}
function parseLimitations(value) {
    const source = exactRecord(value, [
        'evidenceOnly',
        'ownershipTransferAuthorized',
        'liveParityProven',
        'externalWritesObserved',
        'historicalBackfill',
    ], 'payload.limitations');
    return {
        evidenceOnly: literal(source.evidenceOnly, true, 'payload.limitations.evidenceOnly'),
        ownershipTransferAuthorized: literal(source.ownershipTransferAuthorized, false, 'payload.limitations.ownershipTransferAuthorized'),
        liveParityProven: literal(source.liveParityProven, false, 'payload.limitations.liveParityProven'),
        externalWritesObserved: literal(source.externalWritesObserved, 0, 'payload.limitations.externalWritesObserved'),
        historicalBackfill: literal(source.historicalBackfill, false, 'payload.limitations.historicalBackfill'),
    };
}
function assertEvidenceBindings(payload) {
    const attachmentById = new Map(payload.evidenceAttachments.map((attachment) => [attachment.evidenceId, attachment]));
    const referenced = new Set();
    const assertReferences = (ids, fieldPath) => {
        for (const evidenceId of ids) {
            if (!attachmentById.has(evidenceId))
                deny(`${fieldPath} references missing evidence`);
            referenced.add(evidenceId);
        }
    };
    payload.listingCoverage.records.forEach((record, index) => assertReferences(record.evidenceIds, `payload.listingCoverage.records[${index}].evidenceIds`));
    payload.claims.forEach((claim, index) => {
        assertReferences(claim.evidenceIds, `payload.claims[${index}].evidenceIds`);
        const attachments = claim.evidenceIds.map((id) => attachmentById.get(id));
        if (claim.evidenceClass === 'shopify-support-export'
            && !attachments.some((entry) => entry.surface === 'shopify-support-export')) {
            deny(`payload.claims[${index}] lacks Shopify support export evidence`);
        }
        if (claim.evidenceClass === 'operator-attested-ui' && payload.capture.method !== 'operator-ui') {
            deny(`payload.claims[${index}] evidence class conflicts with the capture method`);
        }
    });
    payload.unknowns.forEach((unknown, index) => assertReferences(unknown.evidenceIds, `payload.unknowns[${index}].evidenceIds`));
    for (const attachment of payload.evidenceAttachments) {
        if (!referenced.has(attachment.evidenceId)) {
            deny('payload.evidenceAttachments contains unbound evidence');
        }
    }
}
function assertClaimSemantics(payload) {
    const attachmentById = new Map(payload.evidenceAttachments.map((attachment) => [attachment.evidenceId, attachment]));
    for (const [index, claim] of payload.claims.entries()) {
        if (claim.assertedOwner !== 'marketplace_connect')
            continue;
        if (!['orderImport', 'price', 'inventory'].includes(claim.responsibility)) {
            deny(`payload.claims[${index}] cannot infer listing or operational ownership from UI controls`);
        }
        if (payload.settings.connection !== 'connected') {
            deny(`payload.claims[${index}] requires a connected Marketplace Connect account`);
        }
        const surfaces = claim.evidenceIds.map((id) => attachmentById.get(id).surface);
        if (claim.responsibility === 'orderImport') {
            if (payload.settings.orderImport.productScope === 'unknown'
                || payload.settings.orderImport.productScope === 'no-orders'
                || payload.settings.orderImport.importWhen === 'unknown'
                || !surfaces.includes('order-import-settings')
                || !surfaces.some((surface) => [
                    'shopify-order-attribution',
                    'shopify-support-export',
                ].includes(surface))) {
                deny(`payload.claims[${index}] lacks enabled settings and order-attribution evidence`);
            }
        }
        if (claim.responsibility === 'price') {
            if (payload.settings.priceSync !== 'enabled'
                || claim.evidenceClass !== 'shopify-support-export'
                || !surfaces.includes('shopify-support-export')) {
                deny(`payload.claims[${index}] cannot infer price ownership from UI settings alone`);
            }
        }
        if (claim.responsibility === 'inventory') {
            if (payload.settings.inventorySync !== 'enabled'
                || claim.evidenceClass !== 'shopify-support-export'
                || !surfaces.includes('shopify-support-export')) {
                deny(`payload.claims[${index}] cannot infer inventory ownership from UI settings alone`);
            }
        }
    }
}
function parsePayload(value) {
    const source = exactRecord(value, [
        'subject',
        'capture',
        'settings',
        'listingCoverage',
        'evidenceAttachments',
        'claims',
        'unknowns',
        'limitations',
    ], 'payload');
    const capture = parseCapture(source.capture);
    const payload = {
        subject: parseSubject(source.subject),
        capture,
        settings: parseSettings(source.settings),
        listingCoverage: parseListingCoverage(source.listingCoverage),
        evidenceAttachments: parseAttachments(source.evidenceAttachments, capture),
        claims: parseClaims(source.claims),
        unknowns: parseUnknowns(source.unknowns),
        limitations: parseLimitations(source.limitations),
    };
    if (payload.capture.completeness === 'complete' && payload.listingCoverage.status !== 'complete') {
        deny('a complete capture requires complete listing coverage');
    }
    if (payload.capture.method === 'shopify-support-export'
        && !payload.evidenceAttachments.some((entry) => entry.surface === 'shopify-support-export')) {
        deny('a Shopify support export capture requires its redacted digest attachment');
    }
    if (payload.listingCoverage.status === 'complete'
        && !payload.evidenceAttachments.some((entry) => entry.contentDigest === payload.listingCoverage.terminalPageDigest
            && ['listing-grid', 'link-listings', 'shopify-support-export'].includes(entry.surface))) {
        deny('complete listing coverage terminal digest is not bound to retained evidence');
    }
    assertEvidenceBindings(payload);
    assertClaimSemantics(payload);
    const serialized = canonicalJson(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PACKET_BYTES) {
        deny('canonical payload exceeds the accepted byte bound');
    }
    return payload;
}
function parseSignature(value, role, index) {
    const fieldPath = `signatures[${index}]`;
    const source = exactRecord(value, ['role', 'signerId', 'keyId', 'algorithm', 'signatureBase64'], fieldPath);
    return {
        role: literal(source.role, role, `${fieldPath}.role`),
        signerId: digest(source.signerId, `${fieldPath}.signerId`),
        keyId: digest(source.keyId, `${fieldPath}.keyId`),
        algorithm: literal(source.algorithm, 'Ed25519', `${fieldPath}.algorithm`),
        signatureBase64: canonicalBase64(source.signatureBase64, 64, `${fieldPath}.signatureBase64`),
    };
}
function parsePacket(value) {
    scanUntrustedTree(value);
    const source = exactRecord(value, ['schemaVersion', 'kind', 'payload', 'signatures'], 'packet');
    const signatureValues = boundedArray(source.signatures, 2, 'signatures');
    if (signatureValues.length !== 2)
        deny('signatures must contain collector and reviewer');
    const packet = {
        schemaVersion: literal(source.schemaVersion, 1, 'schemaVersion'),
        kind: literal(source.kind, 'marketplace-connect-readonly-attestation', 'kind'),
        payload: parsePayload(source.payload),
        signatures: [
            parseSignature(signatureValues[0], 'collector', 0),
            parseSignature(signatureValues[1], 'reviewer', 1),
        ],
    };
    if (packet.signatures[0].signerId === packet.signatures[1].signerId
        || packet.signatures[0].keyId === packet.signatures[1].keyId) {
        deny('collector and reviewer must use distinct trusted identities and keys');
    }
    return packet;
}
function verifyDetachedSignature(signature, trusted, canonicalPayload) {
    if (signature.signerId !== trusted.signerId || signature.keyId !== trusted.keyId) {
        deny(`${signature.role} signature does not match the trusted signer`);
    }
    const publicKeyDer = canonicalBase64(trusted.publicKeySpkiBase64, 44, `${signature.role} trusted public key`);
    if (sha256Bytes(Buffer.from(publicKeyDer, 'base64')) !== trusted.keyId) {
        deny(`${signature.role} trusted key digest does not match keyId`);
    }
    let verified = false;
    try {
        const publicKey = createPublicKey({
            key: Buffer.from(publicKeyDer, 'base64'),
            format: 'der',
            type: 'spki',
        });
        verified = verifySignature(null, Buffer.from(canonicalPayload, 'utf8'), publicKey, Buffer.from(signature.signatureBase64, 'base64'));
    }
    catch {
        deny(`${signature.role} trusted public key is invalid`);
    }
    if (!verified)
        deny(`${signature.role} detached signature verification failed`);
}
/** Validate and canonicalize a payload before an external collector/reviewer signs it. */
export function canonicalizeMarketplaceConnectPayload(value) {
    scanUntrustedTree(value);
    return canonicalJson(parsePayload(value));
}
/**
 * Verify a redacted attestation against out-of-band trusted signer keys. The
 * return type is deliberately non-authorizing even when both signatures pass.
 */
export function verifyMarketplaceConnectAttestation(value, trust) {
    const packet = parsePacket(value);
    const expectedSubject = parseSubject(trust.expectedSubject);
    const verifiedAtUtc = canonicalUtc(trust.verifiedAtUtc, 'trust.verifiedAtUtc');
    const verifiedAtMs = Date.parse(verifiedAtUtc);
    const capturedAtMs = Date.parse(packet.payload.capture.capturedAtUtc);
    if (canonicalJson(packet.payload.subject) !== canonicalJson(expectedSubject)
        || capturedAtMs > verifiedAtMs
        || verifiedAtMs - capturedAtMs > MAX_CAPTURE_SESSION_MS) {
        deny('attestation subject or freshness does not match trusted verification context');
    }
    if (trust.collector.signerId === trust.reviewer.signerId
        || trust.collector.keyId === trust.reviewer.keyId) {
        deny('trusted collector and reviewer must be independent');
    }
    const canonicalPayload = canonicalJson(packet.payload);
    verifyDetachedSignature(packet.signatures[0], trust.collector, canonicalPayload);
    verifyDetachedSignature(packet.signatures[1], trust.reviewer, canonicalPayload);
    return {
        packet,
        payloadDigest: sha256Bytes(canonicalPayload),
        verification: {
            collectorSignatureVerified: true,
            reviewerSignatureVerified: true,
        },
        classification: {
            evidenceOnly: true,
            ownershipTransferAuthorized: false,
            liveParityProven: false,
            externalWritesAllowed: false,
            historicalBackfillAllowed: false,
        },
    };
}
