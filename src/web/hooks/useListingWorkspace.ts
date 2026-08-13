import { useQuery } from '@tanstack/react-query';
import { apiClient } from './useApi';
import type { AuthoritativeListingItem } from './useAuthoritativeListings';

export interface WorkspaceMoney {
  value: string;
  currency: string;
}

export interface WorkspaceContent {
  title: string | null;
  descriptionHtml: string | null;
  imageUrls: readonly string[];
}

export interface WorkspaceCondition {
  id: string | null;
  name: string | null;
  description: string | null;
  descriptors: ReadonlyArray<{
    name: string;
    values: readonly string[];
    additionalInfo: string | null;
  }>;
}

export interface WorkspaceIdentifiers {
  brand: string | null;
  mpn: string | null;
  upc: readonly string[];
  ean: readonly string[];
  isbn: readonly string[];
  epid: string | null;
}

export interface EbayListingDetail {
  schemaVersion: 1;
  evidence: {
    source: 'ebay-trading-get-item' | 'ebay-trading-get-item+ebay-inventory-detail';
    observedAtUtc: string;
    complete: true;
    remoteReadPerformed: true;
    externalWritesPerformed: 0;
    requestCount: 2 | 4;
  };
  identity: {
    sellerId: 'usedcameragear';
    marketplaceId: 'EBAY_US';
    mappingState: 'mapped' | 'ebay_only_unmapped';
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    sku: string;
    listingId: string;
    publicListingUrl: string | null;
    offerId: string | null;
  };
  actual: {
    lifecycle: {
      status: string;
      active: boolean;
      format: string | null;
      duration: string | null;
      startAtUtc: string | null;
      endAtUtc: string | null;
    };
    content: WorkspaceContent;
    category: {
      primary: { id: string; name: string | null };
      secondary: { id: string; name: string | null } | null;
      storeCategories: ReadonlyArray<{ id: string; name: string | null }>;
    };
    condition: WorkspaceCondition;
    aspects: Readonly<Record<string, readonly string[]>>;
    identifiers: WorkspaceIdentifiers;
    commerce: {
      price: WorkspaceMoney | null;
      totalQuantity: number | null;
      soldQuantity: number | null;
      availableQuantity: number | null;
      availableQuantityBasis: 'reported' | 'total_minus_sold' | 'unavailable';
      bestOfferEnabled: boolean | null;
    };
    policies: {
      fulfillmentPolicyId: string | null;
      paymentPolicyId: string | null;
      returnPolicyId: string | null;
      paymentMethods: readonly string[];
      shippingType: string | null;
      domesticServices: readonly string[];
      internationalServices: readonly string[];
      returnsAccepted: boolean | null;
      returnPeriod: string | null;
      returnShippingCostPayer: string | null;
    };
    location: {
      publicLocation: string | null;
      countryCode: string | null;
    };
  };
  management: {
    model: 'legacy_trading' | 'inventory_offer';
    controlApi: 'trading' | 'inventory';
    joinKey: 'exact_raw_sku';
    exactBindings: {
      seller: true;
      listing: true;
      sku: true;
      inventoryItem: boolean;
      offer: boolean;
      offerToListing: boolean;
    };
    lifecycleAligned: boolean;
    inventoryItem: {
      sku: string;
      content: WorkspaceContent;
      condition: WorkspaceCondition;
      aspects: Readonly<Record<string, readonly string[]>>;
      identifiers: WorkspaceIdentifiers;
      shipToLocationQuantity: number | null;
    } | null;
    offer: {
      offerId: string;
      sku: string;
      marketplaceId: string;
      status: string;
      listingStatus: string;
      listingOnHold: boolean | null;
      soldQuantity: number | null;
      format: string | null;
      duration: string | null;
      descriptionHtml: string | null;
      primaryCategoryId: string;
      secondaryCategoryId: string | null;
      storeCategoryNames: readonly string[];
      price: WorkspaceMoney | null;
      availableQuantity: number | null;
      quantityLimitPerBuyer: number | null;
      bestOfferEnabled: boolean | null;
      autoAcceptPrice: WorkspaceMoney | null;
      autoDeclinePrice: WorkspaceMoney | null;
      fulfillmentPolicyId: string | null;
      paymentPolicyId: string | null;
      returnPolicyId: string | null;
      merchantLocationKey: string | null;
      includeCatalogProductDetails: boolean | null;
    } | null;
  };
}

