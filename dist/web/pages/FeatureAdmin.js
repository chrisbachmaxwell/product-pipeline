import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Collapsible, Divider, EmptyState, FormLayout, Icon, InlineStack, Layout, Page, Select, SkeletonBodyText, Tabs, Text, TextField, } from '@shopify/polaris';
import { StarIcon, ChevronDownIcon, ChevronRightIcon, } from '@shopify/polaris-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
const STATUS_TABS = ['all', 'new', 'planned', 'in_progress', 'completed', 'declined'];
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
const FeatureAdmin = () => {
    const queryClient = useQueryClient();
    const [selectedTab, setSelectedTab] = useState(0);
    const [expandedId, setExpandedId] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editPriority, setEditPriority] = useState('');
    const [editNotes, setEditNotes] = useState('');
    const activeStatus = STATUS_TABS[selectedTab];
    const { data, isLoading, error } = useQuery({
        queryKey: ['features-admin', activeStatus],
        queryFn: () => {
            const params = activeStatus === 'all' ? '' : `?status=${activeStatus}`;
            return apiClient.get(`/features${params}`);
        },
    });
    const updateFeature = useMutation({
        mutationFn: ({ id, ...body }) => apiClient.put(`/features/${id}`, body),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['features-admin'] });
            queryClient.invalidateQueries({ queryKey: ['features'] });
            setExpandedId(null);
        },
    });
    const deleteFeature = useMutation({
        mutationFn: (id) => apiClient.delete(`/features/${id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['features-admin'] });
            queryClient.invalidateQueries({ queryKey: ['features'] });
        },
    });
    const handleExpand = useCallback((f) => {
        if (expandedId === f.id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(f.id);
        setEditStatus(f.status);
        setEditPriority(f.priority || 'medium');
        setEditNotes(f.admin_notes || '');
    }, [expandedId]);
    const handleSave = useCallback((id) => {
        updateFeature.mutate({
            id,
            status: editStatus,
            priority: editPriority,
            admin_notes: editNotes || undefined,
        });
    }, [editStatus, editPriority, editNotes, updateFeature]);
    const tabs = STATUS_TABS.map((status) => ({
        id: status,
        content: status === 'in_progress'
            ? 'In Progress'
            : status.charAt(0).toUpperCase() + status.slice(1),
        accessibilityLabel: `${status} feature requests`,
        panelID: `${status}-panel`,
    }));
    const features = data?.data || [];
    if (error) {
        return (_jsx(Page, { title: "Feature Admin", subtitle: "Manage feature requests \u2014 set status, priority, and notes", children: _jsx(Banner, { tone: "critical", title: "Failed to load feature requests", children: _jsx(Text, { as: "p", children: error.message }) }) }));
    }
    return (_jsx(Page, { title: "Feature Admin", subtitle: "Manage feature requests \u2014 set status, priority, and notes", children: _jsx(Layout, { children: _jsx(Layout.Section, { children: _jsx(Card, { children: _jsx(Tabs, { tabs: tabs, selected: selectedTab, onSelect: setSelectedTab, children: _jsx(Box, { paddingBlockStart: "400", children: isLoading ? (_jsx(SkeletonBodyText, { lines: 8 })) : features.length === 0 ? (_jsx(EmptyState, { heading: "No feature requests found", image: "", children: _jsxs(Text, { as: "p", children: ["No ", activeStatus === 'all' ? '' : activeStatus, " feature requests yet."] }) })) : (_jsx(BlockStack, { gap: "0", children: features.map((f, index) => {
                                    const isExpanded = expandedId === f.id;
                                    return (_jsxs(React.Fragment, { children: [index > 0 && _jsx(Divider, {}), _jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "200", children: [_jsx("div", { onClick: () => handleExpand(f), role: "button", tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ')
                                                                handleExpand(f); }, style: { cursor: 'pointer' }, children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", wrap: true, children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Icon, { source: isExpanded ? ChevronDownIcon : ChevronRightIcon, tone: "subdued" }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: f.title.length > 60 ? f.title.slice(0, 60) + '…' : f.title }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["#", f.id, " \u00B7", ' ', f.requested_by ? `By ${f.requested_by}` : 'Anonymous', " \u00B7", ' ', new Date(f.created_at).toLocaleDateString()] })] })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(Icon, { source: StarIcon, tone: "subdued" }), _jsx(Text, { variant: "bodySm", fontWeight: "semibold", as: "span", children: f.votes ?? 0 })] }), priorityBadge(f.priority), statusBadge(f.status)] })] }) }), _jsx(InlineStack, { gap: "200", children: _jsx(Button, { size: "slim", tone: "critical", onClick: () => {
                                                                    if (confirm(`Delete feature request #${f.id}?`)) {
                                                                        deleteFeature.mutate(f.id);
                                                                    }
                                                                }, children: "Delete" }) }), _jsx(Collapsible, { open: isExpanded, id: `edit-feature-${f.id}`, children: _jsx(Box, { paddingBlockStart: "400", paddingBlockEnd: "200", borderBlockStartWidth: "025", borderColor: "border", children: _jsxs(FormLayout, { children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: "Description" }), _jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "300", children: _jsx(Text, { as: "p", children: f.description }) })] }), _jsxs(InlineStack, { gap: "400", wrap: true, children: [_jsx(Box, { minWidth: "200px", children: _jsx(Select, { label: "Status", options: [
                                                                                            { label: 'New', value: 'new' },
                                                                                            { label: 'Planned', value: 'planned' },
                                                                                            { label: 'In Progress', value: 'in_progress' },
                                                                                            { label: 'Completed', value: 'completed' },
                                                                                            { label: 'Declined', value: 'declined' },
                                                                                        ], value: editStatus, onChange: setEditStatus }) }), _jsx(Box, { minWidth: "200px", children: _jsx(Select, { label: "Priority", options: [
                                                                                            { label: 'Low', value: 'low' },
                                                                                            { label: 'Medium', value: 'medium' },
                                                                                            { label: 'High', value: 'high' },
                                                                                            { label: 'Critical', value: 'critical' },
                                                                                        ], value: editPriority, onChange: setEditPriority }) })] }), _jsx(TextField, { label: "Admin notes", value: editNotes, onChange: setEditNotes, multiline: 3, placeholder: "Internal notes about this request\u2026", autoComplete: "off" }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "primary", onClick: () => handleSave(f.id), loading: updateFeature.isPending, children: "Save" }), _jsx(Button, { onClick: () => setExpandedId(null), children: "Cancel" })] })] }) }) })] }) })] }, f.id));
                                }) })) }) }) }) }) }) }));
};
export default FeatureAdmin;
