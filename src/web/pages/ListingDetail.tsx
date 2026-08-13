import React, { useState } from 'react';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  Tabs,
  Text,
  Thumbnail,
} from '@shopify/polaris';
import { ProductIcon } from '@shopify/polaris-icons';
import { useParams } from 'react-router-dom';
import { useAuthoritativeListing } from '../hooks/useAuthoritativeListings';
import {
  formatListingPrice,
  formatVerifiedAt,
  listingStatusLabel,
  listingStatusTone,
  verifiedListingImageUrl,
} from '../operator-ui';

const DETAIL_TABS = [
  { id: 'overview', content: 'Overview' },
  { id: 'content', content: 'Content' },
  { id: 'validation', content: 'Validation' },
  { id: 'activity', content: 'Activity' },
];

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <BlockStack gap="100">
    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
    <Text as="p" fontWeight="medium">{children}</Text>
  </BlockStack>
);

const ListingDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const detail = useAuthoritativeListing(id);
  const [tab, setTab] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (detail.isLoading) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card><SkeletonBodyText lines={8} /></Card>
      </Page>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <Page title="Listing" backAction={{ content: 'Listings', url: '/listings' }}>
        <Card>
          <EmptyState heading="Listing unavailable" image="">
            <Text as="p">The verified listing record could not be loaded.</Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const { listing, evidence } = detail.data;
  const imageUrl = verifiedListingImageUrl(listing.shopify.primaryImageUrl);
  const issueCount = listing.audit.unresolvedCount;

  return (
    <Page
      title={listing.shopify.title}
      subtitle={listing.shopify.sku}
      backAction={{ content: 'Listings', url: '/listings' }}
      titleMetadata={(
        <Badge tone={listingStatusTone(listing.lifecycleStatus)}>
          {listingStatusLabel(listing.lifecycleStatus)}
        </Badge>
      )}
      fullWidth
    >
      <BlockStack gap="500">
        <Card padding="0">
          <Tabs tabs={DETAIL_TABS} selected={tab} onSelect={setTab}>
            <Box padding="500">
              {tab === 0 && (
                <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="500">
                  <InlineStack gap="400" blockAlign="center" wrap={false}>
                    <Thumbnail
                      size="large"
                      source={imageUrl ?? ProductIcon}
                      alt={imageUrl ? listing.shopify.title : ''}
                    />
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">{listing.shopify.title}</Text>
                      <Text as="p" tone="subdued">SKU {listing.shopify.sku}</Text>
                      <Text as="p" variant="headingLg">{formatListingPrice(listing.price)}</Text>
                    </BlockStack>
                  </InlineStack>
                  <BlockStack gap="300">
                    <Fact label="eBay listing">{listing.ebay.listingId}</Fact>
                    <Fact label="Last checked">{formatVerifiedAt(listing.lastVerifiedAtUtc)}</Fact>
                    <Button url={listing.ebay.url} external variant="primary">View on eBay</Button>
                  </BlockStack>
                </InlineGrid>
              )}

              {tab === 1 && (
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="500">
                  <Fact label="Title">{listing.shopify.title}</Fact>
                  <Fact label="SKU">{listing.shopify.sku}</Fact>
                  <Fact label="Price">{formatListingPrice(listing.price)}</Fact>
                  <Fact label="Photos">{listing.shopify.imageCount}</Fact>
                </InlineGrid>
              )}

              {tab === 2 && (
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p">Listing evidence</Text>
                    <Badge tone={listing.audit.verified ? 'success' : 'critical'}>
                      {listing.audit.verified ? 'Verified' : 'Unavailable'}
                    </Badge>
                  </InlineStack>
                  <Divider />
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p">Open issues</Text>
                    <Badge tone={issueCount === 0 ? 'success' : 'critical'}>{String(issueCount)}</Badge>
                  </InlineStack>
                  <Divider />
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p">Recovery supported</Text>
                    <Badge tone={listing.audit.recoverySupported ? 'info' : 'attention'}>
                      {listing.audit.recoverySupported ? 'Yes' : 'No'}
                    </Badge>
                  </InlineStack>
                </BlockStack>
              )}

              {tab === 3 && (
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Listing checked</Text>
                  <Text as="p" tone="subdued">{formatVerifiedAt(listing.lastVerifiedAtUtc)}</Text>
                  <Text as="p">eBay listing {listing.ebay.listingId} was active in this verified snapshot.</Text>
                </BlockStack>
              )}
            </Box>
          </Tabs>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingSm">Advanced</Text>
              <Button
                variant="plain"
                onClick={() => setAdvancedOpen((open) => !open)}
                ariaExpanded={advancedOpen}
                ariaControls="listing-audit-details"
              >
                {advancedOpen ? 'Hide' : 'Show'}
              </Button>
            </InlineStack>
            <Collapsible id="listing-audit-details" open={advancedOpen}>
              <BlockStack gap="300">
                <Divider />
                <Fact label="Shopify product">{listing.shopify.productId}</Fact>
                <Fact label="Shopify variant">{listing.shopify.variantId}</Fact>
                <Fact label="eBay offer">{listing.ebay.offerId}</Fact>
                <Fact label="Evidence">{evidence.evidenceKind.replace('_', ' ')}</Fact>
                <Fact label="Current remote state">Not verified</Fact>
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
};

export default ListingDetail;