export interface ListingWorkspaceResponse {
  schemaVersion: 1;
  evidence: {
    catalogObservedAtUtc: string;
    detailObservedAtUtc: string | null;
    freshness: 'live';
    backgroundRefreshSeconds: 60;
    remoteReadPerformed: boolean;
    externalWritesPerformed: 0;
  };
  catalog: AuthoritativeListingItem;
  mapping: {
    state: 'mapped' | 'shopify_only' | 'ebay_only_unmapped' | 'attention';
    joinKey: 'exact_raw_sku';
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    inventorySku: string | null;
    offerId: string | null;
    listingId: string | null;
    managementModel: 'inventory_offer' | 'legacy_trading' | 'none';
    ownership: {
      listing: 'unverified';
      mapping: 'unverified';
      price: 'marketplace_connect';
      inventory: 'marketplace_connect';
    };
    editMode: 'read_only';
  };
  ebayDetail: EbayListingDetail | null;
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const validDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
const nonnegativeIntegerOrNull = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
const booleanOrNull = (value: unknown): value is boolean | null =>
  value === null || typeof value === 'boolean';
const strings = (value: unknown, maximum = 100): value is string[] =>
  Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string');

const money = (value: unknown): value is WorkspaceMoney =>
  record(value) && typeof value.value === 'string' && typeof value.currency === 'string';

const content = (value: unknown): value is WorkspaceContent =>
  record(value) && stringOrNull(value.title) && stringOrNull(value.descriptionHtml)
  && strings(value.imageUrls, 24);

const identifiers = (value: unknown): value is WorkspaceIdentifiers =>
  record(value) && stringOrNull(value.brand) && stringOrNull(value.mpn)
  && strings(value.upc, 24) && strings(value.ean, 24) && strings(value.isbn, 24)
  && stringOrNull(value.epid);

const condition = (value: unknown): value is WorkspaceCondition => {
  if (!record(value) || !stringOrNull(value.id) || !stringOrNull(value.name)
    || !stringOrNull(value.description) || !Array.isArray(value.descriptors)
    || value.descriptors.length > 24) return false;
  return value.descriptors.every((descriptor) => record(descriptor)
    && typeof descriptor.name === 'string' && strings(descriptor.values, 24)
    && stringOrNull(descriptor.additionalInfo));
};

const aspects = (value: unknown): value is Readonly<Record<string, readonly string[]>> =>
  record(value) && Object.keys(value).length <= 200
  && Object.entries(value).every(([key, values]) => key.length > 0 && strings(values, 24));

const category = (value: unknown): value is { id: string; name: string | null } =>
  record(value) && typeof value.id === 'string' && stringOrNull(value.name);

const ebayDetail = (value: unknown): value is EbayListingDetail => {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.evidence)
    || !['ebay-trading-get-item', 'ebay-trading-get-item+ebay-inventory-detail']
      .includes(String(value.evidence.source))
    || !validDate(value.evidence.observedAtUtc) || value.evidence.complete !== true
    || value.evidence.remoteReadPerformed !== true || value.evidence.externalWritesPerformed !== 0
    || ![2, 4].includes(Number(value.evidence.requestCount)) || !record(value.identity)
    || value.identity.sellerId !== 'usedcameragear' || value.identity.marketplaceId !== 'EBAY_US'
    || !['mapped', 'ebay_only_unmapped'].includes(String(value.identity.mappingState))
    || !stringOrNull(value.identity.shopifyProductId)
    || !stringOrNull(value.identity.shopifyVariantId) || typeof value.identity.sku !== 'string'
    || typeof value.identity.listingId !== 'string'
    || !stringOrNull(value.identity.publicListingUrl) || !stringOrNull(value.identity.offerId)
    || !record(value.actual) || !record(value.actual.lifecycle)
    || typeof value.actual.lifecycle.status !== 'string'
    || typeof value.actual.lifecycle.active !== 'boolean'
    || !stringOrNull(value.actual.lifecycle.format) || !stringOrNull(value.actual.lifecycle.duration)
    || !stringOrNull(value.actual.lifecycle.startAtUtc) || !stringOrNull(value.actual.lifecycle.endAtUtc)
    || !content(value.actual.content) || !record(value.actual.category)
    || !category(value.actual.category.primary)
    || !(value.actual.category.secondary === null || category(value.actual.category.secondary))
    || !Array.isArray(value.actual.category.storeCategories)
    || value.actual.category.storeCategories.length > 24
    || !value.actual.category.storeCategories.every(category)
    || !condition(value.actual.condition) || !aspects(value.actual.aspects)
    || !identifiers(value.actual.identifiers) || !record(value.actual.commerce)
    || !(value.actual.commerce.price === null || money(value.actual.commerce.price))
    || !nonnegativeIntegerOrNull(value.actual.commerce.totalQuantity)
    || !nonnegativeIntegerOrNull(value.actual.commerce.soldQuantity)
    || !nonnegativeIntegerOrNull(value.actual.commerce.availableQuantity)
    || !['reported', 'total_minus_sold', 'unavailable']
      .includes(String(value.actual.commerce.availableQuantityBasis))
    || !booleanOrNull(value.actual.commerce.bestOfferEnabled)
    || !record(value.actual.policies) || !stringOrNull(value.actual.policies.fulfillmentPolicyId)
    || !stringOrNull(value.actual.policies.paymentPolicyId)
    || !stringOrNull(value.actual.policies.returnPolicyId)
    || !strings(value.actual.policies.paymentMethods, 24)
    || !stringOrNull(value.actual.policies.shippingType)
    || !strings(value.actual.policies.domesticServices, 24)
    || !strings(value.actual.policies.internationalServices, 24)
    || !booleanOrNull(value.actual.policies.returnsAccepted)
    || !stringOrNull(value.actual.policies.returnPeriod)
    || !stringOrNull(value.actual.policies.returnShippingCostPayer)
    || !record(value.actual.location) || !stringOrNull(value.actual.location.publicLocation)
    || !stringOrNull(value.actual.location.countryCode) || !record(value.management)
    || !['legacy_trading', 'inventory_offer'].includes(String(value.management.model))
    || !['trading', 'inventory'].includes(String(value.management.controlApi))
    || value.management.joinKey !== 'exact_raw_sku' || !record(value.management.exactBindings)
    || value.management.exactBindings.seller !== true
    || value.management.exactBindings.listing !== true
    || value.management.exactBindings.sku !== true
    || typeof value.management.exactBindings.inventoryItem !== 'boolean'
    || typeof value.management.exactBindings.offer !== 'boolean'
    || typeof value.management.exactBindings.offerToListing !== 'boolean'
    || typeof value.management.lifecycleAligned !== 'boolean') return false;

  if (value.management.model === 'legacy_trading') {
    return value.management.controlApi === 'trading'
      && value.management.inventoryItem === null && value.management.offer === null;
  }

  if (value.management.controlApi !== 'inventory' || !record(value.management.inventoryItem)
    || !record(value.management.offer)) return false;
  const item = value.management.inventoryItem;
  const offer = value.management.offer;
  return typeof item.sku === 'string' && content(item.content) && condition(item.condition)
    && aspects(item.aspects) && identifiers(item.identifiers)
    && nonnegativeIntegerOrNull(item.shipToLocationQuantity)
    && typeof offer.offerId === 'string' && typeof offer.sku === 'string'
    && typeof offer.marketplaceId === 'string' && typeof offer.status === 'string'
    && typeof offer.listingStatus === 'string' && booleanOrNull(offer.listingOnHold)
    && nonnegativeIntegerOrNull(offer.soldQuantity) && stringOrNull(offer.format)
    && stringOrNull(offer.duration) && stringOrNull(offer.descriptionHtml)
    && typeof offer.primaryCategoryId === 'string' && stringOrNull(offer.secondaryCategoryId)
    && strings(offer.storeCategoryNames, 24) && (offer.price === null || money(offer.price))
    && nonnegativeIntegerOrNull(offer.availableQuantity)
    && nonnegativeIntegerOrNull(offer.quantityLimitPerBuyer)
    && booleanOrNull(offer.bestOfferEnabled)
    && (offer.autoAcceptPrice === null || money(offer.autoAcceptPrice))
    && (offer.autoDeclinePrice === null || money(offer.autoDeclinePrice))
    && stringOrNull(offer.fulfillmentPolicyId) && stringOrNull(offer.paymentPolicyId)
    && stringOrNull(offer.returnPolicyId) && stringOrNull(offer.merchantLocationKey)
    && booleanOrNull(offer.includeCatalogProductDetails);
};

