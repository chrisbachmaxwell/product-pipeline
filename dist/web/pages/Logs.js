import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Button, ButtonGroup, Card, IndexTable, Layout, Page, Select, Spinner, Text, DatePicker, Popover, Tabs, TextContainer, ProgressBar, } from '@shopify/polaris';
import { CalendarIcon, RefreshIcon } from '@shopify/polaris-icons';
import { XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Area, AreaChart, } from 'recharts';
const formatDateTime = (value) => {
    if (!value) {
        return '—';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return parsed.toLocaleString();
};
const sourceBadge = (source) => {
    const normalized = source?.toLowerCase();
    if (normalized === 'ebay') {
        return _jsx(Badge, { tone: "success", children: "eBay" });
    }
    if (normalized === 'shopify') {
        return _jsx(Badge, { tone: "info", children: "Shopify" });
    }
    return _jsx(Badge, { tone: "warning", children: source ?? 'Unknown' });
};
const statusBadge = (status, level) => {
    if (level === 'error' || status?.toLowerCase().includes('error')) {
        return _jsx(Badge, { tone: "critical", children: "Error" });
    }
    if (level === 'warn' || status?.toLowerCase().includes('warn')) {
        return _jsx(Badge, { tone: "warning", children: "Warning" });
    }
    if (status?.toLowerCase().includes('success')) {
        return _jsx(Badge, { tone: "success", children: "Success" });
    }
    return _jsx(Badge, { tone: "info", children: status ?? 'Unknown' });
};
const parsePayload = (payload) => {
    try {
        const parsed = JSON.parse(payload);
        return JSON.stringify(parsed, null, 2);
    }
    catch {
        return payload;
    }
};
const COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#8dd1e1'];
const Logs = () => {
    const [logs, setLogs] = useState([]);
    const [analytics, setAnalytics] = useState(null);
    const [source, setSource] = useState('all');
    const [level, setLevel] = useState('all');
    const [operation, setOperation] = useState('all');
    const [loading, setLoading] = useState(true);
    const [analyticsLoading, setAnalyticsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [expandedIds, setExpandedIds] = useState(new Set());
    const [selectedTab, setSelectedTab] = useState(0);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [refreshInterval, setRefreshInterval] = useState(10000);
    // Date filter state
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [dateRange, setDateRange] = useState({
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
        end: new Date(),
    });
    // Pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [limit] = useState(50);
    const loadLogs = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (source !== 'all')
                params.append('source', source);
            if (level !== 'all')
                params.append('level', level);
            if (operation !== 'all')
                params.append('operation', operation);
            params.append('limit', limit.toString());
            params.append('offset', ((currentPage - 1) * limit).toString());
            if (dateRange.start) {
                params.append('startDate', dateRange.start.toISOString());
            }
            if (dateRange.end) {
                params.append('endDate', dateRange.end.toISOString());
            }
            const response = await fetch(`/api/logs?${params}`);
            if (!response.ok) {
                throw new Error('Failed to fetch logs');
            }
            const data = (await response.json());
            setLogs(data.data ?? []);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch logs');
        }
        finally {
            setLoading(false);
        }
    }, [source, level, operation, currentPage, limit, dateRange]);
    const loadAnalytics = useCallback(async () => {
        setAnalyticsLoading(true);
        try {
            // Mock analytics data - replace with real API call
            const mockAnalytics = {
                syncVolume: Array.from({ length: 7 }, (_, i) => {
                    const date = new Date();
                    date.setDate(date.getDate() - (6 - i));
                    const syncs = Math.floor(Math.random() * 100) + 20;
                    const success = Math.floor(syncs * (0.8 + Math.random() * 0.15));
                    return {
                        date: date.toISOString().split('T')[0],
                        syncs,
                        success,
                        failed: syncs - success,
                    };
                }),
                successRatio: [
                    { name: 'Success', value: 85, color: '#82ca9d' },
                    { name: 'Failed', value: 12, color: '#ff7300' },
                    { name: 'Warning', value: 3, color: '#ffc658' },
                ],
                averageDuration: [
                    { operation: 'Product Sync', avgDuration: 2.3, count: 156 },
                    { operation: 'Order Sync', avgDuration: 1.8, count: 89 },
                    { operation: 'Inventory Sync', avgDuration: 4.1, count: 234 },
                    { operation: 'Price Update', avgDuration: 0.9, count: 67 },
                ],
                topErrors: [
                    { error: 'eBay API Rate Limit', count: 23, lastOccurred: '2 hours ago' },
                    { error: 'Shopify Webhook Timeout', count: 15, lastOccurred: '4 hours ago' },
                    { error: 'Product Not Found', count: 12, lastOccurred: '1 day ago' },
                    { error: 'Invalid SKU Format', count: 8, lastOccurred: '2 days ago' },
                ],
                realtimeStats: {
                    totalToday: 287,
                    successRate: 87.5,
                    avgResponseTime: 1.2,
                    errorCount: 36,
                },
            };
            setAnalytics(mockAnalytics);
        }
        catch (err) {
            console.error('Failed to load analytics:', err);
        }
        finally {
            setAnalyticsLoading(false);
        }
    }, []);
    useEffect(() => {
        void loadLogs();
    }, [loadLogs]);
    useEffect(() => {
        void loadAnalytics();
    }, [loadAnalytics]);
    // Auto-refresh effect
    useEffect(() => {
        if (!autoRefresh)
            return;
        const interval = setInterval(() => {
            void loadLogs();
            void loadAnalytics();
        }, refreshInterval);
        return () => clearInterval(interval);
    }, [autoRefresh, refreshInterval, loadLogs, loadAnalytics]);
    const toggleExpanded = (id) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            }
            else {
                next.add(id);
            }
            return next;
        });
    };
    const handleRefresh = () => {
        void loadLogs();
        void loadAnalytics();
    };
    const getGroupedErrors = () => {
        const errorLogs = logs.filter(log => log.level === 'error' || log.status?.toLowerCase().includes('error'));
        const grouped = {};
        errorLogs.forEach(log => {
            const errorType = log.topic || 'Unknown Error';
            if (!grouped[errorType]) {
                grouped[errorType] = { count: 0, lastSeen: log.createdAt };
            }
            grouped[errorType].count++;
            if (new Date(log.createdAt) > new Date(grouped[errorType].lastSeen)) {
                grouped[errorType].lastSeen = log.createdAt;
            }
        });
        return Object.entries(grouped)
            .map(([error, data]) => ({ error, ...data }))
            .sort((a, b) => b.count - a.count);
    };
    const renderAnalyticsTab = () => {
        if (analyticsLoading) {
            return (_jsx(Card, { children: _jsxs("div", { style: { textAlign: 'center', padding: '40px' }, children: [_jsx(Spinner, { size: "large" }), _jsx(Text, { variant: "bodyMd", as: "p", tone: "subdued", alignment: "center", children: "Loading analytics..." })] }) }));
        }
        if (!analytics)
            return null;
        return (_jsxs(Layout, { children: [_jsx(Layout.Section, { children: _jsxs(Card, { children: [_jsx(Text, { variant: "headingMd", as: "h3", children: "Real-time Statistics" }), _jsx("div", { style: { marginTop: '16px' }, children: _jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx(Text, { as: "span", children: "Total Operations Today" }), _jsx(Text, { as: "span", fontWeight: "bold", children: analytics.realtimeStats.totalToday })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx(Text, { as: "span", children: "Success Rate" }), _jsxs(Text, { as: "span", fontWeight: "bold", children: [analytics.realtimeStats.successRate, "%"] })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx(Text, { as: "span", children: "Avg Response Time" }), _jsxs(Text, { as: "span", fontWeight: "bold", children: [analytics.realtimeStats.avgResponseTime, "s"] })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx(Text, { as: "span", children: "Errors Today" }), _jsx(Text, { as: "span", fontWeight: "bold", tone: analytics.realtimeStats.errorCount > 0 ? 'critical' : 'success', children: analytics.realtimeStats.errorCount })] })] }) })] }) }), _jsx(Layout.Section, { children: _jsxs(Card, { children: [_jsx(Text, { variant: "headingMd", as: "h3", children: "Success/Failure Ratio" }), _jsx("div", { style: { height: '200px', marginTop: '16px' }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(PieChart, { children: [_jsx(Pie, { data: analytics.successRatio, cx: "50%", cy: "50%", outerRadius: 60, fill: "#8884d8", dataKey: "value", label: ({ name, value }) => `${name} (${value}%)`, children: analytics.successRatio.map((entry, index) => (_jsx(Cell, { fill: entry.color }, `cell-${index}`))) }), _jsx(Tooltip, {})] }) }) })] }) }), _jsx(Layout.Section, { children: _jsxs(Card, { children: [_jsx(Text, { variant: "headingMd", as: "h3", children: "Sync Volume Over Time" }), _jsx("div", { style: { height: '300px', marginTop: '16px' }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(AreaChart, { data: analytics.syncVolume, children: [_jsx(CartesianGrid, { strokeDasharray: "3 3" }), _jsx(XAxis, { dataKey: "date" }), _jsx(YAxis, {}), _jsx(Tooltip, {}), _jsx(Legend, {}), _jsx(Area, { type: "monotone", dataKey: "success", stackId: "1", stroke: "#82ca9d", fill: "#82ca9d", name: "Successful" }), _jsx(Area, { type: "monotone", dataKey: "failed", stackId: "1", stroke: "#ff7300", fill: "#ff7300", name: "Failed" })] }) }) })] }) }), _jsx(Layout.Section, { children: _jsxs(Card, { children: [_jsx(Text, { variant: "headingMd", as: "h3", children: "Average Sync Duration" }), _jsx("div", { style: { height: '250px', marginTop: '16px' }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(BarChart, { data: analytics.averageDuration, layout: "horizontal", children: [_jsx(CartesianGrid, { strokeDasharray: "3 3" }), _jsx(XAxis, { type: "number" }), _jsx(YAxis, { type: "category", dataKey: "operation", width: 100 }), _jsx(Tooltip, { formatter: (value, name) => [`${value}s`, 'Avg Duration'], labelFormatter: (label) => `Operation: ${label}` }), _jsx(Bar, { dataKey: "avgDuration", fill: "#8884d8" })] }) }) })] }) }), _jsx(Layout.Section, { children: _jsxs(Card, { children: [_jsx(Text, { variant: "headingMd", as: "h3", children: "Top Errors" }), _jsx("div", { style: { marginTop: '16px' }, children: analytics.topErrors.length > 0 ? (_jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: analytics.topErrors.map((errorItem, index) => (_jsxs("div", { style: {
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            padding: '8px',
                                            backgroundColor: index === 0 ? '#fff5f5' : 'transparent',
                                            borderRadius: '4px'
                                        }, children: [_jsxs("div", { children: [_jsx(Text, { as: "span", fontWeight: index === 0 ? 'bold' : 'regular', children: errorItem.error }), _jsx("br", {}), _jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: ["Last: ", errorItem.lastOccurred] })] }), _jsx(Badge, { tone: "critical", children: errorItem.count.toString() })] }, index))) })) : (_jsx(TextContainer, { children: _jsx("p", { children: "No errors recorded recently! \uD83C\uDF89" }) })) })] }) })] }));
    };
    const renderLogsTab = () => {
        const rows = useMemo(() => {
            return logs.map((log, index) => {
                const isExpanded = expandedIds.has(log.id);
                const payload = parsePayload(log.payload);
                return (_jsxs(IndexTable.Row, { id: String(log.id), position: index, children: [_jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", variant: "bodyMd", children: log.id }) }), _jsx(IndexTable.Cell, { children: sourceBadge(log.source) }), _jsxs(IndexTable.Cell, { children: [_jsx(Text, { as: "span", variant: "bodyMd", children: log.topic }), log.operation && (_jsx("div", { children: _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: log.operation }) })), _jsx("div", { children: _jsx(Button, { variant: "plain", onClick: () => toggleExpanded(log.id), children: isExpanded ? 'Hide details' : 'View details' }) }), isExpanded && (_jsx("div", { style: { marginTop: '8px', padding: '8px', backgroundColor: '#f9f9f9', borderRadius: '4px' }, children: _jsx("pre", { style: { fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto' }, children: payload }) }))] }), _jsxs(IndexTable.Cell, { children: [statusBadge(log.status, log.level), log.duration && (_jsx("div", { style: { marginTop: '4px' }, children: _jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: [log.duration, "ms"] }) }))] }), _jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", variant: "bodySm", children: formatDateTime(log.createdAt) }) })] }, log.id));
            });
        }, [expandedIds, logs]);
        return (_jsxs(Layout, { children: [_jsx(Layout.Section, { children: _jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', gap: '12px', alignItems: 'end', flexWrap: 'wrap' }, children: [_jsx("div", { style: { minWidth: '150px' }, children: _jsx(Select, { label: "Source", options: [
                                                { label: 'All Sources', value: 'all' },
                                                { label: 'eBay', value: 'ebay' },
                                                { label: 'Shopify', value: 'shopify' },
                                            ], value: source, onChange: setSource }) }), _jsx("div", { style: { minWidth: '150px' }, children: _jsx(Select, { label: "Level", options: [
                                                { label: 'All Levels', value: 'all' },
                                                { label: 'Info', value: 'info' },
                                                { label: 'Warning', value: 'warn' },
                                                { label: 'Error', value: 'error' },
                                            ], value: level, onChange: setLevel }) }), _jsx("div", { style: { minWidth: '150px' }, children: _jsx(Select, { label: "Operation", options: [
                                                { label: 'All Operations', value: 'all' },
                                                { label: 'Product Sync', value: 'product_sync' },
                                                { label: 'Order Sync', value: 'order_sync' },
                                                { label: 'Inventory Update', value: 'inventory_update' },
                                            ], value: operation, onChange: setOperation }) }), _jsx("div", { children: _jsx(Popover, { active: showDatePicker, activator: _jsx(Button, { onClick: () => setShowDatePicker(!showDatePicker), icon: CalendarIcon, children: "Date Range" }), onClose: () => setShowDatePicker(false), children: _jsxs("div", { style: { padding: '16px' }, children: [_jsx(Text, { variant: "headingSm", as: "h4", children: "Filter by Date Range" }), _jsx("div", { style: { marginTop: '12px' }, children: _jsx(DatePicker, { month: dateRange.start?.getMonth() || new Date().getMonth(), year: dateRange.start?.getFullYear() || new Date().getFullYear(), onChange: (selectedDate) => {
                                                                if ('start' in selectedDate && 'end' in selectedDate) {
                                                                    setDateRange({ start: selectedDate.start, end: selectedDate.end });
                                                                }
                                                            }, onMonthChange: (month, year) => {
                                                                // Handle month change if needed
                                                            }, selected: dateRange.start && dateRange.end ? { start: dateRange.start, end: dateRange.end } : undefined, allowRange: true }) })] }) }) }), _jsx("div", { children: _jsxs(ButtonGroup, { children: [_jsx(Button, { onClick: handleRefresh, icon: RefreshIcon, loading: loading, children: "Refresh" }), _jsx(Button, { onClick: () => setAutoRefresh(!autoRefresh), pressed: autoRefresh, children: "Auto-refresh" })] }) })] }), autoRefresh && (_jsxs("div", { style: { marginTop: '12px' }, children: [_jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: ["Auto-refreshing every ", refreshInterval / 1000, "s"] }), _jsx(ProgressBar, { progress: 50, size: "small" })] }))] }) }), _jsx(Layout.Section, { children: _jsx(Card, { children: loading ? (_jsx("div", { style: { textAlign: 'center', padding: '40px' }, children: _jsx(Spinner, { accessibilityLabel: "Loading logs", size: "large" }) })) : (_jsx(IndexTable, { resourceName: { singular: 'log', plural: 'logs' }, itemCount: logs.length, selectable: false, headings: [
                                { title: 'ID' },
                                { title: 'Source' },
                                { title: 'Topic/Operation' },
                                { title: 'Status' },
                                { title: 'Created At' },
                            ], children: rows })) }) })] }));
    };
    const tabs = [
        {
            id: 'analytics',
            content: 'Analytics',
            accessibilityLabel: 'Analytics dashboard',
            panelID: 'analytics-panel',
        },
        {
            id: 'logs',
            content: 'Logs',
            accessibilityLabel: 'System logs',
            panelID: 'logs-panel',
        },
    ];
    return (_jsxs(Page, { title: "Analytics & Logs", children: [error && (_jsx(Banner, { tone: "critical", title: "Unable to load data", onDismiss: () => setError(null), children: _jsx("p", { children: error }) })), _jsx(Card, { children: _jsx(Tabs, { tabs: tabs, selected: selectedTab, onSelect: setSelectedTab, children: _jsxs("div", { style: { marginTop: '16px' }, children: [selectedTab === 0 && renderAnalyticsTab(), selectedTab === 1 && renderLogsTab()] }) }) })] }));
};
export default Logs;
