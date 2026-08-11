import { ShadowReadError, denyShadowRead } from './errors.js';
import { sanitizeFixtureRecords } from './fixture-data.js';
import { validateReadLimits } from './limits.js';
import { orderWindowQueryForTransport, } from './order-window.js';
import { assertEphemeralReadAuthorizedForTransport, } from './token.js';
const ROOT_KEYS = ['ebay', 'limits', 'shopify'];
const SHOPIFY_KEYS = [
    'allowedOrderPathTemplates',
    'allowedPathTemplates',
    'allowedQueryParameters',
    'host',
    'storeDomain',
];
const EBAY_KEYS = [
    'allowedOrderPathTemplates',
    'allowedPathTemplates',
    'allowedQueryParameters',
    'environment',
    'host',
    'marketplaceId',
    'sellerAccount',
];
const REQUEST_KEYS = [
    'method',
    'orderWindow',
    'pageNumber',
    'path',
    'query',
    'requiredScopes',
    'source',
    'token',
];
const RESPONSE_KEYS = ['records', 'status'];
const DEPENDENCY_KEYS = ['clock', 'dispatcher'];
const SHOPIFY_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const EBAY_HOST_BY_ENVIRONMENT = Object.freeze({
    sandbox: 'api.sandbox.ebay.com',
    production: 'api.ebay.com',
});
const SELLER_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_QUERY_KEY = /(?:token|auth|secret|password|credential|api[_-]?key|signature|cookie)/i;
const FORBIDDEN_QUERY_VALUE = /^(?:Bearer\s+|shpat_|shpca_|shppa_|gh[pousr]_|sk-[A-Za-z0-9_-]{10,}|v\^1\.)/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_ORDER_QUERY = new Set(['created_at_min', 'created_at_max', 'filter']);
const TEMPLATE_LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const TEMPLATE_PARAMETER_SEGMENT = /^\{[a-z][A-Za-z0-9]*\}$/;
const PATH_PARAMETER = /^[A-Za-z0-9][A-Za-z0-9._~:@+-]{0,199}$/;
const SHOPIFY_ORDER_PATH_TEMPLATE = '/admin/api/{version}/orders.json';
const EBAY_ORDER_PATH_TEMPLATE = '/sell/fulfillment/v1/order';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function stringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function validTemplate(template) {
    if (!template.startsWith('/')
        || template === '/'
        || template.endsWith('/')
        || template.includes('//')
        || /[?#\\\s%]/.test(template)) {
        return false;
    }
    return template.slice(1).split('/').every((segment) => TEMPLATE_LITERAL_SEGMENT.test(segment) || TEMPLATE_PARAMETER_SEGMENT.test(segment));
}
function validateAllowlist(pathTemplates, queryParameters) {
    if (!stringArray(pathTemplates)
        || pathTemplates.length === 0
        || new Set(pathTemplates).size !== pathTemplates.length
        || !pathTemplates.every(validTemplate)
        || !stringArray(queryParameters)
        || new Set(queryParameters).size !== queryParameters.length
        || !queryParameters.every((key) => QUERY_KEY.test(key)
            && !FORBIDDEN_QUERY_KEY.test(key)
            && !RESERVED_ORDER_QUERY.has(key))) {
        denyShadowRead('configuration-denied');
    }
    return {
        pathTemplates: Object.freeze([...pathTemplates]),
        queryParameters: new Set(queryParameters),
    };
}
function validateOrderPathAllowlist(source, value) {
    const exactTemplate = source === 'shopify'
        ? SHOPIFY_ORDER_PATH_TEMPLATE
        : EBAY_ORDER_PATH_TEMPLATE;
    if (!stringArray(value)
        || value.length !== 1
        || value[0] !== exactTemplate
        || !validTemplate(value[0])) {
        denyShadowRead('configuration-denied');
    }
    return Object.freeze([...value]);
}
function validateConfig(raw) {
    if (!isRecord(raw) || !hasExactKeys(raw, ROOT_KEYS)) {
        denyShadowRead('configuration-denied');
    }
    const shopify = raw.shopify;
    const ebay = raw.ebay;
    if (!isRecord(shopify)
        || !hasExactKeys(shopify, SHOPIFY_KEYS)
        || !isRecord(ebay)
        || !hasExactKeys(ebay, EBAY_KEYS)) {
        denyShadowRead('configuration-denied');
    }
    const shopifyAllowlist = validateAllowlist(shopify.allowedPathTemplates, shopify.allowedQueryParameters);
    const ebayAllowlist = validateAllowlist(ebay.allowedPathTemplates, ebay.allowedQueryParameters);
    const shopifyOrderPaths = validateOrderPathAllowlist('shopify', shopify.allowedOrderPathTemplates);
    const ebayOrderPaths = validateOrderPathAllowlist('ebay', ebay.allowedOrderPathTemplates);
    const limits = validateReadLimits(raw.limits);
    if (typeof shopify.host !== 'string'
        || typeof shopify.storeDomain !== 'string'
        || !SHOPIFY_HOST.test(shopify.host)
        || shopify.host !== shopify.storeDomain
        || (ebay.environment !== 'sandbox' && ebay.environment !== 'production')
        || typeof ebay.host !== 'string'
        || ebay.host !== EBAY_HOST_BY_ENVIRONMENT[ebay.environment]
        || typeof ebay.sellerAccount !== 'string'
        || !SELLER_ACCOUNT.test(ebay.sellerAccount)
        || ebay.marketplaceId !== 'EBAY_US'
        || shopifyAllowlist.pathTemplates.includes(SHOPIFY_ORDER_PATH_TEMPLATE)
        || ebayAllowlist.pathTemplates.includes(EBAY_ORDER_PATH_TEMPLATE)) {
        denyShadowRead('configuration-denied');
    }
    const config = Object.freeze({
        shopify: Object.freeze({
            host: shopify.host,
            storeDomain: shopify.storeDomain,
            allowedPathTemplates: shopifyAllowlist.pathTemplates,
            allowedOrderPathTemplates: shopifyOrderPaths,
            allowedQueryParameters: Object.freeze([...shopify.allowedQueryParameters]),
        }),
        ebay: Object.freeze({
            host: ebay.host,
            environment: ebay.environment,
            sellerAccount: ebay.sellerAccount,
            marketplaceId: 'EBAY_US',
            allowedPathTemplates: ebayAllowlist.pathTemplates,
            allowedOrderPathTemplates: ebayOrderPaths,
            allowedQueryParameters: Object.freeze([...ebay.allowedQueryParameters]),
        }),
        limits,
    });
    return {
        config,
        authorities: {
            shopify: Object.freeze({
                host: config.shopify.host,
                allowedPathTemplates: config.shopify.allowedPathTemplates,
                allowedOrderPathTemplates: config.shopify.allowedOrderPathTemplates,
                allowedQueryParameters: shopifyAllowlist.queryParameters,
            }),
            ebay: Object.freeze({
                host: config.ebay.host,
                allowedPathTemplates: config.ebay.allowedPathTemplates,
                allowedOrderPathTemplates: config.ebay.allowedOrderPathTemplates,
                allowedQueryParameters: ebayAllowlist.queryParameters,
            }),
        },
    };
}
function validateDependencies(raw) {
    if (!isRecord(raw))
        denyShadowRead('configuration-denied');
    const actual = Object.keys(raw).sort();
    if (!actual.every((key) => DEPENDENCY_KEYS.includes(key))) {
        denyShadowRead('configuration-denied');
    }
    if (raw.dispatcher !== undefined && typeof raw.dispatcher !== 'function') {
        denyShadowRead('configuration-denied');
    }
    if (raw.clock !== undefined && typeof raw.clock !== 'function') {
        denyShadowRead('configuration-denied');
    }
    return raw;
}
function decodePathSegment(segment) {
    try {
        const decoded = decodeURIComponent(segment);
        if (decoded === '.'
            || decoded === '..'
            || decoded.includes('/')
            || decoded.includes('\\')
            || /[\u0000-\u001f\u007f\s]/.test(decoded)) {
            return null;
        }
        return decoded;
    }
    catch {
        return null;
    }
}
function pathMatchesTemplate(path, template) {
    const pathSegments = path.slice(1).split('/');
    const templateSegments = template.slice(1).split('/');
    if (pathSegments.length !== templateSegments.length)
        return false;
    return pathSegments.every((rawSegment, index) => {
        const decoded = decodePathSegment(rawSegment);
        if (decoded === null)
            return false;
        const templateSegment = templateSegments[index];
        return TEMPLATE_PARAMETER_SEGMENT.test(templateSegment)
            ? PATH_PARAMETER.test(decoded)
            : rawSegment === templateSegment;
    });
}
function validatePath(path, authority) {
    if (typeof path !== 'string'
        || !path.startsWith('/')
        || path === '/'
        || path.endsWith('/')
        || path.includes('//')
        || /[?#\\\s]/.test(path)) {
        denyShadowRead('path-denied');
    }
    const regularMatch = authority.allowedPathTemplates.some((template) => pathMatchesTemplate(path, template));
    const orderMatch = authority.allowedOrderPathTemplates.some((template) => pathMatchesTemplate(path, template));
    if (regularMatch === orderMatch)
        denyShadowRead('path-denied');
    return { path, orderPath: orderMatch };
}
function validateQuery(query, allowed) {
    if (!isRecord(query))
        denyShadowRead('query-denied');
    for (const [key, value] of Object.entries(query)) {
        if (!allowed.has(key)
            || FORBIDDEN_QUERY_KEY.test(key)
            || typeof value !== 'string'
            || value.length > 512
            || /[\u0000-\u001f\u007f]/.test(value)
            || FORBIDDEN_QUERY_VALUE.test(value.trim())
            || EMAIL_VALUE.test(value.trim())) {
            denyShadowRead('query-denied');
        }
    }
    return query;
}
function responseIsValid(value) {
    return isRecord(value)
        && hasExactKeys(value, RESPONSE_KEYS)
        && Number.isInteger(value.status)
        && Number(value.status) >= 100
        && Number(value.status) <= 599
        && Array.isArray(value.records);
}
function safeError(value) {
    return value instanceof ShadowReadError ? value : new ShadowReadError('upstream-failure');
}
export function createFixtureReadTransport(rawConfig, rawDependencies = {}) {
    const { config, authorities } = validateConfig(rawConfig);
    const dependencies = validateDependencies(rawDependencies);
    const dispatcher = dependencies.dispatcher;
    const clock = dependencies.clock ?? (() => new Date());
    const events = [];
    let sequence = 0;
    const record = (base, outcome, status, errorCode) => {
        const event = Object.freeze({
            sequence: ++sequence,
            ...base,
            outcome,
            status,
            errorCode,
            fixtureOnly: true,
            liveProof: false,
        });
        events.push(event);
        return event;
    };
    const request = async (rawRequest) => {
        if (!isRecord(rawRequest) || !hasExactKeys(rawRequest, REQUEST_KEYS)) {
            denyShadowRead('configuration-denied');
        }
        const source = rawRequest.source;
        if (source !== 'shopify' && source !== 'ebay')
            denyShadowRead('configuration-denied');
        const authority = authorities[source];
        const method = rawRequest.method;
        if (method !== 'GET' && method !== 'HEAD')
            denyShadowRead('method-denied');
        const pageNumber = rawRequest.pageNumber;
        if (!Number.isInteger(pageNumber) || pageNumber < 1)
            denyShadowRead('configuration-denied');
        if (pageNumber > config.limits.maxPages)
            denyShadowRead('page-cap-exceeded');
        const pathValidation = validatePath(rawRequest.path, authority);
        const path = pathValidation.path;
        const suppliedQuery = validateQuery(rawRequest.query, authority.allowedQueryParameters);
        let query = suppliedQuery;
        if (pathValidation.orderPath) {
            if (rawRequest.orderWindow === null)
                denyShadowRead('order-window-denied');
            query = Object.freeze({
                ...suppliedQuery,
                ...orderWindowQueryForTransport(rawRequest.orderWindow, source),
            });
        }
        else if (rawRequest.orderWindow !== null) {
            denyShadowRead('order-window-denied');
        }
        if (!stringArray(rawRequest.requiredScopes))
            denyShadowRead('token-scope-denied');
        const base = { source, method, host: authority.host, path, pageNumber };
        let attempted = false;
        let responseStatus = null;
        try {
            const now = clock();
            if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
                denyShadowRead('configuration-denied');
            }
            assertEphemeralReadAuthorizedForTransport(rawRequest.token, source, rawRequest.requiredScopes, now.toISOString());
            record(base, 'attempted', null, null);
            attempted = true;
            if (!dispatcher)
                denyShadowRead('transport-unavailable');
            const url = new URL(`https://${authority.host}${path}`);
            for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
                url.searchParams.append(key, value);
            }
            const controller = new AbortController();
            let timeout;
            const timeoutPromise = new Promise((_resolve, reject) => {
                timeout = setTimeout(() => {
                    controller.abort();
                    reject(new ShadowReadError('transport-timeout'));
                }, config.limits.timeoutMs);
            });
            let response;
            try {
                response = await Promise.race([
                    Promise.resolve().then(() => dispatcher(Object.freeze({
                        method,
                        url: url.toString(),
                        headers: Object.freeze({ Accept: 'application/json' }),
                        authority: Object.freeze({
                            kind: 'validated-ephemeral-read-token',
                            secretExposed: false,
                        }),
                        redirect: 'error',
                        signal: controller.signal,
                    }))),
                    timeoutPromise,
                ]);
            }
            finally {
                if (timeout !== undefined)
                    clearTimeout(timeout);
            }
            if (!responseIsValid(response))
                denyShadowRead('upstream-failure');
            responseStatus = response.status;
            if (response.status < 200 || response.status >= 300) {
                denyShadowRead('upstream-status-denied');
            }
            if (method === 'HEAD' && response.records.length !== 0) {
                denyShadowRead('upstream-failure');
            }
            const sanitized = sanitizeFixtureRecords(response.records, config.limits.maxRecords, config.limits.maxResponseBytes);
            const metadata = record(base, 'succeeded', response.status, null);
            return Object.freeze({
                status: response.status,
                records: sanitized.records,
                recordCount: sanitized.recordCount,
                responseBytes: sanitized.responseBytes,
                datasetDigest: sanitized.datasetDigest,
                metadata,
                provenance: Object.freeze({
                    method: 'injected-fixture-read',
                    attestation: 'not-runtime-observed',
                    fixtureOnly: true,
                    liveProof: false,
                    productionParity: false,
                }),
            });
        }
        catch (rawError) {
            const error = safeError(rawError);
            record(base, !attempted || error.code === 'transport-unavailable' || error.code.endsWith('-denied')
                ? 'denied'
                : 'failed', responseStatus, error.code);
            throw error;
        }
    };
    return Object.freeze({
        request,
        auditEvents: () => Object.freeze([...events]),
        policy: Object.freeze({
            shopifyHost: config.shopify.host,
            shopifyStoreDomain: config.shopify.storeDomain,
            ebayHost: config.ebay.host,
            ebayEnvironment: config.ebay.environment,
            ebaySellerAccount: config.ebay.sellerAccount,
            ebayMarketplaceId: config.ebay.marketplaceId,
            limits: config.limits,
            fixtureOnly: true,
            liveProof: false,
        }),
    });
}
