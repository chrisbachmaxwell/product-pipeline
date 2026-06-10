import React, { useMemo, useState, useCallback } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  Icon,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Pagination,
  Select,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from '@shopify/polaris';
import {
  SearchIcon,
  OrderIcon,
  ImportIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  DeliveryIcon,
} from '@shopify/polaris-icons';
import {
  useEbayOrders,
  useEbayOrderStats,
  useImportEbayOrders,
  useEbayOrderImportStatus,
  useEnableEbayOrderImport,
  useDisableEbayOrderImport,
  type EbayOrderItem,
} from '../hooks/useApi';

/* ────────────────── Constants ────────────────── */

const PAGE_SIZE = 25;

const FULFILLMENT_OPTIONS = [
  { label: 'All fulfillment', value: '' },
  { label: 'Fulfilled', value: 'FULFILLED' },
  { label: 'Not Started', value: 'NOT_STARTED' },
  { label: 'In Progress', value: 'IN_PROGRESS' },
];

const PAYMENT_OPTIONS = [
  { label: 'All payment', value: '' },
  { label: 'Paid', value: 'PAID' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Failed', value: 'FAILED' },
];

const DAYS_OPTIONS = [
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 60 days', value: '60' },
  { label: 'Last 90 days', value: '90' },
];

/* ────────────────── Helpers ────────────────── */

const formatCurrency = (amount?: number | null, currency = 'USD') => {
  if (amount === undefined || amount === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
};

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatTimestamp = (unix?: number | null) => {
  if (!unix) return 'Never';
  const d = new Date(unix * 1000);
  return isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
};

const fulfillmentTone = (status?: string | null): 'success' | 'attention' | 'warning' | 'info' | undefined => {
  switch (status) {
    case 'FULFILLED': return 'success';
    case 'IN_PROGRESS': return 'attention';
    case 'NOT_STARTED': return 'warning';
    default: return 'info';
  }
};

const paymentTone = (status?: string | null): 'success' | 'critical' | 'attention' | 'info' | undefined => {
  switch (status) {
    case 'PAID': return 'success';
    case 'FAILED': return 'critical';
    case 'PENDING': return 'attention';
    default: return 'info';
  }
};

/* ────────────────── Stat Card ────────────────── */

const StatCard: React.FC<{ label: string; value: number | string; icon: any; tone?: 'success' | 'critical' | 'warning' | 'info' }> = ({ label, value, icon, tone }) => (
  <Card>
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Box
          background={
            tone === 'success' ? 'bg-fill-success-secondary'
              : tone === 'critical' ? 'bg-fill-critical-secondary'
                : tone === 'warning' ? 'bg-fill-warning-secondary'
                  : 'bg-fill-secondary'
          }
          borderRadius="200"
          padding="200"
        >
          <Icon source={icon} tone={tone ?? 'base'} />
        </Box>
      </InlineStack>
      <Text variant="headingXl" as="p">{typeof value === 'number' ? value.toLocaleString() : value}</Text>
      <Text variant="bodySm" tone="subdued" as="p">{label}</Text>
    </BlockStack>
  </Card>
);

/* ────────────────── Order Detail ────────────────── */

const OrderDetail: React.FC<{ order: EbayOrderItem }> = ({ order }) => {
  const lineItems = useMemo(() => {
    try { return JSON.parse(order.line_items_json || '[]'); } catch { return []; }
  }, [order.line_items_json]);

  const shipping = useMemo(() => {
    try { return order.shipping_address_json ? JSON.parse(order.shipping_address_json) : null; } catch { return null; }
  }, [order.shipping_address_json]);

  return (
    <Box padding="400" background="bg-surface-secondary">
      <BlockStack gap="400">
        <InlineStack gap="800" align="start">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Box background="bg-fill-secondary" borderRadius="200" padding="200">
                <Icon source={OrderIcon} />
              </Box>
              <Text variant="headingSm" as="h3">Line Items</Text>
            </InlineStack>
            {lineItems.length === 0 && <Text as="p" tone="subdued">No line items</Text>}
            {lineItems.map((item: any, i: number) => (
              <InlineStack key={i} gap="200" blockAlign="center">
                <Text as="span" variant="bodySm" fontWeight="semibold">{item.quantity ?? 1}×</Text>
                <Text as="span" variant="bodySm">{item.title || item.legacyItemId || 'Unknown item'}</Text>
                {item.lineItemCost && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {formatCurrency(parseFloat(item.lineItemCost.value), item.lineItemCost.currency)}
                  </Text>
                )}
              </InlineStack>
            ))}
          </BlockStack>

          {shipping && (
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Box background="bg-fill-secondary" borderRadius="200" padding="200">
                  <Icon source={DeliveryIcon} />
                </Box>
                <Text variant="headingSm" as="h3">Shipping Address</Text>
              </InlineStack>
              <Text as="p" variant="bodySm">{shipping.fullName}</Text>
              {shipping.contactAddress && (
                <>
                  <Text as="p" variant="bodySm">{shipping.contactAddress.addressLine1}</Text>
                  {shipping.contactAddress.addressLine2 && <Text as="p" variant="bodySm">{shipping.contactAddress.addressLine2}</Text>}
                  <Text as="p" variant="bodySm">
                    {shipping.contactAddress.city}, {shipping.contactAddress.stateOrProvince} {shipping.contactAddress.postalCode}
                  </Text>
                </>
              )}
            </BlockStack>
          )}
        </InlineStack>

        <Divider />
        <InlineStack gap="200">
          <Tooltip content="Coming soon">
            <Button disabled>Sync to Shopify</Button>
          </Tooltip>
        </InlineStack>
      </BlockStack>
    </Box>
  );
};

/* ────────────────── Marketplace Connect Cutover ────────────────── */

const ImportCutoverCard: React.FC = () => {
  const { data: status, isLoading } = useEbayOrderImportStatus();
  const enableMutation = useEnableEbayOrderImport();
  const disableMutation = useDisableEbayOrderImport();
  const [confirmText, setConfirmText] = useState('');

  if (isLoading || !status) return null;

  if (status.enabled) {
    return (
      <Banner tone="success" title="Automatic order import is ON">
        <BlockStack gap="200">
          <Text as="p">
            New eBay orders created after{' '}
            <strong>{status.cutoff ? new Date(status.cutoff).toLocaleString() : '—'}</strong>{' '}
            are imported into Shopify automatically. Orders before the cutoff are never touched
            (they belong to Marketplace Connect).
          </Text>
          <InlineStack gap="200">
            <Button
              tone="critical"
              onClick={() => disableMutation.mutate()}
              loading={disableMutation.isPending}
            >
              Turn off automatic import
            </Button>
          </InlineStack>
        </BlockStack>
      </Banner>
    );
  }

  return (
    <Banner tone="warning" title="Automatic order import is OFF (Marketplace Connect cutover)">
      <BlockStack gap="200">
        <Text as="p">
          When you're ready to replace Marketplace Connect:{' '}
          <strong>1)</strong> turn off order sync in the Marketplace Connect app first, then{' '}
          <strong>2)</strong> enable import here. The moment you enable it becomes the go-live
          cutoff — only eBay orders created <em>after</em> that moment will ever be imported,
          so historical orders and orders Marketplace Connect already created stay untouched.
        </Text>
        <InlineStack gap="200" blockAlign="end">
          <Box minWidth="260px">
            <TextField
              label='Type "ENABLE" to confirm'
              value={confirmText}
              onChange={setConfirmText}
              autoComplete="off"
            />
          </Box>
          <Button
            variant="primary"
            disabled={confirmText !== 'ENABLE'}
            onClick={() => { enableMutation.mutate(); setConfirmText(''); }}
            loading={enableMutation.isPending}
          >
            Enable order import from now
          </Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
};

