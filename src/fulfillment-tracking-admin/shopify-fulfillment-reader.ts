import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { createProductionShopifyOrderTokenProvider } from '../order-import-admin/shopify-order-adapter.js';
import type { ShopifyFulfillmentOrder } from './manifest.js';

const GRAPHQL_URL = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}`
  + `/admin/api/${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.adminApiVersion}/graphql.json`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ORDER_GID = /^gid:\/\/shopify\/Order\/[^/\s]+$/;
const REQUEST_TIMEOUT_MS = 20_000;

export class ShopifyFulfillmentReadError extends Error {
  constructor(readonly code:
    | 'FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE'
    | 'FULFILLMENT_SHOPIFY_TARGET_INVALID'
    | 'FULFILLMENT_SHOPIFY_READ_FAILED') {
    super('Shopify fulfillment read denied');
    this.name = 'ShopifyFulfillmentReadError';
  }
}

const deny = (code: ConstructorParameters<typeof ShopifyFulfillmentReadError>[0]): never => {
  throw new ShopifyFulfillmentReadError(code);
};

type FetchLike = typeof fetch;

const ORDER_QUERY = `query FulfillmentTrackingOrder($id: ID!) {
  shop { id myshopifyDomain }
  order(id: $id) {
    id
    lineItems(first: 100) { nodes { id quantity } }
    fulfillments(first: 10) {
      id status createdAt
      trackingInfo(first: 10) { company number }
      fulfillmentLineItems(first: 100) { nodes { quantity lineItem { id } } }
    }
  }
}`;

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : deny('FULFILLMENT_SHOPIFY_READ_FAILED');
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : deny('FULFILLMENT_SHOPIFY_READ_FAILED');
}

function text(value: unknown, maximum = 256): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : deny('FULFILLMENT_SHOPIFY_READ_FAILED');
}

function quantity(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : deny('FULFILLMENT_SHOPIFY_READ_FAILED');
}

export type ShopifyFulfillmentReader = Readonly<{
  getOrder: (orderGid: string) => Promise<ShopifyFulfillmentOrder>;
}>;

export function createShopifyFulfillmentReader(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
}>): ShopifyFulfillmentReader {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return Object.freeze({
    getOrder: async (orderGid: string): Promise<ShopifyFulfillmentOrder> => {
      if (!ORDER_GID.test(orderGid)) deny('FULFILLMENT_SHOPIFY_TARGET_INVALID');
      let token = '';
      try {
        token = await dependencies.getAccessToken();
      } catch {
        deny('FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE');
      }
      if (!token || token.length > 4_096) deny('FULFILLMENT_SHOPIFY_AUTHORITY_UNAVAILABLE');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            operationName: 'FulfillmentTrackingOrder',
            query: ORDER_QUERY,
            variables: { id: orderGid },
          }),
          redirect: 'error',
          signal: controller.signal,
        });
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          deny('FULFILLMENT_SHOPIFY_READ_FAILED');
        }
        const body = await response.text();
        if (!response.ok || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
          deny('FULFILLMENT_SHOPIFY_READ_FAILED');
        }
        const parsed = record(JSON.parse(body));
        if (parsed.errors !== undefined) deny('FULFILLMENT_SHOPIFY_READ_FAILED');
        const data = record(parsed.data);
        const shop = record(data.shop);
        if (shop.id !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.shopGid
          || shop.myshopifyDomain !== PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain) {
          deny('FULFILLMENT_SHOPIFY_READ_FAILED');
        }
        const order = record(data.order);
        if (order.id !== orderGid) deny('FULFILLMENT_SHOPIFY_READ_FAILED');
        const lineItems = array(record(order.lineItems).nodes).map((raw) => {
          const item = record(raw);
          return Object.freeze({ lineItemGid: text(item.id), quantity: quantity(item.quantity) });
        });
        const fulfillments = array(order.fulfillments).map((raw) => {
          const fulfillment = record(raw);
          const tracking = array(fulfillment.trackingInfo).map((rawTracking) => {
            const item = record(rawTracking);
            return Object.freeze({
              company: typeof item.company === 'string' ? item.company.slice(0, 128) : null,
              number: text(item.number, 128),
            });
          });
          const fulfillmentLineItems = array(record(fulfillment.fulfillmentLineItems).nodes)
            .map((rawLine) => {
              const line = record(rawLine);
              return Object.freeze({
                lineItemGid: text(record(line.lineItem).id),
                quantity: quantity(line.quantity),
              });
            });
          return Object.freeze({
            fulfillmentGid: text(fulfillment.id),
            status: text(fulfillment.status, 32),
            createdAtUtc: text(fulfillment.createdAt, 64),
            tracking: Object.freeze(tracking),
            lineItems: Object.freeze(fulfillmentLineItems),
          });
        });
        return Object.freeze({
          orderGid,
          lineItems: Object.freeze(lineItems),
          fulfillments: Object.freeze(fulfillments),
        });
      } catch (error) {
        if (error instanceof ShopifyFulfillmentReadError) throw error;
        return deny('FULFILLMENT_SHOPIFY_READ_FAILED');
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

export function createProductionShopifyFulfillmentReader(): ShopifyFulfillmentReader {
  return createShopifyFulfillmentReader({
    getAccessToken: createProductionShopifyOrderTokenProvider(),
  });
}
