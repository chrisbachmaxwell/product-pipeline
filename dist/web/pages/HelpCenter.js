import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@shopify/polaris';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useLocation, Outlet } from 'react-router-dom';
import { apiClient } from '../hooks/useApi';
import '../styles/help.css';
/* ── Category metadata ──────────────────────────────────── */
const CATEGORY_META = {
    'Getting Started': {
        icon: '🚀',
        color: '#e8f5e9',
        description: 'New here? Start with the basics',
        order: 0,
    },
    Products: {
        icon: '📦',
        color: '#e3f2fd',
        description: 'Managing your Shopify product catalog',
        order: 1,
    },
    Mappings: {
        icon: '🔗',
        color: '#f3e5f5',
        description: 'Configure how Shopify fields map to eBay',
        order: 2,
    },
    Pipeline: {
        icon: '⚡',
        color: '#fff3e0',
        description: 'Automated listing workflow and stages',
        order: 3,
    },
    Orders: {
        icon: '🛒',
        color: '#e8eaf6',
        description: 'Order sync and fulfillment',
        order: 4,
    },
    Analytics: {
        icon: '📊',
        color: '#fce4ec',
        description: 'Reports, logs, and insights',
        order: 5,
    },
    Chat: {
        icon: '💬',
        color: '#e0f7fa',
        description: 'Using the AI assistant',
        order: 6,
    },
    General: {
        icon: '📖',
        color: '#f1f8e9',
        description: 'General usage and tips',
        order: 7,
    },
};
const getCategoryMeta = (name) => CATEGORY_META[name] || { icon: '📄', color: '#f5f5f5', description: '', order: 99 };
export const categorySlug = (name) => encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-'));
export const categoryFromSlug = (slug, categories) => categories.find((c) => categorySlug(c) === slug) || slug;
/* ── Helpers ────────────────────────────────────────────── */
const stripFormatting = (text) => text.replace(/\*\*/g, '').replace(/\n/g, ' ');
const snippet = (text, max = 120) => {
    const plain = stripFormatting(text);
    return plain.length > max ? plain.slice(0, max) + '…' : plain;
};
/* ═══════════════════════════════════════════════════════════
   HelpCenter — outer layout with sidebar + <Outlet>
   ═══════════════════════════════════════════════════════════ */