/* ────────────────── EbayOrders Page ────────────────── */

const EbayOrders: React.FC = () => {
  const [search, setSearch] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [pageOffset, setPageOffset] = useState(0);
  const [importDays, setImportDays] = useState('30');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading } = useEbayOrders({
    limit: PAGE_SIZE,
    offset: pageOffset,
    search: search || undefined,
    fulfillmentStatus: fulfillmentFilter || undefined,
    paymentStatus: paymentFilter || undefined,
  });

  const { data: stats } = useEbayOrderStats();
  const importMutation = useImportEbayOrders();

  const orders = data?.data ?? [];
  const total = data?.total ?? 0;
  const hasPrev = pageOffset > 0;
  const hasNext = pageOffset + PAGE_SIZE < total;

  const handleImport = useCallback(() => {
    importMutation.mutate({ days: parseInt(importDays) });
  }, [importDays, importMutation]);

  const rowMarkup = orders.map((order, index) => (
    <React.Fragment key={order.id}>
      <IndexTable.Row
        id={String(order.id)}
        position={index}
        onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}
        selected={false}
      >
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="semibold" as="span">
            {order.legacy_order_id || order.ebay_order_id}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{order.buyer_username || '—'}</IndexTable.Cell>
        <IndexTable.Cell>{order.item_count ?? 0}</IndexTable.Cell>
        <IndexTable.Cell>{formatCurrency(order.total_amount, order.currency)}</IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={fulfillmentTone(order.fulfillment_status)}>
            {order.fulfillment_status || 'UNKNOWN'}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={paymentTone(order.payment_status)}>
            {order.payment_status || 'UNKNOWN'}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>{formatDate(order.ebay_created_at)}</IndexTable.Cell>
        <IndexTable.Cell>
          {order.synced_to_shopify ? (
            <Badge tone="success">Synced</Badge>
          ) : (
            <Badge tone="info">Not synced</Badge>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
      {expandedId === order.id && (
        <IndexTable.Row id={`${order.id}-detail`} position={index} selected={false}>
          <IndexTable.Cell colSpan={8}>
            <OrderDetail order={order} />
          </IndexTable.Cell>
        </IndexTable.Row>
      )}
    </React.Fragment>
  ));

  return (
    <Page title="eBay Orders" subtitle="Import and manage eBay orders" fullWidth>
      <BlockStack gap="500">
        {/* Safety banner */}
        <Banner tone="critical" title="⚠️ Lightspeed POS Impact — Read Before Syncing">
          <BlockStack gap="200">
            <Text as="p">
              <strong>Every Shopify order created here flows into Lightspeed POS automatically.</strong>{' '}
              Duplicate orders caused hours of manual cleanup in February 2026.
            </Text>
            <Text as="p">
              The <strong>Import from eBay</strong> button is safe — it only stores orders to the local database.
              Syncing to Shopify requires explicit confirmation and is rate-limited to 5 orders/hour.
            </Text>
            <Text as="p" tone="critical">
              If you suspect duplicates exist in Shopify, <strong>stop immediately</strong> and contact the developer.
            </Text>
          </BlockStack>
        </Banner>

        {/* Marketplace Connect cutover control */}
        <ImportCutoverCard />

        {/* Stats + Import */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Box background="bg-fill-secondary" borderRadius="200" padding="200">
                    <Icon source={ImportIcon} />
                  </Box>
                  <Text variant="headingSm" as="h2">Import from eBay</Text>
                </InlineStack>
                <Select label="Time range" options={DAYS_OPTIONS} value={importDays} onChange={setImportDays} />
                <Button variant="primary" onClick={handleImport} loading={importMutation.isPending} fullWidth>
                  Import Orders
                </Button>
                {stats?.lastImportedAt && (
                  <Text as="p" variant="bodySm" tone="subdued">Last import: {formatTimestamp(stats.lastImportedAt)}</Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
              <StatCard label="Total Orders" value={stats?.total ?? 0} icon={OrderIcon} />
              {stats?.byFulfillmentStatus && Object.entries(stats.byFulfillmentStatus).map(([status, count]) => (
                <StatCard
                  key={status}
                  label={status}
                  value={count}
                  icon={status === 'FULFILLED' ? CheckCircleIcon : status === 'NOT_STARTED' ? AlertCircleIcon : ClockIcon}
                  tone={status === 'FULFILLED' ? 'success' : status === 'NOT_STARTED' ? 'warning' : 'info'}
                />
              ))}
              <StatCard label="Synced" value={stats?.synced ?? 0} icon={CheckCircleIcon} tone="success" />
            </InlineGrid>
          </Layout.Section>
        </Layout>

        {/* Filters */}
        <Card>
          <InlineStack gap="300" align="start" blockAlign="end">
            <Box minWidth="280px">
              <TextField
                label="Search"
                labelHidden
                placeholder="Search order ID or buyer…"
                value={search}
                onChange={(v) => { setSearch(v); setPageOffset(0); }}
                prefix={<Icon source={SearchIcon} />}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => { setSearch(''); setPageOffset(0); }}
              />
            </Box>
            <Select
              label="Fulfillment"
              labelHidden
              options={FULFILLMENT_OPTIONS}
              value={fulfillmentFilter}
              onChange={(v) => { setFulfillmentFilter(v); setPageOffset(0); }}
            />
            <Select
              label="Payment"
              labelHidden
              options={PAYMENT_OPTIONS}
              value={paymentFilter}
              onChange={(v) => { setPaymentFilter(v); setPageOffset(0); }}
            />
          </InlineStack>
        </Card>

        {/* Orders table */}
        <Card padding="0">
          {isLoading ? (
            <Box padding="800">
              <InlineStack align="center">
                <Spinner accessibilityLabel="Loading orders" size="large" />
              </InlineStack>
            </Box>
          ) : (
            <IndexTable
              resourceName={{ singular: 'order', plural: 'orders' }}
              itemCount={orders.length}
              headings={[
                { title: 'Order ID' },
                { title: 'Buyer' },
                { title: 'Items' },
                { title: 'Total' },
                { title: 'Fulfillment' },
                { title: 'Payment' },
                { title: 'Date' },
                { title: 'Synced' },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
          )}
        </Card>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <InlineStack align="center" gap="300">
            <Pagination
              hasPrevious={hasPrev}
              hasNext={hasNext}
              onPrevious={() => setPageOffset(Math.max(0, pageOffset - PAGE_SIZE))}
              onNext={() => setPageOffset(pageOffset + PAGE_SIZE)}
            />
            <Text as="p" variant="bodySm" tone="subdued">
              {pageOffset + 1}–{Math.min(pageOffset + PAGE_SIZE, total)} of {total}
            </Text>
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
};

export default EbayOrders;
