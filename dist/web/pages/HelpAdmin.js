import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Collapsible, Divider, EmptyState, FormLayout, Icon, InlineStack, Layout, Page, Select, SkeletonBodyText, Tabs, Text, TextField, } from '@shopify/polaris';
import { ChevronDownIcon, ChevronRightIcon, CheckCircleIcon, } from '@shopify/polaris-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
const STATUS_TABS = ['all', 'pending', 'answered', 'published', 'archived'];
const statusBadge = (status) => {
    switch (status) {
        case 'pending':
            return _jsx(Badge, { tone: "warning", children: "Pending" });
        case 'answered':
            return _jsx(Badge, { tone: "info", children: "Answered" });
        case 'published':
            return _jsx(Badge, { tone: "success", children: "Published" });
        case 'archived':
            return _jsx(Badge, { children: "Archived" });
        default:
            return _jsx(Badge, { children: status });
    }
};
const HelpAdmin = () => {
    const queryClient = useQueryClient();
    const [selectedTab, setSelectedTab] = useState(0);
    const [expandedId, setExpandedId] = useState(null);
    const [editAnswer, setEditAnswer] = useState('');
    const [editCategory, setEditCategory] = useState('');
    const [editStatus, setEditStatus] = useState('');
    const activeStatus = STATUS_TABS[selectedTab];
    const { data, isLoading, error } = useQuery({
        queryKey: ['help-questions', activeStatus],
        queryFn: () => {
            const params = activeStatus === 'all' ? '' : `?status=${activeStatus}`;
            return apiClient.get(`/help/questions${params}`);
        },
    });
    const updateQuestion = useMutation({
        mutationFn: ({ id, ...body }) => apiClient.put(`/help/questions/${id}`, body),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['help-questions'] });
            queryClient.invalidateQueries({ queryKey: ['help-faq'] });
            setExpandedId(null);
        },
    });
    const deleteQuestion = useMutation({
        mutationFn: (id) => apiClient.delete(`/help/questions/${id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['help-questions'] });
            queryClient.invalidateQueries({ queryKey: ['help-faq'] });
        },
    });
    const handleExpand = useCallback((q) => {
        if (expandedId === q.id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(q.id);
        setEditAnswer(q.answer || '');
        setEditCategory(q.category || '');
        setEditStatus(q.status);
    }, [expandedId]);
    const handleSave = useCallback((id) => {
        updateQuestion.mutate({
            id,
            answer: editAnswer,
            status: editStatus,
            category: editCategory || undefined,
            answered_by: 'Admin',
        });
    }, [editAnswer, editStatus, editCategory, updateQuestion]);
    const handleQuickPublish = useCallback((q) => {
        if (!q.answer)
            return;
        updateQuestion.mutate({ id: q.id, status: 'published' });
    }, [updateQuestion]);
    const handleQuickArchive = useCallback((q) => {
        updateQuestion.mutate({ id: q.id, status: 'archived' });
    }, [updateQuestion]);
    const tabs = STATUS_TABS.map((status) => ({
        id: status,
        content: status.charAt(0).toUpperCase() + status.slice(1),
        accessibilityLabel: `${status} questions`,
        panelID: `${status}-panel`,
    }));
    const questions = data?.data || [];
    if (error) {
        return (_jsx(Page, { title: "Help Admin", subtitle: "Manage questions and FAQ content", children: _jsx(Banner, { tone: "critical", title: "Failed to load questions", children: _jsx(Text, { as: "p", children: error.message }) }) }));
    }
    return (_jsx(Page, { title: "Help Admin", subtitle: "Manage questions and FAQ content", children: _jsx(Layout, { children: _jsx(Layout.Section, { children: _jsx(Card, { children: _jsx(Tabs, { tabs: tabs, selected: selectedTab, onSelect: setSelectedTab, children: _jsx(Box, { paddingBlockStart: "400", children: isLoading ? (_jsx(SkeletonBodyText, { lines: 8 })) : questions.length === 0 ? (_jsx(EmptyState, { heading: "No questions found", image: "", children: _jsxs(Text, { as: "p", children: ["No ", activeStatus === 'all' ? '' : activeStatus, " questions yet."] }) })) : (_jsx(BlockStack, { gap: "0", children: questions.map((q, index) => {
                                    const isExpanded = expandedId === q.id;
                                    const questionText = q.question || q.question_text || q.title || 'Untitled question';
                                    return (_jsxs(React.Fragment, { children: [index > 0 && _jsx(Divider, {}), _jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "200", children: [_jsx("div", { onClick: () => handleExpand(q), style: { cursor: 'pointer' }, role: "button", tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ')
                                                                handleExpand(q); }, children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", wrap: true, children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Icon, { source: isExpanded ? ChevronDownIcon : ChevronRightIcon, tone: "subdued" }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: questionText.length > 80
                                                                                            ? questionText.slice(0, 80) + '…'
                                                                                            : questionText }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["#", q.id, " \u00B7", ' ', q.asked_by ? `Asked by ${q.asked_by}` : 'Anonymous', " \u00B7", ' ', new Date(q.created_at).toLocaleDateString()] })] })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [q.category && _jsx(Badge, { children: q.category }), statusBadge(q.status)] })] }) }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [q.answer && q.status !== 'published' && (_jsx(Button, { size: "slim", icon: CheckCircleIcon, onClick: () => handleQuickPublish(q), children: "Publish" })), q.status !== 'archived' && (_jsx(Button, { size: "slim", onClick: () => handleQuickArchive(q), children: "Archive" })), _jsx(Button, { size: "slim", tone: "critical", onClick: () => {
                                                                        if (confirm(`Delete question #${q.id}?`)) {
                                                                            deleteQuestion.mutate(q.id);
                                                                        }
                                                                    }, children: "Delete" })] }), _jsx(Collapsible, { open: isExpanded, id: `edit-${q.id}`, children: _jsx(Box, { paddingBlockStart: "400", paddingBlockEnd: "200", borderBlockStartWidth: "025", borderColor: "border", children: _jsxs(FormLayout, { children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: "Full question" }), _jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "300", children: _jsx(Text, { as: "p", children: questionText }) })] }), _jsx(TextField, { label: "Answer", value: editAnswer, onChange: setEditAnswer, multiline: 4, autoComplete: "off" }), _jsxs(InlineStack, { gap: "400", wrap: true, children: [_jsx(Box, { minWidth: "200px", children: _jsx(TextField, { label: "Category", value: editCategory, onChange: setEditCategory, placeholder: "e.g. Shipping, Returns", autoComplete: "off" }) }), _jsx(Box, { minWidth: "200px", children: _jsx(Select, { label: "Status", options: [
                                                                                            { label: 'Pending', value: 'pending' },
                                                                                            { label: 'Answered', value: 'answered' },
                                                                                            { label: 'Published', value: 'published' },
                                                                                            { label: 'Archived', value: 'archived' },
                                                                                        ], value: editStatus, onChange: setEditStatus }) })] }), _jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "primary", onClick: () => handleSave(q.id), loading: updateQuestion.isPending, children: "Save" }), _jsx(Button, { onClick: () => setExpandedId(null), children: "Cancel" })] })] }) }) })] }) })] }, q.id));
                                }) })) }) }) }) }) }) }));
};
export default HelpAdmin;
