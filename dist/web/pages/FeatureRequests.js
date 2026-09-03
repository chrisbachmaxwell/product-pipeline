import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useMemo, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Divider, EmptyState, FormLayout, Icon, InlineStack, Layout, Modal, Page, Select, SkeletonBodyText, Text, TextField, } from '@shopify/polaris';
import { StarIcon, StarFilledIcon, PlusIcon, } from '@shopify/polaris-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
const statusBadge = (status) => {
    switch (status) {
        case 'new':
            return _jsx(Badge, { tone: "info", children: "New" });
        case 'planned':
            return _jsx(Badge, { tone: "attention", children: "Planned" });
        case 'in_progress':
            return _jsx(Badge, { tone: "warning", children: "In Progress" });
        case 'completed':
            return _jsx(Badge, { tone: "success", children: "Completed" });
        case 'declined':
            return _jsx(Badge, { children: "Declined" });
        default:
            return _jsx(Badge, { children: status });
    }
};
const priorityBadge = (priority) => {
    switch (priority) {
        case 'critical':
            return _jsx(Badge, { tone: "critical", children: "Critical" });
        case 'high':
            return _jsx(Badge, { tone: "warning", children: "High" });
        case 'medium':
            return _jsx(Badge, { tone: "info", children: "Medium" });
        case 'low':
            return _jsx(Badge, { children: "Low" });
        default:
            return _jsx(Badge, { children: priority });
    }
};
const FeatureRequests = () => {
    const queryClient = useQueryClient();
    const voterId = useMemo(() => {
        if (typeof window === 'undefined')
            return 'anonymous';
        const existing = localStorage.getItem('pp-feature-voter-id');
        if (existing)
            return existing;
        const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `pp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem('pp-feature-voter-id', generated);
        return generated;
    }, []);
    const [votedIds, setVotedIds] = useState(() => {
        if (typeof window === 'undefined')
            return new Set();
        try {
            const raw = localStorage.getItem('pp-feature-votes');
            if (!raw)
                return new Set();
            return new Set(JSON.parse(raw));
        }
        catch {
            return new Set();
        }
    });
    const [submitOpen, setSubmitOpen] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newPriority, setNewPriority] = useState('medium');
    const [newRequestedBy, setNewRequestedBy] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const { data, isLoading, error } = useQuery({
        queryKey: ['features', filterStatus],
        queryFn: () => {
            const params = filterStatus === 'all' ? '' : `?status=${filterStatus}`;
            return apiClient.get(`/features${params}`);
        },
    });
    const submitRequest = useMutation({
        mutationFn: (body) => apiClient.post('/features', body),
        onSuccess: () => {
            setSubmitOpen(false);
            setNewTitle('');
            setNewDescription('');
            setNewPriority('medium');
            setNewRequestedBy('');
            queryClient.invalidateQueries({ queryKey: ['features'] });
        },
    });
    const voteForFeature = useMutation({
        mutationFn: (featureId) => apiClient.post(`/features/${featureId}/vote`, { voterId }),
        onSuccess: (_data, featureId) => {
            setVotedIds((prev) => {
                const next = new Set(prev);
                next.add(featureId);
                if (typeof window !== 'undefined') {
                    localStorage.setItem('pp-feature-votes', JSON.stringify(Array.from(next)));
                }
                return next;
            });
            queryClient.invalidateQueries({ queryKey: ['features'] });
        },
    });
    const handleSubmit = useCallback(() => {
        if (!newTitle.trim() || !newDescription.trim())
            return;
        submitRequest.mutate({
            title: newTitle.trim(),
            description: newDescription.trim(),
            priority: newPriority,
            ...(newRequestedBy.trim() ? { requested_by: newRequestedBy.trim() } : {}),
        });
    }, [newTitle, newDescription, newPriority, newRequestedBy, submitRequest]);
    const statusOptions = [
        { label: 'All', value: 'all' },
        { label: 'New', value: 'new' },
        { label: 'Planned', value: 'planned' },
        { label: 'In Progress', value: 'in_progress' },
        { label: 'Completed', value: 'completed' },
        { label: 'Declined', value: 'declined' },
    ];
    const features = data?.data || [];
    if (error) {
        return (_jsx(Page, { title: "Feature Requests", children: _jsx(Banner, { tone: "critical", title: "Failed to load feature requests", children: _jsx(Text, { as: "p", children: error.message }) }) }));
    }
    return (_jsxs(Page, { title: "Feature Requests", subtitle: "Suggest improvements and track what's coming", primaryAction: {
            content: 'Submit Request',
            icon: PlusIcon,
            onAction: () => setSubmitOpen(true),
        }, children: [_jsxs(Layout, { children: [_jsx(Layout.Section, { children: _jsx(Card, { children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", wrap: true, children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: StarIcon }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingSm", as: "h2", children: "Feature requests" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: [features.length, " request", features.length !== 1 ? 's' : '', filterStatus !== 'all' ? ` with status "${filterStatus}"` : ''] })] })] }), _jsx(Box, { minWidth: "200px", children: _jsx(Select, { label: "Filter by status", labelHidden: true, options: statusOptions, value: filterStatus, onChange: setFilterStatus }) })] }) }) }), _jsx(Layout.Section, { children: isLoading ? (_jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 8 }) })) : features.length === 0 ? (_jsx(Card, { children: _jsxs(EmptyState, { heading: "No feature requests", image: "", children: [_jsx(Text, { as: "p", children: filterStatus !== 'all'
                                            ? 'No requests with this status. Try a different filter.'
                                            : 'No feature requests yet. Be the first to submit one!' }), _jsx(Button, { onClick: () => setSubmitOpen(true), variant: "primary", children: "Submit first request" })] }) })) : (_jsx(Card, { children: _jsx(BlockStack, { gap: "0", children: features.map((feature, index) => (_jsxs(React.Fragment, { children: [index > 0 && _jsx(Divider, {}), _jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "start", wrap: true, children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: feature.title }), _jsxs(InlineStack, { gap: "200", children: [statusBadge(feature.status), priorityBadge(feature.priority)] })] }), _jsxs(BlockStack, { gap: "100", inlineAlign: "end", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: new Date(feature.created_at).toLocaleDateString() }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(Icon, { source: votedIds.has(feature.id) ? StarFilledIcon : StarIcon, tone: votedIds.has(feature.id) ? 'warning' : 'subdued' }), _jsx(Text, { variant: "bodySm", fontWeight: "semibold", as: "span", children: feature.votes ?? 0 })] }), _jsx(Button, { size: "slim", variant: votedIds.has(feature.id) ? 'secondary' : 'primary', disabled: votedIds.has(feature.id), onClick: () => voteForFeature.mutate(feature.id), children: votedIds.has(feature.id) ? 'Voted' : 'Vote' })] })] })] }), _jsx(Text, { variant: "bodyMd", tone: "subdued", as: "p", children: feature.description }), feature.admin_notes && (_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", paddingInlineStart: "300", paddingBlockStart: "200", paddingBlockEnd: "200", paddingInlineEnd: "300", children: _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "bodySm", fontWeight: "semibold", tone: "subdued", as: "span", children: "Admin notes" }), _jsx(Text, { variant: "bodySm", as: "p", children: feature.admin_notes })] }) })), _jsxs(InlineStack, { gap: "300", children: [feature.requested_by && (_jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["Requested by ", feature.requested_by] })), feature.completed_at && (_jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["\u00B7 Completed ", new Date(feature.completed_at).toLocaleDateString()] }))] })] }) })] }, feature.id))) }) })) })] }), _jsx(Modal, { open: submitOpen, onClose: () => setSubmitOpen(false), title: "Submit Feature Request", primaryAction: {
                    content: 'Submit',
                    onAction: handleSubmit,
                    loading: submitRequest.isPending,
                    disabled: !newTitle.trim() || !newDescription.trim(),
                }, secondaryActions: [{ content: 'Cancel', onAction: () => setSubmitOpen(false) }], children: _jsx(Modal.Section, { children: _jsxs(FormLayout, { children: [_jsx(TextField, { label: "Title", value: newTitle, onChange: setNewTitle, placeholder: "Brief title for your request", autoComplete: "off", requiredIndicator: true }), _jsx(TextField, { label: "Description", value: newDescription, onChange: setNewDescription, multiline: 4, placeholder: "Describe the feature and why it would be useful\u2026", autoComplete: "off", requiredIndicator: true }), _jsx(Select, { label: "Priority", options: [
                                    { label: 'Low', value: 'low' },
                                    { label: 'Medium', value: 'medium' },
                                    { label: 'High', value: 'high' },
                                    { label: 'Critical', value: 'critical' },
                                ], value: newPriority, onChange: setNewPriority }), _jsx(TextField, { label: "Your name (optional)", value: newRequestedBy, onChange: setNewRequestedBy, autoComplete: "off" })] }) }) })] }));
};
export default FeatureRequests;
