import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, BlockStack, Card, Divider, InlineStack, Page, Text, } from '@shopify/polaris';
import { useAuthoritativeListings } from '../hooks/useAuthoritativeListings';
import { useMigrationStatus } from '../hooks/useApi';
import { isHistoricalBackfillProtected, isLiveCatalogResponse, isMigrationPolicyAvailable, } from '../operator-ui';
const Row = ({ label, value, tone, }) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", gap: "300", children: [_jsx(Text, { as: "p", children: label }), _jsx(Badge, { tone: tone, children: value })] }));
const Settings = () => {
    const migration = useMigrationStatus();
    const listings = useAuthoritativeListings({ limit: 1, offset: 0 });
    const migrationAvailable = !migration.error && isMigrationPolicyAvailable(migration.data);
    const ebayAvailable = !listings.error && isLiveCatalogResponse(listings.data);
    const ebayCurrent = ebayAvailable && listings.data?.authoritative === true;
    const backfillProtected = isHistoricalBackfillProtected(migration.data);
    const shopifyState = migration.isLoading
        ? { value: 'Checking', tone: 'info' }
        : migrationAvailable
            ? { value: 'Embedded app', tone: 'info' }
            : { value: 'Unavailable', tone: 'critical' };
    const ebayState = listings.isLoading
        ? { value: 'Checking', tone: 'info' }
        : ebayCurrent
            ? { value: 'Current', tone: 'success' }
            : ebayAvailable
                ? { value: 'Unknown', tone: 'attention' }
                : { value: 'Unavailable', tone: 'critical' };
    const protectionState = migration.isLoading
        ? { value: 'Checking', tone: 'info' }
        : !migrationAvailable || migration.data?.historicalBackfillAllowed === undefined
            ? { value: 'Unavailable', tone: 'critical' }
            : backfillProtected
                ? { value: 'On', tone: 'success' }
                : { value: 'Off', tone: 'critical' };
    return (_jsx(Page, { title: "Settings", fullWidth: true, children: _jsxs(BlockStack, { gap: "500", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Connections" }), _jsx(Row, { label: "Shopify", ...shopifyState }), _jsx(Divider, {}), _jsx(Row, { label: "eBay", ...ebayState })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Ownership" }), _jsx(Row, { label: "Canon listing canary", value: "ProductPipeline", tone: "info" }), _jsx(Divider, {}), _jsx(Row, { label: "Orders", value: "Marketplace Connect", tone: "attention" }), _jsx(Divider, {}), _jsx(Row, { label: "Price", value: "Marketplace Connect", tone: "attention" }), _jsx(Divider, {}), _jsx(Row, { label: "Inventory", value: "Marketplace Connect", tone: "attention" })] }) }), _jsx(Card, { children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Historical orders" }), _jsx(Text, { as: "p", tone: "subdued", children: "Backfill protection" })] }), _jsx(Badge, { tone: protectionState.tone, children: protectionState.value })] }) })] }) }));
};
export default Settings;
