import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  ButtonGroup,
  Card,
  IndexTable,
  Layout,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
  DatePicker,
  Popover,
  Icon,
  Tabs,
  TextContainer,
  ProgressBar,
} from '@shopify/polaris';
import { CalendarIcon, FilterIcon, RefreshIcon } from '@shopify/polaris-icons';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Area,
  AreaChart,
} from 'recharts';

type LogEntry = {
  id: number;
  source: string;
  topic: string;
  status: string;
  createdAt: string;
  payload: string;
  level?: 'info' | 'warn' | 'error';
  operation?: string;
  duration?: number;
};

type LogsResponse = {
  data: LogEntry[];
  total?: number;
  hasMore?: boolean;
};

type AnalyticsData = {
  syncVolume: Array<{
    date: string;
    syncs: number;
    success: number;
    failed: number;
  }>;
  successRatio: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  averageDuration: Array<{
    operation: string;
    avgDuration: number;
    count: number;
  }>;
  topErrors: Array<{
    error: string;
    count: number;
    lastOccurred: string;
  }>;
  realtimeStats: {
    totalToday: number;
    successRate: number;
    avgResponseTime: number;
    errorCount: number;
  };
};

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const sourceBadge = (source?: string) => {
  const normalized = source?.toLowerCase();
  if (normalized === 'ebay') {
    return <Badge tone="success">eBay</Badge>;
  }
  if (normalized === 'shopify') {
    return <Badge tone="info">Shopify</Badge>;
  }
  return <Badge tone="warning">{source ?? 'Unknown'}</Badge>;
};

const statusBadge = (status?: string, level?: string) => {
  if (level === 'error' || status?.toLowerCase().includes('error')) {
    return <Badge tone="critical">Error</Badge>;
  }
  if (level === 'warn' || status?.toLowerCase().includes('warn')) {
    return <Badge tone="warning">Warning</Badge>;
  }
  if (status?.toLowerCase().includes('success')) {
    return <Badge tone="success">Success</Badge>;
  }
  return <Badge tone="info">{status ?? 'Unknown'}</Badge>;
};

const parsePayload = (payload: string) => {
  try {
    const parsed = JSON.parse(payload);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return payload;
  }
};

const COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#8dd1e1'];

