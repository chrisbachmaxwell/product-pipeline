import { ShadowReadError, denyShadowRead, type ShadowReadErrorCode } from './errors.js';
import { sanitizeFixtureRecords } from './fixture-data.js';
import { validateReadLimits, type ReadLimits } from './limits.js';
import {
  orderWindowQueryForTransport,
  type BoundedOrderReadWindow,
} from './order-window.js';
import {
  assertEphemeralReadAuthorizedForTransport,
  type ReadProvider,
  type ValidatedEphemeralReadToken,
} from './token.js';

export type ReadMethod = 'GET' | 'HEAD';

export type ShopifyReadAuthority = Readonly<{
  host: string;
  storeDomain: string;
  allowedPathTemplates: readonly string[];
  allowedOrderPathTemplates: readonly string[];
  allowedQueryParameters: readonly string[];
}>;

export type EbayReadAuthority = Readonly<{
  host: string;
  environment: 'sandbox' | 'production';
  sellerAccount: string;
  marketplaceId: 'EBAY_US';
  allowedPathTemplates: readonly string[];
  allowedOrderPathTemplates: readonly string[];
  allowedQueryParameters: readonly string[];
}>;

export type FixtureReadTransportConfig = Readonly<{
  shopify: ShopifyReadAuthority;
  ebay: EbayReadAuthority;
  limits: ReadLimits;
}>;

export type FixtureReadRequest = Readonly<{
  source: ReadProvider;
  method: ReadMethod;
  path: string;
  query: Readonly<Record<string, string>>;
  pageNumber: number;
  requiredScopes: readonly string[];
  token: ValidatedEphemeralReadToken;
  orderWindow: BoundedOrderReadWindow | null;
}>;

/** The request has deliberately no body, redirect override, or credential mode. */
export type InjectedFixtureReadRequest = Readonly<{
  method: ReadMethod;
  url: string;
  headers: Readonly<{ Accept: 'application/json' }>;
  authority: Readonly<{
    kind: 'validated-ephemeral-read-token';
    secretExposed: false;
  }>;
  redirect: 'error';
  signal: AbortSignal;
}>;

export type InjectedFixtureReadResponse<T = unknown> = Readonly<{
  status: number;
  records: readonly T[];
}>;

/** Test/fixture seam only. There is intentionally no global-fetch implementation. */
export type FixtureReadDispatcher = (
  request: InjectedFixtureReadRequest,
) => Promise<InjectedFixtureReadResponse<unknown>>;

export type ReadAuditEvent = Readonly<{
  sequence: number;
  source: ReadProvider;
  method: ReadMethod;
  host: string;
  path: string;
  pageNumber: number;
  outcome: 'attempted' | 'succeeded' | 'denied' | 'failed';
  status: number | null;
  errorCode: ShadowReadErrorCode | null;
  fixtureOnly: true;
  liveProof: false;
}>;

export type FixtureReadResponse<T> = Readonly<{
  status: number;
  records: readonly T[];
  recordCount: number;
  responseBytes: number;
  datasetDigest: string;
  metadata: ReadAuditEvent;
  provenance: Readonly<{
    method: 'injected-fixture-read';
    attestation: 'not-runtime-observed';
    fixtureOnly: true;
    liveProof: false;
    productionParity: false;
  }>;
}>;

export type FixtureReadTransport = Readonly<{
  request: <T = unknown>(request: FixtureReadRequest) => Promise<FixtureReadResponse<T>>;
  auditEvents: () => readonly ReadAuditEvent[];
  policy: Readonly<{
    shopifyHost: string;
    shopifyStoreDomain: string;
    ebayHost: string;
    ebayEnvironment: 'sandbox' | 'production';
    ebaySellerAccount: string;
    ebayMarketplaceId: 'EBAY_US';
    limits: ReadLimits;
    fixtureOnly: true;
    liveProof: false;
  }>;
}>;

type FixtureReadTransportDependencies = Readonly<{
  dispatcher?: FixtureReadDispatcher;
  clock?: () => Date;
}>;

type CompiledAuthority = Readonly<{
  host: string;
  allowedPathTemplates: readonly string[];
  allowedOrderPathTemplates: readonly string[];
  allowedQueryParameters: ReadonlySet<string>;
}>;

