import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, BlockStack, InlineStack, ProgressBar, Text } from '@shopify/polaris';
import { CheckCircle2, XCircle, Loader2, Circle } from 'lucide-react';
const STEP_CONFIG = [
    { name: 'fetch_product', label: 'Shopify Import' },
    { name: 'generate_description', label: 'AI Description' },
    { name: 'process_images', label: 'Image Processing' },
    { name: 'create_ebay_listing', label: 'Draft Creation' },
];
const SECS_PER_IMAGE = 4;
const PipelineProgress = ({ jobId, onComplete, compact }) => {
    const [steps, setSteps] = useState(STEP_CONFIG.map((s) => ({ name: s.name, label: s.label, status: 'pending' })));
    const [jobStatus, setJobStatus] = useState('queued');
    const [title, setTitle] = useState('');
    const [startTime, setStartTime] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const [imageTotal, setImageTotal] = useState(0);
    const [sseConnected, setSseConnected] = useState(false);
    const eventSourceRef = useRef(null);
    const pollIntervalRef = useRef(null);
    const completeCalled = useRef(false);
    // Elapsed time ticker
    useEffect(() => {
        if (!startTime || jobStatus === 'completed' || jobStatus === 'failed')
            return;
        const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
        return () => clearInterval(id);
    }, [startTime, jobStatus]);
    const applySnapshot = useCallback((job) => {
        if (!job)
            return;
        setJobStatus(job.status);
        if (job.shopifyTitle)
            setTitle(job.shopifyTitle);
        if (job.startedAt) {
            const ms = job.startedAt > 1e12 ? job.startedAt : job.startedAt * 1000;
            setStartTime(ms);
        }
        setSteps((prev) => prev.map((s) => {
            const match = job.steps.find((js) => js.name === s.name);
            return match
                ? { ...s, status: match.status, result: match.result }
                : s;
        }));
    }, []);
    const applyStepEvent = useCallback((evt) => {
        if (evt.shopifyTitle)
            setTitle(evt.shopifyTitle);
        if (evt.jobStatus) {
            setJobStatus(evt.jobStatus);
            if ((evt.jobStatus === 'completed' || evt.jobStatus === 'failed') &&
                !completeCalled.current) {
                completeCalled.current = true;
                onComplete?.(evt.jobStatus, evt.shopifyTitle);
            }
        }
        if (!startTime && evt.status === 'running')
            setStartTime(Date.now());
        setSteps((prev) => prev.map((s) => {
            if (s.name !== evt.step)
                return s;
            return {
                ...s,
                status: evt.status ?? s.status,
                result: evt.detail ?? s.result,
                subDetail: evt.progress
                    ? `${evt.detail ?? ''}`
                    : evt.status === 'running'
                        ? evt.detail
                        : s.subDetail,
                progress: evt.progress ?? s.progress,
            };
        }));
        // Track image count for ETA
        if (evt.progress?.total && evt.step === 'process_images') {
            setImageTotal(evt.progress.total);
        }
    }, [onComplete, startTime]);
    // SSE connection
    useEffect(() => {
        const es = new EventSource(`/api/pipeline/jobs/${jobId}/stream`);
        eventSourceRef.current = es;
        es.onopen = () => setSseConnected(true);
        es.onerror = () => {
            setSseConnected(false);
            // Fallback to polling
            if (!pollIntervalRef.current) {
                pollIntervalRef.current = setInterval(async () => {
                    try {
                        const res = await fetch(`/api/pipeline/jobs/${jobId}`);
                        if (res.ok) {
                            const job = await res.json();
                            applySnapshot(job);
                        }
                    }
                    catch { }
                }, 10000);
            }
        };
        es.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                if (data.type === 'snapshot')
                    applySnapshot(data.job);
                else
                    applyStepEvent(data);
            }
            catch { }
        };
        return () => {
            es.close();
            if (pollIntervalRef.current)
                clearInterval(pollIntervalRef.current);
        };
    }, [jobId, applySnapshot, applyStepEvent]);
    // Progress calculation
    const progressPercent = useMemo(() => {
        const doneCount = steps.filter((s) => s.status === 'done').length;
        const runningStep = steps.find((s) => s.status === 'running');
        let partial = 0;
        if (runningStep?.progress) {
            partial = runningStep.progress.current / runningStep.progress.total;
        }
        return Math.round(((doneCount + partial * 0.9) / steps.length) * 100);
    }, [steps]);
    // ETA
    const etaText = useMemo(() => {
        if (jobStatus === 'completed')
            return 'Done';
        if (jobStatus === 'failed')
            return 'Failed';
        const currentStep = steps.find((s) => s.status === 'running');
        if (!currentStep)
            return '';
        if (currentStep.name === 'process_images' && imageTotal > 0 && currentStep.progress) {
            const remaining = imageTotal - currentStep.progress.current;
            const secs = remaining * SECS_PER_IMAGE;
            return secs > 60 ? `~${Math.ceil(secs / 60)}m remaining` : `~${secs}s remaining`;
        }
        return '';
    }, [steps, jobStatus, imageTotal]);
    const formatElapsed = (s) => {
        if (s < 60)
            return `${s}s`;
        return `${Math.floor(s / 60)}m ${s % 60}s`;
    };
    const statusIcon = (status) => {
        switch (status) {
            case 'done':
                return _jsx(CheckCircle2, { size: 18, color: "#22c55e" });
            case 'running':
                return _jsx(Loader2, { size: 18, color: "#f59e0b", className: "pipeline-spin" });
            case 'error':
                return _jsx(XCircle, { size: 18, color: "#ef4444" });
            default:
                return _jsx(Circle, { size: 18, color: "#d1d5db" });
        }
    };
    if (compact) {
        return (_jsxs("div", { style: { padding: '12px 0' }, children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [steps.map((s) => (_jsx("span", { title: `${s.label}: ${s.status}`, children: statusIcon(s.status) }, s.name))), _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: title || jobId }), etaText && (_jsx(Badge, { tone: "info", children: etaText }))] }), _jsx("div", { style: { marginTop: 6 }, children: _jsx(ProgressBar, { progress: progressPercent, size: "small", tone: jobStatus === 'failed' ? 'critical' : 'primary' }) })] }));
    }
    return (_jsxs("div", { className: "pipeline-progress-container", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: title || 'Processing...' }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Badge, { tone: jobStatus === 'completed' ? 'success' : jobStatus === 'failed' ? 'critical' : 'attention', children: jobStatus }), !sseConnected && _jsx(Badge, { tone: "warning", children: "Polling" })] })] }), _jsxs(BlockStack, { gap: "050", inlineAlign: "end", children: [_jsxs(Text, { as: "span", variant: "bodySm", tone: "subdued", children: ["Elapsed: ", formatElapsed(elapsed)] }), etaText && (_jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: etaText })), jobStatus === 'processing' && (_jsx("button", { onClick: async () => {
                                    try {
                                        await fetch(`/api/pipeline/jobs/${jobId}/cancel`, { method: 'POST' });
                                    }
                                    catch { /* best effort */ }
                                }, style: {
                                    marginTop: '4px',
                                    padding: '4px 12px',
                                    fontSize: '12px',
                                    background: '#dc2626',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                }, children: "\u2715 Cancel" }))] })] }), _jsx("div", { style: { margin: '16px 0' }, children: _jsx(ProgressBar, { progress: progressPercent, size: "small", tone: jobStatus === 'failed' ? 'critical' : 'primary' }) }), _jsx(BlockStack, { gap: "300", children: steps.map((step) => (_jsxs("div", { style: {
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '12px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        background: step.status === 'running'
                            ? 'rgba(245, 158, 11, 0.08)'
                            : step.status === 'done'
                                ? 'rgba(34, 197, 94, 0.05)'
                                : step.status === 'error'
                                    ? 'rgba(239, 68, 68, 0.06)'
                                    : 'transparent',
                        transition: 'background 0.3s',
                    }, children: [_jsx("div", { style: { marginTop: 2 }, children: statusIcon(step.status) }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsx(Text, { as: "span", variant: "bodyMd", fontWeight: "semibold", children: step.label }), step.subDetail && step.status === 'running' && (_jsx("div", { style: { marginTop: 2 }, children: _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: step.subDetail }) })), step.progress && step.status === 'running' && (_jsx("div", { style: { marginTop: 4, maxWidth: 200 }, children: _jsx(ProgressBar, { progress: Math.round((step.progress.current / step.progress.total) * 100), size: "small" }) })), step.status === 'done' && step.result && (_jsx("div", { style: { marginTop: 2 }, children: _jsx(Text, { as: "span", variant: "bodySm", tone: "subdued", children: step.result }) })), step.status === 'error' && step.result && (_jsx("div", { style: { marginTop: 2 }, children: _jsx(Text, { as: "span", variant: "bodySm", tone: "critical", children: step.result }) }))] })] }, step.name))) })] }));
};
export default PipelineProgress;
