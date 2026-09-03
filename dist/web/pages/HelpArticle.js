import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useMemo, useState } from 'react';
import { Badge, BlockStack, Box, Button, Card, Divider, EmptyState, Icon, InlineStack, Spinner, Text, } from '@shopify/polaris';
import { ArrowLeftIcon, ArrowRightIcon, ThumbsUpIcon, ThumbsDownIcon, ChevronRightIcon, } from '@shopify/polaris-icons';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { categorySlug } from './HelpCenter';
/* ── Simple markdown-ish renderer ───────────────────────── */
function renderArticleContent(text) {
    if (!text)
        return null;
    const blocks = text.split(/\n\n+/);
    return blocks.map((block, i) => {
        const trimmed = block.trim();
        if (!trimmed)
            return null;
        const lines = trimmed.split('\n');
        const isNumberedList = lines.every((l) => /^\d+\.\s/.test(l.trim()) || l.trim() === '');
        const isBulletList = lines.every((l) => /^[-•]\s/.test(l.trim()) || l.trim() === '');
        if (isNumberedList) {
            return (_jsx("ol", { style: { paddingLeft: 20, margin: '8px 0' }, children: lines
                    .filter((l) => l.trim())
                    .map((l, j) => (_jsx("li", { style: { marginBottom: 4 }, children: renderInline(l.replace(/^\d+\.\s*/, '')) }, j))) }, i));
        }
        if (isBulletList) {
            return (_jsx("ul", { style: { paddingLeft: 20, margin: '8px 0' }, children: lines
                    .filter((l) => l.trim())
                    .map((l, j) => (_jsx("li", { style: { marginBottom: 4 }, children: renderInline(l.replace(/^[-•]\s*/, '')) }, j))) }, i));
        }
        return (_jsx("p", { style: { margin: '8px 0', lineHeight: 1.6 }, children: renderInline(trimmed) }, i));
    });
}
function renderInline(text) {
    const parts = [];
    const regex = /\*\*(.+?)\*\*/g;
    let lastIdx = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx)
            parts.push(text.slice(lastIdx, match.index));
        parts.push(_jsx("strong", { children: match[1] }, match.index));
        lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length)
        parts.push(text.slice(lastIdx));
    return parts.length === 1 ? parts[0] : _jsx(_Fragment, { children: parts });
}
const HelpArticlePage = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const ctx = useOutletContext();
    const articles = ctx?.articles || [];
    const categories = ctx?.categories || [];
    const [feedback, setFeedback] = useState(null);
    const article = useMemo(() => articles.find((a) => a.id === Number(id)), [articles, id]);
    const orderedArticles = useMemo(() => categories.flatMap((c) => c.items), [categories]);
    const currentIndex = useMemo(() => orderedArticles.findIndex((a) => a.id === Number(id)), [orderedArticles, id]);
    const prevArticle = currentIndex > 0 ? orderedArticles[currentIndex - 1] : null;
    const nextArticle = currentIndex >= 0 && currentIndex < orderedArticles.length - 1
        ? orderedArticles[currentIndex + 1]
        : null;
    const relatedArticles = useMemo(() => {
        if (!article)
            return [];
        return articles
            .filter((a) => a.category === article.category && a.id !== article.id)
            .slice(0, 4);
    }, [article, articles]);
    const handleFeedback = useCallback((value) => {
        setFeedback(value);
    }, []);
    if (!articles.length) {
        return (_jsx(Card, { children: _jsx(Box, { padding: "600", children: _jsx(InlineStack, { align: "center", children: _jsx(Spinner, { size: "large", accessibilityLabel: "Loading article" }) }) }) }));
    }
    if (!article) {
        return (_jsx(Card, { children: _jsxs(EmptyState, { heading: "Article not found", image: "", children: [_jsx(Text, { as: "p", children: "This article may have been removed or the link is incorrect." }), _jsx(Button, { onClick: () => navigate('/help'), children: "Back to Help Center" })] }) }));
    }
    const catName = article.category || 'General';
    return (_jsxs(BlockStack, { gap: "400", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Button, { variant: "plain", onClick: () => navigate('/help'), children: "Help" }), _jsx(Icon, { source: ChevronRightIcon, tone: "subdued" }), _jsx(Button, { variant: "plain", onClick: () => navigate(`/help/category/${categorySlug(catName)}`), children: catName }), _jsx(Icon, { source: ChevronRightIcon, tone: "subdued" }), _jsx(Text, { variant: "bodySm", tone: "subdued", as: "span", children: article.question.length > 40
                            ? article.question.slice(0, 40) + '…'
                            : article.question })] }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsxs(BlockStack, { gap: "200", children: [_jsx(InlineStack, { gap: "200", blockAlign: "center", children: _jsx(Badge, { children: catName }) }), _jsx(Text, { variant: "headingLg", as: "h1", children: article.question }), _jsxs(Text, { variant: "bodySm", tone: "subdued", as: "p", children: ["Last updated", ' ', new Date(article.updated_at).toLocaleDateString('en-US', {
                                            month: 'long',
                                            day: 'numeric',
                                            year: 'numeric',
                                        })] })] }), _jsx(Divider, {}), _jsx(Box, { children: _jsx("div", { style: { lineHeight: 1.7, color: 'var(--p-color-text)' }, children: renderArticleContent(article.answer || '') }) }), _jsx(Divider, {}), _jsx(Box, { background: "bg-fill-secondary", borderRadius: "200", padding: "400", children: _jsxs(BlockStack, { gap: "200", inlineAlign: "center", children: [_jsx(Text, { variant: "bodySm", fontWeight: "semibold", as: "p", children: "Was this article helpful?" }), feedback ? (_jsx(Text, { variant: "bodySm", tone: "success", as: "p", children: "Thanks for your feedback!" })) : (_jsxs(InlineStack, { gap: "300", children: [_jsx(Button, { icon: ThumbsUpIcon, onClick: () => handleFeedback('yes'), children: "Yes, helpful" }), _jsx(Button, { icon: ThumbsDownIcon, onClick: () => handleFeedback('no'), children: "Not really" })] }))] }) })] }) }), relatedArticles.length > 0 && (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { variant: "headingMd", as: "h3", children: "Related articles" }), _jsx(Divider, {}), _jsx(BlockStack, { gap: "200", children: relatedArticles.map((a) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Button, { variant: "plain", onClick: () => navigate(`/help/article/${a.id}`), children: a.question }), _jsx(Icon, { source: ChevronRightIcon, tone: "subdued" })] }, a.id))) })] }) })), _jsxs(InlineStack, { align: "space-between", children: [prevArticle ? (_jsx(Button, { icon: ArrowLeftIcon, onClick: () => navigate(`/help/article/${prevArticle.id}`), children: prevArticle.question.length > 35
                            ? prevArticle.question.slice(0, 35) + '…'
                            : prevArticle.question })) : (_jsx(Box, {})), nextArticle ? (_jsx(Button, { icon: ArrowRightIcon, onClick: () => navigate(`/help/article/${nextArticle.id}`), children: nextArticle.question.length > 35
                            ? nextArticle.question.slice(0, 35) + '…'
                            : nextArticle.question })) : (_jsx(Box, {}))] })] }));
};
export default HelpArticlePage;