const ROOT_KEYS = ['ebay', 'limits', 'shopify'] as const;
const SHOPIFY_KEYS = [
  'allowedOrderPathTemplates',
  'allowedPathTemplates',
  'allowedQueryParameters',
  'host',
  'storeDomain',
] as const;
const EBAY_KEYS = [
  'allowedOrderPathTemplates',
  'allowedPathTemplates',
  'allowedQueryParameters',
  'environment',
  'host',
  'marketplaceId',
  'sellerAccount',
] as const;
const REQUEST_KEYS = [
  'method',
  'orderWindow',
  'pageNumber',
  'path',
  'query',
  'requiredScopes',
  'source',
  'token',
] as const;
const RESPONSE_KEYS = ['records', 'status'] as const;
const DEPENDENCY_KEYS = ['clock', 'dispatcher'] as const;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string');
}

function validTemplate(template: string): boolean {
  if (
    !template.startsWith('/')
    || template === '/'
    || template.endsWith('/')
    || template.includes('//')
    || /[?#\\\s%]/.test(template)
  ) {
    return false;
  }
  return template.slice(1).split('/').every((segment) =>
    TEMPLATE_LITERAL_SEGMENT.test(segment) || TEMPLATE_PARAMETER_SEGMENT.test(segment));
}

function validateAllowlist(
  pathTemplates: unknown,
  queryParameters: unknown,
): { pathTemplates: readonly string[]; queryParameters: ReadonlySet<string> } {
  if (
    !stringArray(pathTemplates)
    || pathTemplates.length === 0
    || new Set(pathTemplates).size !== pathTemplates.length
    || !pathTemplates.every(validTemplate)
    || !stringArray(queryParameters)
    || new Set(queryParameters).size !== queryParameters.length
    || !queryParameters.every((key) =>
      QUERY_KEY.test(key)
      && !FORBIDDEN_QUERY_KEY.test(key)
      && !RESERVED_ORDER_QUERY.has(key))
  ) {
    denyShadowRead('configuration-denied');
  }
  return {
    pathTemplates: Object.freeze([...pathTemplates]),
    queryParameters: new Set(queryParameters),
  };
}

function validateOrderPathAllowlist(
  source: ReadProvider,
  value: unknown,
): readonly string[] {
  const exactTemplate = source === 'shopify'
    ? SHOPIFY_ORDER_PATH_TEMPLATE
    : EBAY_ORDER_PATH_TEMPLATE;
  if (
    !stringArray(value)
    || value.length !== 1
    || value[0] !== exactTemplate
    || !validTemplate(value[0])
  ) {
    denyShadowRead('configuration-denied');
  }
  return Object.freeze([...value]);
}

function validateConfig(raw: unknown): {
  config: FixtureReadTransportConfig;
  authorities: Record<ReadProvider, CompiledAuthority>;
} {
  if (!isRecord(raw) || !hasExactKeys(raw, ROOT_KEYS)) {
    denyShadowRead('configuration-denied');
  }
  const shopify = raw.shopify;
  const ebay = raw.ebay;
  if (
    !isRecord(shopify)
    || !hasExactKeys(shopify, SHOPIFY_KEYS)
    || !isRecord(ebay)
    || !hasExactKeys(ebay, EBAY_KEYS)
  ) {
    denyShadowRead('configuration-denied');
  }

  const shopifyAllowlist = validateAllowlist(
    shopify.allowedPathTemplates,
    shopify.allowedQueryParameters,
  );
  const ebayAllowlist = validateAllowlist(ebay.allowedPathTemplates, ebay.allowedQueryParameters);
  const shopifyOrderPaths = validateOrderPathAllowlist('shopify', shopify.allowedOrderPathTemplates);
  const ebayOrderPaths = validateOrderPathAllowlist('ebay', ebay.allowedOrderPathTemplates);
  const limits = validateReadLimits(raw.limits);

  if (
    typeof shopify.host !== 'string'
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
    || ebayAllowlist.pathTemplates.includes(EBAY_ORDER_PATH_TEMPLATE)
  ) {
    denyShadowRead('configuration-denied');
  }

  const config: FixtureReadTransportConfig = Object.freeze({
    shopify: Object.freeze({
      host: shopify.host,
      storeDomain: shopify.storeDomain,
      allowedPathTemplates: shopifyAllowlist.pathTemplates,
      allowedOrderPathTemplates: shopifyOrderPaths,
      allowedQueryParameters: Object.freeze([...(shopify.allowedQueryParameters as string[])]),
    }),
    ebay: Object.freeze({
      host: ebay.host,
      environment: ebay.environment,
      sellerAccount: ebay.sellerAccount,
      marketplaceId: 'EBAY_US',
      allowedPathTemplates: ebayAllowlist.pathTemplates,
      allowedOrderPathTemplates: ebayOrderPaths,
      allowedQueryParameters: Object.freeze([...(ebay.allowedQueryParameters as string[])]),
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

function validateDependencies(raw: unknown): FixtureReadTransportDependencies {
  if (!isRecord(raw)) denyShadowRead('configuration-denied');
  const actual = Object.keys(raw).sort();
  if (!actual.every((key) => DEPENDENCY_KEYS.includes(key as (typeof DEPENDENCY_KEYS)[number]))) {
    denyShadowRead('configuration-denied');
  }
  if (raw.dispatcher !== undefined && typeof raw.dispatcher !== 'function') {
    denyShadowRead('configuration-denied');
  }
  if (raw.clock !== undefined && typeof raw.clock !== 'function') {
    denyShadowRead('configuration-denied');
  }
  return raw as FixtureReadTransportDependencies;
}

function decodePathSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || /[\u0000-\u001f\u007f\s]/.test(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function pathMatchesTemplate(path: string, template: string): boolean {
  const pathSegments = path.slice(1).split('/');
  const templateSegments = template.slice(1).split('/');
  if (pathSegments.length !== templateSegments.length) return false;

  return pathSegments.every((rawSegment, index) => {
    const decoded = decodePathSegment(rawSegment);
    if (decoded === null) return false;
    const templateSegment = templateSegments[index];
    return TEMPLATE_PARAMETER_SEGMENT.test(templateSegment)
      ? PATH_PARAMETER.test(decoded)
      : rawSegment === templateSegment;
  });
}

function validatePath(
  path: unknown,
  authority: CompiledAuthority,
): { path: string; orderPath: boolean } {
  if (
    typeof path !== 'string'
    || !path.startsWith('/')
    || path === '/'
    || path.endsWith('/')
    || path.includes('//')
    || /[?#\\\s]/.test(path)
  ) {
    denyShadowRead('path-denied');
  }
  const regularMatch = authority.allowedPathTemplates.some((template) =>
    pathMatchesTemplate(path, template));
  const orderMatch = authority.allowedOrderPathTemplates.some((template) =>
    pathMatchesTemplate(path, template));
  if (regularMatch === orderMatch) denyShadowRead('path-denied');
  return { path, orderPath: orderMatch };
}

function validateQuery(
  query: unknown,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (!isRecord(query)) denyShadowRead('query-denied');
  for (const [key, value] of Object.entries(query)) {
    if (
      !allowed.has(key)
      || FORBIDDEN_QUERY_KEY.test(key)
      || typeof value !== 'string'
      || value.length > 512
      || /[\u0000-\u001f\u007f]/.test(value)
      || FORBIDDEN_QUERY_VALUE.test(value.trim())
      || EMAIL_VALUE.test(value.trim())
    ) {
      denyShadowRead('query-denied');
    }
  }
  return query as Readonly<Record<string, string>>;
}

function responseIsValid(value: unknown): value is InjectedFixtureReadResponse<unknown> {
  return isRecord(value)
    && hasExactKeys(value, RESPONSE_KEYS)
    && Number.isInteger(value.status)
    && Number(value.status) >= 100
    && Number(value.status) <= 599
    && Array.isArray(value.records);
}

function safeError(value: unknown): ShadowReadError {
  return value instanceof ShadowReadError ? value : new ShadowReadError('upstream-failure');
}

export function createFixtureReadTransport(
  rawConfig: unknown,
  rawDependencies: unknown = {},
): FixtureReadTransport {
  const { config, authorities } = validateConfig(rawConfig);
  const dependencies = validateDependencies(rawDependencies);
  const dispatcher = dependencies.dispatcher;
  const clock = dependencies.clock ?? (() => new Date());
  const events: ReadAuditEvent[] = [];
  let sequence = 0;

  const record = (
    base: Pick<ReadAuditEvent, 'source' | 'method' | 'host' | 'path' | 'pageNumber'>,
    outcome: ReadAuditEvent['outcome'],
    status: number | null,
    errorCode: ShadowReadErrorCode | null,
  ): ReadAuditEvent => {
    const event = Object.freeze({
      sequence: ++sequence,
      ...base,
      outcome,
      status,
      errorCode,
      fixtureOnly: true as const,
      liveProof: false as const,
    });
    events.push(event);
    return event;
  };

  const request = async <T = unknown>(rawRequest: FixtureReadRequest): Promise<FixtureReadResponse<T>> => {
    if (!isRecord(rawRequest) || !hasExactKeys(rawRequest, REQUEST_KEYS)) {
      denyShadowRead('configuration-denied');
    }
    const source = rawRequest.source;
    if (source !== 'shopify' && source !== 'ebay') denyShadowRead('configuration-denied');
    const authority = authorities[source];
    const method = rawRequest.method;
    if (method !== 'GET' && method !== 'HEAD') denyShadowRead('method-denied');
    const pageNumber = rawRequest.pageNumber;
    if (!Number.isInteger(pageNumber) || pageNumber < 1) denyShadowRead('configuration-denied');
    if (pageNumber > config.limits.maxPages) denyShadowRead('page-cap-exceeded');
    const pathValidation = validatePath(rawRequest.path, authority);
    const path = pathValidation.path;
    const suppliedQuery = validateQuery(rawRequest.query, authority.allowedQueryParameters);
    let query: Readonly<Record<string, string>> = suppliedQuery;
    if (pathValidation.orderPath) {
      if (rawRequest.orderWindow === null) denyShadowRead('order-window-denied');
      query = Object.freeze({
        ...suppliedQuery,
        ...orderWindowQueryForTransport(rawRequest.orderWindow, source),
      });
    } else if (rawRequest.orderWindow !== null) {
      denyShadowRead('order-window-denied');
    }
    if (!stringArray(rawRequest.requiredScopes)) denyShadowRead('token-scope-denied');

    const base = { source, method, host: authority.host, path, pageNumber } as const;
    let attempted = false;
    let responseStatus: number | null = null;
    try {
      const now = clock();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        denyShadowRead('configuration-denied');
      }
      assertEphemeralReadAuthorizedForTransport(
        rawRequest.token,
        source,
        rawRequest.requiredScopes,
        now.toISOString(),
      );
      record(base, 'attempted', null, null);
      attempted = true;
      if (!dispatcher) denyShadowRead('transport-unavailable');

      const url = new URL(`https://${authority.host}${path}`);
      for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
        url.searchParams.append(key, value);
      }

      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new ShadowReadError('transport-timeout'));
        }, config.limits.timeoutMs);
      });

      let response: unknown;
      try {
        response = await Promise.race([
          Promise.resolve().then(() => dispatcher(Object.freeze({
            method,
            url: url.toString(),
            headers: Object.freeze({ Accept: 'application/json' as const }),
            authority: Object.freeze({
              kind: 'validated-ephemeral-read-token' as const,
              secretExposed: false as const,
            }),
            redirect: 'error' as const,
            signal: controller.signal,
          }))),
          timeoutPromise,
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }

      if (!responseIsValid(response)) denyShadowRead('upstream-failure');
      responseStatus = response.status;
      if (response.status < 200 || response.status >= 300) {
        denyShadowRead('upstream-status-denied');
      }
      if (method === 'HEAD' && response.records.length !== 0) {
        denyShadowRead('upstream-failure');
      }
      const sanitized = sanitizeFixtureRecords<T>(
        response.records,
        config.limits.maxRecords,
        config.limits.maxResponseBytes,
      );

      const metadata = record(base, 'succeeded', response.status, null);
      return Object.freeze({
        status: response.status,
        records: sanitized.records,
        recordCount: sanitized.recordCount,
        responseBytes: sanitized.responseBytes,
        datasetDigest: sanitized.datasetDigest,
        metadata,
        provenance: Object.freeze({
          method: 'injected-fixture-read' as const,
          attestation: 'not-runtime-observed' as const,
          fixtureOnly: true as const,
          liveProof: false as const,
          productionParity: false as const,
        }),
      });
    } catch (rawError) {
      const error = safeError(rawError);
      record(
        base,
        !attempted || error.code === 'transport-unavailable' || error.code.endsWith('-denied')
          ? 'denied'
          : 'failed',
        responseStatus,
        error.code,
      );
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
      fixtureOnly: true as const,
      liveProof: false as const,
    }),
  });
}
