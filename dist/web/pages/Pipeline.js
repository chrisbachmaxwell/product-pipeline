import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Divider, EmptyState, Icon, IndexTable, InlineGrid, InlineStack, Page, SkeletonBodyText, SkeletonPage, Text, TextField, } from '@shopify/polaris';
import { ProductIcon, MagicIcon, ImageIcon, StoreIcon, StatusActiveIcon, AlertCircleIcon, ClockIcon, CheckCircleIcon, PlayIcon, } from '@shopify/polaris-icons';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
import PipelineProgress from '../components/PipelineProgress';
/* ────────────────── Helpers ────────────────── */
const STEP_LABELS = {
    fetch_product: 'Shopify Import',
    generate_description: 'AI Description',
    process_images: 'Image Processing',
    create_ebay_listing: 'eBay Listing',
};
const STAGE_CONFIG = [
    { key: 'import', label: 'Shopify Import', description: 'Products ingested from catalog', icon: ProductIcon, tone: 'info' },
    { key: 'ai', label: 'AI Description', description: 'Optimized listing copy generated', icon: MagicIcon, tone: 'warning' },
    { key: 'images', label: 'Image Processing', description: 'PhotoRoom templates applied', icon: ImageIcon, tone: 'success' },
    { key: 'listing', label: 'eBay Listing', description: 'Published to marketplace', icon: StoreIcon, tone: 'info' },
];
function resolveStepLabel(job) {
    if (job.currentStep)
        return job.currentStep;
    const running = job.steps?.find((s) => s.status === 'running');
    if (running?.name && STEP_LABELS[running.name])
        return STEP_LABELS[running.name];
    const pending = job.steps?.find((s) => s.status === 'pending');
    if (pending?.name && STEP_LABELS[pending.name])
        return STEP_LABELS[pending.name];
    return 'Shopify Import';
}
function toMilliseconds(value) {
    if (value === null || value === undefined || value === '')
        return null;
    if (typeof value === 'number')
        return value > 1e12 ? value : value * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
function formatTimestamp(value) {
    const ms = toMilliseconds(value);
    if (!ms)
        return '—';
    const d = new Date(ms);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000)
        return 'Just now';
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString();
}
function formatDuration(start, end) {
    const startMs = toMilliseconds(start);
    if (!startMs)
        return '—';
    const endMs = toMilliseconds(end) ?? Date.now();
    const diffMs = Math.max(0, endMs - startMs);
    const totalMinutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (totalMinutes > 0)
        return `${totalMinutes}m`;
    return `${Math.max(1, Math.floor(diffMs / 1000))}s`;
}
function statusBadge(status) {
    switch (status) {
        case 'completed': return _jsx(Badge, { tone: "success", children: "Completed" });
        case 'processing': return _jsx(Badge, { tone: "attention", children: "Processing" });
        case 'queued': return _jsx(Badge, { tone: "info", children: "Queued" });
        case 'failed': return _jsx(Badge, { tone: "critical", children: "Failed" });
        default: return _jsx(Badge, { children: status });
    }
}
/* ────────────────── Stage Card ────────────────── */
const StageCard = ({ icon, label, description, count, tone }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", inlineAlign: "center", children: [_jsx(Box, { background: tone === 'success' ? 'bg-fill-success-secondary'
                    : tone === 'warning' ? 'bg-fill-warning-secondary'
                        : 'bg-fill-secondary', borderRadius: "200", padding: "300", children: _jsx(Icon, { source: icon, tone: tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'base' }) }), _jsx(Text, { variant: "headingSm", as: "h3", alignment: "center", children: label }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", alignment: "center", children: description }), count > 0 && _jsx(Badge, { tone: "attention", children: `${count} active` })] }) }));
/* ────────────────── Stat Card ────────────────── */
const StatCard = ({ label, value, icon, tone }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(InlineStack, { align: "space-between", blockAlign: "center", children: _jsx(Box, { background: tone === 'success' ? 'bg-fill-success-secondary'
                        : tone === 'critical' ? 'bg-fill-critical-secondary'
                            : tone === 'warning' ? 'bg-fill-warning-secondary'
                                : 'bg-fill-secondary', borderRadius: "200", padding: "200", children: _jsx(Icon, { source: icon, tone: tone }) }) }), _jsx(Text, { variant: "headingXl", as: "p", children: value }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: label })] }) }));
