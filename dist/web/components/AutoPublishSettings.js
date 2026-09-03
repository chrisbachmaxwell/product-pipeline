import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Card, BlockStack, InlineStack, Text, Button, Banner, Checkbox, TextField, Divider, Badge, Spinner, } from '@shopify/polaris';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
const AutoPublishSettings = () => {
    const queryClient = useQueryClient();
    const [newProductType, setNewProductType] = useState('');
    const [localGlobal, setLocalGlobal] = useState({
        autoPublishNoPhotos: false,
        autoPublishNoDescription: false,
    });
    const [localPerType, setLocalPerType] = useState([]);
    const [hasChanges, setHasChanges] = useState(false);
    const { data: settings, isLoading } = useQuery({
        queryKey: ['draft-settings'],
        queryFn: () => apiClient.get('/drafts/settings'),
    });
    useEffect(() => {
        if (settings) {
            setLocalGlobal(settings.global);
            setLocalPerType(settings.perType);
            setHasChanges(false);
        }
    }, [settings]);
    const saveMutation = useMutation({
        mutationFn: (data) => apiClient.put('/drafts/settings', data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['draft-settings'] });
            setHasChanges(false);
        },
    });
    const handleGlobalChange = (key) => (newValue) => {
        setLocalGlobal((prev) => ({ ...prev, [key]: newValue }));
        setHasChanges(true);
    };
    const handleTypeToggle = (productType) => {
        setLocalPerType((prev) => prev.map((item) => item.product_type === productType ? { ...item, enabled: !item.enabled } : item));
        setHasChanges(true);
    };
    const handleAddType = () => {
        const trimmed = newProductType.trim();
        if (!trimmed)
            return;
        if (localPerType.some((t) => t.product_type === trimmed))
            return;
        setLocalPerType((prev) => [...prev, { product_type: trimmed, enabled: true }]);
        setNewProductType('');
        setHasChanges(true);
    };
    const handleSave = () => {
        saveMutation.mutate({ perType: localPerType, global: localGlobal });
    };
    if (isLoading) {
        return (_jsx(Card, { children: _jsx("div", { style: { textAlign: 'center', padding: '2rem' }, children: _jsx(Spinner, { size: "large" }) }) }));
    }
    return (_jsxs(BlockStack, { gap: "400", children: [_jsx(Banner, { tone: "warning", children: _jsxs("p", { children: [_jsx("strong", { children: "Active products with existing content always require manual review." }), ' ', "Auto-publish only applies to products that have ", _jsx("em", { children: "no" }), " existing photos or descriptions on Shopify. This ensures live product data is never overwritten without human approval."] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Global Auto-Publish Rules" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "These rules determine when processed content is automatically published without requiring manual review." }), _jsx(Divider, {}), _jsx(Checkbox, { label: "Auto-publish when product has no existing photos", helpText: "When enabled, products with no Shopify photos will have draft images published automatically.", checked: localGlobal.autoPublishNoPhotos, onChange: handleGlobalChange('autoPublishNoPhotos') }), _jsx(Checkbox, { label: "Auto-publish when product has no existing description", helpText: "When enabled, products with no Shopify description will have AI descriptions published automatically.", checked: localGlobal.autoPublishNoDescription, onChange: handleGlobalChange('autoPublishNoDescription') })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Per Product Type Settings" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Enable auto-publish for specific product types. Only products with no existing content will be auto-published." }), _jsx(Divider, {}), localPerType.length === 0 ? (_jsx(Text, { as: "p", tone: "subdued", children: "No product type rules configured. Add one below." })) : (_jsx(BlockStack, { gap: "200", children: localPerType.map((item) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Checkbox, { label: "", checked: item.enabled, onChange: () => handleTypeToggle(item.product_type) }), _jsx(Text, { variant: "bodyMd", as: "span", children: item.product_type })] }), _jsx(Badge, { tone: item.enabled ? 'success' : undefined, children: item.enabled ? 'Auto-publish' : 'Manual review' })] }, item.product_type))) })), _jsx(Divider, {}), _jsxs(InlineStack, { gap: "200", blockAlign: "end", children: [_jsx("div", { style: { flex: 1 }, children: _jsx(TextField, { label: "Add product type", labelHidden: true, value: newProductType, onChange: setNewProductType, placeholder: "e.g. Camera, Lens, Flash", autoComplete: "off" }) }), _jsx(Button, { onClick: handleAddType, disabled: !newProductType.trim(), children: "Add" })] })] }) }), hasChanges && (_jsx("div", { style: { position: 'sticky', bottom: 0, padding: '1rem 0' }, children: _jsx(Banner, { tone: "info", children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "span", children: "You have unsaved changes." }), _jsx(Button, { variant: "primary", onClick: handleSave, loading: saveMutation.isPending, children: "Save Settings" })] }) }) }))] }));
};
export default AutoPublishSettings;
