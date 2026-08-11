import { randomUUID } from 'node:crypto';
import { EBAY_READ_SCOPES, } from './ebay.js';
import { SHOPIFY_ADMIN_API_VERSION, SHOPIFY_GRAPHQL_DOCUMENTS, } from './shopify.js';
export const EVIDENCE_AUTHORITY_ENVIRONMENT = Object.freeze({
    shopifyAccess: 'PRODUCT_PIPELINE_SHOPIFY_READ_ACCESS_TOKEN',
    ebayAccess: 'PRODUCT_PIPELINE_EBAY_READ_ACCESS_TOKEN',
    ebayScopes: 'PRODUCT_PIPELINE_EBAY_READ_ACCESS_SCOPES',
    ebayIssuedAt: 'PRODUCT_PIPELINE_EBAY_READ_ACCESS_ISSUED_AT_UTC',
    ebayExpiresAt: 'PRODUCT_PIPELINE_EBAY_READ_ACCESS_EXPIRES_AT_UTC',
});
export class EvidenceNetworkError extends Error {
    code;
    constructor(code) {
        super(`Evidence network read failed closed: ${code}`);
        this.name = 'EvidenceNetworkError';
        this.code = code;
    }
}
const MAX_ACCESS_LENGTH = 8_192;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ACCESS_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const SAFE_SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/;
const SAFE_OFFSET_PATTERN = /^(?:0|[1-9][0-9]{0,8})$/;
const SAFE_FILTER_PATTERN = /^creationdate:\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\.\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\]$/;
function canonicalUtc(value) {
    if (typeof value !== 'string')
        throw new EvidenceNetworkError('authority-unavailable');
    const epochMs = Date.parse(value);
    if (Number.isNaN(epochMs) || new Date(epochMs).toISOString() !== value) {
        throw new EvidenceNetworkError('authority-invalid');
    }
    return { text: value, epochMs };
}
function accessValue(environment, name) {
    const value = environment[name];
    if (typeof value !== 'string'
        || value.length < 12
        || value.length > MAX_ACCESS_LENGTH
        || value.trim() !== value
        || !ACCESS_PATTERN.test(value)) {
        throw new EvidenceNetworkError(value === undefined ? 'authority-unavailable' : 'authority-invalid');
    }
    return value;
}
function exactObjectKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length
        && actual.every((entry, index) => entry === sortedExpected[index]);
}
function assertShopifyVariables(request) {
    const expectedDocument = request.body.operationName === 'ProductPipelineShopifyPreflight'
        ? SHOPIFY_GRAPHQL_DOCUMENTS.preflight
        : request.body.operationName === 'ProductPipelineShopifyVariants'
            ? SHOPIFY_GRAPHQL_DOCUMENTS.variants
            : request.body.operationName === 'ProductPipelineShopifyOrders'
                ? SHOPIFY_GRAPHQL_DOCUMENTS.orders
                : null;
    if (expectedDocument === null || request.body.query !== expectedDocument || /\bmutation\b/i.test(request.body.query)) {
        throw new EvidenceNetworkError('request-denied');
    }
    const variables = request.body.variables;
    if (request.body.operationName === 'ProductPipelineShopifyPreflight') {
        if (!exactObjectKeys(variables, []))
            throw new EvidenceNetworkError('request-denied');
        return;
    }
    if (request.body.operationName === 'ProductPipelineShopifyVariants') {
        if (!exactObjectKeys(variables, ['after', 'first'])
            || !Number.isInteger(variables.first)
            || Number(variables.first) < 1
            || Number(variables.first) > 100
            || (variables.after !== null && (typeof variables.after !== 'string' || variables.after.length > 2_048)))
            throw new EvidenceNetworkError('request-denied');
        return;
    }
    if (!exactObjectKeys(variables, ['after', 'first', 'query'])
        || !Number.isInteger(variables.first)
        || Number(variables.first) < 1
        || Number(variables.first) > 100
        || (variables.after !== null && (typeof variables.after !== 'string' || variables.after.length > 2_048))
        || typeof variables.query !== 'string'
        || variables.query.length > 256
        || !/^created_at:>='[^']+' created_at:<'[^']+'$/.test(variables.query))
        throw new EvidenceNetworkError('request-denied');
}
function assertEbayUrl(request, loaded) {
    let url;
    try {
        url = new URL(request.url);
    }
    catch {
        throw new EvidenceNetworkError('request-denied');
    }
    const production = loaded.config.identities.ebayEnvironment === 'production';
    const identityHost = production ? 'apiz.ebay.com' : 'apiz.sandbox.ebay.com';
    const sellHost = production ? 'api.ebay.com' : 'api.sandbox.ebay.com';
    if (request.method !== 'GET'
        || request.redirect !== 'error'
        || url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.hash !== '')
        throw new EvidenceNetworkError('request-denied');
    const entries = [...url.searchParams.entries()];
    if (url.host === identityHost && url.pathname === '/commerce/identity/v1/user/') {
        if (request.requiredScope !== EBAY_READ_SCOPES.identity || entries.length !== 0) {
            throw new EvidenceNetworkError('request-denied');
        }
        return;
    }
    if (url.host !== sellHost)
        throw new EvidenceNetworkError('request-denied');
    const query = Object.fromEntries(entries);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        throw new EvidenceNetworkError('request-denied');
    }
    if (url.pathname === '/sell/inventory/v1/inventory_item') {
        if (request.requiredScope !== EBAY_READ_SCOPES.inventory
            || !exactObjectKeys(query, ['limit', 'offset'])
            || query.limit !== '200'
            || !SAFE_OFFSET_PATTERN.test(query.offset ?? ''))
            throw new EvidenceNetworkError('request-denied');
        return;
    }
    if (url.pathname === '/sell/inventory/v1/offer') {
        if (request.requiredScope !== EBAY_READ_SCOPES.inventory
            || !exactObjectKeys(query, ['limit', 'marketplace_id', 'offset', 'sku'])
            || query.limit !== '25'
            || query.marketplace_id !== loaded.config.identities.ebayMarketplaceId
            || !SAFE_OFFSET_PATTERN.test(query.offset ?? '')
            || !SAFE_SKU_PATTERN.test(query.sku ?? ''))
            throw new EvidenceNetworkError('request-denied');
        return;
    }
    if (url.pathname === '/sell/fulfillment/v1/order') {
        if (request.requiredScope !== EBAY_READ_SCOPES.fulfillment
            || !exactObjectKeys(query, ['filter', 'limit', 'offset'])
            || query.limit !== '200'
            || !SAFE_OFFSET_PATTERN.test(query.offset ?? '')
            || !SAFE_FILTER_PATTERN.test(query.filter ?? ''))
            throw new EvidenceNetworkError('request-denied');
        return;
    }
    throw new EvidenceNetworkError('request-denied');
}
async function readJsonResponse(response, maximumBytes) {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        const parsed = Number(declaredLength);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
            throw new EvidenceNetworkError('response-denied');
        }
    }
    if (response.body === null)
        throw new EvidenceNetworkError('response-denied');
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > maximumBytes) {
                await reader.cancel();
                throw new EvidenceNetworkError('response-denied');
            }
            chunks.push(chunk.value);
        }
    }
    catch (error) {
        if (error instanceof EvidenceNetworkError)
            throw error;
        throw new EvidenceNetworkError('transport-failed');
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        throw new EvidenceNetworkError('response-denied');
    }
}
function linkedSignal(signal, timeoutMs) {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
/**
 * Creates a semantic-read-only Shopify dispatcher. The authority remains in a
 * closure and never enters the collector request, result, error, or audit data.
 */
export function createShopifyNetworkDispatcher(input) {
    const access = accessValue(input.environment, EVIDENCE_AUTHORITY_ENVIRONMENT.shopifyAccess);
    const expectedUrl = `https://${input.loaded.config.identities.shopifyStoreDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
    return async (request) => {
        if (request.method !== 'POST'
            || request.url !== expectedUrl
            || request.redirect !== 'error'
            || request.headers.Accept !== 'application/json'
            || request.headers['Content-Type'] !== 'application/json')
            throw new EvidenceNetworkError('request-denied');
        assertShopifyVariables(request);
        let response;
        try {
            response = await input.fetch(request.url, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': access,
                },
                redirect: 'error',
                signal: linkedSignal(request.signal, input.loaded.config.limits.requestTimeoutMs),
                body: JSON.stringify(request.body),
            });
        }
        catch (error) {
            if (error instanceof EvidenceNetworkError)
                throw error;
            throw new EvidenceNetworkError('transport-failed');
        }
        return {
            status: response.status,
            apiVersion: response.headers.get('x-shopify-api-version'),
            body: await readJsonResponse(response, Math.min(input.loaded.config.limits.maxResponseBytes, MAX_RESPONSE_BYTES)),
        };
    };
}
/**
 * Creates a GET-only eBay transport. It cannot acquire or refresh OAuth access,
 * cannot submit a body, and rejects every host/path/query outside the capture contract.
 */
export function createEbayNetworkTransport(input) {
    const access = accessValue(input.environment, EVIDENCE_AUTHORITY_ENVIRONMENT.ebayAccess);
    const scopes = Object.freeze([
        EBAY_READ_SCOPES.identity,
        EBAY_READ_SCOPES.inventory,
        EBAY_READ_SCOPES.fulfillment,
    ]);
    if (input.environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayScopes]
        !== scopes.join(' ')) {
        throw new EvidenceNetworkError('authority-invalid');
    }
    const now = canonicalUtc(input.nowUtc);
    const issuedAt = canonicalUtc(input.environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayIssuedAt]);
    const expiresAt = canonicalUtc(input.environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayExpiresAt]);
    if (issuedAt.epochMs > now.epochMs || expiresAt.epochMs <= issuedAt.epochMs) {
        throw new EvidenceNetworkError('authority-invalid');
    }
    if (expiresAt.epochMs <= now.epochMs)
        throw new EvidenceNetworkError('authority-expired');
    if (expiresAt.epochMs - now.epochMs
        < input.loaded.config.limits.minimumEbayAccessValiditySeconds * 1_000)
        throw new EvidenceNetworkError('authority-near-expiry');
    const authorization = Object.freeze({
        kind: 'ephemeral-user-access-attestation',
        scopes,
        issuedAtUtc: issuedAt.text,
        expiresAtUtc: expiresAt.text,
        refreshSupported: false,
        credentialProvidedToCollector: false,
    });
    const transport = Object.freeze({
        provenance: Object.freeze({
            kind: 'direct-ebay-api',
            captureSessionId: randomUUID(),
        }),
        get: async (request) => {
            assertEbayUrl(request, input.loaded);
            let response;
            try {
                response = await input.fetch(request.url, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        Authorization: `Bearer ${access}`,
                    },
                    redirect: 'error',
                    signal: linkedSignal(request.signal, input.loaded.config.limits.requestTimeoutMs),
                });
            }
            catch (error) {
                if (error instanceof EvidenceNetworkError)
                    throw error;
                throw new EvidenceNetworkError('transport-failed');
            }
            return {
                status: response.status,
                body: await readJsonResponse(response, Math.min(input.loaded.config.limits.maxResponseBytes, MAX_RESPONSE_BYTES)),
            };
        },
    });
    return { transport, authorization };
}
export function inspectEvidenceAuthorityAvailability(environment) {
    return Object.freeze({
        shopifyAccessPresent: typeof environment[EVIDENCE_AUTHORITY_ENVIRONMENT.shopifyAccess] === 'string',
        ebayAccessPresent: typeof environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayAccess] === 'string',
        ebayScopeMetadataPresent: typeof environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayScopes] === 'string',
        ebayExpiryMetadataPresent: typeof environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayIssuedAt] === 'string'
            && typeof environment[EVIDENCE_AUTHORITY_ENVIRONMENT.ebayExpiresAt] === 'string',
        signingAuthorityPresent: typeof environment.PRODUCT_PIPELINE_EVIDENCE_SIGNING_KEY_PKCS8_B64 === 'string',
    });
}
