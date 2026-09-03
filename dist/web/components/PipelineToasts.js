import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, useCallback } from 'react';
const PipelineToasts = () => {
    const [jobs, setJobs] = useState(new Map());
    const cleanupTimers = useRef(new Map());
    const updateJob = useCallback((jobId, updates) => {
        setJobs((prev) => {
            const next = new Map(prev);
            const existing = next.get(jobId) || {
                jobId,
                title: jobId,
                status: 'running',
                currentStep: '',
                detail: '',
                startedAt: Date.now(),
            };
            next.set(jobId, { ...existing, ...updates });
            return next;
        });
    }, []);
    const removeJob = useCallback((jobId) => {
        setJobs((prev) => {
            const next = new Map(prev);
            next.delete(jobId);
            return next;
        });
    }, []);
    useEffect(() => {
        const es = new EventSource('/api/pipeline/stream');
        es.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                const { jobId, step, status, detail, progress, jobStatus, shopifyTitle } = data;
                const title = shopifyTitle || jobId;
                if (!jobId)
                    return;
                // Job started
                if (step === 'fetch_product' && status === 'running') {
                    // Clear any pending removal timer
                    const timer = cleanupTimers.current.get(jobId);
                    if (timer) {
                        clearTimeout(timer);
                        cleanupTimers.current.delete(jobId);
                    }
                    updateJob(jobId, { title, status: 'running', currentStep: 'Fetching product...', detail: '' });
                }
                // Step updates
                const stepLabels = {
                    fetch_product: 'Importing from Shopify',
                    generate_description: 'Generating AI description',
                    process_images: 'Processing photos',
                    create_ebay_listing: 'Creating draft',
                };
                if (step && status === 'running') {
                    const stepLabel = stepLabels[step] || step;
                    const progressText = progress ? ` (${progress.current}/${progress.total})` : '';
                    updateJob(jobId, {
                        title,
                        status: 'running',
                        currentStep: stepLabel + progressText,
                        detail: detail || '',
                        progress: progress || undefined,
                    });
                }
                if (step && status === 'done') {
                    const stepLabel = stepLabels[step] || step;
                    updateJob(jobId, {
                        title,
                        currentStep: `✅ ${stepLabel}`,
                        detail: detail || '',
                    });
                }
                // TIM condition
                if (detail?.includes('condition:') || detail?.includes('Condition')) {
                    updateJob(jobId, { detail });
                }
                // Completed
                if (jobStatus === 'completed') {
                    updateJob(jobId, {
                        title,
                        status: 'completed',
                        currentStep: '✅ Draft ready for review',
                        detail: detail || '',
                        completedAt: Date.now(),
                    });
                    // Auto-remove after 10 seconds
                    const timer = setTimeout(() => removeJob(jobId), 10000);
                    cleanupTimers.current.set(jobId, timer);
                }
                // Failed
                if (jobStatus === 'failed') {
                    updateJob(jobId, {
                        title,
                        status: 'failed',
                        currentStep: '❌ Failed',
                        detail: detail || 'Unknown error',
                        completedAt: Date.now(),
                    });
                    // Auto-remove after 15 seconds
                    const timer = setTimeout(() => removeJob(jobId), 15000);
                    cleanupTimers.current.set(jobId, timer);
                }
            }
            catch { }
        };
        return () => {
            es.close();
            cleanupTimers.current.forEach((t) => clearTimeout(t));
        };
    }, [updateJob, removeJob]);
    const activeJobs = Array.from(jobs.values());
    if (activeJobs.length === 0)
        return null;
    return (_jsxs("div", { style: {
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 999999,
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
        }, children: [activeJobs.map((job) => {
                const elapsed = Math.floor(((job.completedAt || Date.now()) - job.startedAt) / 1000);
                const bgColor = job.status === 'completed' ? '#16a34a'
                    : job.status === 'failed' ? '#dc2626'
                        : '#1a1a1a';
                return (_jsxs("div", { style: {
                        background: bgColor,
                        color: 'white',
                        padding: '10px 20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '13px',
                        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                        transition: 'background 0.3s ease',
                    }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }, children: [job.status === 'running' && (_jsx("div", { style: {
                                        width: '8px', height: '8px',
                                        borderRadius: '50%',
                                        background: '#fbbf24',
                                        animation: 'pulse 1.5s infinite',
                                    } })), _jsx("span", { style: { fontWeight: 600 }, children: job.title }), _jsx("span", { style: { opacity: 0.8 }, children: "\u2014" }), _jsx("span", { children: job.currentStep }), job.detail && job.status === 'running' && (_jsx("span", { style: { opacity: 0.6, fontSize: '12px' }, children: job.detail }))] }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px' }, children: [job.progress && job.status === 'running' && (_jsx("div", { style: {
                                        width: '100px', height: '4px',
                                        background: 'rgba(255,255,255,0.2)',
                                        borderRadius: '2px',
                                        overflow: 'hidden',
                                    }, children: _jsx("div", { style: {
                                            width: `${(job.progress.current / job.progress.total) * 100}%`,
                                            height: '100%',
                                            background: '#fbbf24',
                                            borderRadius: '2px',
                                            transition: 'width 0.3s ease',
                                        } }) })), _jsx("span", { style: { opacity: 0.6, fontSize: '12px' }, children: elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` }), job.status === 'running' && (_jsx("button", { onClick: async () => {
                                        try {
                                            await fetch(`/api/pipeline/jobs/${job.jobId}/cancel`, { method: 'POST' });
                                            removeJob(job.jobId);
                                        }
                                        catch { }
                                    }, style: {
                                        background: 'rgba(255,255,255,0.15)',
                                        border: 'none',
                                        color: 'white',
                                        padding: '2px 8px',
                                        borderRadius: '3px',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                    }, children: "\u2715" })), job.status !== 'running' && (_jsx("button", { onClick: () => removeJob(job.jobId), style: {
                                        background: 'none',
                                        border: 'none',
                                        color: 'rgba(255,255,255,0.6)',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                    }, children: "\u2715" }))] })] }, job.jobId));
            }), _jsx("style", { children: `
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      ` })] }));
};
export default PipelineToasts;
