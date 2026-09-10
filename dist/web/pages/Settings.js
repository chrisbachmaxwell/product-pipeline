import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, BlockStack, Card, InlineStack, Page, Text, } from '@shopify/polaris';
import { useMigrationStatus } from '../hooks/useApi';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { isLiveCatalogResponse } from '../operator-ui';
const Row = ({ label, children }) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "span", children: label }), children] }));
/** Owner labels the server reports -> what the operator should read. */
const OWNER_LABEL = {
    'product-pipeline': { text: 'ProductPipeline', tone: 'success' },
    'marketplace-connect': { text: 'Marketplace Connect', tone: 'attention' },
    unverified: { text: 'Not yet transferred', tone: 'attention' },
};
const RESPONSIBILITY_LABEL = {
    orderImport: 'Order import',
    price: 'Prices',
    inventory: 'Inventory',
    listingCreate: 'New listings',
    listingRevise: 'Listing edits',
    listingEndRelist: 'Ending and relisting',
    fulfillment: 'Tracking numbers',
};
const Settings = () => {
    const migration = useMigrationStatus();
    const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
    const ebayCurrent = isLiveCatalogResponse(listings.data);
    const responsibilities = (migration.data?.responsibilities ?? [])
        .filter((entry) => entry.responsibility in RESPONSIBILITY_LABEL);
    return (_jsx(Page, { title: "Settings", fullWidth: true, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Connections" }), _jsx(Row, { label: "Shopify", children: _jsx(Badge, { tone: "success", children: "Connected" }) }), _jsx(Row, { label: "eBay", children: ebayCurrent
                                    ? _jsx(Badge, { tone: "success", children: "Connected" })
                                    : _jsx(Badge, { tone: "attention", children: "Checking\u2026" }) })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "What ProductPipeline runs" }), responsibilities.map((entry) => {
                                const owner = OWNER_LABEL[entry.owner ?? ''] ?? OWNER_LABEL.unverified;
                                return (_jsx(Row, { label: RESPONSIBILITY_LABEL[entry.responsibility], children: _jsx(Badge, { tone: owner.tone, children: owner.text }) }, entry.responsibility));
                            }), _jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Marketplace Connect was retired on September 8, 2026. Every change to eBay is recorded in a tamper-evident history." })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Old eBay orders" }), _jsx(Badge, { tone: "success", children: "Protected" })] }), _jsx(Text, { as: "p", tone: "subdued", children: "Orders from before September 8, 2026 are never imported into Shopify. This protection is permanent and cannot be switched off." })] }) })] }) }));
};
export default Settings;