const catalogItem = (value: unknown): value is AuthoritativeListingItem => {
  if (!record(value) || typeof value.id !== 'string' || !record(value.ebay)
    || typeof value.ebay.sku !== 'string'
    || !['active', 'not_listed', 'attention', 'unknown'].includes(String(value.lifecycleStatus))
    || value.ebay.state !== value.lifecycleStatus || !stringOrNull(value.ebay.listingId)
    || !stringOrNull(value.ebay.offerId) || !stringOrNull(value.ebay.url)
    || !nonnegativeIntegerOrNull(value.ebay.activeMatchCount)
    || !nonnegativeIntegerOrNull(value.ebay.inventoryItemCount)
    || !nonnegativeIntegerOrNull(value.ebay.offerCount)
    || !nonnegativeIntegerOrNull(value.ebay.unpublishedArtifactCount)
    || !validDate(value.lastVerifiedAtUtc) || !record(value.audit)
    || typeof value.audit.verified !== 'boolean' || typeof value.audit.evidenceState !== 'string'
    || !nonnegativeIntegerOrNull(value.audit.unresolvedCount)
    || !strings(value.audit.attentionReasons, 20)
    || value.audit.recoverySupported !== false
    || typeof value.audit.currentRemoteStateVerified !== 'boolean') return false;
  if (value.shopify === null) return true;
  return record(value.shopify) && typeof value.shopify.productId === 'string'
    && typeof value.shopify.variantId === 'string' && typeof value.shopify.sku === 'string'
    && typeof value.shopify.title === 'string' && typeof value.shopify.variantTitle === 'string'
    && typeof value.shopify.productStatus === 'string' && stringOrNull(value.shopify.primaryImageUrl)
    && Number.isSafeInteger(value.shopify.imageCount) && Number(value.shopify.imageCount) >= 0
    && (value.shopify.available === null || Number.isSafeInteger(value.shopify.available))
    && record(value.shopify.price)
    && typeof value.shopify.price.amount === 'string'
    && typeof value.shopify.price.currency === 'string';
};

