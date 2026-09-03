import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Divider, InlineStack, Modal, RangeSlider, Text, TextField, } from '@shopify/polaris';
import { useQuery } from '@tanstack/react-query';
import { Bookmark, Edit3, Plus, Star, Trash2, Image as ImageIcon, Palette, Layers, } from 'lucide-react';
/* ── Color presets ────────────────────────────────────────────────────── */
const COLOR_PRESETS = [
    { hex: '#FFFFFF', label: 'White' },
    { hex: '#F5F5F5', label: 'Light Gray' },
    { hex: '#E0E0E0', label: 'Gray' },
    { hex: '#000000', label: 'Black' },
    { hex: '#E8F0FE', label: 'Light Blue' },
    { hex: '#FFF9E6', label: 'Cream' },
];
/* ── Preview Box ──────────────────────────────────────────────────────── */
const TemplatePreview = ({ params }) => {
    return (_jsx("div", { style: {
            width: 80,
            height: 80,
            backgroundColor: params.background,
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
        }, children: _jsx("div", { style: {
                width: `${Math.max(20, 80 - params.padding * 160)}px`,
                height: `${Math.max(20, 80 - params.padding * 160)}px`,
                backgroundColor: '#9ca3af',
                borderRadius: 4,
                boxShadow: params.shadow ? '0 4px 8px rgba(0,0,0,0.2)' : 'none',
            } }) }));
};
/* ── Template Card ────────────────────────────────────────────────────── */
const TemplateCard = ({ template, productId, onEdit, onDelete, onApply, onSetDefault, applying }) => {
    return (_jsx(Card, { padding: "300", children: _jsxs(BlockStack, { gap: "300", children: [_jsx(InlineStack, { align: "space-between", blockAlign: "start", children: _jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(TemplatePreview, { params: template.params }), _jsxs(BlockStack, { gap: "100", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: template.name }), template.isDefault && (_jsx(Badge, { tone: "success", children: "\u2B50 Default" }))] }), template.category && (_jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: ["Category: ", template.category] })), _jsxs(InlineStack, { gap: "200", children: [_jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["BG: ", template.params.background] }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["Padding: ", Math.round(template.params.padding * 100), "%"] }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: ["Shadow: ", template.params.shadow ? 'On' : 'Off'] })] })] })] }) }), _jsx(Divider, {}), _jsxs(InlineStack, { gap: "200", children: [productId && (_jsx(Button, { size: "slim", variant: "primary", loading: applying === template.id, onClick: () => onApply(template), icon: _jsx(ImageIcon, { size: 14 }), children: "Apply" })), _jsx(Button, { size: "slim", onClick: () => onEdit(template), icon: _jsx(Edit3, { size: 14 }), children: "Edit" }), !template.isDefault && template.category && (_jsx(Button, { size: "slim", onClick: () => onSetDefault(template), icon: _jsx(Star, { size: 14 }), children: "Set Default" })), _jsx(Button, { size: "slim", tone: "critical", onClick: () => onDelete(template.id), icon: _jsx(Trash2, { size: 14 }), children: "Delete" })] })] }) }));
};
/* ── Template Form Modal ──────────────────────────────────────────────── */
const TemplateFormModal = ({ open, editingTemplate, onClose, onSave, saving, initialCategory }) => {
    const [name, setName] = useState('');
    const [category, setCategory] = useState('');
    const [background, setBackground] = useState('#FFFFFF');
    const [padding, setPadding] = useState(10);
    const [shadow, setShadow] = useState(true);
    const [isDefault, setIsDefault] = useState(false);
    // Fetch categories for combobox
    const { data: categoriesData } = useQuery({
        queryKey: ['template-categories'],
        queryFn: async () => {
            const response = await fetch('/api/templates/categories');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
        },
    });
    const availableCategories = categoriesData?.categories || [];
    useEffect(() => {
        if (editingTemplate) {
            setName(editingTemplate.name);
            setCategory(editingTemplate.category ?? '');
            setBackground(editingTemplate.params.background);
            setPadding(Math.round(editingTemplate.params.padding * 100));
            setShadow(editingTemplate.params.shadow);
            setIsDefault(editingTemplate.isDefault);
        }
        else {
            setName('');
            setCategory(initialCategory ?? '');
            setBackground('#FFFFFF');
            setPadding(10);
            setShadow(true);
            setIsDefault(false);
        }
    }, [editingTemplate, open, initialCategory]);
    const handleSave = () => {
        onSave({
            name,
            category,
            params: { background, padding: padding / 100, shadow },
            isDefault,
        });
    };
    return (_jsx(Modal, { open: open, onClose: onClose, title: editingTemplate ? `Edit Template: ${editingTemplate.name}` : 'Create New Template', primaryAction: {
            content: editingTemplate ? 'Save Changes' : 'Create Template',
            onAction: handleSave,
            loading: saving,
            disabled: !name.trim(),
        }, secondaryActions: [{ content: 'Cancel', onAction: onClose }], children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(TextField, { label: "Template Name", value: name, onChange: setName, autoComplete: "off", placeholder: "e.g. Small Lenses" }), _jsx(TextField, { label: "Category (StyleShoots Preset)", value: category, onChange: setCategory, autoComplete: "off", placeholder: "Select or type a category...", helpText: availableCategories.length > 0
                            ? `Available categories: ${availableCategories.join(', ')}. Maps to a StyleShoots preset folder name for auto-apply.`
                            : "Maps to a StyleShoots preset folder name for auto-apply" }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(Palette, { size: 16, color: "#6b7280" }), _jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Background Color" })] }), _jsx(InlineStack, { gap: "200", wrap: true, children: COLOR_PRESETS.map((preset) => (_jsx("button", { onClick: () => setBackground(preset.hex), title: preset.label, style: {
                                        width: 32,
                                        height: 32,
                                        borderRadius: 6,
                                        border: background === preset.hex
                                            ? '2px solid #2563eb'
                                            : '2px solid #e5e7eb',
                                        backgroundColor: preset.hex,
                                        cursor: 'pointer',
                                        padding: 0,
                                        position: 'relative',
                                    }, children: background === preset.hex && (_jsx("span", { style: {
                                            position: 'absolute',
                                            inset: 0,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            color: preset.hex === '#000000' ? '#fff' : '#2563eb',
                                            fontWeight: 700,
                                            fontSize: 14,
                                        }, children: "\u2713" })) }, preset.hex))) }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: ["Selected: ", background] })] }), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(Layers, { size: 16, color: "#6b7280" }), _jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Padding" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: [padding, "%"] })] }), _jsx(RangeSlider, { label: "", value: padding, min: 0, max: 50, step: 1, onChange: (val) => setPadding(typeof val === 'number' ? val : val[0]), output: true })] }), _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Drop Shadow" }), _jsx("button", { onClick: () => setShadow(!shadow), style: {
                                    position: 'relative',
                                    width: 44,
                                    height: 24,
                                    borderRadius: 12,
                                    border: 'none',
                                    backgroundColor: shadow ? '#2563eb' : '#d1d5db',
                                    cursor: 'pointer',
                                    transition: 'background-color 200ms',
                                    padding: 0,
                                }, children: _jsx("span", { style: {
                                        position: 'absolute',
                                        top: 2,
                                        left: shadow ? 22 : 2,
                                        width: 20,
                                        height: 20,
                                        borderRadius: '50%',
                                        backgroundColor: '#fff',
                                        transition: 'left 200ms',
                                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                    } }) })] }), category && (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Set as Default" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: ["Auto-apply when photos arrive in \"", category, "\""] })] }), _jsx("button", { onClick: () => setIsDefault(!isDefault), style: {
                                    position: 'relative',
                                    width: 44,
                                    height: 24,
                                    borderRadius: 12,
                                    border: 'none',
                                    backgroundColor: isDefault ? '#f59e0b' : '#d1d5db',
                                    cursor: 'pointer',
                                    transition: 'background-color 200ms',
                                    padding: 0,
                                }, children: _jsx("span", { style: {
                                        position: 'absolute',
                                        top: 2,
                                        left: isDefault ? 22 : 2,
                                        width: 20,
                                        height: 20,
                                        borderRadius: '50%',
                                        backgroundColor: '#fff',
                                        transition: 'left 200ms',
                                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                    } }) })] })), _jsx(Box, { padding: "300", background: "bg-surface-secondary", borderRadius: "200", children: _jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(TemplatePreview, { params: { background, padding: padding / 100, shadow } }), _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", fontWeight: "semibold", as: "span", children: "Preview" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: ["Background: ", background, " \u00B7 Padding: ", padding, "% \u00B7 Shadow: ", shadow ? 'On' : 'Off'] })] })] }) })] }) }) }));
};
/* ── Main Component ───────────────────────────────────────────────────── */
const TemplateManager = ({ productId, onApplied, initialCategory }) => {
    const [templates, setTemplates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState(null);
    const [saving, setSaving] = useState(false);
    const [applying, setApplying] = useState(null);
    const fetchTemplates = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/templates');
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setTemplates(data.templates || []);
            setError(null);
        }
        catch (err) {
            setError(String(err));
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        fetchTemplates();
    }, [fetchTemplates]);
    const handleCreate = () => {
        setEditingTemplate(null);
        setModalOpen(true);
    };
    const handleEdit = (template) => {
        setEditingTemplate(template);
        setModalOpen(true);
    };
    const handleSave = async (data) => {
        setSaving(true);
        try {
            const url = editingTemplate
                ? `/api/templates/${editingTemplate.id}`
                : '/api/templates';
            const method = editingTemplate ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: data.name,
                    category: data.category || null,
                    params: data.params,
                    isDefault: data.isDefault,
                }),
            });
            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || `HTTP ${res.status}`);
            }
            setModalOpen(false);
            await fetchTemplates();
        }
        catch (err) {
            setError(String(err));
        }
        finally {
            setSaving(false);
        }
    };
    const handleDelete = async (id) => {
        if (!confirm('Delete this template?'))
            return;
        try {
            const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            await fetchTemplates();
        }
        catch (err) {
            setError(String(err));
        }
    };
    const handleApply = async (template) => {
        if (!productId)
            return;
        setApplying(template.id);
        try {
            const res = await fetch(`/api/templates/${template.id}/apply/${productId}`, {
                method: 'POST',
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            onApplied?.(template.id);
            setError(null);
        }
        catch (err) {
            setError(String(err));
        }
        finally {
            setApplying(null);
        }
    };
    const handleSetDefault = async (template) => {
        if (!template.category)
            return;
        try {
            const res = await fetch(`/api/templates/${template.id}/set-default`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: template.category }),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            await fetchTemplates();
        }
        catch (err) {
            setError(String(err));
        }
    };
    if (loading) {
        return (_jsx(Card, { children: _jsx(Box, { padding: "400", children: _jsx(Text, { tone: "subdued", as: "p", children: "Loading templates\u2026" }) }) }));
    }
    return (_jsxs(_Fragment, { children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photo Templates" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Reusable PhotoRoom settings for consistent photo processing" })] }), _jsx(Button, { variant: "primary", onClick: handleCreate, icon: _jsx(Plus, { size: 16 }), children: "New Template" })] }), error && (_jsx(Banner, { tone: "critical", onDismiss: () => setError(null), children: _jsx("p", { children: error }) })), templates.length === 0 ? (_jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(Bookmark, { size: 48, color: "#9ca3af" }), _jsx(Text, { tone: "subdued", as: "p", alignment: "center", children: "No templates yet. Create one to save reusable photo settings." }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", alignment: "center", children: "Or use the chat: \"Save current settings as Small Lenses template\"" })] }) })) : (_jsx(BlockStack, { gap: "300", children: templates.map((template) => (_jsx(TemplateCard, { template: template, productId: productId, onEdit: handleEdit, onDelete: handleDelete, onApply: handleApply, onSetDefault: handleSetDefault, applying: applying }, template.id))) }))] }) }), _jsx(TemplateFormModal, { open: modalOpen, editingTemplate: editingTemplate, onClose: () => setModalOpen(false), onSave: handleSave, saving: saving, initialCategory: initialCategory })] }));
};
export default TemplateManager;
