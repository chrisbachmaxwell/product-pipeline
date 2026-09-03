import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo, useState, useCallback } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Divider, Icon, IndexTable, InlineGrid, InlineStack, Layout, Page, Pagination, Select, Spinner, Text, TextField, Tooltip, } from '@shopify/polaris';
import { SearchIcon, OrderIcon, ImportIcon, AlertCircleIcon, CheckCircleIcon, ClockIcon, DeliveryIcon, } from '@shopify/polaris-icons';
import { useEbayOrders, useEbayOrderStats, useImportEbayOrders, useEbayOrderImportStatus, useEnableEbayOrderImport, useDisableEbayOrderImport, } from '../hooks/useApi';
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
const formatCurrency = (amount, currency = 'USD') => {
    if (amount === undefined || amount === null)
        return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
};
const formatDate = (value) => {
    if (!value)
        return '—';
    const d = new Date(value);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const formatTimestamp = (unix) => {
    if (!unix)
        return 'Never';
    const d = new Date(unix * 1000);
    return isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
};
const fulfillmentTone = (status) => {
    switch (status) {
        case 'FULFILLED': return 'success';
        case 'IN_PROGRESS': return 'attention';
        case 'NOT_STARTED': return 'warning';
        default: return 'info';
    }
};
const paymentTone = (status) => {
    switch (status) {
        case 'PAID': return 'success';
        case 'FAILED': return 'critical';
        case 'PENDING': return 'attention';
        default: return 'info';
    }
};
/* ────────────────── Stat Card ────────────────── */
const StatCard = ({ label, value, icon, tone }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(InlineStack, { align: "space-between", blockAlign: "center", children: _jsx(Box, { background: tone === 'success' ? 'bg-fill-success-secondary'
                        : tone === 'critical' ? 'bg-fill-critical-secondary'
                            : tone === 'warning' ? 'bg-fill-warning-secondary'
                                : 'bg-fill-secondary', borderRadius: "200", padding: "200", children: _jsx(Icon, { source: icon, tone: tone ?? 'base' }) }) }), _jsx(Text, { variant: "headingXl", as: "p", children: typeof value === 'number' ? value.toLocaleString() : value }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: label })] }) }));
