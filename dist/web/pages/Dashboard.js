import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, BlockStack, Button, Card, InlineGrid, InlineStack, Page, SkeletonBodyText, Text, } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { useActivity, useOperationalMonitoring } from '../hooks/useApi';
import { formatVerifiedAt, isLiveCatalogResponse } from '../operator-ui';
const EVENT_EMOJI = {
    order_imported: '🛒',
    listing_ended: '🔚',
    listing_relisted: '🔁',
    quantity_updated: '📦',
    price_updated: '💲',
    tracking_sent: '🚚',
    listing_created: '✨',
};
const timeOfDay = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const CountCard = ({ label, value, tone, onClick }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: label }), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "p", variant: "heading2xl", tone: tone, children: value ?? '—' }), onClick && value !== null && value > 0 && (_jsx(Button, { variant: "plain", onClick: onClick, children: "View" }))] })] }) }));
/**
 * Home answers three questions in one glance, in plain words:
 * is everything synced, what sold, and what needs me?
 */
const Dashboard = () => {
    const navigate = useNavigate();
    const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
    const monitoring = useOperationalMonitoring();
    const activity = useActivity();
    const valid = isLiveCatalogResponse(listings.data);
    const summary = valid ? listings.data?.summary : undefined;
    const loading = listings.isLoading;
    const unavailable = Boolean(listings.error || (listings.data && !valid));
    const shadow = monitoring.data?.dailyDigest?.shadow;
    const attention = summary?.attention ?? null;
    const unknown = summary?.unknown ?? null;
    let heroTone = 'success';
    let heroHeading = 'Everything is synced';
    let heroBody = 'Your eBay listings match Shopify.';
    if (unavailable) {
        heroTone = 'warning';
        heroHeading = 'Checking eBay…';
        heroBody = 'Live status is temporarily unavailable. Syncing continues in the background.';
    }
    else if ((attention ?? 0) > 0) {
        heroTone = 'critical';
        heroHeading = attention === 1 ? '1 listing needs your review' : `${attention} listings need your review`;
        heroBody = 'Everything else is synced.';
    }
    else if ((unknown ?? 0) > 0) {
        heroTone = 'warning';
        heroHeading = 'Refreshing eBay status…';
        heroBody = 'The latest check has not finished. Syncing continues in the background.';
    }
    return (_jsx(Page, { title: "Home", fullWidth: true, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: loading ? (_jsx(SkeletonBodyText, { lines: 2 })) : (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Badge, { tone: heroTone === 'success' ? 'success' : heroTone === 'warning' ? 'attention' : 'critical', children: heroTone === 'success' ? 'Synced' : heroTone === 'warning' ? 'Checking' : 'Review' }), _jsx(Text, { as: "h2", variant: "headingLg", children: heroHeading })] }), _jsx(Text, { as: "p", tone: "subdued", children: heroBody })] }), (attention ?? 0) > 0 && (_jsx(Button, { variant: "primary", onClick: () => navigate('/issues'), children: "Review now" }))] })) }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 4 }, gap: "400", children: [_jsx(CountCard, { label: "Live on eBay", value: summary?.active ?? null }), _jsx(CountCard, { label: "Ready to list", value: summary?.readyToList ?? null, tone: (summary?.readyToList ?? 0) > 0 ? 'success' : undefined, onClick: () => navigate('/listings?filter=ready') }), _jsx(CountCard, { label: "Not on eBay", value: summary?.notListed ?? null, onClick: () => navigate('/listings') }), _jsx(CountCard, { label: "Needs review", value: attention, tone: (attention ?? 0) > 0 ? 'critical' : undefined, onClick: () => navigate('/issues') })] }), (activity.data?.events?.length ?? 0) > 0 && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Today" }), _jsx(BlockStack, { gap: "200", children: activity.data.events.slice(0, 8).map((event, index) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(Text, { as: "span", children: [(EVENT_EMOJI[event.kind] ?? '•') + ' ' + event.label, event.sku ? ` — ${event.sku}` : ''] }), _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: timeOfDay(event.atUtc) })] }, `${event.atUtc}-${index}`))) })] }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "eBay orders" }), _jsx(Badge, { tone: "success", children: "Automatic" })] }), _jsx(Text, { as: "p", tone: "subdued", children: "New eBay sales become Shopify orders within a few minutes, stock counts update everywhere, and tracking is sent back to eBay when you ship." }), shadow && shadow.observedCount > 0 && (_jsxs(Text, { as: "p", children: ["Last checked window: ", shadow.matchedCount, " of ", shadow.observedCount, " eBay orders confirmed in Shopify."] }))] }) }), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: valid ? formatVerifiedAt(listings.data?.observedAtUtc) : 'Waiting for the next check…' }), _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: "Shopify + eBay" })] })] }) }));
};
export default Dashboard;