export const isListingWorkspaceResponse = (
  value: unknown,
  expectedCatalogId?: string,
): value is ListingWorkspaceResponse => {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.evidence)
    || !validDate(value.evidence.catalogObservedAtUtc)
    || !stringOrNull(value.evidence.detailObservedAtUtc)
    || (value.evidence.detailObservedAtUtc !== null
      && !validDate(value.evidence.detailObservedAtUtc))
    || value.evidence.freshness !== 'live' || value.evidence.backgroundRefreshSeconds !== 60
    || typeof value.evidence.remoteReadPerformed !== 'boolean'
    || value.evidence.externalWritesPerformed !== 0 || !catalogItem(value.catalog)
    || (expectedCatalogId !== undefined && value.catalog.id !== expectedCatalogId)
    || !record(value.mapping)
    || !['mapped', 'shopify_only', 'ebay_only_unmapped', 'attention']
      .includes(String(value.mapping.state))
    || value.mapping.joinKey !== 'exact_raw_sku'
    || !stringOrNull(value.mapping.shopifyProductId)
    || !stringOrNull(value.mapping.shopifyVariantId)
    || !stringOrNull(value.mapping.inventorySku) || !stringOrNull(value.mapping.offerId)
    || !stringOrNull(value.mapping.listingId)
    || !['inventory_offer', 'legacy_trading', 'none']
      .includes(String(value.mapping.managementModel))
    || !record(value.mapping.ownership)
    || value.mapping.ownership.listing !== 'unverified'
    || value.mapping.ownership.mapping !== 'unverified'
    || value.mapping.ownership.price !== 'marketplace_connect'
    || value.mapping.ownership.inventory !== 'marketplace_connect'
    || value.mapping.editMode !== 'read_only'
    || !(value.ebayDetail === null || ebayDetail(value.ebayDetail))) return false;

  if ((value.ebayDetail !== null) !== value.evidence.remoteReadPerformed
    || (value.ebayDetail === null) !== (value.evidence.detailObservedAtUtc === null)
    || value.mapping.shopifyProductId !== (value.catalog.shopify?.productId ?? null)
    || value.mapping.shopifyVariantId !== (value.catalog.shopify?.variantId ?? null)
    || value.mapping.offerId !== value.catalog.ebay.offerId
    || value.mapping.listingId !== value.catalog.ebay.listingId) return false;

  if (value.ebayDetail === null) {
    if (value.mapping.managementModel !== 'none') return false;
    if (value.mapping.listingId === null) return true;
    return value.mapping.inventorySku === null
      && (value.mapping.state === 'attention'
        || value.mapping.state === 'ebay_only_unmapped');
  }
  return value.ebayDetail.evidence.observedAtUtc === value.evidence.detailObservedAtUtc
    && value.ebayDetail.identity.shopifyProductId === value.mapping.shopifyProductId
    && value.ebayDetail.identity.shopifyVariantId === value.mapping.shopifyVariantId
    && value.ebayDetail.identity.sku === value.mapping.inventorySku
    && value.ebayDetail.identity.listingId === value.mapping.listingId
    && value.ebayDetail.identity.offerId === value.mapping.offerId
    && value.ebayDetail.management.model === value.mapping.managementModel;
};

export const useListingWorkspace = (id: string | undefined) =>
  useQuery({
    queryKey: ['listing-workspace-v1', id],
    queryFn: () => apiClient.get<ListingWorkspaceResponse>(
      `/listing-workspace?id=${encodeURIComponent(id ?? '')}`,
    ),
    enabled: Boolean(id),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
