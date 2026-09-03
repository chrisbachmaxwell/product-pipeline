import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useState } from 'react';
import { Banner, BlockStack, Box, Button, Card, Divider, FormLayout, Icon, InlineStack, Page, Select, Text, } from '@shopify/polaris';
import { QuestionCircleIcon, CheckCircleIcon } from '@shopify/polaris-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../hooks/useApi';
const CATEGORY_OPTIONS = [
    { label: 'Select a category…', value: '' },
    { label: 'Getting Started', value: 'Getting Started' },
    { label: 'Products', value: 'Products' },
    { label: 'Mappings', value: 'Mappings' },
    { label: 'Pipeline', value: 'Pipeline' },
    { label: 'Orders', value: 'Orders' },
    { label: 'Analytics', value: 'Analytics' },
    { label: 'Chat', value: 'Chat' },
    { label: 'General', value: 'General' },
];
const HelpAsk = () => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [question, setQuestion] = useState('');
    const [category, setCategory] = useState('');
    const [askedBy, setAskedBy] = useState('');
    const [submitted, setSubmitted] = useState(false);
    const submitMutation = useMutation({
        mutationFn: (body) => apiClient.post('/help/questions', body),
        onSuccess: () => {
            setSubmitted(true);
            queryClient.invalidateQueries({ queryKey: ['help-articles-all'] });
        },
    });
    const handleSubmit = useCallback(() => {
        if (!question.trim())
            return;
        submitMutation.mutate({
            question: question.trim(),
            ...(askedBy.trim() ? { asked_by: askedBy.trim() } : {}),
            ...(category ? { category } : {}),
        });
    }, [question, askedBy, category, submitMutation]);
    if (submitted) {
        return (_jsx(Page, { title: "Ask a Question", backAction: { content: 'Help Center', onAction: () => navigate('/help') }, children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", inlineAlign: "center", children: [_jsx(Box, { background: "bg-fill-success-secondary", borderRadius: "full", padding: "300", children: _jsx(Icon, { source: CheckCircleIcon, tone: "success" }) }), _jsx(Text, { variant: "headingLg", as: "h2", children: "Question Submitted!" }), _jsx(Text, { as: "p", tone: "subdued", children: "Your question has been received. If our AI can answer it, you'll see it in the documentation shortly. Otherwise, an admin will review and respond." }), _jsxs(InlineStack, { gap: "300", children: [_jsx(Button, { onClick: () => navigate('/help'), children: "Back to Help Center" }), _jsx(Button, { variant: "primary", onClick: () => {
                                        setSubmitted(false);
                                        setQuestion('');
                                        setCategory('');
                                        setAskedBy('');
                                    }, children: "Ask Another Question" })] })] }) }) }));
    }
    return (_jsx(Page, { title: "Ask a Question", subtitle: "Can't find what you're looking for? Submit a question.", backAction: { content: 'Help Center', onAction: () => navigate('/help') }, children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Banner, { tone: "info", title: "AI-powered answers", children: _jsx(Text, { as: "p", children: "Submit your question and our AI will try to answer it instantly. Questions may also be reviewed by an admin and added to the documentation." }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: QuestionCircleIcon }) }), _jsx(Text, { variant: "headingMd", as: "h2", children: "Your question" })] }), _jsx(Divider, {}), _jsxs(FormLayout, { children: [_jsx(FormLayout.Group, { children: _jsxs("div", { children: [_jsxs(Text, { variant: "bodySm", fontWeight: "semibold", as: "p", children: ["Question ", _jsx("span", { style: { color: 'var(--p-color-text-critical)' }, children: "*" })] }), _jsx("textarea", { value: question, onChange: (e) => setQuestion(e.target.value), placeholder: "How do I\u2026?", rows: 4, style: {
                                                        width: '100%',
                                                        padding: '8px 12px',
                                                        marginTop: 4,
                                                        border: '1px solid var(--p-color-border)',
                                                        borderRadius: 'var(--p-border-radius-200)',
                                                        fontSize: '0.875rem',
                                                        fontFamily: 'inherit',
                                                        resize: 'vertical',
                                                        lineHeight: 1.5,
                                                    } })] }) }), _jsx(FormLayout.Group, { children: _jsx(Select, { label: "Category", options: CATEGORY_OPTIONS, value: category, onChange: setCategory }) }), _jsx(FormLayout.Group, { children: _jsxs("div", { children: [_jsx(Text, { variant: "bodySm", fontWeight: "semibold", as: "p", children: "Your name (optional)" }), _jsx("input", { type: "text", value: askedBy, onChange: (e) => setAskedBy(e.target.value), placeholder: "e.g. Jane", style: {
                                                        width: '100%',
                                                        padding: '8px 12px',
                                                        marginTop: 4,
                                                        border: '1px solid var(--p-color-border)',
                                                        borderRadius: 'var(--p-border-radius-200)',
                                                        fontSize: '0.875rem',
                                                        fontFamily: 'inherit',
                                                    } })] }) })] }), submitMutation.isError && (_jsx(Banner, { tone: "critical", title: "Submission failed", children: _jsx(Text, { as: "p", children: submitMutation.error?.message ?? 'Please try again.' }) })), _jsxs(InlineStack, { gap: "300", children: [_jsx(Button, { variant: "primary", onClick: handleSubmit, loading: submitMutation.isPending, disabled: !question.trim(), children: "Submit Question" }), _jsx(Button, { onClick: () => navigate('/help'), children: "Cancel" })] })] }) })] }) }));
};
export default HelpAsk;