/* ────────────────── Pipeline Page ────────────────── */
const Pipeline = () => {
    const [productId, setProductId] = useState('');
    const [triggerStatus, setTriggerStatus] = useState({ loading: false, result: null });
    const [activeJobIds, setActiveJobIds] = useState([]);
    const handleRunPipeline = useCallback(async () => {
        const id = productId.trim();
        if (!id)
            return;
        setTriggerStatus({ loading: true, result: null });
        try {
            const res = await apiClient.post(`/auto-list/${encodeURIComponent(id)}`);
            const newJobId = res.jobId;
            setTriggerStatus({ loading: false, result: { success: true, message: res.message || 'Pipeline job started', jobId: newJobId } });
            if (newJobId)
                setActiveJobIds((prev) => (prev.includes(newJobId) ? prev : [newJobId, ...prev]));
        }
        catch (err) {
            setTriggerStatus({ loading: false, result: { success: false, message: err?.message || 'Failed to start pipeline job' } });
        }
    }, [productId]);
    const { data, isLoading } = useQuery({
        queryKey: ['pipeline-jobs'],
        queryFn: () => apiClient.get('/pipeline/jobs'),
        refetchInterval: 10000,
        retry: 1,
    });
    const jobs = data?.jobs ?? [];
    React.useEffect(() => {
        const activeFromData = jobs.filter((j) => j.status === 'processing' || j.status === 'queued').map((j) => j.id);
        if (activeFromData.length > 0) {
            setActiveJobIds((prev) => Array.from(new Set([...prev, ...activeFromData])));
        }
    }, [jobs]);
    const missingTitleIds = React.useMemo(() => {
        return Array.from(new Set(jobs.filter((j) => !j.shopifyTitle && j.shopifyProductId).map((j) => j.shopifyProductId)));
    }, [jobs]);
    const { data: titleLookup } = useQuery({
        queryKey: ['pipeline-job-titles', missingTitleIds],
        queryFn: async () => {
            if (missingTitleIds.length === 0)
                return {};
            const entries = await Promise.all(missingTitleIds.map(async (id) => {
                try {
                    const res = await apiClient.get(`/test/product-info/${encodeURIComponent(id)}`);
                    return [id, res.product?.title ?? ''];
                }
                catch {
                    return [id, ''];
                }
            }));
            return entries.reduce((acc, [id, title]) => { if (title)
                acc[id] = title; return acc; }, {});
        },
        enabled: missingTitleIds.length > 0,
        staleTime: 5 * 60 * 1000,
    });
    // Stage counts
    const countAtStep = (step) => jobs.filter((j) => resolveStepLabel(j) === step && (j.status === 'processing' || j.status === 'queued')).length;
    const stageCounts = {
        import: countAtStep('Shopify Import'),
        ai: countAtStep('AI Description'),
        images: countAtStep('Image Processing'),
        listing: countAtStep('eBay Listing'),
    };
    const completed = jobs.filter((j) => j.status === 'completed').length;
    const processing = jobs.filter((j) => j.status === 'processing').length;
    const queued = jobs.filter((j) => j.status === 'queued').length;
    const failed = jobs.filter((j) => j.status === 'failed').length;
    if (isLoading) {
        return (_jsx(SkeletonPage, { title: "Pipeline Overview", fullWidth: true, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 3 }) }), _jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 4 }) })] }) }));
    }
    return (_jsx(Page, { title: "Pipeline Overview", subtitle: "Real-time product automation flow", fullWidth: true, children: _jsxs(BlockStack, { gap: "500", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: PlayIcon }) }), _jsx(Text, { as: "h2", variant: "headingMd", children: "Process Product" })] }), _jsx(Text, { as: "p", tone: "subdued", variant: "bodySm", children: "Enter a Shopify product ID to run it through the auto-listing pipeline." }), _jsx(InlineStack, { gap: "300", blockAlign: "end", children: _jsx(Box, { minWidth: "320px", children: _jsx(TextField, { label: "Shopify Product ID", labelHidden: true, value: productId, onChange: setProductId, placeholder: "e.g. 8012345678901", autoComplete: "off", connectedRight: _jsx(Button, { variant: "primary", onClick: handleRunPipeline, loading: triggerStatus.loading, disabled: !productId.trim(), children: "Run Pipeline" }) }) }) }), triggerStatus.result && (_jsx(Banner, { tone: triggerStatus.result.success ? 'success' : 'critical', title: triggerStatus.result.message, onDismiss: () => setTriggerStatus((prev) => ({ ...prev, result: null })), children: triggerStatus.result.jobId && (_jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["Job ID: ", triggerStatus.result.jobId] })) }))] }) }), activeJobIds.length > 0 && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-warning-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: StatusActiveIcon, tone: "warning" }) }), _jsx(Text, { as: "h2", variant: "headingMd", children: "Live Pipeline Progress" })] }), _jsx(Button, { size: "slim", onClick: async () => {
                                            await fetch('/api/pipeline/jobs/clear-stuck', { method: 'POST' });
                                            setActiveJobIds([]);
                                        }, children: "Clear All" })] }), _jsx(Divider, {}), activeJobIds.map((jid) => (_jsx(PipelineProgress, { jobId: jid, onComplete: () => {
                                    setTimeout(() => setActiveJobIds((prev) => prev.filter((id) => id !== jid)), 10000);
                                } }, jid)))] }) })), _jsxs(InlineGrid, { columns: { xs: 2, sm: 4 }, gap: "300", children: [_jsx(StatCard, { label: "Completed", value: completed, icon: CheckCircleIcon, tone: "success" }), _jsx(StatCard, { label: "Processing", value: processing, icon: StatusActiveIcon, tone: "warning" }), _jsx(StatCard, { label: "Queued", value: queued, icon: ClockIcon, tone: "info" }), _jsx(StatCard, { label: "Failed", value: failed, icon: AlertCircleIcon, tone: "critical" })] }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Pipeline Flow" }), _jsx(Divider, {}), _jsx(InlineGrid, { columns: { xs: 2, sm: 4 }, gap: "300", children: STAGE_CONFIG.map((stage) => (_jsx(StageCard, { icon: stage.icon, label: stage.label, description: stage.description, count: stageCounts[stage.key] ?? 0, tone: stage.tone }, stage.key))) })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: ClockIcon }) }), _jsx(Text, { as: "h2", variant: "headingMd", children: "Recent Pipeline Jobs" })] }), _jsx(Divider, {}), jobs.length === 0 ? (_jsx(EmptyState, { heading: "No pipeline jobs yet", image: "", children: _jsx(Text, { as: "p", tone: "subdued", children: "Enter a Shopify Product ID above to run the pipeline." }) })) : (_jsx(IndexTable, { resourceName: { singular: 'job', plural: 'jobs' }, itemCount: jobs.length, headings: [
                                    { title: 'Product' },
                                    { title: 'Status' },
                                    { title: 'Current Step' },
                                    { title: 'Started' },
                                    { title: 'Duration' },
                                ], selectable: false, children: jobs.map((job, idx) => (_jsxs(IndexTable.Row, { id: job.id, position: idx, children: [_jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", variant: "bodyMd", fontWeight: "semibold", children: job.shopifyTitle ?? titleLookup?.[job.shopifyProductId] ?? `Product ${job.shopifyProductId}` }) }), _jsx(IndexTable.Cell, { children: statusBadge(job.status) }), _jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", children: resolveStepLabel(job) }) }), _jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", tone: "subdued", children: formatTimestamp(job.startedAt ?? job.createdAt ?? null) }) }), _jsx(IndexTable.Cell, { children: _jsx(Text, { as: "span", tone: "subdued", children: formatDuration(job.startedAt ?? job.createdAt ?? null, job.completedAt ?? null) }) })] }, job.id))) }))] }) })] }) }));
};
export default Pipeline;
