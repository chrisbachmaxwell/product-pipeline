import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, Banner, BlockStack, Card, InlineGrid, InlineStack, SkeletonBodyText, Text, } from '@shopify/polaris';
import { useOperationalMonitoring } from '../hooks/useApi';
const Count = ({ label, value }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "p", tone: "subdued", children: label }), _jsx(Text, { as: "p", variant: "headingLg", children: value.toLocaleString() })] }) }));
export const OperationalMonitoring = () => {
    const query = useOperationalMonitoring();
    if (query.isLoading)
        return _jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 5 }) });
    const monitor = query.data;
    if (query.error || !monitor || monitor.schemaVersion !== 1) {
        return (_jsx(Banner, { tone: "critical", title: "Operational monitoring unavailable", children: _jsx(Text, { as: "p", children: "The read-only operations digest could not be verified. No write is enabled." }) }));
    }
    const tone = monitor.status === 'green'
        ? 'success'
        : monitor.status === 'critical' ? 'critical' : 'warning';
    return (_jsxs(BlockStack, { gap: "400", children: [_jsx(Banner, { tone: tone, title: `Operations status: ${monitor.status}`, children: _jsx(Text, { as: "p", children: "Read-only local monitoring. It performs no provider read or write and sends no message." }) }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 3 }, gap: "300", children: [_jsx(Count, { label: "Unresolved jobs", value: monitor.counters.unresolvedJobs }), _jsx(Count, { label: "Confirmed missing jobs", value: monitor.counters.failedJobs }), _jsx(Count, { label: "Reconciliation exceptions", value: monitor.counters.reconciliationExceptions }), _jsx(Count, { label: "Unmatched shadow orders", value: monitor.counters.shadowUnmatchedOrders }), _jsx(Count, { label: "Blocked shadow lookups", value: monitor.counters.shadowBlockedOrders }), _jsx(Count, { label: "Catalog read failures", value: monitor.counters.catalogReadFailures })] }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Daily operations digest" }), _jsx(Badge, { tone: tone, children: monitor.dailyDigest.dateUtc ?? 'Unavailable' })] }), _jsxs(InlineGrid, { columns: { xs: 2, md: 4 }, gap: "300", children: [_jsx(Count, { label: "Writes performed", value: monitor.dailyDigest.writes.performed }), _jsx(Count, { label: "Writes succeeded", value: monitor.dailyDigest.writes.succeeded }), _jsx(Count, { label: "Writes failed", value: monitor.dailyDigest.writes.failed }), _jsx(Count, { label: "Writes unresolved", value: monitor.dailyDigest.writes.unresolved })] }), _jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["Skipped-write counts are not journaled until the separately gated G18 workers exist. Digest ", monitor.dailyDigest.digest] })] }) })] }));
};
