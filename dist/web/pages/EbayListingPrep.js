import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * eBay Listing Prep Page
 *
 * Full-page view shown when the user clicks "Approve & List on eBay".
 * Displays all decisions the system made — editable before listing.
 * Includes a real eBay-style preview of how the listing will look.
 */
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Page, Layout, Card, Badge, Button, Text, BlockStack, InlineStack, Divider, Spinner, TextField, Select, FormLayout, Banner, Combobox, Listbox, } from '@shopify/polaris';
import { DeleteIcon, PlusIcon, RefreshIcon, } from '@shopify/polaris-icons';
import DraggablePhotoGrid from '../components/DraggablePhotoGrid';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../hooks/useApi';
import { useAppStore } from '../store';
import { getConditionDescription } from '../../config/condition-descriptions';
// ── Condition options ──────────────────────────────────────────────────
const CONDITION_OPTIONS = [
    { label: 'New', value: 'NEW' },
    { label: 'Like New / New Other', value: 'LIKE_NEW' },
    { label: 'Excellent', value: 'USED_EXCELLENT' },
    { label: 'Very Good', value: 'VERY_GOOD' },
    { label: 'Good', value: 'GOOD' },
    { label: 'Acceptable', value: 'ACCEPTABLE' },
    { label: 'For Parts or Not Working', value: 'FOR_PARTS_OR_NOT_WORKING' },
];
const CONDITION_LABELS = {
    NEW: 'New',
    NEW_OTHER: 'New - Other',
    LIKE_NEW: 'Like New',
    USED_EXCELLENT: 'Excellent',
    VERY_GOOD: 'Very Good',
    GOOD: 'Good',
    ACCEPTABLE: 'Acceptable',
    FOR_PARTS_OR_NOT_WORKING: 'For Parts / Not Working',
};
const EBAY_CATEGORIES = [
    { id: '31388', name: 'Digital Cameras', label: 'Digital Cameras (31388)' },
    { id: '3323', name: 'Camera Lenses', label: 'Camera Lenses (3323)' },
    { id: '4201', name: 'Film Photography Film', label: 'Film Photography Film (4201)' },
    { id: '78997', name: 'Film Photography Cameras', label: 'Film Photography Cameras (78997)' },
    { id: '183331', name: 'Flashes & Flash Accessories', label: 'Flashes & Flash Accessories (183331)' },
    { id: '30090', name: 'Tripods & Monopods', label: 'Tripods & Monopods (30090)' },
    { id: '29982', name: 'Camera Bags & Cases', label: 'Camera Bags & Cases (29982)' },
    { id: '48446', name: 'Binoculars & Telescopes', label: 'Binoculars & Telescopes (48446)' },
    { id: '48528', name: 'Camera Filters', label: 'Camera Filters (48528)' },
    { id: '48444', name: 'Other Camera Accessories', label: 'Other Camera Accessories (48444)' },
];
/** Given a category ID, return the matching label or the raw ID as fallback */
function getCategoryLabel(categoryId) {
    const match = EBAY_CATEGORIES.find((c) => c.id === categoryId);
    return match ? match.label : categoryId;
}
// ── localStorage helpers ───────────────────────────────────────────────
const STORAGE_KEY = (draftId) => `ebay-prep-overrides-${draftId}`;
const loadOverrides = (draftId) => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY(draftId));
        if (raw)
            return JSON.parse(raw);
    }
    catch { /* ignore */ }
    return {};
};
const saveOverrides = (draftId, overrides) => {
    try {
        localStorage.setItem(STORAGE_KEY(draftId), JSON.stringify(overrides));
    }
    catch { /* ignore */ }
};
const clearOverrides = (draftId) => {
    try {
        localStorage.removeItem(STORAGE_KEY(draftId));
    }
    catch { /* ignore */ }
};
// ── eBay-style preview component ───────────────────────────────────────
const EbayPreview = ({ state, brand, categoryName, policies, }) => {
    const [activeImg, setActiveImg] = useState(0);
    const conditionLabel = CONDITION_LABELS[state.condition] || state.condition;
    const priceNum = parseFloat(state.price) || 0;
    return (_jsxs("div", { style: {
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            overflow: 'hidden',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            background: '#fff',
        }, children: [_jsxs("div", { style: {
                    background: 'linear-gradient(135deg, #e53238 0%, #0064d3 100%)',
                    padding: '8px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                }, children: [_jsx("span", { style: { color: '#fff', fontWeight: 800, fontSize: '20px', letterSpacing: '-0.5px' }, children: "ebay" }), _jsx("span", { style: { color: 'rgba(255,255,255,0.8)', fontSize: '12px', marginLeft: '8px' }, children: "Preview \u2014 not live yet" })] }), _jsxs("div", { style: { padding: '16px' }, children: [_jsx("h2", { style: {
                            fontSize: '18px',
                            fontWeight: 700,
                            color: '#111',
                            margin: '0 0 12px 0',
                            lineHeight: '1.3',
                        }, children: state.title || 'Untitled Product' }), _jsx("div", { style: { marginBottom: '12px' }, children: _jsxs("span", { style: {
                                display: 'inline-block',
                                padding: '2px 8px',
                                background: '#f0f7ff',
                                color: '#0064d3',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                border: '1px solid #c8e0ff',
                            }, children: ["Condition: ", conditionLabel] }) }), _jsxs("div", { style: { display: 'flex', gap: '20px', marginBottom: '16px' }, children: [_jsx("div", { style: { flexShrink: 0, width: '260px' }, children: state.imageUrls.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("div", { style: {
                                                width: '260px',
                                                height: '260px',
                                                border: '1px solid #e5e7eb',
                                                borderRadius: '4px',
                                                overflow: 'hidden',
                                                background: '#fafafa',
                                                marginBottom: '8px',
                                            }, children: _jsx("img", { src: state.imageUrls[activeImg], alt: "Product", style: { width: '100%', height: '100%', objectFit: 'contain' }, onError: (e) => { e.target.style.display = 'none'; } }) }), _jsx("div", { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' }, children: state.imageUrls.slice(0, 8).map((url, i) => (_jsx("div", { onClick: () => setActiveImg(i), style: {
                                                    width: '44px',
                                                    height: '44px',
                                                    border: `2px solid ${i === activeImg ? '#0064d3' : '#e5e7eb'}`,
                                                    borderRadius: '3px',
                                                    overflow: 'hidden',
                                                    cursor: 'pointer',
                                                    background: '#fafafa',
                                                }, children: _jsx("img", { src: url, alt: "", style: { width: '100%', height: '100%', objectFit: 'cover' } }) }, i))) })] })) : (_jsx("div", { style: {
                                        width: '260px',
                                        height: '260px',
                                        border: '1px dashed #d1d5db',
                                        borderRadius: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: '#9ca3af',
                                        fontSize: '14px',
                                    }, children: "No photos" })) }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsxs("div", { style: { marginBottom: '8px' }, children: [_jsxs("div", { style: { fontSize: '28px', fontWeight: 700, color: '#111' }, children: ["US $", priceNum.toFixed(2)] }), _jsx("div", { style: { fontSize: '12px', color: '#555', marginTop: '2px' }, children: "+ Free shipping \u00B7 Free returns" })] }), _jsxs("div", { style: { marginTop: '16px', padding: '12px', background: '#f0f9f0', borderRadius: '6px', border: '1px solid #c3e6cb' }, children: [_jsx("div", { style: { fontSize: '13px', fontWeight: 600, color: '#1a7f37', marginBottom: '4px' }, children: "Add to cart" }), _jsx("div", { style: { fontSize: '12px', color: '#555' }, children: "Ships from Salt Lake City, UT" }), _jsx("div", { style: { fontSize: '12px', color: '#555', marginTop: '2px' }, children: "Seller: usedcam-0 \u2B50\u2B50\u2B50\u2B50\u2B50" })] }), policies && (_jsxs("div", { style: { marginTop: '12px', fontSize: '12px', color: '#555' }, children: [_jsx("div", { children: "\u2713 Returns accepted" }), _jsx("div", { children: "\u2713 Secure payments" }), _jsx("div", { style: { color: '#888', marginTop: '4px', fontSize: '11px' }, children: categoryName ? `${categoryName} (${state.categoryId})` : `Category ID: ${state.categoryId}` })] }))] })] }), _jsx(Divider, {}), state.aspects.length > 0 && (_jsxs("div", { style: { marginTop: '16px' }, children: [_jsx("div", { style: { fontSize: '14px', fontWeight: 600, color: '#111', marginBottom: '10px' }, children: "Item specifics" }), _jsxs("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px' }, children: [brand && (_jsxs(React.Fragment, { children: [_jsx("div", { style: { fontSize: '13px', color: '#555' }, children: "Brand" }), _jsx("div", { style: { fontSize: '13px', fontWeight: 500, color: '#111' }, children: brand })] }, "brand-row")), state.aspects.filter((a) => a.key && a.value).map((aspect, i) => (_jsxs(React.Fragment, { children: [_jsx("div", { style: { fontSize: '13px', color: '#555' }, children: aspect.key }), _jsx("div", { style: { fontSize: '13px', fontWeight: 500, color: '#111' }, children: aspect.value })] }, i)))] })] })), state.description && (_jsxs(_Fragment, { children: [_jsx(Divider, {}), _jsxs("div", { style: { marginTop: '16px' }, children: [_jsx("div", { style: { fontSize: '14px', fontWeight: 600, color: '#111', marginBottom: '8px' }, children: "Description" }), _jsx("div", { style: {
                                            fontSize: '13px',
                                            lineHeight: '1.6',
                                            color: '#333',
                                            maxHeight: '200px',
                                            overflow: 'auto',
                                            padding: '8px',
                                            background: '#fafafa',
                                            border: '1px solid #f3f4f6',
                                            borderRadius: '4px',
                                        }, dangerouslySetInnerHTML: { __html: state.description } })] })] }))] })] }));
};
// ── Aspects Editor ─────────────────────────────────────────────────────
const AspectsEditor = ({ aspects, onChange }) => {
    const updateAspect = (idx, field, val) => {
        const next = aspects.map((a, i) => (i === idx ? { ...a, [field]: val } : a));
        onChange(next);
    };
    const removeAspect = (idx) => {
        onChange(aspects.filter((_, i) => i !== idx));
    };
    const addAspect = () => {
        onChange([...aspects, { key: '', value: '' }]);
    };
    return (_jsxs(BlockStack, { gap: "300", children: [aspects.map((aspect, idx) => (_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx("div", { style: { flex: 1 }, children: _jsx(TextField, { label: "Field", labelHidden: true, placeholder: "e.g. Mount Type", value: aspect.key, onChange: (val) => updateAspect(idx, 'key', val), autoComplete: "off" }) }), _jsx("div", { style: { flex: 1 }, children: _jsx(TextField, { label: "Value", labelHidden: true, placeholder: "e.g. Canon EF", value: aspect.value, onChange: (val) => updateAspect(idx, 'value', val), autoComplete: "off" }) }), _jsx(Button, { icon: DeleteIcon, onClick: () => removeAspect(idx), tone: "critical", variant: "plain", accessibilityLabel: "Remove aspect" })] }, idx))), _jsx(Button, { icon: PlusIcon, onClick: addAspect, variant: "plain", size: "slim", children: "Add Item Specific" })] }));
};
// ── Photos Editor (replaced by DraggablePhotoGrid) ────────────────────
// PhotosEditor has been removed. DraggablePhotoGrid from
// src/web/components/DraggablePhotoGrid.tsx is used directly in the
// Photos card below. Drag to reorder; × to remove; first photo = MAIN.
// ── Main Component ─────────────────────────────────────────────────────
const EbayListingPrep = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { addNotification } = useAppStore();
    const draftId = parseInt(id || '0');
    const [editState, setEditState] = useState(null);
    const [brand, setBrand] = useState('');
    const [categoryName, setCategoryName] = useState('');
    const [policies, setPolicies] = useState(undefined);
    const [showPreview, setShowPreview] = useState(false);
    const [hasSavedOverrides, setHasSavedOverrides] = useState(false);
    // Category combobox state
    const [categoryInputValue, setCategoryInputValue] = useState('');
    const [categoryPopoverActive, setCategoryPopoverActive] = useState(false);
    // ── Load draft data ────────────────────────────────────────────────
    const { data: detailData, isLoading: draftLoading } = useQuery({
        queryKey: ['draft-detail', draftId],
        queryFn: () => apiClient.get(`/drafts/${draftId}`),
        enabled: draftId > 0,
    });
    const draft = detailData?.draft;
    // ── Fetch preview data (auto-loads on mount) ────────────────────────
    const previewMutation = useMutation({
        mutationFn: () => apiClient.post(`/drafts/${draftId}/preview-ebay-listing`),
        onSuccess: (data) => {
            if (data.preview) {
                const preview = data.preview;
                setBrand(preview.brand);
                setCategoryName(preview.categoryName || '');
                setPolicies(preview.policies);
                // Convert aspects from Record to array
                const aspectsArray = Object.entries(preview.aspects).map(([key, vals]) => ({
                    key,
                    value: Array.isArray(vals) ? vals.join(', ') : String(vals),
                }));
                const initial = {
                    title: preview.title,
                    price: preview.price,
                    categoryId: preview.categoryId,
                    condition: preview.condition,
                    conditionDescription: preview.conditionDescription || '',
                    aspects: aspectsArray,
                    description: preview.description,
                    imageUrls: preview.imageUrls,
                };
                // Merge saved overrides from localStorage
                const saved = loadOverrides(draftId);
                const hasSaved = Object.keys(saved).length > 0;
                setHasSavedOverrides(hasSaved);
                if (hasSaved) {
                    const merged = { ...initial, ...saved };
                    setEditState(merged);
                    // Sync category combobox display value
                    setCategoryInputValue(getCategoryLabel(merged.categoryId));
                }
                else {
                    setEditState(initial);
                    // Sync category combobox display value
                    setCategoryInputValue(getCategoryLabel(initial.categoryId));
                }
            }
            else {
                addNotification({
                    type: 'error',
                    title: 'Could not load listing preview',
                    message: data.error || 'Failed to fetch eBay preview. Check eBay connection in Settings.',
                    autoClose: 10000,
                });
            }
        },
        onError: (err) => {
            addNotification({
                type: 'error',
                title: 'Preview error',
                message: err instanceof Error ? err.message : 'Unknown error',
                autoClose: 10000,
            });
        },
    });
    // Auto-load preview on mount
    useEffect(() => {
        if (draftId > 0) {
            previewMutation.mutate();
        }
    }, [draftId]);
    // ── List on eBay ───────────────────────────────────────────────────
    const listOnEbayMutation = useMutation({
        mutationFn: () => {
            if (!editState)
                throw new Error('No listing data');
            const aspectsRecord = {};
            editState.aspects.forEach(({ key, value }) => {
                if (key.trim())
                    aspectsRecord[key.trim()] = value.split(',').map((v) => v.trim()).filter(Boolean);
            });
            return apiClient.post(`/drafts/${draftId}/list-on-ebay`, {
                title: editState.title,
                price: parseFloat(editState.price),
                categoryId: editState.categoryId,
                condition: editState.condition,
                aspects: aspectsRecord,
                description: editState.description,
                imageUrls: editState.imageUrls,
            });
        },
        onSuccess: (data) => {
            if (data.success && data.listingId) {
                clearOverrides(draftId);
                queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
                queryClient.invalidateQueries({ queryKey: ['drafts'] });
                addNotification({
                    type: 'success',
                    title: '🎉 Listed on eBay!',
                    message: `Listing ID: ${data.listingId}`,
                    autoClose: 10000,
                });
                navigate(`/review/${draftId}`);
            }
            else {
                addNotification({
                    type: 'error',
                    title: 'Listing failed',
                    message: data.error || 'Unknown error',
                    autoClose: 10000,
                });
            }
        },
        onError: (err) => {
            addNotification({
                type: 'error',
                title: 'Listing failed',
                message: err instanceof Error ? err.message : 'Unknown error',
                autoClose: 10000,
            });
        },
    });
    // ── Save as Draft (saves overrides to localStorage + title/desc to API) ──
    const saveDraftMutation = useMutation({
        mutationFn: () => {
            if (!editState)
                return Promise.resolve({ success: true });
            return apiClient.put(`/drafts/${draftId}`, {
                title: editState.title,
                description: editState.description,
            });
        },
        onSuccess: () => {
            if (editState) {
                saveOverrides(draftId, {
                    price: editState.price,
                    categoryId: editState.categoryId,
                    condition: editState.condition,
                    conditionDescription: editState.conditionDescription,
                    aspects: editState.aspects,
                    imageUrls: editState.imageUrls,
                });
            }
            queryClient.invalidateQueries({ queryKey: ['draft-detail', draftId] });
            addNotification({ type: 'success', title: 'Draft saved', message: 'Your changes have been saved', autoClose: 4000 });
            navigate(`/review/${draftId}`);
        },
        onError: () => {
            addNotification({ type: 'error', title: 'Save failed', autoClose: 5000 });
        },
    });
    // ── Update helpers ─────────────────────────────────────────────────
    const update = useCallback((key, value) => {
        setEditState((prev) => (prev ? { ...prev, [key]: value } : prev));
    }, []);
    // ── Category combobox ──────────────────────────────────────────────
    /** Options filtered by whatever the user has typed */
    const filteredCategoryOptions = useMemo(() => {
        const q = categoryInputValue.toLowerCase().trim();
        if (!q)
            return EBAY_CATEGORIES;
        return EBAY_CATEGORIES.filter((c) => c.name.toLowerCase().includes(q) ||
            c.id.includes(q) ||
            c.label.toLowerCase().includes(q));
    }, [categoryInputValue]);
    /** User selects an option from the dropdown */
    const handleCategorySelect = useCallback((selectedId) => {
        update('categoryId', selectedId);
        const match = EBAY_CATEGORIES.find((c) => c.id === selectedId);
        const display = match ? match.label : selectedId;
        setCategoryInputValue(display);
        setCategoryName(match?.name ?? '');
        setCategoryPopoverActive(false);
    }, [update]);
    /** User types in the combobox text field */
    const handleCategoryInputChange = useCallback((value) => {
        setCategoryInputValue(value);
        setCategoryPopoverActive(true);
        // If the typed value looks like a bare numeric ID, store it directly
        if (/^\d+$/.test(value.trim())) {
            update('categoryId', value.trim());
            const match = EBAY_CATEGORIES.find((c) => c.id === value.trim());
            setCategoryName(match?.name ?? '');
        }
    }, [update]);
    // ── Condition auto-populate ────────────────────────────────────────
    /** When condition changes, auto-populate conditionDescription from config */
    const handleConditionChange = useCallback((val) => {
        update('condition', val);
        const desc = getConditionDescription(val);
        if (desc)
            update('conditionDescription', desc);
    }, [update]);
    // ── Loading / Error states ─────────────────────────────────────────
    if (draftLoading) {
        return (_jsx(Page, { backAction: { content: 'Back to Review', url: `/review/${draftId}` }, title: "Loading...", children: _jsx("div", { style: { textAlign: 'center', padding: '4rem' }, children: _jsx(Spinner, { size: "large" }) }) }));
    }
    const isLoading = previewMutation.isPending;
    const pageTitle = draft?.draft_title || `Draft #${draftId}`;
    const charCount = editState?.title.length || 0;
    return (_jsxs(Page, { backAction: { content: 'Back to Review', url: `/review/${draftId}` }, title: "Prepare eBay Listing", subtitle: pageTitle, titleMetadata: _jsx(Badge, { tone: "attention", children: "Not yet listed" }), secondaryActions: [
            {
                content: 'Reload from System',
                icon: RefreshIcon,
                onAction: () => previewMutation.mutate(),
                loading: previewMutation.isPending,
                disabled: listOnEbayMutation.isPending,
            },
        ], children: [isLoading && !editState && (_jsxs("div", { style: { textAlign: 'center', padding: '4rem' }, children: [_jsx(Spinner, { size: "large" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", alignment: "center", children: "Loading eBay listing data\u2026" })] })), hasSavedOverrides && editState && !isLoading && (_jsx("div", { style: { marginBottom: '16px' }, children: _jsx(Banner, { tone: "info", children: _jsx("p", { children: "Loaded your previously saved edits. Click \"Reload from System\" to start fresh with system defaults." }) }) })), editState && (_jsxs(Layout, { children: [_jsx(Layout.Section, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Listing Details" }), _jsxs(FormLayout, { children: [_jsx(TextField, { label: _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx("span", { children: "eBay Title" }), _jsx(Badge, { tone: charCount > 80 ? 'critical' : charCount > 65 ? 'warning' : 'success', children: `${charCount}/80` })] }), value: editState.title, onChange: (val) => update('title', val.slice(0, 80)), maxLength: 80, showCharacterCount: true, helpText: "eBay allows up to 80 characters. Avoid special characters like \u00A9, \u2122.", autoComplete: "off", error: charCount > 80 ? 'Title exceeds 80 character eBay limit' : undefined }), _jsx(TextField, { label: "Price (USD)", type: "number", prefix: "$", value: editState.price, onChange: (val) => update('price', val), helpText: "Price as it will appear on eBay. Pulled from Shopify.", autoComplete: "off" }), _jsxs(FormLayout.Group, { children: [_jsx(Combobox, { activator: _jsx(Combobox.TextField, { label: "eBay Category", value: categoryInputValue, onChange: handleCategoryInputChange, onFocus: () => setCategoryPopoverActive(true), onBlur: () => {
                                                                        // Short delay so a click on an option registers first
                                                                        setTimeout(() => setCategoryPopoverActive(false), 150);
                                                                    }, placeholder: "Search or enter category ID\u2026", helpText: categoryName
                                                                        ? `Auto-suggested · type to search, or enter a numeric ID`
                                                                        : 'Type to search categories, or enter a numeric ID', autoComplete: "off" }), allowMultiple: false, children: categoryPopoverActive && filteredCategoryOptions.length > 0 ? (_jsx(Listbox, { onSelect: handleCategorySelect, children: filteredCategoryOptions.map((cat) => (_jsx(Listbox.Option, { value: cat.id, selected: editState.categoryId === cat.id, accessibilityLabel: cat.label, children: _jsx(Listbox.TextOption, { selected: editState.categoryId === cat.id, children: cat.label }) }, cat.id))) })) : null }), _jsx(Select, { label: "Condition", options: CONDITION_OPTIONS, value: editState.condition, onChange: handleConditionChange, helpText: "Changes auto-populate the condition description below" })] }), _jsx(TextField, { label: "Condition Description", value: editState.conditionDescription, onChange: (val) => update('conditionDescription', val), helpText: "Auto-filled from Pictureline grade; edit freely. Shown to buyers on eBay.", maxLength: 1000, multiline: 2, autoComplete: "off" })] })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Item Specifics" }), _jsxs(Text, { variant: "bodySm", as: "p", tone: "subdued", children: ["Auto-extracted from product data. Brand \"", brand, "\" is always included."] })] }), _jsx(Badge, { children: `${editState.aspects.length} fields` })] }), _jsx(AspectsEditor, { aspects: editState.aspects, onChange: (aspects) => update('aspects', aspects) })] }) }), _jsx("div", { style: { marginTop: '16px' } }), policies && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Business Policies" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Policies are set in your eBay seller account and applied automatically." }), _jsx("div", { style: {
                                                    background: '#f9fafb',
                                                    borderRadius: '8px',
                                                    padding: '12px 16px',
                                                    border: '1px solid #e3e5e7',
                                                }, children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Fulfillment / Shipping" }), _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "span", fontWeight: "semibold", children: policies.fulfillmentPolicyName }), _jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: _jsx("code", { style: { fontSize: '11px', background: '#f3f4f6', padding: '1px 4px', borderRadius: '3px' }, children: policies.fulfillmentPolicyId }) })] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Returns" }), _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "span", fontWeight: "semibold", children: policies.returnPolicyName }), _jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: _jsx("code", { style: { fontSize: '11px', background: '#f3f4f6', padding: '1px 4px', borderRadius: '3px' }, children: policies.returnPolicyId }) })] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Payment" }), _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", as: "span", fontWeight: "semibold", children: policies.paymentPolicyName }), _jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: _jsx("code", { style: { fontSize: '11px', background: '#f3f4f6', padding: '1px 4px', borderRadius: '3px' }, children: policies.paymentPolicyId }) })] })] })] }) }), _jsxs(Text, { variant: "bodySm", as: "p", tone: "subdued", children: ["To change policies, update them in your", ' ', _jsx("a", { href: "https://www.ebay.com/sh/acc/business-policies", target: "_blank", rel: "noopener noreferrer", style: { color: '#0064d3' }, children: "eBay Business Policies" }), ' ', "settings."] })] }) })), _jsx("div", { style: { marginTop: '16px' } }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Photos" }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "Drag to reorder. First photo (MAIN) is the hero image on eBay. Click \u2715 to remove." })] }), _jsx(Badge, { tone: editState.imageUrls.length === 0 ? 'critical' : 'success', children: `${editState.imageUrls.length} photo${editState.imageUrls.length !== 1 ? 's' : ''}` })] }), _jsx(DraggablePhotoGrid, { imageUrls: editState.imageUrls, onChange: (urls) => update('imageUrls', urls) })] }) }), _jsx("div", { style: { marginTop: '16px' } }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Description" }), _jsx(Badge, { children: `${editState.description.length} chars${editState.description.length > 500000 ? ' (⚠️ too long)' : ''}` })] }), _jsx("textarea", { value: editState.description, onChange: (e) => update('description', e.target.value), rows: 16, style: {
                                                    width: '100%',
                                                    padding: '12px',
                                                    fontSize: '13px',
                                                    lineHeight: '1.6',
                                                    borderRadius: '8px',
                                                    border: '1px solid #c9cccf',
                                                    fontFamily: 'monospace',
                                                    resize: 'vertical',
                                                    boxSizing: 'border-box',
                                                } }), _jsx(Text, { variant: "bodySm", as: "p", tone: "subdued", children: "HTML is supported. This will be the eBay listing description." })] }) }), _jsx("div", { style: { marginTop: '16px' }, children: _jsx(Button, { onClick: () => setShowPreview((v) => !v), variant: "plain", size: "slim", children: showPreview ? '▲ Hide eBay Preview' : '▼ Show eBay Preview' }) }), showPreview && (_jsx("div", { style: { marginTop: '12px' }, children: _jsx(EbayPreview, { state: editState, brand: brand, categoryName: categoryName, policies: policies }) })), _jsx("div", { style: { height: '100px' } })] }) }), _jsx(Layout.Section, { variant: "oneThird", children: _jsxs("div", { style: {
                                position: 'sticky',
                                top: '16px',
                                zIndex: 100,
                            }, children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Ready to List" }), editState.imageUrls.length === 0 && (_jsx(Banner, { tone: "critical", children: _jsx("p", { children: "\u26A0\uFE0F No photos \u2014 eBay requires at least one image." }) })), editState.title.length === 0 && (_jsx(Banner, { tone: "critical", children: _jsx("p", { children: "\u26A0\uFE0F Title is required." }) })), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Title" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [charCount, "/80 chars"] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Price" }), _jsxs(Text, { variant: "bodySm", as: "span", fontWeight: "semibold", children: ["$", editState.price] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Condition" }), _jsx(Text, { variant: "bodySm", as: "span", children: CONDITION_LABELS[editState.condition] || editState.condition })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Photos" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [editState.imageUrls.length, " image", editState.imageUrls.length !== 1 ? 's' : ''] })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Category" }), _jsx(Text, { variant: "bodySm", as: "span", children: categoryName ? `${categoryName} (${editState.categoryId})` : editState.categoryId })] }), _jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { variant: "bodySm", as: "span", tone: "subdued", children: "Item Specifics" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [editState.aspects.filter((a) => a.key).length, " fields"] })] })] }), _jsx(Divider, {}), _jsx(Button, { variant: "primary", size: "large", fullWidth: true, onClick: () => listOnEbayMutation.mutate(), loading: listOnEbayMutation.isPending, disabled: editState.imageUrls.length === 0 ||
                                                    editState.title.length === 0 ||
                                                    saveDraftMutation.isPending, children: "\uD83D\uDECD\uFE0F List on eBay" }), _jsx(Button, { fullWidth: true, onClick: () => saveDraftMutation.mutate(), loading: saveDraftMutation.isPending, disabled: listOnEbayMutation.isPending, children: "\uD83D\uDCBE Save as Draft" }), _jsx(Button, { fullWidth: true, variant: "plain", url: `/review/${draftId}`, disabled: listOnEbayMutation.isPending || saveDraftMutation.isPending, children: "\u2190 Back without saving" })] }) }), _jsx("div", { style: { marginTop: '16px' } }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Preview" }), _jsx(Badge, { tone: "info", children: "Live" })] }), _jsx(EbayPreview, { state: editState, brand: brand, categoryName: categoryName, policies: policies })] }) })] }) })] }))] }));
};
export default EbayListingPrep;
