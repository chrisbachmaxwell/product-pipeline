import React, { useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Divider,
  IndexTable,
  InlineStack,
  Page,
  Pagination,
  Select,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { SearchIcon } from '@shopify/polaris-icons';
import { useListings, useMigrationStatus } from '../hooks/useApi';
import { MigrationSafetyBanner } from '../components/MigrationSafety';
import { DurableMigrationState } from '../components/DurableMigrationState';

const PAGE_SIZE = 50;

const FILTERS = [
  { label: 'All local statuses', value: '' },
  { label: 'Active', value: 'active,synced' },
  { label: 'Draft', value: 'draft' },
  { label: 'Ended', value: 'ended' },
  { label: 'Error', value: 'error,failed' },
];

const normalize = (record: Record<string, unknown>) => ({
  id: String(record.id ?? ''),
  shopifyProductId: String(record.shopifyProductId ?? record.shopify_product_id ?? ''),
  title: String(record.shopifyTitle ?? record.shopify_title ?? 'Untitled local record'),
  sku: String(record.shopifySku ?? record.shopify_sku ?? ''),
  ebayListingId: record.ebayListingId ?? record.ebay_listing_id,
  status: String(record.status ?? 'unknown'),
  price: Number(record.originalPrice ?? record.original_price ?? record.shopify_price ?? record.price ?? 0),
  updatedAt: record.updatedAt ?? record.updated_at,
});

const formatMoney = (value: number) =>
  value > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
    : '—';

const formatDate = (value: unknown) => {
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const numeric = typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

const statusTone = (value: string): 'success' | 'warning' | 'info' | 'critical' => {
  const normalized = value.toLowerCase();
  if (normalized === 'active' || normalized === 'synced') return 'success';
  if (normalized === 'error' || normalized === 'failed') return 'critical';
  if (normalized === 'ended') return 'warning';
  return 'info';
};

const Listings: React.FC = () => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const migration = useMigrationStatus();
  const listingsQuery = useListings({
    limit: PAGE_SIZE,
    offset,
    search: search || undefined,
    status: statusFilter || undefined,
  });
  const listings = useMemo(
    () => (listingsQuery.data?.data ?? []).map((record) => normalize(record as unknown as Record<string, unknown>)),
    [listingsQuery.data],
  );
  const total = listingsQuery.data?.total ?? 0;

  return (
    <Page
      title="Listings"
      subtitle="Observation-only local listing ledger"
      primaryAction={{
        content: 'Refresh evidence',
        onAction: () => {
          void Promise.all([migration.refetch(), listingsQuery.refetch()]);
        },
        loading: migration.isFetching || listingsQuery.isFetching,
      }}
      fullWidth
    >
      <BlockStack gap="500">
        <MigrationSafetyBanner
          status={migration.data}
          error={migration.error instanceof Error ? migration.error : null}
        />
        <Banner tone="critical" title="Listing ownership and current eBay parity are unverified">
          <BlockStack gap="100">
            <Text as="p">
              Listing lifecycle and mapping ownership remain unverified. Marketplace Connect was
              browser-observed with price and inventory sync enabled on 2026-08-11, but no current
              authoritative Shopify/eBay/Marketplace Connect parity snapshot is available.
            </Text>
            <Text as="p" tone="subdued">
              ProductPipeline cannot sync, publish, revise, end, relist, or bulk-update listings in
              shadow mode. These local identifiers are not authoritative eBay state.
            </Text>
          </BlockStack>
        </Banner>

        <DurableMigrationState status={migration.data} compact="listings" />

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" align="space-between" blockAlign="end">
              <Box minWidth="280px">
                <TextField
                  label="Search local listings"
                  labelHidden
                  placeholder="Title, SKU, Shopify ID, or eBay listing ID"
                  value={search}
                  onChange={(value) => { setSearch(value); setOffset(0); }}
                  prefix={<SearchIcon />}
                  clearButton
                  onClearButtonClick={() => { setSearch(''); setOffset(0); }}
                  autoComplete="off"
                />
              </Box>
              <Box minWidth="200px">
                <Select
                  label="Local status"
                  labelHidden
                  options={FILTERS}
                  value={statusFilter}
                  onChange={(value) => { setStatusFilter(value); setOffset(0); }}
                />
              </Box>
            </InlineStack>
            <Divider />

            {listingsQuery.error && (
              <Banner tone="critical" title="Unable to load local listing records">
                <Text as="p">{listingsQuery.error instanceof Error ? listingsQuery.error.message : 'Unknown error'}</Text>
              </Banner>
            )}

            {listingsQuery.isLoading ? (
              <Box padding="800">
                <InlineStack align="center">
                  <Spinner accessibilityLabel="Loading local listing records" size="large" />
                </InlineStack>
              </Box>
            ) : (
              <IndexTable
                resourceName={{ singular: 'local listing record', plural: 'local listing records' }}
                itemCount={listings.length}
                selectable={false}
                headings={[
                  { title: 'Product' },
                  { title: 'eBay listing ID' },
                  { title: 'Local status' },
                  { title: 'Recorded price' },
                  { title: 'Local update' },
                ]}
              >
                {listings.map((listing, index) => (
                  <IndexTable.Row id={listing.id || String(index)} key={listing.id || index} position={index}>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">{listing.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {listing.sku ? `SKU ${listing.sku}` : `Shopify ${listing.shopifyProductId || '—'}`}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{String(listing.ebayListingId ?? 'Not recorded')}</IndexTable.Cell>
                    <IndexTable.Cell><Badge tone={statusTone(listing.status)}>{listing.status}</Badge></IndexTable.Cell>
                    <IndexTable.Cell>{formatMoney(listing.price)}</IndexTable.Cell>
                    <IndexTable.Cell>{formatDate(listing.updatedAt)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </BlockStack>
        </Card>

        <InlineStack align="center">
          <Pagination
            hasPrevious={offset > 0}
            onPrevious={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            hasNext={offset + PAGE_SIZE < total}
            onNext={() => setOffset(offset + PAGE_SIZE)}
          />
        </InlineStack>
      </BlockStack>
    </Page>
  );
};

export default Listings;
