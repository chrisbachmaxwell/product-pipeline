import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from 'react';
import { BlockStack, Box, Button, Card, Divider, EmptyState, Icon, InlineStack, Spinner, Text, } from '@shopify/polaris';
import { ChevronRightIcon, QuestionCircleIcon } from '@shopify/polaris-icons';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { categoryFromSlug } from './HelpCenter';
const snippet = (text, max = 140) => {
    const plain = text.replace(/\*\*/g, '').replace(/\n/g, ' ');
    return plain.length > max ? plain.slice(0, max) + '…' : plain;
};
const HelpCategoryPage = () => {
    const { category: catSlug } = useParams();
    const navigate = useNavigate();
    const ctx = useOutletContext();
    const articles = ctx?.articles || [];
    const categories = ctx?.categories || [];
    const catName = useMemo(() => categoryFromSlug(catSlug || '', categories.map((c) => c.name)), [catSlug, categories]);
    const catArticles = useMemo(() => articles.filter((a) => (a.category || 'General') === catName), [articles, catName]);
    if (!articles.length) {
        return (_jsx(Card, { children: _jsx(Box, { padding: "600", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { size: "large", accessibilityLabel: "Loading" }) }) }) }));
    }
    if (!catArticles.length) {
        return (_jsx(Card, { children: _jsxs(EmptyState, { heading: "Category not found", image: "", children: [_jsx(Text, { as: "p", children: "No articles found for this category." }), _jsx(Button, { onClick: () => navigate('/help'), children: "Back to Help Center" })] }) }));
    }
    return (_jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Button, { variant: "plain", onClick: () => navigate('/help'), children: "Help" }), _jsx(Icon, { source: ChevronRightIcon, tone: "subdued" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: catName })] }), _jsx(Card, { children: _jsx(BlockStack, { gap: "200", children: _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "200", children: _jsx(Icon, { source: QuestionCircleIcon }) }), _jsxs(BlockStack, { gap: "050", children: [_jsx(Text, { variant: "headingLg", as: "h1", children: catName }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: [catArticles.length, " article", catArticles.length !== 1 ? 's' : ''] })] })] }) }) }), _jsx(Card, { children: _jsx(BlockStack, { gap: "0", children: catArticles.map((article, index) => (_jsxs(React.Fragment, { children: [index > 0 && _jsx(Divider, {}), _jsx("div", { onClick: () => navigate(`/help/article/${article.id}`), role: "button", tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter')
                                    navigate(`/help/article/${article.id}`); }, style: { cursor: 'pointer', padding: 'var(--p-space-400)' }, children: _jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { variant: "bodyMd", fontWeight: "semibold", as: "p", children: article.question }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "p", children: snippet(article.answer || '') })] }), _jsx(Icon, { source: ChevronRightIcon, tone: "subdued" })] }) })] }, article.id))) }) })] }));
};
export default HelpCategoryPage;
