import React, { useState } from 'react';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Pagination,
  Spinner,
  Tabs,
  Text,
  TextField,
  Thumbnail,
} from '@shopify/polaris';
import { ProductIcon, SearchIcon } from '@shopify/polaris-icons';
import { Link } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import {
  DEFAULT_LISTING_TAB,
  formatListingPrice,
  formatVerifiedAt,
  LISTING_TABS,
  listingStatusLabel,
  listingStatusTone,
  verifiedListingImageUrl,
} from '../operator-ui';

const PAGE_SIZE = 25;

const Listings: React.FC = () => {
  const [tab, setTab] = useState(DEFAULT_LISTING_TAB);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const status = LISTING_TABS[tab]?.id ?? 'active';
  const listings = useAuthoritativeListings({
    limit: PAGE_SIZE,
    offset,
    status,
    search: search || undefined,
  });
  const rows = listings.data?.data ?? [];
  const total = listings.data?.total ?? 0;

  return (
    <Page title="Listings" fullWidth>
      <BlockStack gap="500">
        <Card padding="0">
          <div className="operator-tabs">
            <Tabs
            tabs={LISTING_TABS.map((item) => ({ id: item.id, content: item.label }))}
            selected={tab}
            onSelect={(next) => {
              setTab(next);
              setOffset(0);
            }}
            >
            <Box padding="400">
              <BlockStack gap="400">
                <InlineStack align="space-between" gap="300" blockAlign="center">
                  <Box minWidth="280px" maxWidth="440px">
                    <TextField
                      label="Search listings"
                      labelHidden
                      placeholder="Search product, SKU, or listing"
                      value={search}
                      onChange={(value) => {
                        setSearch(value);
                        setOffset(0);
                      }}
                      onClearButtonClick={() => {
                        setSearch('');
                        setOffset(0);
                      }}
                      prefix={<SearchIcon />}
                      clearButton
                      autoComplete="off"
                    />
                  </Box>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="info">Verified snapshot</Badge>
                    <Button
                      variant="plain"
                      onClick={() => { void listings.refetch(); }}
                      loading={listings.isFetching}
                    >
                      Refresh
                    </Button>
                  </InlineStack>
                </InlineStack>

                {listings.error ? (
                  <EmptyState
                    heading="Listings unavailable"
                    image=""
                    action={{ content: 'Try again', onAction: () => { void listings.refetch(); } }}
                  >
                    <Text as="p">The verified listing record could not be loaded.</Text>
                  </EmptyState>
                ) : listings.isLoading ? (
                  <Box padding="1200">
                    <InlineStack align="center">
                      <Spinner accessibilityLabel="Loading listings" size="large" />
                    </InlineStack>
                  </Box>
                ) : rows.length === 0 ? (
                  <EmptyState heading={`No ${LISTING_TABS[tab]?.label.toLowerCase()} listings`} image="">
                    <Text as="p">Nothing to review here.</Text>
                  </EmptyState>
                ) : (
                  <>
                    <div className="operator-listings-desktop">
                      <IndexTable
                        resourceName={{ singular: 'listing', plural: 'listings' }}
                        itemCount={rows.length}
                        selectable={false}
                        headings={[
                          { title: 'Product' },
                          { title: 'Status' },
                          { title: 'Price' },
                          { title: 'Verified' },
                          { title: '' },
                        ]}
                      >
                        {rows.map((row, index) => {
                          const imageUrl = verifiedListingImageUrl(row.shopify.primaryImageUrl);
                          return (
                            <IndexTable.Row id={row.id} key={row.id} position={index}>
                              <IndexTable.Cell>
                                <InlineStack gap="300" blockAlign="center" wrap={false}>
                                  <Thumbnail
                                    size="small"
                                    source={imageUrl ?? ProductIcon}
                                    alt={imageUrl ? row.shopify.title : ''}
                                  />
                                  <BlockStack gap="050">
                                    <Text as="span" fontWeight="semibold">{row.shopify.title}</Text>
                                    <Text as="span" variant="bodySm" tone="subdued">{row.shopify.sku}</Text>
                                  </BlockStack>
                                </InlineStack>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Badge tone={listingStatusTone(row.lifecycleStatus)}>
                                  {listingStatusLabel(row.lifecycleStatus)}
                                </Badge>
                              </IndexTable.Cell>
                              <IndexTable.Cell>{formatListingPrice(row.price)}</IndexTable.Cell>
                              <IndexTable.Cell>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {formatVerifiedAt(row.lastVerifiedAtUtc)}
                                </Text>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Link
                                  to={`/listings/${encodeURIComponent(row.id)}`}
                                  aria-label={`View ${row.shopify.title}`}
                                >
                                  View
                                </Link>
                              </IndexTable.Cell>
                            </IndexTable.Row>
                          );
                        })}
                      </IndexTable>
                    </div>
                    <div className="operator-listings-mobile">
                      <BlockStack gap="300">
                        {rows.map((row) => {
                          const imageUrl = verifiedListingImageUrl(row.shopify.primaryImageUrl);
                          return (
                            <Card key={row.id}>
                              <BlockStack gap="300">
                                <InlineStack gap="300" blockAlign="center" wrap={false}>
                                  <Thumbnail
                                    size="small"
                                    source={imageUrl ?? ProductIcon}
                                    alt={imageUrl ? row.shopify.title : ''}
                                  />
                                  <BlockStack gap="050">
                                    <Text as="span" fontWeight="semibold">{row.shopify.title}</Text>
                                    <Text as="span" variant="bodySm" tone="subdued">{row.shopify.sku}</Text>
                                  </BlockStack>
                                </InlineStack>
                                <InlineStack align="space-between" blockAlign="center">
                                  <Badge tone={listingStatusTone(row.lifecycleStatus)}>
                                    {listingStatusLabel(row.lifecycleStatus)}
                                  </Badge>
                                  <Text as="span" fontWeight="semibold">{formatListingPrice(row.price)}</Text>
                                </InlineStack>
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {formatVerifiedAt(row.lastVerifiedAtUtc)}
                                  </Text>
                                  <Link
                                    to={`/listings/${encodeURIComponent(row.id)}`}
                                    aria-label={`View ${row.shopify.title}`}
                                  >
                                    View
                                  </Link>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          );
                        })}
                      </BlockStack>
                    </div>
                  </>
                )}
              </BlockStack>
            </Box>
            </Tabs>
          </div>
        </Card>

        {total > PAGE_SIZE && (
          <InlineStack align="center">
            <Pagination
              hasPrevious={offset > 0}
              onPrevious={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              hasNext={offset + PAGE_SIZE < total}
              onNext={() => setOffset(offset + PAGE_SIZE)}
            />
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
};

export default Listings;
