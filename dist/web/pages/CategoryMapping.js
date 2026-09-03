import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Badge, BlockStack, Box, Button, Card, Icon, InlineStack, Layout, Modal, Page, Select, Text, } from '@shopify/polaris';
import { ImageIcon, StatusActiveIcon, AlertCircleIcon, SettingsIcon, CheckCircleIcon, } from '@shopify/polaris-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../hooks/useApi';
import { useAppStore } from '../store';
/* ────────────────── Category Row ────────────────── */
const CategoryRow = ({ category, templates, defaultTemplate, onChangeTemplate, onCreateTemplate }) => (_jsx(Card, { children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: defaultTemplate ? 'bg-fill-success-secondary' : 'bg-fill-secondary', borderRadius: "200", padding: "200", children: _jsx(Icon, { source: defaultTemplate ? CheckCircleIcon : ImageIcon, tone: defaultTemplate ? 'success' : 'base' }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: category }), defaultTemplate ? (_jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: [defaultTemplate.name, " \u00B7 BG: ", defaultTemplate.params.background, " \u00B7 Padding: ", Math.round(defaultTemplate.params.padding * 100), "% \u00B7 Shadow: ", defaultTemplate.params.shadow ? 'On' : 'Off'] })) : (_jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "No template assigned" }))] })] }), _jsx(InlineStack, { gap: "200", children: templates.length > 0 ? (_jsx(Button, { size: "slim", onClick: () => onChangeTemplate(category), children: defaultTemplate ? 'Change' : 'Assign' })) : (_jsx(Button, { size: "slim", variant: "primary", onClick: () => onCreateTemplate(category), children: "Create Template" })) })] }) }));
/* ────────────────── Main Component ────────────────── */
const CategoryMapping = () => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    const [selectedCategory, setSelectedCategory] = useState(null);
    const [templateModalOpen, setTemplateModalOpen] = useState(false);
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
        queryKey: ['template-categories'],
        queryFn: () => apiClient.get('/templates/categories'),
    });
    const { data: templatesData } = useQuery({
        queryKey: ['templates'],
        queryFn: () => apiClient.get('/templates'),
    });
    const setDefaultMutation = useMutation({
        mutationFn: ({ templateId, category }) => apiClient.post(`/templates/${templateId}/set-default`, { category }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['templates'] });
            setTemplateModalOpen(false);
            setSelectedCategory(null);
            setSelectedTemplateId('');
            addNotification({ type: 'success', title: 'Template assigned successfully', autoClose: 4000 });
        },
        onError: (error) => {
            addNotification({ type: 'error', title: 'Failed to assign template', message: error instanceof Error ? error.message : 'Unknown error', autoClose: 8000 });
        },
    });
    const categories = categoriesData?.categories || [];
    const templates = templatesData?.templates || [];
    const mounted = categoriesData?.mounted || false;
    const templatesByCategory = templates.reduce((acc, template) => {
        const cat = template.category || 'uncategorized';
        if (!acc[cat])
            acc[cat] = [];
        acc[cat].push(template);
        return acc;
    }, {});
    const defaultTemplates = templates.reduce((acc, template) => {
        if (template.isDefault && template.category)
            acc[template.category] = template;
        return acc;
    }, {});
    const assignedCategories = categories.filter((cat) => defaultTemplates[cat]);
    const unassignedCategories = categories.filter((cat) => !defaultTemplates[cat]);
    const handleChangeTemplate = (category) => {
        setSelectedCategory(category);
        setTemplateModalOpen(true);
        setSelectedTemplateId('');
    };
    const handleCreateTemplate = (category) => {
        navigate(`/images?category=${encodeURIComponent(category)}`);
    };
    const handleAssignTemplate = () => {
        if (!selectedCategory || !selectedTemplateId)
            return;
        setDefaultMutation.mutate({ templateId: parseInt(selectedTemplateId, 10), category: selectedCategory });
    };
    const templateSelectOptions = [
        { label: 'Select a template...', value: '' },
        ...templates.map((t) => ({
            label: `${t.name} (${t.params.background}, ${Math.round(t.params.padding * 100)}% padding)`,
            value: String(t.id),
        })),
    ];
    return (_jsxs(Page, { title: "Category Mapping", subtitle: "Map StyleShoots preset folders to photo templates for automatic processing", primaryAction: { content: 'Manage Templates', onAction: () => navigate('/images') }, children: [_jsxs(BlockStack, { gap: "500", children: [_jsx(Card, { children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: mounted ? 'bg-fill-success-secondary' : 'bg-fill-critical-secondary', borderRadius: "full", padding: "200", children: _jsx(Icon, { source: mounted ? StatusActiveIcon : AlertCircleIcon, tone: mounted ? 'success' : 'critical' }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingSm", as: "h2", children: mounted ? 'StyleShoots drive connected' : 'StyleShoots drive disconnected' }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: [categories.length, " categories found"] })] })] }), _jsxs(InlineStack, { gap: "200", children: [assignedCategories.length > 0 && (_jsx(Badge, { tone: "success", children: `${assignedCategories.length} assigned` })), unassignedCategories.length > 0 && (_jsx(Badge, { tone: "attention", children: `${unassignedCategories.length} need templates` }))] })] }) }), assignedCategories.length > 0 && (_jsx(Layout, { children: _jsx(Layout.Section, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Assigned Categories" }), _jsx(Badge, { tone: "success", children: String(assignedCategories.length) })] }), _jsx(BlockStack, { gap: "200", children: assignedCategories.map((cat) => (_jsx(CategoryRow, { category: cat, templates: templatesByCategory[cat] || [], defaultTemplate: defaultTemplates[cat], onChangeTemplate: handleChangeTemplate, onCreateTemplate: handleCreateTemplate }, cat))) })] }) }) })), unassignedCategories.length > 0 && (_jsx(Layout, { children: _jsx(Layout.Section, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(InlineStack, { gap: "200", align: "space-between", blockAlign: "center", children: _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Unassigned Categories" }), _jsx(Badge, { tone: "attention", children: `${unassignedCategories.length} need templates` })] }) }), _jsx(BlockStack, { gap: "200", children: unassignedCategories.map((cat) => (_jsx(CategoryRow, { category: cat, templates: templatesByCategory[cat] || [], defaultTemplate: null, onChangeTemplate: handleChangeTemplate, onCreateTemplate: handleCreateTemplate }, cat))) })] }) }) })), categories.length === 0 && !categoriesLoading && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", inlineAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "400", children: _jsx(Icon, { source: SettingsIcon }) }), _jsx(Text, { variant: "headingMd", as: "h3", alignment: "center", children: "No categories found" }), _jsx(Text, { variant: "bodyMd", tone: "subdued", as: "p", alignment: "center", children: "Connect the StyleShoots drive or create templates with categories to get started." }), _jsx(Button, { variant: "primary", onClick: () => navigate('/images'), children: "Manage Templates" })] }) }))] }), _jsx(Modal, { open: templateModalOpen, onClose: () => { setTemplateModalOpen(false); setSelectedCategory(null); setSelectedTemplateId(''); }, title: selectedCategory ? `Assign template to "${selectedCategory}"` : 'Assign Template', primaryAction: {
                    content: 'Assign Template',
                    onAction: handleAssignTemplate,
                    disabled: !selectedTemplateId,
                    loading: setDefaultMutation.isPending,
                }, secondaryActions: [{
                        content: 'Cancel',
                        onAction: () => { setTemplateModalOpen(false); setSelectedCategory(null); setSelectedTemplateId(''); },
                    }], children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(Text, { variant: "bodyMd", as: "p", children: ["Select a photo template to use as the default for the \"", selectedCategory, "\" category. When new photos arrive, the selected template will be automatically applied."] }), templates.length > 0 ? (_jsx(Select, { label: "Photo Template", options: templateSelectOptions, value: selectedTemplateId, onChange: setSelectedTemplateId })) : (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(Text, { variant: "bodyMd", as: "p", tone: "subdued", alignment: "center", children: "No templates available. Create a template first." }), _jsx(Button, { variant: "primary", onClick: () => { setTemplateModalOpen(false); handleCreateTemplate(selectedCategory || ''); }, children: "Create Template" })] }) }))] }) }) })] }));
};
export default CategoryMapping;
