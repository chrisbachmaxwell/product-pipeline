import React, { useState } from 'react';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Collapsible,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Text,
  Thumbnail,
} from '@shopify/polaris';
import { ProductIcon } from '@shopify/polaris-icons';
import { useParams } from 'react-router-dom';
import { useAuthoritativeListing } from '../hooks/useAuthoritativeListings';
import {
  formatListingPrice,
  formatVerifiedAt,
  isLiveCatalogResponse,
  listingAttentionText,
  listingSkuLabel,
  listingStatusLabel,
  listingStatusTone,
  verifiedEbayListingUrl,
  verifiedListingImageUrl,
} from '../operator-ui';

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <Text as="p" fontWeight="medium">{children}</Text>
  </BlockStack>
);

const ListingDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const detail = useAuthoritativeListing(id);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (detail.isLoading) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card><SkeletonBodyText lines={6} /></Card>
      </Page>
    );
  }

  if (detail.error || !detail.data || !isLiveCatalogResponse(detail.data.evidence)) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card>
          <EmptyState heading="Listing unavailable" image="">
            <Text as="p">Shopify and eBay could not be checked.</Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const { listing, evidence } = detail.data;
  const imageUrl = verifiedListingImageUrl(listing.shopify.primaryImageUrl);
  const attention = listingAttentionText(listing);
  const active = listing.lifecycleStatus === 'active';
  const ebayUrl = verifiedEbayListingUrl(listing.ebay.listingId, listing.ebay.url);

  return (
    <Page
      title={listing.shopify.title}
      subtitle={listingSkuLabel(listing.shopify.sku)}
      backAction={{ content: 'Listings', url: '/listings' }}
      titleMetadata={(
        <Badge tone={listingStatusTone(listing.lifecycleStatus)}>
          {listingStatusLabel(listing.lifecycleStatus)}
        </Badge>
      )}
      primaryAction={active && ebayUrl ? {
        content: 'View on eBay',
        url: ebayUrl,
        external: true,
      } : undefined}
      fullWidth
    >
      <BlockStack gap="400">
        <Card>
          <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="500">
            <InlineStack gap="400" blockAlign="center" wrap={false}>
              <Thumbnail
                size="large"
                source={imageUrl ?? ProductIcon}
                alt={imageUrl ? listing.shopify.title : ''}
              />
              <BlockStack gap="150">
                <Text as="h2" variant="headingMd">{listing.shopify.title}</Text>
                {listing.shopify.variantTitle !== 'Default Title' && (
                  <Text as="p" tone="subdued">{listing.shopify.variantTitle}</Text>
                )}
                <Text as="p" variant="headingLg">{formatListingPrice(listing.shopify.price)}</Text>
              </BlockStack>
            </InlineStack>
            <InlineGrid columns={2} gap="400">
              <Fact label="Available">{listing.shopify.available}</Fact>
              <Fact label="Photos">{listing.shopify.imageCount}</Fact>
              <Fact label="SKU">{listingSkuLabel(listing.shopify.sku)}</Fact>
              <Fact label="Checked">{formatVerifiedAt(evidence.observedAtUtc).replace('Checked ', '')}</Fact>
            </InlineGrid>
          </InlineGrid>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="h2" variant="headingMd">eBay</Text>
              <Badge tone={listingStatusTone(listing.lifecycleStatus)}>
                {listingStatusLabel(listing.lifecycleStatus)}
              </Badge>
            </InlineStack>
            {attention && <Text as="p" tone="critical">{attention}</Text>}
            {active && listing.ebay.listingId && (
              <Text as="p" tone="subdued">Listing {listing.ebay.listingId}</Text>
            )}
            {listing.lifecycleStatus === 'not_listed' && (
              <Text as="p" tone="subdued">Review the product before publishing.</Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingSm">Advanced</Text>
              <Button
                variant="plain"
                onClick={() => setAdvancedOpen((open) => !open)}
                ariaExpanded={advancedOpen}
                ariaControls="listing-catalog-details"
              >
                {advancedOpen ? 'Hide' : 'Show'}
              </Button>
            </InlineStack>
            <Collapsible id="listing-catalog-details" open={advancedOpen}>
              <BlockStack gap="300">
                <Divider />
                <Fact label="Shopify product">{listing.shopify.productId}</Fact>
                <Fact label="Shopify variant">{listing.shopify.variantId}</Fact>
                {listing.ebay.offerId && <Fact label="eBay offer">{listing.ebay.offerId}</Fact>}
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default ListingDetail;