const Logs: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [source, setSource] = useState('all');
  const [level, setLevel] = useState('all');
  const [operation, setOperation] = useState('all');
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [selectedTab, setSelectedTab] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(10000);

  // Date filter state
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [dateRange, setDateRange] = useState<{
    start?: Date;
    end?: Date;
  }>({
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
      if (source !== 'all') params.append('source', source);
      if (level !== 'all') params.append('level', level);
      if (operation !== 'all') params.append('operation', operation);
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
      const data = (await response.json()) as LogsResponse;
      setLogs(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  }, [source, level, operation, currentPage, limit, dateRange]);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    
    try {
      // Mock analytics data - replace with real API call
      const mockAnalytics: AnalyticsData = {
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
    } catch (err) {
      console.error('Failed to load analytics:', err);
    } finally {
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
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      void loadLogs();
      void loadAnalytics();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, loadLogs, loadAnalytics]);

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
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
    const grouped: Record<string, { count: number; lastSeen: string }> = {};
    
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
      return (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Spinner size="large" />
            <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
              Loading analytics...
            </Text>
          </div>
        </Card>
      );
    }

    if (!analytics) return null;

    return (
      <Layout>
        <Layout.Section>
          <Card>
            <Text variant="headingMd" as="h3">Real-time Statistics</Text>
            <div style={{ marginTop: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text as="span">Total Operations Today</Text>
                  <Text as="span" fontWeight="bold">{analytics.realtimeStats.totalToday}</Text>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text as="span">Success Rate</Text>
                  <Text as="span" fontWeight="bold">{analytics.realtimeStats.successRate}%</Text>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text as="span">Avg Response Time</Text>
                  <Text as="span" fontWeight="bold">{analytics.realtimeStats.avgResponseTime}s</Text>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text as="span">Errors Today</Text>
                  <Text as="span" fontWeight="bold" 
                    tone={analytics.realtimeStats.errorCount > 0 ? 'critical' : 'success'}>
                    {analytics.realtimeStats.errorCount}
                  </Text>
                </div>
              </div>
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text variant="headingMd" as="h3">Success/Failure Ratio</Text>
            <div style={{ height: '200px', marginTop: '16px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={analytics.successRatio}
                    cx="50%"
                    cy="50%"
                    outerRadius={60}
                    fill="#8884d8"
                    dataKey="value"
                    label={({ name, value }) => `${name} (${value}%)`}
                  >
                    {analytics.successRatio.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text variant="headingMd" as="h3">Sync Volume Over Time</Text>
            <div style={{ height: '300px', marginTop: '16px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics.syncVolume}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Area 
                    type="monotone" 
                    dataKey="success" 
                    stackId="1"
                    stroke="#82ca9d" 
                    fill="#82ca9d" 
                    name="Successful"
                  />
                  <Area 
                    type="monotone" 
                    dataKey="failed" 
                    stackId="1"
                    stroke="#ff7300" 
                    fill="#ff7300" 
                    name="Failed"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text variant="headingMd" as="h3">Average Sync Duration</Text>
            <div style={{ height: '250px', marginTop: '16px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.averageDuration} layout="horizontal">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="operation" width={100} />
                  <Tooltip 
                    formatter={(value, name) => [`${value}s`, 'Avg Duration']}
                    labelFormatter={(label) => `Operation: ${label}`}
                  />
                  <Bar dataKey="avgDuration" fill="#8884d8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text variant="headingMd" as="h3">Top Errors</Text>
            <div style={{ marginTop: '16px' }}>
              {analytics.topErrors.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {analytics.topErrors.map((errorItem, index) => (
                    <div 
                      key={index}
                      style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        padding: '8px',
                        backgroundColor: index === 0 ? '#fff5f5' : 'transparent',
                        borderRadius: '4px'
                      }}
                    >
                      <div>
                        <Text as="span" fontWeight={index === 0 ? 'bold' : 'regular'}>
                          {errorItem.error}
                        </Text>
                        <br />
                        <Text as="span" variant="bodySm" tone="subdued">
                          Last: {errorItem.lastOccurred}
                        </Text>
                      </div>
                      <Badge tone="critical">{errorItem.count.toString()}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <TextContainer>
                  <p>No errors recorded recently! 🎉</p>
                </TextContainer>
              )}
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    );
  };

  const renderLogsTab = () => {
    const rows = useMemo(() => {
      return logs.map((log: LogEntry, index: number) => {
        const isExpanded = expandedIds.has(log.id);
        const payload = parsePayload(log.payload);

        return (
          <IndexTable.Row id={String(log.id)} key={log.id} position={index}>
            <IndexTable.Cell>
              <Text as="span" variant="bodyMd">
                {log.id}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>{sourceBadge(log.source)}</IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" variant="bodyMd">
                {log.topic}
              </Text>
              {log.operation && (
                <div>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {log.operation}
                  </Text>
                </div>
              )}
              <div>
                <Button variant="plain" onClick={() => toggleExpanded(log.id)}>
                  {isExpanded ? 'Hide details' : 'View details'}
                </Button>
              </div>
              {isExpanded && (
                <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#f9f9f9', borderRadius: '4px' }}>
                  <pre style={{ fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto' }}>
                    {payload}
                  </pre>
                </div>
              )}
            </IndexTable.Cell>
            <IndexTable.Cell>
              {statusBadge(log.status, log.level)}
              {log.duration && (
                <div style={{ marginTop: '4px' }}>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {log.duration}ms
                  </Text>
                </div>
              )}
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" variant="bodySm">
                {formatDateTime(log.createdAt)}
              </Text>
            </IndexTable.Cell>
          </IndexTable.Row>
        );
      });
    }, [expandedIds, logs]);

    return (
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'end', flexWrap: 'wrap' }}>
              <div style={{ minWidth: '150px' }}>
                <Select
                  label="Source"
                  options={[
                    { label: 'All Sources', value: 'all' },
                    { label: 'eBay', value: 'ebay' },
                    { label: 'Shopify', value: 'shopify' },
                  ]}
                  value={source}
                  onChange={setSource}
                />
              </div>
              <div style={{ minWidth: '150px' }}>
                <Select
                  label="Level"
                  options={[
                    { label: 'All Levels', value: 'all' },
                    { label: 'Info', value: 'info' },
                    { label: 'Warning', value: 'warn' },
                    { label: 'Error', value: 'error' },
                  ]}
                  value={level}
                  onChange={setLevel}
                />
              </div>
              <div style={{ minWidth: '150px' }}>
                <Select
                  label="Operation"
                  options={[
                    { label: 'All Operations', value: 'all' },
                    { label: 'Product Sync', value: 'product_sync' },
                    { label: 'Order Sync', value: 'order_sync' },
                    { label: 'Inventory Update', value: 'inventory_update' },
                  ]}
                  value={operation}
                  onChange={setOperation}
                />
              </div>
              <div>
                <Popover
                  active={showDatePicker}
                  activator={
                    <Button 
                      onClick={() => setShowDatePicker(!showDatePicker)}
                      icon={CalendarIcon}
                    >
                      Date Range
                    </Button>
                  }
                  onClose={() => setShowDatePicker(false)}
                >
                  <div style={{ padding: '16px' }}>
                    <Text variant="headingSm" as="h4">Filter by Date Range</Text>
                    <div style={{ marginTop: '12px' }}>
                      <DatePicker
                        month={dateRange.start?.getMonth() || new Date().getMonth()}
                        year={dateRange.start?.getFullYear() || new Date().getFullYear()}
                        onChange={(selectedDate) => {
                          if ('start' in selectedDate && 'end' in selectedDate) {
                            setDateRange({ start: selectedDate.start, end: selectedDate.end });
                          }
                        }}
                        onMonthChange={(month, year) => {
                          // Handle month change if needed
                        }}
                        selected={dateRange.start && dateRange.end ? { start: dateRange.start, end: dateRange.end } : undefined}
                        allowRange
                      />
                    </div>
                  </div>
                </Popover>
              </div>
              <div>
                <ButtonGroup>
                  <Button 
                    onClick={handleRefresh} 
                    icon={RefreshIcon}
                    loading={loading}
                  >
                    Refresh
                  </Button>
                  <Button 
                    onClick={() => setAutoRefresh(!autoRefresh)}
                    pressed={autoRefresh}
                  >
                    Auto-refresh
                  </Button>
                </ButtonGroup>
              </div>
            </div>
            {autoRefresh && (
              <div style={{ marginTop: '12px' }}>
                <Text as="span" variant="bodySm" tone="subdued">
                  Auto-refreshing every {refreshInterval / 1000}s
                </Text>
                <ProgressBar progress={50} size="small" />
              </div>
            )}
          </Card>
        </Layout.Section>
        
        <Layout.Section>
          <Card>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <Spinner accessibilityLabel="Loading logs" size="large" />
              </div>
            ) : (
              <IndexTable
                resourceName={{ singular: 'log', plural: 'logs' }}
                itemCount={logs.length}
                selectable={false}
                headings={[
                  { title: 'ID' },
                  { title: 'Source' },
                  { title: 'Topic/Operation' },
                  { title: 'Status' },
                  { title: 'Created At' },
                ]}
              >
                {rows}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    );
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

  return (
    <Page title="Analytics & Logs">
      {error && (
        <Banner tone="critical" title="Unable to load data" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      )}
      
      <Card>
        <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
          <div style={{ marginTop: '16px' }}>
            {selectedTab === 0 && renderAnalyticsTab()}
            {selectedTab === 1 && renderLogsTab()}
          </div>
        </Tabs>
      </Card>
    </Page>
  );
};

export default Logs;