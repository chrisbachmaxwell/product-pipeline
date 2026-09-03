import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useMemo, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Card, Collapsible, Divider, EmptyState, FormLayout, Icon, InlineStack, Layout, Modal, Page, SkeletonBodyText, Select, Text, TextField, } from '@shopify/polaris';
import { QuestionCircleIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon, } from '@shopify/polaris-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
const Help = () => {
    const queryClient = useQueryClient();
    const { data, isLoading, error } = useQuery({
        queryKey: ['help-faq'],
        queryFn: () => apiClient.get('/help/faq'),
    });
    const [askOpen, setAskOpen] = useState(false);
    const [newQuestion, setNewQuestion] = useState('');
    const [newCategory, setNewCategory] = useState('');
    const [askedBy, setAskedBy] = useState('');
    const [expandedIds, setExpandedIds] = useState(new Set());
    const [search, setSearch] = useState('');
    const [filterCategory, setFilterCategory] = useState('all');
    const toggleExpanded = useCallback((id) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    const categories = useMemo(() => {
        if (!data?.data)
            return [];
        const cats = new Set();
        for (const item of data.data) {
            if (item.category)
                cats.add(item.category);
        }
        return Array.from(cats).sort();
    }, [data]);
    const categoryOptions = useMemo(() => [
        { label: 'All categories', value: 'all' },
        ...categories.map((c) => ({ label: c, value: c })),
    ], [categories]);
    const filteredFaq = useMemo(() => {
        if (!data?.data)
            return [];
        return data.data.filter((item) => {
            if (filterCategory !== 'all' && item.category !== filterCategory)
                return false;
            if (search) {
                const q = search.toLowerCase();
                return (item.question.toLowerCase().includes(q) ||
                    (item.answer && item.answer.toLowerCase().includes(q)) ||
                    (item.category && item.category.toLowerCase().includes(q)));
            }
            return true;
        });
    }, [data, filterCategory, search]);
    const submitQuestion = useMutation({
        mutationFn: (body) => apiClient.post('/help/questions', body),
        onSuccess: () => {
            setAskOpen(false);
            setNewQuestion('');
            setNewCategory('');
            setAskedBy('');
            queryClient.invalidateQueries({ queryKey: ['help-faq'] });
        },
    });
    const handleSubmit = useCallback(() => {
        if (!newQuestion.trim())
            return;
        submitQuestion.mutate({
            question: newQuestion.trim(),
            ...(askedBy.trim() ? { asked_by: askedBy.trim() } : {}),
            ...(newCategory.trim() ? { category: newCategory.trim() } : {}),
        });
    }, [newQuestion, askedBy, newCategory, submitQuestion]);
    if (error) {
        return (_jsx(Page, { title: "Help & FAQ", children: _jsx(Banner, { tone: "critical", title: "Failed to load FAQ", children: _jsx(Text, { as: "p", children: error.message }) }) }));
    }
    return (_jsxs(Page, { title: "Help & FAQ", subtitle: "Frequently asked questions and support", primaryAction: {
            content: 'Ask a Question',
            icon: QuestionCircleIcon,
            onAction: () => setAskOpen(true),
        }, children: [_jsxs(Layout, { children: [_jsx(Layout.Section, { children: _jsx(Card, { children: _jsxs(InlineStack, { gap: "400", wrap: true, children: [_jsx(Box, { minWidth: "240px", children: _jsx(TextField, { label: "Search FAQ", labelHidden: true, value: search, onChange: setSearch, placeholder: "Search questions\u2026", prefix: _jsx(Icon, { source: SearchIcon }), clearButton: true, onClearButtonClick: () => setSearch(''), autoComplete: "off" }) }), categories.length > 0 && (_jsx(Box, { minWidth: "200px", children: _jsx(Select, { label: "Category", labelHidden: true, options: categoryOptions, value: filterCategory, onChange: setFilterCategory }) }))] }) }) }), _jsx(Layout.Section, { children: isLoading ? (_jsx(Card, { children: _jsx(SkeletonBodyText, { lines: 8 }) })) : filteredFaq.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { heading: "No FAQ items found", image: "", children: _jsx(Text, { as: "p", children: search || filterCategory !== 'all'
                                        ? 'Try adjusting your search or filter.'
                                        : 'No published FAQ items yet. Ask a question to get started!' }) }) })) : (_jsx(Card, { children: _jsx(BlockStack, { gap: "0", children: filteredFaq.map((item, index) => {
                                    const isOpen = expandedIds.has(item.id);
                                    return (_jsxs(React.Fragment, { children: [index > 0 && _jsx(Divider, {}), _jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "200", children: [_jsx("div", { onClick: () => toggleExpanded(item.id), role: "button", tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ')
                                                                toggleExpanded(item.id); }, style: { cursor: 'pointer' }, children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Icon, { source: isOpen ? ChevronDownIcon : ChevronRightIcon, tone: "subdued" }), _jsx(Text, { variant: "headingSm", as: "span", children: item.question })] }), item.category && _jsx(Badge, { children: item.category })] }) }), _jsx(Collapsible, { open: isOpen, id: `faq-${item.id}`, children: _jsx(Box, { paddingInlineStart: "600", paddingBlockStart: "100", children: _jsx(Text, { as: "p", tone: "subdued", children: item.answer }) }) })] }) })] }, item.id));
                                }) }) })) })] }), _jsx(Modal, { open: askOpen, onClose: () => setAskOpen(false), title: "Ask a Question", primaryAction: {
                    content: 'Submit',
                    onAction: handleSubmit,
                    loading: submitQuestion.isPending,
                    disabled: !newQuestion.trim(),
                }, secondaryActions: [{ content: 'Cancel', onAction: () => setAskOpen(false) }], children: _jsx(Modal.Section, { children: _jsxs(FormLayout, { children: [_jsx(TextField, { label: "Your question", value: newQuestion, onChange: setNewQuestion, multiline: 3, autoComplete: "off", requiredIndicator: true, placeholder: "How do I\u2026?" }), _jsx(TextField, { label: "Your name (optional)", value: askedBy, onChange: setAskedBy, autoComplete: "off" }), _jsx(TextField, { label: "Category (optional)", value: newCategory, onChange: setNewCategory, placeholder: "e.g. Shipping, Returns, Products", autoComplete: "off" })] }) }) })] }));
};
export default Help;
