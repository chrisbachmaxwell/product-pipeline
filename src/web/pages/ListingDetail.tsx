import React from 'react';
import {
  Badge,
  BlockStack,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useParams } from 'react-router-dom';
import {
  isListingWorkspaceResponse,
  useListingWorkspace,
} from '../hooks/useListingWorkspace';
import {
  descriptionSummary,
  formatListingPrice,
  formatListingQuantity,
  formatVerifiedAt,
  formatWorkspaceMoney,
  listingDisplaySku,
  listingDisplayTitle,
  listingSkuLabel,
  listingStatusLabel,
  listingStatusTone,
  verifiedEbayListingUrl,
  verifiedShopifyProductUrl,
} from '../operator-ui';

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <div>{children}</div>
  </BlockStack>
);

const Value: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text as="p" fontWeight="medium">{children}</Text>
);

const MappingNode: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <BlockStack gap="050">
    <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
    <Text as="span" fontWeight="semibold">{value}</Text>
  </BlockStack>
);

const Difference: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text as="p" variant="bodySm" tone="subdued">Shopify: {children}</Text>
);

const ListingDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const workspace = useListingWorkspace(id);

  if (workspace.isLoading) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card><SkeletonBodyText lines={8} /></Card>
      </Page>
    );
  }

  if (workspace.error || !isListingWorkspaceResponse(workspace.data, id)) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card>
          <EmptyState
            heading="Listing unavailable"
            image=""
            action={{ content: 'Try again', onAction: () => { void workspace.refetch(); } }}
          >
            <Text as="p">Current Shopify and eBay details are unavailable.</Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const { catalog, mapping, ebayDetail, evidence } = workspace.data;
  const actual = ebayDetail?.actual ?? null;
  const title = actual?.content.title ?? listingDisplayTitle(catalog);
  const sku = listingDisplaySku(catalog);
  const ebayUrl = verifiedEbayListingUrl(catalog.ebay.listingId, catalog.ebay.url);
  const shopifyUrl = verifiedShopifyProductUrl(catalog.shopify?.productId ?? null);
  const actualPrice = actual?.commerce.price ?? null;
  const shopifyPrice = catalog.shopify?.price ?? null;
  const actualQuantity = actual?.commerce.availableQuantity ?? null;
  const shopifyQuantity = catalog.shopify?.available ?? null;
  const priceDiffers = Boolean(actualPrice && shopifyPrice && (
    actualPrice.currency !== shopifyPrice.currency || actualPrice.value !== shopifyPrice.amount
  ));
  const quantityDiffers = actualQuantity !== null && shopifyQuantity !== null
    && actualQuantity !== shopifyQuantity;
  const titleDiffers = Boolean(actual?.content.title && catalog.shopify?.title
    && actual.content.title.trim() !== catalog.shopify.title.trim());
  const aspectEntries = actual ? Object.entries(actual.aspects).slice(0, 8) : [];
  const identifiers = actual ? [
    ['Brand', actual.identifiers.brand],
    ['MPN', actual.identifiers.mpn],
    ['UPC', actual.identifiers.upc.join(', ') || null],
    ['EAN', actual.identifiers.ean.join(', ') || null],
    ['ISBN', actual.identifiers.isbn.join(', ') || null],
    ['ePID', actual.identifiers.epid],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])) : [];
  const managementLabel = mapping.managementModel === 'inventory_offer'
    ? 'Inventory item'
    : mapping.managementModel === 'legacy_trading'
      ? 'Legacy listing'
      : 'Not listed';
  const category = actual
    ? `${actual.category.primary.name ?? 'Category'}${actual.category.primary.id
      ? ` · ${actual.category.primary.id}` : ''}`
    : '—';
  const observedAt = evidence.detailObservedAtUtc ?? evidence.catalogObservedAtUtc;

  return (
    <Page
      title={title || 'Listing'}
      subtitle={listingSkuLabel(sku)}
      backAction={{ content: 'Listings', url: '/listings' }}
      titleMetadata={(
        <InlineStack gap="200" blockAlign="center">
          <Badge tone={listingStatusTone(catalog.lifecycleStatus)}>
            {listingStatusLabel(catalog.lifecycleStatus)}
          </Badge>
          <Badge tone="info">Read only</Badge>
        </InlineStack>
      )}
      primaryAction={ebayUrl ? {
        content: 'View on eBay',
        url: ebayUrl,
        external: true,
      } : undefined}
      secondaryActions={shopifyUrl ? [{
        content: 'View in Shopify',
        url: shopifyUrl,
        external: true,
      }] : undefined}
      fullWidth
    >
      <BlockStack gap="400">
        <InlineStack align="end">
          <Text as="span" variant="bodySm" tone="subdued">
            {formatVerifiedAt(observedAt)} · refreshes every minute
          </Text>
        </InlineStack>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Mapping</Text>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="attention">Owner unverified</Badge>
                <Badge tone="info">Read only</Badge>
              </InlineStack>
            </InlineStack>
            <InlineStack gap="300" blockAlign="center" wrap>
              <MappingNode
                label="Shopify variant"
                value={catalog.shopify?.variantTitle !== 'Default Title'
                  ? catalog.shopify?.variantTitle ?? 'Not mapped'
                  : 'Default variant'}
              />
              <Text as="span" tone="subdued">→</Text>
              <MappingNode label="SKU" value={listingSkuLabel(mapping.inventorySku ?? sku)} />
              <Text as="span" tone="subdued">→</Text>
              <MappingNode label="Model" value={managementLabel} />
              {mapping.offerId && (
                <>
                  <Text as="span" tone="subdued">→</Text>
                  <MappingNode label="Offer" value={mapping.offerId} />
                </>
              )}
              <Text as="span" tone="subdued">→</Text>
              <MappingNode label="Listing" value={mapping.listingId ?? 'Not listed'} />
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
              <Fact label="State"><Value>{mapping.state.replaceAll('_', ' ')}</Value></Fact>
              <Fact label="Join"><Value>Exact SKU</Value></Fact>
              <Fact label="Shopify variant ID"><Value>{mapping.shopifyVariantId ?? '—'}</Value></Fact>
              <Fact label="Control API"><Value>{ebayDetail?.management.controlApi ?? '—'}</Value></Fact>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Listing</Text>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="attention">Owner unverified</Badge>
                <Badge tone="info">Read only</Badge>
              </InlineStack>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
              <Fact label="Status"><Value>{actual?.lifecycle.status ?? '—'}</Value></Fact>
              <Fact label="Title">
                <Value>{actual?.content.title ?? '—'}</Value>
                {titleDiffers && <Difference>{catalog.shopify?.title}</Difference>}
              </Fact>
              <Fact label="Category"><Value>{category}</Value></Fact>
              <Fact label="Condition">
                <Value>{actual?.condition.name ?? actual?.condition.id ?? '—'}</Value>
              </Fact>
              <Fact label={mapping.ownership.price === 'marketplace_connect'
                ? 'Price · Marketplace Connect' : 'Price'}>
                <Value>{formatWorkspaceMoney(actualPrice)}</Value>
                {priceDiffers && <Difference>{formatListingPrice(shopifyPrice)}</Difference>}
              </Fact>
              <Fact label={mapping.ownership.inventory === 'marketplace_connect'
                ? 'Quantity · Marketplace Connect' : 'Quantity'}>
                <Value>{formatListingQuantity(actualQuantity)}</Value>
                {quantityDiffers && <Difference>{formatListingQuantity(shopifyQuantity)}</Difference>}
              </Fact>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Content</Text>
              <Badge tone="info">eBay actual</Badge>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="500">
              <Fact label="Description">
                <Text as="p">{descriptionSummary(actual?.content.descriptionHtml ?? null)}</Text>
              </Fact>
              <InlineGrid columns={2} gap="300">
                <Fact label="Images"><Value>{actual?.content.imageUrls.length ?? '—'}</Value></Fact>
                <Fact label="Best offer">
                  <Value>{actual?.commerce.bestOfferEnabled === null || !actual
                    ? '—'
                    : actual.commerce.bestOfferEnabled ? 'On' : 'Off'}</Value>
                </Fact>
              </InlineGrid>
            </InlineGrid>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="500">
              <Fact label="Item specifics">
                {aspectEntries.length ? (
                  <BlockStack gap="100">
                    {aspectEntries.map(([name, values]) => (
                      <Text as="p" key={name}><strong>{name}:</strong> {values.join(', ')}</Text>
                    ))}
                  </BlockStack>
                ) : <Value>—</Value>}
              </Fact>
              <Fact label="Identifiers">
                {identifiers.length ? (
                  <BlockStack gap="100">
                    {identifiers.map(([name, value]) => (
                      <Text as="p" key={name}><strong>{name}:</strong> {value}</Text>
                    ))}
                  </BlockStack>
                ) : <Value>—</Value>}
              </Fact>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">Delivery</Text>
              <Badge tone="info">eBay actual</Badge>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
              <Fact label="Fulfillment policy"><Value>{actual?.policies.fulfillmentPolicyId ?? '—'}</Value></Fact>
              <Fact label="Payment policy"><Value>{actual?.policies.paymentPolicyId ?? '—'}</Value></Fact>
              <Fact label="Return policy"><Value>{actual?.policies.returnPolicyId ?? '—'}</Value></Fact>
              <Fact label="Location">
                <Value>{actual?.location.publicLocation ?? actual?.location.countryCode ?? '—'}</Value>
              </Fact>
              <Fact label="Returns">
                <Value>{actual?.policies.returnsAccepted === null || !actual
                  ? '—'
                  : actual.policies.returnsAccepted ? 'Accepted' : 'Not accepted'}</Value>
              </Fact>
              <Fact label="Shipping">
                <Value>{actual?.policies.domesticServices.slice(0, 3).join(', ') || '—'}</Value>
              </Fact>
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default ListingDetail;