const HelpCenter = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const params = useParams();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [expandedCats, setExpandedCats] = useState(new Set());
    const [sidebarSearch, setSidebarSearch] = useState('');
    // Fetch all published articles
    const { data, isLoading } = useQuery({
        queryKey: ['help-articles-all'],
        queryFn: () => apiClient.get('/help/faq'),
    });
    const articles = data?.data || [];
    // Derive sorted categories
    const categories = useMemo(() => {
        const catMap = new Map();
        for (const a of articles) {
            const cat = a.category || 'general';
            if (!catMap.has(cat))
                catMap.set(cat, []);
            catMap.get(cat).push(a);
        }
        return Array.from(catMap.entries())
            .map(([name, items]) => ({ name, items }))
            .sort((a, b) => getCategoryMeta(a.name).order - getCategoryMeta(b.name).order);
    }, [articles]);
    // Auto-expand the active category
    useEffect(() => {
        if (params.category) {
            const catName = categoryFromSlug(params.category, categories.map((c) => c.name));
            setExpandedCats((prev) => {
                const next = new Set(prev);
                next.add(catName);
                return next;
            });
        }
        if (params.id) {
            const article = articles.find((a) => a.id === Number(params.id));
            if (article) {
                setExpandedCats((prev) => {
                    const next = new Set(prev);
                    next.add(article.category || 'general');
                    return next;
                });
            }
        }
    }, [params.category, params.id, categories, articles]);
    const toggleCategory = useCallback((name) => {
        setExpandedCats((prev) => {
            const next = new Set(prev);
            if (next.has(name))
                next.delete(name);
            else
                next.add(name);
            return next;
        });
    }, []);
    // Filter sidebar articles by search
    const filteredCategories = useMemo(() => {
        if (!sidebarSearch.trim())
            return categories;
        const q = sidebarSearch.toLowerCase();
        return categories
            .map((cat) => ({
            ...cat,
            items: cat.items.filter((a) => a.question.toLowerCase().includes(q) ||
                (a.answer && a.answer.toLowerCase().includes(q))),
        }))
            .filter((cat) => cat.items.length > 0);
    }, [categories, sidebarSearch]);
    // Auto-expand all when searching
    useEffect(() => {
        if (sidebarSearch.trim()) {
            setExpandedCats(new Set(filteredCategories.map((c) => c.name)));
        }
    }, [sidebarSearch, filteredCategories]);
    const activeArticleId = params.id ? Number(params.id) : null;
    const goToArticle = useCallback((id) => {
        navigate(`/help/article/${id}`);
        setSidebarOpen(false);
    }, [navigate]);
    const goToCategory = useCallback((name) => {
        navigate(`/help/category/${categorySlug(name)}`);
        setSidebarOpen(false);
    }, [navigate]);
    const isLanding = location.pathname === '/help';
    return (_jsxs("div", { className: "help-docs", children: [sidebarOpen && _jsx("div", { className: "help-mobile-overlay", onClick: () => setSidebarOpen(false) }), _jsxs("aside", { className: `help-docs-sidebar${sidebarOpen ? ' mobile-open' : ''}`, children: [_jsx("div", { className: "help-sidebar-header", children: _jsx("span", { className: "help-sidebar-title", onClick: () => navigate('/help'), children: "\uD83D\uDCDA Documentation" }) }), _jsx("div", { className: "help-sidebar-search", children: _jsx("input", { type: "text", placeholder: "Filter articles\u2026", value: sidebarSearch, onChange: (e) => setSidebarSearch(e.target.value) }) }), isLoading ? (_jsx("div", { className: "help-loading", children: _jsx(Spinner, { size: "small", accessibilityLabel: "Loading" }) })) : (filteredCategories.map((cat) => {
                        const meta = getCategoryMeta(cat.name);
                        const isExpanded = expandedCats.has(cat.name);
                        return (_jsxs("div", { className: "help-sidebar-category", children: [_jsxs("button", { className: `help-sidebar-category-btn${params.category && categoryFromSlug(params.category, categories.map((c) => c.name)) === cat.name
                                        ? ' active'
                                        : ''}`, onClick: () => toggleCategory(cat.name), children: [_jsxs("span", { children: [meta.icon, " ", cat.name] }), _jsx("span", { className: "help-sidebar-category-count", children: cat.items.length }), _jsx("span", { className: `help-sidebar-category-chevron${isExpanded ? ' open' : ''}`, children: "\u25B8" })] }), _jsx("div", { className: "help-sidebar-articles", style: { maxHeight: isExpanded ? `${cat.items.length * 34 + 4}px` : '0px' }, children: cat.items.map((article) => (_jsx("div", { className: `help-sidebar-article-link${activeArticleId === article.id ? ' active' : ''}`, onClick: () => goToArticle(article.id), tabIndex: 0, onKeyDown: (e) => {
                                            if (e.key === 'Enter')
                                                goToArticle(article.id);
                                        }, children: article.question.length > 40
                                            ? article.question.slice(0, 40) + '…'
                                            : article.question }, article.id))) })] }, cat.name));
                    }))] }), _jsx("main", { className: "help-docs-main", children: isLanding ? (_jsx(HelpLanding, { articles: articles, categories: categories, goToArticle: goToArticle, goToCategory: goToCategory })) : (_jsx(Outlet, { context: { articles, categories } })) }), _jsx("button", { className: "help-mobile-toggle", onClick: () => setSidebarOpen((prev) => !prev), children: "\u2630" })] }));
};
const HelpLanding = ({ articles, categories, goToArticle, goToCategory }) => {
    const [search, setSearch] = useState('');
    const searchResults = useMemo(() => {
        if (!search.trim())
            return [];
        const q = search.toLowerCase();
        return articles
            .filter((a) => a.question.toLowerCase().includes(q) ||
            (a.answer && a.answer.toLowerCase().includes(q)) ||
            (a.category && a.category.toLowerCase().includes(q)))
            .slice(0, 10);
    }, [search, articles]);
    // Popular = first article from each category
    const popular = useMemo(() => categories.slice(0, 8).map((c) => c.items[0]).filter(Boolean), [categories]);
    return (_jsxs("div", { className: "help-landing", children: [_jsxs("div", { className: "help-hero", children: [_jsx("h1", { children: "How can we help?" }), _jsx("p", { children: "Search our documentation or browse by category below" }), _jsxs("div", { className: "help-hero-search", children: [_jsx("span", { className: "help-hero-search-icon", children: "\uD83D\uDD0D" }), _jsx("input", { type: "text", placeholder: "Search articles\u2026", value: search, onChange: (e) => setSearch(e.target.value) })] })] }), search.trim() && (_jsx("div", { className: "help-search-results", children: searchResults.length === 0 ? (_jsxs("div", { className: "help-empty", children: [_jsx("h3", { children: "No results found" }), _jsx("p", { children: "Try different keywords or browse the categories below" })] })) : (searchResults.map((a) => (_jsxs("div", { className: "help-search-result-item", onClick: () => goToArticle(a.id), tabIndex: 0, onKeyDown: (e) => {
                        if (e.key === 'Enter')
                            goToArticle(a.id);
                    }, children: [_jsx("p", { className: "help-search-result-category", children: a.category || 'general' }), _jsx("p", { className: "help-search-result-title", children: a.question }), _jsx("p", { className: "help-search-result-snippet", children: snippet(a.answer || '', 150) })] }, a.id)))) })), !search.trim() && (_jsxs(_Fragment, { children: [_jsx("div", { className: "help-categories-grid", children: categories.map((cat) => {
                            const meta = getCategoryMeta(cat.name);
                            return (_jsxs("div", { className: "help-category-card", onClick: () => goToCategory(cat.name), tabIndex: 0, onKeyDown: (e) => {
                                    if (e.key === 'Enter')
                                        goToCategory(cat.name);
                                }, children: [_jsx("div", { className: "help-category-card-icon", style: { background: meta.color }, children: meta.icon }), _jsx("p", { className: "help-category-card-title", children: cat.name }), meta.description && (_jsx("p", { className: "help-category-card-desc", children: meta.description })), _jsxs("p", { className: "help-category-card-count", children: [cat.items.length, " article", cat.items.length !== 1 ? 's' : ''] })] }, cat.name));
                        }) }), popular.length > 0 && (_jsxs("div", { className: "help-popular-section", children: [_jsx("h2", { className: "help-section-title", children: "Popular Articles" }), _jsx("div", { className: "help-popular-list", children: popular.map((a) => (_jsxs("div", { className: "help-popular-item", onClick: () => goToArticle(a.id), tabIndex: 0, onKeyDown: (e) => {
                                        if (e.key === 'Enter')
                                            goToArticle(a.id);
                                    }, children: [_jsx("span", { className: "help-popular-item-icon", children: "\u2192" }), _jsx("span", { className: "help-popular-item-text", children: a.question })] }, a.id))) })] }))] }))] }));
};
export default HelpCenter;
