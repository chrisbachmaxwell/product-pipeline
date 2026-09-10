import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, BlockStack, Card, InlineStack, Page, Text, } from '@shopify/polaris';
import { useMigrationStatus, useOperationalMonitoring } from '../hooks/useApi';
/**
 * Orders is a reassurance page, not a work surface: imports are automatic,
 * and the actual orders live in Shopify's own Orders section where the
 * operator already works. This page says what runs, and what never will.
 */
const Orders = () => {
    const migration = useMigrationStatus();
    const monitoring = useOperationalMonitoring();
    const historical = migration.data?.reconciliation?.counts?.historicalEbayOrders
        ?? migration.data?.reconciliation?.counts?.historicalOrdersIneligible;
    const shadow = monitoring.data?.dailyDigest?.shadow;
    return (_jsx(Page, { title: "Orders", fullWidth: true, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Automatic import" }), _jsx(Badge, { tone: "success", children: "On" })] }), _jsx(Text, { as: "p", tone: "subdued", children: "When something sells on eBay, ProductPipeline creates the Shopify order (tagged \u201CeBay\u201D), lowers the stock count, and \u2014 once you ship with a tracking number \u2014 sends that tracking back to eBay. No clicks needed." }), _jsx(Text, { as: "p", tone: "subdued", children: "Find the orders themselves in Shopify\u2019s Orders section, filtered by the \u201CeBay\u201D tag." })] }) }), shadow && shadow.observedCount > 0 && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Latest check" }), _jsxs(Text, { as: "p", children: [shadow.matchedCount, " of ", shadow.observedCount, " recent eBay orders are confirmed in Shopify", shadow.unmatchedCount > 0
                                        ? ` — ${shadow.unmatchedCount} still importing or need a look.`
                                        : '.'] })] }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Old eBay orders" }), _jsx(Text, { as: "p", variant: "headingLg", children: typeof historical === 'number' ? historical : '—' })] }), _jsx(Text, { as: "p", tone: "subdued", children: "Orders from before September 8, 2026 stay in eBay\u2019s history and are never imported into Shopify. That protection is permanent." })] }) })] }) }));
};
export default Orders;
