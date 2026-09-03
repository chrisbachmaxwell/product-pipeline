import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, Divider, DropZone, Icon, IndexTable, InlineStack, Modal, Page, Select, Spinner, Tabs, Text, TextField, Toast, } from '@shopify/polaris';
import { ArrowRightIcon, ExportIcon, ImportIcon, SearchIcon, SaveIcon, SettingsIcon, } from '@shopify/polaris-icons';
import { useBulkUpdateMappings, useMappings, apiClient, } from '../hooks/useApi';
import { useAppStore } from '../store';
/* ────────────────── Constants ────────────────── */
const SHOPIFY_FIELD_OPTIONS = [
    { label: 'Select a field', value: '' },
    {
        title: 'Product fields',
        options: [
            { label: 'Title', value: 'title' },
            { label: 'Description (body_html)', value: 'body_html' },
            { label: 'Vendor', value: 'vendor' },
            { label: 'Product type', value: 'product_type' },
            { label: 'Tags', value: 'tags' },
            { label: 'Handle', value: 'handle' },
            { label: 'Status', value: 'status' },
        ],
    },
    {
        title: 'Variant fields',
        options: [
            { label: 'SKU', value: 'variants[0].sku' },
            { label: 'Barcode', value: 'variants[0].barcode' },
            { label: 'Price', value: 'variants[0].price' },
            { label: 'Compare at price', value: 'variants[0].compare_at_price' },
            { label: 'Weight', value: 'variants[0].weight' },
            { label: 'Inventory quantity', value: 'variants[0].inventory_quantity' },
        ],
    },
    {
        title: 'Metafields',
        options: [
            { label: 'Condition', value: 'metafields.condition' },
            { label: 'Brand', value: 'metafields.brand' },
        ],
    },
    {
        title: 'Images',
        options: [
            { label: 'Main image URL', value: 'images[0].src' },
            { label: 'Featured image URL', value: 'image.src' },
        ],
    },
];
const MAPPING_TYPE_OPTIONS = [
    { label: 'Use Shopify field', value: 'shopify_field' },
    { label: 'Set constant value', value: 'constant' },
    { label: 'Edit per product', value: 'edit_in_grid' },
    { label: 'Custom formula', value: 'formula' },
];
const REQUIRED_FIELDS = {
    sales: ['sku', 'price'],
    listing: ['title', 'description', 'condition', 'category'],
    payment: ['accepted_payments'],
    shipping: ['shipping_cost', 'handling_time'],
};
const CATEGORY_LABELS = {
    sales: 'Sales',
    listing: 'Listing',
    payment: 'Payment',
    shipping: 'Shipping',
};
const FILTER_OPTIONS = [
    { label: 'All fields', value: 'all' },
    { label: 'Required only', value: 'required' },
    { label: 'Unmapped required', value: 'unmapped' },
    { label: 'Disabled', value: 'disabled' },
];
/* ────────────────── Helpers ────────────────── */
const formatFieldName = (value) => value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
const isMappingComplete = (mapping) => {
    if (!mapping || !mapping.is_enabled)
        return false;
    switch (mapping.mapping_type) {
        case 'shopify_field': return Boolean(mapping.source_value);
        case 'constant':
        case 'formula': return Boolean(mapping.target_value);
        case 'edit_in_grid': return true;
        default: return false;
    }
};
/* ────────────────── Mappings Page ────────────────── */
const Mappings = () => {
    const { data, isLoading, error, refetch } = useMappings();
    const bulkUpdate = useBulkUpdateMappings();
    const { setUnsavedMappingChange, removeUnsavedMappingChange, clearUnsavedMappingChanges, setSavingMappings, } = useAppStore();
    const [selectedTab, setSelectedTab] = useState(0);
    const [searchValue, setSearchValue] = useState('');
    const [filterValue, setFilterValue] = useState('all');
    const [pendingUpdates, setPendingUpdates] = useState(new Map());
    const [toastMessage, setToastMessage] = useState(null);
    const [importModalOpen, setImportModalOpen] = useState(false);
    const [exportModalOpen, setExportModalOpen] = useState(false);
    const [importFile, setImportFile] = useState(null);
    const debounceRef = useRef(null);
    const categories = useMemo(() => Object.keys(CATEGORY_LABELS), []);
    const mappingIndex = useMemo(() => {
        const map = new Map();
        if (!data)
            return map;
        categories.forEach((category) => {
            data[category]?.forEach((mapping) => {
                map.set(`${category}:${mapping.field_name}`, mapping);
            });
        });
        return map;
    }, [data, categories]);
    const mergedMapping = useCallback((mapping) => {
        const key = `${mapping.category}:${mapping.field_name}`;
        return { ...mapping, ...(pendingUpdates.get(key) ?? {}) };
    }, [pendingUpdates]);
    const applyUpdates = useCallback((mapping, updates) => {
        const key = `${mapping.category}:${mapping.field_name}`;
        setPendingUpdates((prev) => {
            const next = new Map(prev);
            next.set(key, { ...(next.get(key) ?? {}), ...updates });
            return next;
        });
        setUnsavedMappingChange(key, updates);
    }, [setUnsavedMappingChange]);
    const saveMappings = useCallback(async (keys) => {
        if (keys.length === 0)
            return;
        setSavingMappings(true);
        const payload = keys
            .map((key) => {
            const base = mappingIndex.get(key);
            const updates = pendingUpdates.get(key) ?? {};
            return base ? { ...base, ...updates } : null;
        })
            .filter(Boolean);
        if (payload.length === 0)
            return;
        bulkUpdate.mutate(payload, {
            onSuccess: () => {
                setPendingUpdates((prev) => {
                    const next = new Map(prev);
                    keys.forEach((key) => next.delete(key));
                    return next;
                });
                keys.forEach((key) => removeUnsavedMappingChange(key));
                setSavingMappings(false);
                setToastMessage('Mappings saved');
            },
            onError: (err) => {
                setSavingMappings(false);
                setToastMessage(err instanceof Error ? err.message : 'Failed to save mappings');
            },
        });
    }, [bulkUpdate, mappingIndex, pendingUpdates, removeUnsavedMappingChange, setSavingMappings]);
    useEffect(() => {
        if (pendingUpdates.size === 0)
            return;
        if (debounceRef.current)
            window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => {
            void saveMappings(Array.from(pendingUpdates.keys()));
        }, 800);
        return () => { if (debounceRef.current)
            window.clearTimeout(debounceRef.current); };
    }, [pendingUpdates, saveMappings]);
    const tabDefinitions = useMemo(() => {
        return categories.map((category) => {
            const required = REQUIRED_FIELDS[category] ?? [];
            const unmappedCount = required.reduce((count, field) => {
                return count + (isMappingComplete(mappingIndex.get(`${category}:${field}`)) ? 0 : 1);
            }, 0);
            return {
                id: category,
                content: CATEGORY_LABELS[category],
                accessibilityLabel: `${CATEGORY_LABELS[category]} mappings`,
                badge: unmappedCount > 0 ? String(unmappedCount) : undefined,
            };
        });
    }, [categories, mappingIndex]);
    const currentCategory = categories[selectedTab];
    const currentMappings = useMemo(() => {
        const categoryMappings = data?.[currentCategory] ?? [];
        return categoryMappings.filter((mapping) => {
            if (!mapping.field_name.toLowerCase().includes(searchValue.toLowerCase()))
                return false;
            if (filterValue === 'required')
                return (REQUIRED_FIELDS[currentCategory] ?? []).includes(mapping.field_name);
            if (filterValue === 'disabled')
                return !mergedMapping(mapping).is_enabled;
            if (filterValue === 'unmapped') {
                return (REQUIRED_FIELDS[currentCategory] ?? []).includes(mapping.field_name) && !isMappingComplete(mergedMapping(mapping));
            }
            return true;
        });
    }, [currentCategory, data, filterValue, mergedMapping, searchValue]);
    const unmappedRequiredCount = useMemo(() => {
        const required = REQUIRED_FIELDS[currentCategory] ?? [];
        return required.reduce((count, field) => count + (isMappingComplete(mappingIndex.get(`${currentCategory}:${field}`)) ? 0 : 1), 0);
    }, [currentCategory, mappingIndex]);
    const handleExport = async () => {
        try {
            const response = await fetch('/api/mappings/export');
            if (!response.ok)
                throw new Error('Export failed');
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `mappings-export-${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            window.URL.revokeObjectURL(url);
            setExportModalOpen(false);
        }
        catch (err) {
            setToastMessage(err instanceof Error ? err.message : 'Export failed');
        }
    };
    const handleImport = async () => {
        if (!importFile)
            return;
        try {
            const content = await importFile.text();
            const parsed = JSON.parse(content);
            const mappings = Array.isArray(parsed) ? parsed : parsed.mappings ?? [];
            await apiClient.post('/mappings/import', { mappings });
            setImportModalOpen(false);
            setImportFile(null);
            clearUnsavedMappingChanges();
            refetch();
            setToastMessage('Mappings imported');
        }
        catch (err) {
            setToastMessage(err instanceof Error ? err.message : 'Import failed');
        }
    };
    if (isLoading) {
        return (_jsx(Page, { title: "Field Mappings", fullWidth: true, children: _jsx(Card, { children: _jsx(Box, { padding: "600", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { accessibilityLabel: "Loading mappings", size: "large" }) }) }) }) }));
    }
    if (error) {
        return (_jsx(Page, { title: "Field Mappings", fullWidth: true, children: _jsx(Banner, { tone: "critical", title: "Failed to load mappings", children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", children: error.message }), _jsx(Button, { onClick: () => refetch(), children: "Try again" })] }) }) }));
    }
    return (_jsxs(Page, { title: "Field Mappings", subtitle: "Configure how Shopify fields map to eBay listing attributes", fullWidth: true, primaryAction: {
            content: 'Save changes',
            icon: SaveIcon,
            onAction: () => saveMappings(Array.from(pendingUpdates.keys())),
            disabled: pendingUpdates.size === 0,
            loading: bulkUpdate.isPending,
        }, secondaryActions: [
            { content: 'Export', icon: ExportIcon, onAction: () => setExportModalOpen(true) },
            { content: 'Import', icon: ImportIcon, onAction: () => setImportModalOpen(true) },
        ], children: [_jsxs(BlockStack, { gap: "500", children: [pendingUpdates.size > 0 && (_jsx(Banner, { tone: "info", title: "Auto-save is enabled", children: _jsx(Text, { as: "p", children: "Changes are saved automatically after a short delay." }) })), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: SettingsIcon }) }), _jsx(Text, { variant: "headingMd", as: "h2", children: "Mapping Configuration" })] }), _jsxs(InlineStack, { gap: "400", align: "space-between", children: [_jsx(Box, { minWidth: "280px", children: _jsx(TextField, { label: "Search fields", labelHidden: true, value: searchValue, onChange: setSearchValue, prefix: _jsx(Icon, { source: SearchIcon }), placeholder: "Search fields", clearButton: true, onClearButtonClick: () => setSearchValue(''), autoComplete: "off" }) }), _jsx(Box, { minWidth: "220px", children: _jsx(Select, { label: "Filter", labelHidden: true, options: FILTER_OPTIONS, value: filterValue, onChange: setFilterValue }) })] }), _jsx(Divider, {}), _jsx(Tabs, { tabs: tabDefinitions, selected: selectedTab, onSelect: setSelectedTab, children: _jsx(Box, { paddingBlockStart: "400", children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { gap: "200", align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsxs(Text, { variant: "headingMd", as: "h2", children: [CATEGORY_LABELS[currentCategory], " mappings"] }), _jsxs(Text, { as: "p", tone: "subdued", variant: "bodySm", children: [currentMappings.length, " fields \u00B7 ", unmappedRequiredCount, " required unmapped"] })] }), _jsx(Badge, { tone: unmappedRequiredCount > 0 ? 'critical' : 'success', children: unmappedRequiredCount > 0 ? 'Action needed' : 'Complete' })] }), _jsx(IndexTable, { resourceName: { singular: 'mapping', plural: 'mappings' }, itemCount: currentMappings.length, selectable: false, headings: [
                                                        { title: 'Field name' },
                                                        { title: '' },
                                                        { title: 'Mapping type' },
                                                        { title: 'Configuration' },
                                                        { title: 'Enabled' },
                                                    ], children: currentMappings.map((mapping, index) => {
                                                        const merged = mergedMapping(mapping);
                                                        const required = (REQUIRED_FIELDS[mapping.category] ?? []).includes(mapping.field_name);
                                                        return (_jsxs(IndexTable.Row, { id: `${mapping.category}-${mapping.field_name}`, position: index, children: [_jsx(IndexTable.Cell, { children: _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: formatFieldName(mapping.field_name) }), required && _jsx(Badge, { tone: "critical", size: "small", children: "Required" })] }) }), _jsx(IndexTable.Cell, { children: _jsx(Icon, { source: ArrowRightIcon, tone: "subdued" }) }), _jsx(IndexTable.Cell, { children: _jsx(Select, { label: "Mapping type", labelHidden: true, options: MAPPING_TYPE_OPTIONS, value: merged.mapping_type, onChange: (value) => {
                                                                            const updates = {
                                                                                mapping_type: value,
                                                                            };
                                                                            if (value === 'shopify_field') {
                                                                                updates.source_value = '';
                                                                                updates.target_value = null;
                                                                            }
                                                                            else if (value === 'constant' || value === 'formula') {
                                                                                updates.target_value = '';
                                                                                updates.source_value = null;
                                                                            }
                                                                            else {
                                                                                updates.source_value = null;
                                                                                updates.target_value = null;
                                                                            }
                                                                            applyUpdates(mapping, updates);
                                                                        } }) }), _jsx(IndexTable.Cell, { children: _jsxs(Box, { minWidth: "220px", children: [merged.mapping_type === 'shopify_field' && (_jsx(Select, { label: "Shopify field", labelHidden: true, options: SHOPIFY_FIELD_OPTIONS, value: merged.source_value ?? '', onChange: (value) => applyUpdates(mapping, { source_value: value }) })), merged.mapping_type === 'constant' && (_jsx(TextField, { label: "Constant value", labelHidden: true, value: merged.target_value ?? '', onChange: (value) => applyUpdates(mapping, { target_value: value }), placeholder: "Enter value", autoComplete: "off" })), merged.mapping_type === 'formula' && (_jsx(TextField, { label: "Formula", labelHidden: true, value: merged.target_value ?? '', onChange: (value) => applyUpdates(mapping, { target_value: value }), placeholder: "e.g. {{title}} - {{sku}}", helpText: "Use {{field}} tokens for Shopify fields", autoComplete: "off" })), merged.mapping_type === 'edit_in_grid' && (_jsx(Text, { as: "p", tone: "subdued", variant: "bodySm", children: "Edit per product in the listings grid." }))] }) }), _jsx(IndexTable.Cell, { children: _jsx(Checkbox, { label: "Enabled", labelHidden: true, checked: merged.is_enabled, onChange: (value) => applyUpdates(mapping, { is_enabled: value }) }) })] }, `${mapping.category}-${mapping.field_name}`));
                                                    }) })] }) }) })] }) })] }), _jsx(Modal, { open: exportModalOpen, onClose: () => setExportModalOpen(false), title: "Export mappings", primaryAction: { content: 'Export', onAction: handleExport }, secondaryActions: [{ content: 'Cancel', onAction: () => setExportModalOpen(false) }], children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", children: "Download all mappings as a JSON file." }), _jsx(Text, { as: "p", tone: "subdued", variant: "bodySm", children: "Use this export to back up or move mappings between stores." })] }) }) }), _jsx(Modal, { open: importModalOpen, onClose: () => setImportModalOpen(false), title: "Import mappings", primaryAction: { content: 'Import', onAction: handleImport, disabled: !importFile }, secondaryActions: [{ content: 'Cancel', onAction: () => setImportModalOpen(false) }], children: _jsx(Modal.Section, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "p", children: "Upload a JSON export to replace existing mappings." }), _jsx(DropZone, { accept: "application/json", onDrop: (files) => setImportFile(files[0] ?? null), allowMultiple: false, children: _jsx(DropZone.FileUpload, { actionTitle: "Add JSON file", actionHint: "or drop a file" }) }), importFile && (_jsx(Banner, { tone: "warning", title: "Import will overwrite all mappings", children: _jsxs(Text, { as: "p", children: ["Selected file: ", importFile.name] }) }))] }) }) }), toastMessage && _jsx(Toast, { content: toastMessage, onDismiss: () => setToastMessage(null) })] }));
};
export default Mappings;
