import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, BlockStack, Box, Card, InlineStack, Text } from '@shopify/polaris';
const formatValue = (value) => {
    if (typeof value === 'number') {
        return value.toLocaleString();
    }
    return value;
};
const MetricCard = ({ title, value, trend, icon, tone = 'default', loading = false, onClick, }) => {
    return (_jsx(Card, { padding: "400", children: _jsx("div", { onClick: onClick, style: { cursor: onClick ? 'pointer' : 'default' }, children: _jsxs(BlockStack, { gap: "200", children: [_jsxs(InlineStack, { align: "space-between", children: [_jsx(Text, { tone: "subdued", as: "p", children: title }), icon] }), _jsx(Text, { variant: "headingLg", as: "p", children: loading ? '—' : formatValue(value) }), trend && !loading && (_jsxs(InlineStack, { gap: "200", align: "center", children: [_jsx(Badge, { tone: trend.value >= 0 ? 'success' : 'critical', children: `${trend.value >= 0 ? '+' : ''}${trend.value}%` }), _jsx(Text, { tone: "subdued", as: "span", children: trend.period })] })), tone !== 'default' && (_jsx(Box, { children: _jsx(Badge, { tone: tone, children: tone === 'critical' ? 'Needs attention' : tone }) }))] }) }) }));
};
export default MetricCard;