/* ────────────────── Order Detail ────────────────── */
const OrderDetail = ({ order }) => {
    const lineItems = useMemo(() => {
        try {
            return JSON.parse(order.line_items_json || '[]');
        }
        catch {
            return [];
        }
    }, [order.line_items_json]);
    const shipping = useMemo(() => {
        try {
            return order.shipping_address_json ? JSON.parse(order.shipping_address_json) : null;
        }
        catch {
            return null;
        }
    }, [order.shipping_address_json]);
    return (_jsx(Box, { padding: "400", background: "bg-surface-secondary", children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "800", align: "start", children: [_jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: OrderIcon }) }), _jsx(Text, { variant: "headingSm", as: "h3", children: "Line Items" })] }), lineItems.length === 0 && _jsx(Text, { as: "p", tone: "subdued", children: "No line items" }), lineItems.map((item, i) => (_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsxs(Text, { as: "span", variant: "bodySm", fontWeight: "semibold", children: [item.quantity ?? 1, "\u00D7"] }), _jsx(Text, { as: "span", variant: "bodySm", children: item.title || item.legacyItemId || 'Unknown item' }), item.lineItemCost && (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: formatCurrency(parseFloat(item.lineItemCost.value), item.lineItemCost.currency) }))] }, i)))] }), shipping && (_jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: DeliveryIcon }) }), _jsx(Text, { variant: "headingSm", as: "h3", children: "Shipping Address" })] }), _jsx(Text, { as: "p", variant: "bodySm", children: shipping.fullName }), shipping.contactAddress && (_jsxs(_Fragment, { children: [_jsx(Text, { as: "p", variant: "bodySm", children: shipping.contactAddress.addressLine1 }), shipping.contactAddress.addressLine2 && _jsx(Text, { as: "p", variant: "bodySm", children: shipping.contactAddress.addressLine2 }), _jsxs(Text, { as: "p", variant: "bodySm", children: [shipping.contactAddress.city, ", ", shipping.contactAddress.stateOrProvince, " ", shipping.contactAddress.postalCode] })] }))] }))] }), _jsx(Divider, {}), _jsx(InlineStack, { gap: "200", children: _jsx(Tooltip, { content: "Coming soon", children: _jsx(Button, { disabled: true, children: "Sync to Shopify" }) }) })] }) }));
};
/* ────────────────── Marketplace Connect Cutover ────────────────── */
const ImportCutoverCard = () => {
    const { data: status, isLoading } = useEbayOrderImportStatus();
    const enableMutation = useEnableEbayOrderImport();
    const disableMutation = useDisableEbayOrderImport();
    const [confirmText, setConfirmText] = useState('');
    if (isLoading || !status)
        return null;
    if (status.enabled) {
        return (_jsx(Banner, { tone: "success", title: "Automatic order import is ON", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(Text, { as: "p", children: ["New eBay orders created after", ' ', _jsx("strong", { children: status.cutoff ? new Date(status.cutoff).toLocaleString() : '—' }), ' ', "are imported into Shopify automatically. Orders before the cutoff are never touched (they belong to Marketplace Connect)."] }), _jsx(InlineStack, { gap: "200", children: _jsx(Button, { tone: "critical", onClick: () => disableMutation.mutate(), loading: disableMutation.isPending, children: "Turn off automatic import" }) })] }) }));
    }
    return (_jsx(Banner, { tone: "warning", title: "Automatic order import is OFF (Marketplace Connect cutover)", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(Text, { as: "p", children: ["When you're ready to replace Marketplace Connect:", ' ', _jsx("strong", { children: "1)" }), " turn off order sync in the Marketplace Connect app first, then", ' ', _jsx("strong", { children: "2)" }), " enable import here. The moment you enable it becomes the go-live cutoff \u2014 only eBay orders created ", _jsx("em", { children: "after" }), " that moment will ever be imported, so historical orders and orders Marketplace Connect already created stay untouched."] }), _jsxs(InlineStack, { gap: "200", blockAlign: "end", children: [_jsx(Box, { minWidth: "260px", children: _jsx(TextField, { label: 'Type "ENABLE" to confirm', value: confirmText, onChange: setConfirmText, autoComplete: "off" }) }), _jsx(Button, { variant: "primary", disabled: confirmText !== 'ENABLE', onClick: () => { enableMutation.mutate(); setConfirmText(''); }, loading: enableMutation.isPending, children: "Enable order import from now" })] })] }) }));
};
/* ────────────────── EbayOrders Page ────────────────── */
const EbayOrders = () => {
    const [search, setSearch] = useState('');
    const [fulfillmentFilter, setFulfillmentFilter] = useState('');
    const [paymentFilter, setPaymentFilter] = useState('');
    const [pageOffset, setPageOffset] = useState(0);
    const [importDays, setImportDays] = useState('30');
    const [expandedId, setExpandedId] = useState(null);
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
    const rowMarkup = orders.map((order, index) => (_jsxs(React.Fragment, { children: [_jsxs(IndexTable.Row, { id: String(order.id), position: index, onClick: () => setExpandedId(expandedId === order.id ? null : order.id), selected: false, children: [_jsx(IndexTable.Cell, { children: _jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: order.legacy_order_id || order.ebay_order_id }) }), _jsx(IndexTable.Cell, { children: order.buyer_username || '—' }), _jsx(IndexTable.Cell, { children: order.item_count ?? 0 }), _jsx(IndexTable.Cell, { children: formatCurrency(order.total_amount, order.currency) }), _jsx(IndexTable.Cell, { children: _jsx(Badge, { tone: fulfillmentTone(order.fulfillment_status), children: order.fulfillment_status || 'UNKNOWN' }) }), _jsx(IndexTable.Cell, { children: _jsx(Badge, { tone: paymentTone(order.payment_status), children: order.payment_status || 'UNKNOWN' }) }), _jsx(IndexTable.Cell, { children: formatDate(order.ebay_created_at) }), _jsx(IndexTable.Cell, { children: order.synced_to_shopify ? (_jsx(Badge, { tone: "success", children: "Synced" })) : (_jsx(Badge, { tone: "info", children: "Not synced" })) })] }), expandedId === order.id && (_jsx(IndexTable.Row, { id: `${order.id}-detail`, position: index, selected: false, children: _jsx(IndexTable.Cell, { colSpan: 8, children: _jsx(OrderDetail, { order: order }) }) }))] }, order.id)));
    return (_jsx(Page, { title: "eBay Orders", subtitle: "Import and manage eBay orders", fullWidth: true, children: _jsxs(BlockStack, { gap: "500", children: [_jsx(Banner, { tone: "critical", title: "\u26A0\uFE0F Lightspeed POS Impact \u2014 Read Before Syncing", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(Text, { as: "p", children: [_jsx("strong", { children: "Every Shopify order created here flows into Lightspeed POS automatically." }), ' ', "Duplicate orders caused hours of manual cleanup in February 2026."] }), _jsxs(Text, { as: "p", children: ["The ", _jsx("strong", { children: "Import from eBay" }), " button is safe \u2014 it only stores orders to the local database. Syncing to Shopify requires explicit confirmation and is rate-limited to 5 orders/hour."] }), _jsxs(Text, { as: "p", tone: "critical", children: ["If you suspect duplicates exist in Shopify, ", _jsx("strong", { children: "stop immediately" }), " and contact the developer."] })] }) }), _jsx(ImportCutoverCard, {}), _jsxs(Layout, { children: [_jsx(Layout.Section, { variant: "oneThird", children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: ImportIcon }) }), _jsx(Text, { variant: "headingSm", as: "h2", children: "Import from eBay" })] }), _jsx(Select, { label: "Time range", options: DAYS_OPTIONS, value: importDays, onChange: setImportDays }), _jsx(Button, { variant: "primary", onClick: handleImport, loading: importMutation.isPending, fullWidth: true, children: "Import Orders" }), stats?.lastImportedAt && (_jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["Last import: ", formatTimestamp(stats.lastImportedAt)] }))] }) }) }), _jsx(Layout.Section, { children: _jsxs(InlineGrid, { columns: { xs: 2, sm: 4 }, gap: "300", children: [_jsx(StatCard, { label: "Total Orders", value: stats?.total ?? 0, icon: OrderIcon }), stats?.byFulfillmentStatus && Object.entries(stats.byFulfillmentStatus).map(([status, count]) => (_jsx(StatCard, { label: status, value: count, icon: status === 'FULFILLED' ? CheckCircleIcon : status === 'NOT_STARTED' ? AlertCircleIcon : ClockIcon, tone: status === 'FULFILLED' ? 'success' : status === 'NOT_STARTED' ? 'warning' : 'info' }, status))), _jsx(StatCard, { label: "Synced", value: stats?.synced ?? 0, icon: CheckCircleIcon, tone: "success" })] }) })] }), _jsx(Card, { children: _jsxs(InlineStack, { gap: "300", align: "start", blockAlign: "end", children: [_jsx(Box, { minWidth: "280px", children: _jsx(TextField, { label: "Search", labelHidden: true, placeholder: "Search order ID or buyer\u2026", value: search, onChange: (v) => { setSearch(v); setPageOffset(0); }, prefix: _jsx(Icon, { source: SearchIcon }), autoComplete: "off", clearButton: true, onClearButtonClick: () => { setSearch(''); setPageOffset(0); } }) }), _jsx(Select, { label: "Fulfillment", labelHidden: true, options: FULFILLMENT_OPTIONS, value: fulfillmentFilter, onChange: (v) => { setFulfillmentFilter(v); setPageOffset(0); } }), _jsx(Select, { label: "Payment", labelHidden: true, options: PAYMENT_OPTIONS, value: paymentFilter, onChange: (v) => { setPaymentFilter(v); setPageOffset(0); } })] }) }), _jsx(Card, { padding: "0", children: isLoading ? (_jsx(Box, { padding: "800", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { accessibilityLabel: "Loading orders", size: "large" }) }) })) : (_jsx(IndexTable, { resourceName: { singular: 'order', plural: 'orders' }, itemCount: orders.length, headings: [
                            { title: 'Order ID' },
                            { title: 'Buyer' },
                            { title: 'Items' },
                            { title: 'Total' },
                            { title: 'Fulfillment' },
                            { title: 'Payment' },
                            { title: 'Date' },
                            { title: 'Synced' },
                        ], selectable: false, children: rowMarkup })) }), total > PAGE_SIZE && (_jsxs(InlineStack, { align: "center", gap: "300", children: [_jsx(Pagination, { hasPrevious: hasPrev, hasNext: hasNext, onPrevious: () => setPageOffset(Math.max(0, pageOffset - PAGE_SIZE)), onNext: () => setPageOffset(pageOffset + PAGE_SIZE) }), _jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: [pageOffset + 1, "\u2013", Math.min(pageOffset + PAGE_SIZE, total), " of ", total] })] }))] }) }));
};
export default EbayOrders;
