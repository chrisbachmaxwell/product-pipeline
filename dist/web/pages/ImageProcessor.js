import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useState } from 'react';
import { Banner, BlockStack, Box, Button, Card, Divider, Icon, InlineGrid, InlineStack, Page, Spinner, Text, TextField, } from '@shopify/polaris';
import { ImageIcon, CheckCircleIcon, AlertCircleIcon } from '@shopify/polaris-icons';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '../hooks/useApi';
import TemplateManager from '../components/TemplateManager';
const ImageProcessor = () => {
    const [searchParams] = useSearchParams();
    const initialCategory = searchParams.get('category') || undefined;
    const [productId, setProductId] = useState('');
    const [processing, setProcessing] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const { data: status, isLoading: statusLoading } = useQuery({
        queryKey: ['images-status'],
        queryFn: () => apiClient.get('/images/status'),
        staleTime: 60000,
    });
    const handleProcess = useCallback(async () => {
        if (!productId.trim())
            return;
        setProcessing(true);
        setResult(null);
        setError(null);
        try {
            const res = await apiClient.post(`/images/process/${productId.trim()}`);
            setResult(res);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Processing failed');
        }
        finally {
            setProcessing(false);
        }
    }, [productId]);
    if (statusLoading) {
        return (_jsx(Page, { title: "Image Processor", fullWidth: true, children: _jsx(Card, { children: _jsx(Box, { padding: "400", children: _jsxs(InlineStack, { align: "center", gap: "200", children: [_jsx(Spinner, { size: "small" }), _jsx(Text, { as: "span", variant: "bodyMd", children: "Checking PhotoRoom status\u2026" })] }) }) }) }));
    }
    return (_jsx(Page, { title: "Image Processor", subtitle: "PhotoRoom background removal & product image processing", fullWidth: true, children: _jsxs(BlockStack, { gap: "500", children: [_jsx(Card, { children: _jsx(InlineStack, { align: "space-between", blockAlign: "center", children: _jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: status?.configured ? 'bg-fill-success-secondary' : 'bg-fill-warning-secondary', borderRadius: "200", padding: "200", children: _jsx(Icon, { source: status?.configured ? CheckCircleIcon : AlertCircleIcon, tone: status?.configured ? 'success' : 'warning' }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingSm", as: "h2", children: "PhotoRoom Integration" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: status?.configured
                                                ? 'API configured and ready'
                                                : 'Setup required' })] })] }) }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Configuration" }), _jsx(Divider, {}), status?.configured ? (_jsx(Banner, { tone: "success", title: "PhotoRoom API Ready", children: _jsx(Text, { as: "p", children: "PhotoRoom API is configured and ready to use for automatic image processing." }) })) : (_jsx(Banner, { tone: "warning", title: "Setup Required", children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(Text, { as: "p", children: ["PhotoRoom API is not configured. Set the", ' ', _jsx("code", { children: "PHOTOROOM_API_KEY" }), " environment variable to enable automatic image processing."] }), _jsxs(Text, { tone: "subdued", as: "p", children: ["Get your API key at", ' ', _jsx("a", { href: "https://app.photoroom.com/api-dashboard", target: "_blank", rel: "noopener noreferrer", children: "app.photoroom.com/api-dashboard" })] })] }) }))] }) }), status?.configured && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "300", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: ImageIcon }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Process Product Images" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: "Remove backgrounds, add white background with drop shadow, and generate clean product images" })] })] }), _jsx(Divider, {}), _jsxs(InlineStack, { gap: "300", align: "space-between", wrap: false, children: [_jsx(Box, { minWidth: "300px", children: _jsx(TextField, { label: "", value: productId, onChange: setProductId, placeholder: "Enter Shopify Product ID (e.g. 8234567890123)", autoComplete: "off" }) }), _jsx(Button, { variant: "primary", onClick: handleProcess, loading: processing, disabled: !productId.trim(), children: processing ? 'Processing...' : 'Process Images' })] })] }) })), error && (_jsx(Banner, { tone: "critical", title: "Processing Failed", onDismiss: () => setError(null), children: _jsx(Text, { as: "p", children: error }) })), result && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Processing Complete" }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: [result.processedCount, " of ", result.originalCount, " images processed successfully"] })] }), _jsx(Box, { background: "bg-fill-success-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: CheckCircleIcon, tone: "success" }) })] }), _jsx(Divider, {}), result.images.length === 0 ? (_jsx(Box, { padding: "400", children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(Icon, { source: ImageIcon, tone: "subdued" }), _jsx(Text, { tone: "subdued", as: "p", children: "No processed images to display" })] }) })) : (_jsx(InlineGrid, { columns: { xs: 2, sm: 3, md: 4 }, gap: "300", children: result.images.map((src, idx) => (_jsx(Card, { children: _jsx(Box, { padding: "200", children: _jsx("img", { src: src, alt: `Processed image ${idx + 1}`, style: {
                                                width: '100%',
                                                height: 'auto',
                                                maxHeight: '200px',
                                                objectFit: 'contain',
                                                borderRadius: '4px',
                                            } }) }) }, idx))) }))] }) })), _jsx(TemplateManager, { initialCategory: initialCategory })] }) }));
};
export default ImageProcessor;
