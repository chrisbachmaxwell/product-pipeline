import { ebayRequest } from './client.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';

export interface EbayOrderLineItem {
  lineItemId: string;
  legacyItemId: string;
  title: string;
  sku: string;
  quantity: number;
  lineItemCost: { value: string; currency: string };
  deliveryCost?: { shippingCost?: { value: string; currency: string } };
  lineItemFulfillmentStatus: string;
}

export interface EbayShippingAddress {
  fullName: string;
  contactAddress: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateOrProvince: string;
    postalCode: string;
    countryCode: string;
  };
  primaryPhone?: { phoneNumber: string };
  email?: string;
}

export interface EbayOrder {
  orderId: string;
  legacyOrderId: string;
  creationDate: string;
  lastModifiedDate: string;
  orderFulfillmentStatus: string;
  orderPaymentStatus: string;
  pricingSummary: {
    total: { value: string; currency: string };
    subtotal?: { value: string; currency: string };
    deliveryCost?: { value: string; currency: string };
    tax?: { value: string; currency: string };
  };
  buyer: {
    username: string;
    taxAddress?: { stateOrProvince: string; postalCode: string; countryCode: string };
  };
  fulfillmentStartInstructions: Array<{
    shippingStep: {
      shipTo: EbayShippingAddress;
      shippingCarrierCode?: string;
      shippingServiceCode?: string;
    };
  }>;
  lineItems: EbayOrderLineItem[];
  salesRecordReference?: string;
  cancelStatus?: { cancelState: string };
}

export interface EbayOrdersResponse {
  href: string;
  total: number;
  limit: number;
  offset: number;
  orders: EbayOrder[];
  next?: string;
  prev?: string;
}

/**
 * Fetch eBay orders using the Fulfillment API.
 */
export const fetchEbayOrders = async (
  accessToken: string,
  options: {
    createdAfter?: string;
    modifiedAfter?: string;
    fulfillmentStatus?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<EbayOrdersResponse> => {
  const filters: string[] = [];

  if (options.createdAfter) {
    filters.push(`creationdate:[${options.createdAfter}..]`);
  }
  if (options.modifiedAfter) {
    filters.push(`lastmodifieddate:[${options.modifiedAfter}..]`);
  }
  if (options.fulfillmentStatus) {
    filters.push(`orderfulfillmentstatus:{${options.fulfillmentStatus}}`);
  }

  const params = new URLSearchParams();
  if (filters.length) params.set('filter', filters.join(','));
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  const query = params.toString();
  const path = `/sell/fulfillment/v1/order${query ? '?' + query : ''}`;

  return ebayRequest<EbayOrdersResponse>({ path, accessToken });
};

/**
 * Fetch ALL eBay orders with automatic pagination.
 */
export const fetchAllEbayOrders = async (
  accessToken: string,
  options: { createdAfter?: string; modifiedAfter?: string } = {},
): Promise<EbayOrder[]> => {
  const allOrders: EbayOrder[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const response = await fetchEbayOrders(accessToken, {
      ...options,
      limit,
      offset,
    });
    if (response.orders) {
      allOrders.push(...response.orders);
    }

    if (allOrders.length >= response.total || !response.next) break;
    offset += limit;
  }

  return allOrders;
};

/**
 * Fetch a single eBay order by ID.
 */
export const fetchEbayOrder = async (
  accessToken: string,
  orderId: string,
): Promise<EbayOrder> => {
  return ebayRequest<EbayOrder>({
    path: `/sell/fulfillment/v1/order/${orderId}`,
    accessToken,
  });
};

export interface EbayShippingFulfillmentInput {
  lineItems: Array<{
    lineItemId: string;
    quantity: number;
  }>;
  shippedDate: string; // ISO 8601
  shippingCarrierCode: string;
  trackingNumber: string;
}

/**
 * Create a shipping fulfillment for an eBay order.
 * POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
 */
export const createShippingFulfillment = async (
  accessToken: string,
  orderId: string,
  fulfillment: EbayShippingFulfillmentInput,
): Promise<{ fulfillmentId: string }> => {
  denyExternalWrite('fulfillment', 'create eBay shipping fulfillment');
  return ebayRequest<{ fulfillmentId: string }>({
    method: 'POST',
    path: `/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`,
    accessToken,
    body: fulfillment,
  });
};

/**
 * Get shipping fulfillments for an eBay order.
 */
export const getShippingFulfillments = async (
  accessToken: string,
  orderId: string,
): Promise<{ fulfillments: Array<{ fulfillmentId: string; shippedDate: string; trackingNumber?: string }> }> => {
  return ebayRequest({
    path: `/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`,
    accessToken,
  });
};
