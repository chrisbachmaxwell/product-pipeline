import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo } from 'react';
import { Badge, Banner, BlockStack, Box, Card, DataTable, Divider, Icon, InlineGrid, InlineStack, Layout, Page, SkeletonBodyText, SkeletonDisplayText, Text, } from '@shopify/polaris';
import { ChartVerticalFilledIcon, AlertCircleIcon, ClockIcon, StatusActiveIcon, } from '@shopify/polaris-icons';
import { useListingHealth, useLogs } from '../hooks/useApi';
/* ────────────────── Helpers ────────────────── */
const formatTimestamp = (value) => {
    if (!value)
        return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        return '—';
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000)
        return 'Just now';
    if (diffMs < 3_600_000)
        return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000)
        return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return d.toLocaleDateString();
};
const StatCard = ({ label, value, icon, tone }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(InlineStack, { align: "space-between", blockAlign: "center", children: _jsx(Box, { background: tone === 'success'
                        ? 'bg-fill-success-secondary'
                        : tone === 'critical'
                            ? 'bg-fill-critical-secondary'
                            : tone === 'warning'
                                ? 'bg-fill-warning-secondary'
                                : 'bg-fill-secondary', borderRadius: "200", padding: "200", children: _jsx(Icon, { source: icon, tone: tone ?? 'base' }) }) }), _jsx(Text, { variant: "headingXl", as: "p", children: typeof value === 'number' ? value.toLocaleString() : value }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: label })] }) }));
/* ────────────────── Analytics ────────────────── */
const Analytics = () => {
    const { data: logsData, isLoading: logsLoading, error: logsError } = useLogs(100);
    const { data: healthData, isLoading: healthLoading, error: healthError } = useListingHealth();
    const errorRows = useMemo(() => {
        if (!logsData?.data)
            return [];
        return logsData.data
            .filter((log) => log.status === 'error')
            .slice(0, 6)
            .map((log) => [
            log.topic ?? log.message ?? 'Error',
            log.source ?? 'System',
            formatTimestamp(log.createdAt ?? log.created_at),
        ]);
    }, [logsData]);
    const isLoading = logsLoading || healthLoading;
    if (logsError || healthError) {
        return (_jsx(Page, { title: "Analytics", subtitle: "Sync history and listing health", fullWidth: true, children: _jsx(Banner, { tone: "critical", title: "Analytics unavailable", children: _jsx(Text, { as: "p", children: logsError?.message ?? healthError?.message }) }) }));
    }
    return (_jsx(Page, { title: "Analytics", subtitle: "Sync history and listing health", fullWidth: true, children: _jsxs(BlockStack, { gap: "500", children: [_jsx(Layout, { children: _jsx(Layout.Section, { children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: ChartVerticalFilledIcon }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Listing Health" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Overview of your active listings and performance" })] })] }), _jsx(Divider, {}), _jsx(InlineGrid, { columns: { xs: 2, sm: 2, md: 4 }, gap: "300", children: isLoading ? (_jsx(_Fragment, { children: [1, 2, 3, 4].map((i) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(SkeletonDisplayText, { size: "large" }), _jsx(SkeletonBodyText, { lines: 1 })] }) }, i))) })) : (_jsxs(_Fragment, { children: [_jsx(StatCard, { label: "Active Listings", value: healthData?.totalActive ?? 0, icon: StatusActiveIcon, tone: (healthData?.totalActive ?? 0) > 0 ? 'success' : undefined }), _jsx(StatCard, { label: "Ended Listings", value: healthData?.totalEnded ?? 0, icon: ClockIcon }), _jsx(StatCard, { label: "Avg Days Listed", value: healthData?.averageDaysListed ?? 0, icon: ClockIcon }), _jsx(StatCard, { label: "Revenue", value: `$${(healthData?.revenue ?? 0).toLocaleString()}`, icon: ChartVerticalFilledIcon, tone: (healthData?.revenue ?? 0) > 0 ? 'success' : undefined })] })) })] }) }) }) }), !isLoading && Object.keys(healthData?.ageBuckets ?? {}).length > 0 && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Age Distribution" }), _jsx(Divider, {}), _jsx(DataTable, { columnContentTypes: ['text', 'numeric'], headings: ['Age Bucket', 'Listings'], rows: Object.entries(healthData?.ageBuckets ?? {}).map(([bucket, count]) => [bucket, count]) })] }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: errorRows.length > 0 ? 'bg-fill-critical-secondary' : 'bg-fill-success-secondary', borderRadius: "200", padding: "200", children: _jsx(Icon, { source: AlertCircleIcon, tone: errorRows.length > 0 ? 'critical' : 'success' }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Recent Errors" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: errorRows.length === 0 ? 'No recent errors — all clear!' : `${errorRows.length} error${errorRows.length !== 1 ? 's' : ''} found` })] })] }), errorRows.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Divider, {}), _jsx(DataTable, { columnContentTypes: ['text', 'text', 'text'], headings: ['Message', 'Source', 'Timestamp'], rows: errorRows })] }))] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Latest Sync History" }), _jsx(Divider, {}), isLoading ? (_jsx(SkeletonBodyText, { lines: 6 })) : (logsData?.data ?? []).length === 0 ? (_jsx(BlockStack, { gap: "200", inlineAlign: "center", children: _jsx(Text, { tone: "subdued", as: "p", children: "No sync activity yet" }) })) : (_jsx(BlockStack, { gap: "300", children: (logsData?.data ?? []).slice(0, 8).map((log) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "start", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "bodyMd", as: "p", fontWeight: "medium", children: log.topic ?? log.message ?? 'Sync event' }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: log.source ?? 'System' })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Badge, { tone: log.status === 'error'
                                                        ? 'critical'
                                                        : log.status === 'warning'
                                                            ? 'warning'
                                                            : log.status === 'success'
                                                                ? 'success'
                                                                : 'info', children: log.status ?? 'info' }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: formatTimestamp(log.createdAt ?? log.created_at) })] })] }, String(log.id ?? Math.random())))) }))] }) })] }) }));
};
export default Analytics;
