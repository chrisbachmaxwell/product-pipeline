import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from 'react';
import { Badge, Banner, BlockStack, Box, Button, Card, Divider, InlineStack, RangeSlider, Text, TextField, } from '@shopify/polaris';
import { Image as ImageIcon, RefreshCw, Palette, Layers } from 'lucide-react';
/* ── Color presets ──────────────────────────────────────────────────── */
const COLOR_PRESETS = [
    { hex: '#FFFFFF', label: 'White' },
    { hex: '#F5F5F5', label: 'Light Gray' },
    { hex: '#000000', label: 'Black' },
    { hex: '#E8F0FE', label: 'Light Blue' },
    { hex: '#FFF9E6', label: 'Cream' },
    { hex: '#F0F0F0', label: 'Silver' },
];
/* ── Main Component ─────────────────────────────────────────────────── */
const PhotoControls = ({ selectedImageUrl, onReprocess, onReprocessAll, onParamsChange, reprocessing, reprocessingAll, previewUrl, imageCount = 0, hideActionButtons = false, }) => {
    const [background, setBackground] = useState('#FFFFFF');
    const [padding, setPadding] = useState(10); // percentage 0-50
    const [shadow, setShadow] = useState(true);
    const [customColor, setCustomColor] = useState('');
    // Build params from state
    const getParams = useCallback(() => {
        return {
            background,
            padding: padding / 100, // convert % to 0-0.5 ratio
            shadow,
        };
    }, [background, padding, shadow]);
    // Notify parent about parameter changes
    useEffect(() => {
        if (onParamsChange) {
            onParamsChange(getParams());
        }
    }, [onParamsChange, getParams]);
    const handleReprocess = useCallback(() => {
        if (selectedImageUrl) {
            onReprocess(selectedImageUrl, getParams());
        }
    }, [selectedImageUrl, onReprocess, getParams]);
    const handleReprocessAll = useCallback(() => {
        onReprocessAll(getParams());
    }, [onReprocessAll, getParams]);
    const handleCustomColorApply = useCallback(() => {
        const hex = customColor.startsWith('#') ? customColor : `#${customColor}`;
        if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
            setBackground(hex);
            setCustomColor('');
        }
    }, [customColor]);
    return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Reprocessing Controls" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Adjust PhotoRoom settings and reprocess images" })] }), _jsx(Badge, { tone: "info", children: "PhotoRoom" })] }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(Palette, { size: 16, color: "#6b7280" }), _jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Background Color" })] }), _jsx(InlineStack, { gap: "200", wrap: true, children: COLOR_PRESETS.map((preset) => (_jsx("button", { onClick: () => setBackground(preset.hex), title: preset.label, style: {
                                    width: 36,
                                    height: 36,
                                    borderRadius: 8,
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
                                        fontSize: 16,
                                    }, children: "\u2713" })) }, preset.hex))) }), _jsxs(InlineStack, { gap: "200", blockAlign: "end", children: [_jsx("div", { style: { flex: 1, maxWidth: 160 }, children: _jsx(TextField, { label: "", placeholder: "#AABBCC", value: customColor, onChange: setCustomColor, autoComplete: "off", connectedRight: _jsx(Button, { size: "slim", onClick: handleCustomColorApply, children: "Apply" }) }) }), _jsx("div", { style: {
                                        width: 36,
                                        height: 36,
                                        borderRadius: 8,
                                        border: '2px solid #e5e7eb',
                                        backgroundColor: background,
                                    } }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: background })] })] }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(Layers, { size: 16, color: "#6b7280" }), _jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Padding / White Space" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "span", children: [padding, "%"] })] }), _jsx(RangeSlider, { label: "", value: padding, min: 0, max: 50, step: 1, onChange: (val) => setPadding(typeof val === 'number' ? val : val[0]), output: true }), _jsx(InlineStack, { gap: "200", children: [0, 5, 10, 20, 30].map((val) => (_jsx(Button, { size: "slim", variant: padding === val ? 'primary' : 'secondary', onClick: () => setPadding(val), children: `${val}%` }, val))) })] }), _jsx(Divider, {}), _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(InlineStack, { gap: "100", blockAlign: "center", children: [_jsx(ImageIcon, { size: 16, color: "#6b7280" }), _jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Drop Shadow" })] }), _jsx("button", { onClick: () => setShadow(!shadow), style: {
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
                                        } }) })] }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: shadow
                                ? 'AI soft shadow enabled — adds a natural drop shadow under the product'
                                : 'Shadow disabled — clean cutout on solid background' })] }), _jsx(Divider, {}), previewUrl && (_jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "span", children: "Preview" }), _jsx("div", { style: {
                                background: '#f9fafb',
                                borderRadius: 8,
                                padding: 8,
                                textAlign: 'center',
                            }, children: _jsx("img", { src: previewUrl, alt: "Processing preview", style: {
                                    maxWidth: '100%',
                                    maxHeight: 240,
                                    objectFit: 'contain',
                                    borderRadius: 6,
                                } }) }), _jsx(Divider, {})] })), _jsx(Box, { padding: "200", background: "bg-surface-secondary", borderRadius: "200", children: _jsxs(InlineStack, { gap: "300", wrap: true, children: [_jsxs(InlineStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "BG:" }), _jsx("div", { style: {
                                            width: 14,
                                            height: 14,
                                            borderRadius: 3,
                                            border: '1px solid #e5e7eb',
                                            backgroundColor: background,
                                            display: 'inline-block',
                                        } }), _jsx(Text, { variant: "bodySm", as: "span", children: background })] }), _jsxs(InlineStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Padding:" }), _jsxs(Text, { variant: "bodySm", as: "span", children: [padding, "%"] })] }), _jsxs(InlineStack, { gap: "100", children: [_jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: "Shadow:" }), _jsx(Badge, { tone: shadow ? 'success' : undefined, children: shadow ? 'On' : 'Off' })] })] }) }), !hideActionButtons && (_jsxs(_Fragment, { children: [_jsxs(InlineStack, { gap: "200", children: [_jsx(Button, { variant: "primary", icon: _jsx(RefreshCw, { size: 16 }), onClick: handleReprocess, loading: reprocessing, disabled: !selectedImageUrl || reprocessingAll, children: selectedImageUrl ? 'Reprocess Image' : 'Select an image first' }), _jsx(Button, { icon: _jsx(RefreshCw, { size: 16 }), onClick: handleReprocessAll, loading: reprocessingAll, disabled: imageCount === 0 || reprocessing, children: `Reprocess All (${imageCount})` })] }), !selectedImageUrl && (_jsx(Banner, { tone: "info", children: _jsx("p", { children: "Click an image in the gallery above to select it for individual reprocessing." }) }))] }))] }) }));
};
export default PhotoControls;
