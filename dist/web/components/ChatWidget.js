import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCircle, Send, X, Bot, User, Zap, Clock, Navigation, ChevronDown, ChevronUp, Copy, Check, Maximize2, Minimize2, Trash2, Sparkles, Command, } from 'lucide-react';
import { useAppStore } from '../store';
// ─── Command patterns (fast path) ───────────────────────────────
const commandPatterns = [
    { pattern: /sync\s+(all\s+)?products?/i, action: 'sync_products', method: 'POST', endpoint: '/api/sync/products' },
    { pattern: /sync\s+orders?\s+since\s+(\d{4}-\d{2}-\d{2})/i, action: 'sync_orders_dated', method: 'POST', endpoint: '/api/sync/trigger', dataFn: (m) => ({ type: 'orders', startDate: m[1] }) },
    { pattern: /sync\s+orders?/i, action: 'sync_orders', method: 'POST', endpoint: '/api/sync/trigger', dataFn: () => {
            const since = new Date();
            since.setDate(since.getDate() - 7);
            return { type: 'orders', startDate: since.toISOString().slice(0, 10) };
        } },
    { pattern: /sync\s+inventory/i, action: 'sync_inventory', method: 'POST', endpoint: '/api/sync/inventory' },
    { pattern: /republish\s+stale\s+listings?/i, action: 'republish_stale', method: 'POST', endpoint: '/api/listings/republish-stale' },
    { pattern: /apply\s+price\s+drops?/i, action: 'apply_price_drops', method: 'POST', endpoint: '/api/listings/apply-price-drops' },
    { pattern: /show\s+stale\s+listings?/i, action: 'show_stale_listings', method: 'GET', endpoint: '/api/listings/stale' },
    { pattern: /show\s+listing\s+health/i, action: 'show_listing_health', method: 'GET', endpoint: '/api/listings/health' },
    { pattern: /show\s+status|check\s+status|^status$/i, action: 'show_status', method: 'GET', endpoint: '/api/status' },
    { pattern: /check\s+inventory/i, action: 'check_inventory', method: 'GET', endpoint: '/api/sync/inventory' },
    { pattern: /show\s+settings/i, action: 'show_settings', method: 'GET', endpoint: '/api/settings' },
    { pattern: /cleanup\s+duplicate\s+orders?/i, action: 'cleanup_orders', method: 'POST', endpoint: '/api/orders/cleanup' },
];
// ─── Suggestions ─────────────────────────────────────────────────
const suggestions = [
    'sync all products', 'sync orders', 'check inventory', 'show status',
    'show stale listings', 'show listing health', 'apply price drops',
    'republish stale listings', 'cleanup duplicate orders', 'show settings',
    'add more white space', 'remove the shadow', 'make background gray',
    'tighter crop', 'reprocess all photos', 'list templates', 'save settings as template',
    'show me products that haven\'t sold in 30 days',
    'how many orders this week', 'what\'s the revenue today',
];
const defaultQuickActions = [
    { label: '📊 Show status', message: 'show status', isNew: false },
    { label: '📦 List products', message: 'list products', isNew: false },
    { label: '🔄 Sync all products', message: 'sync all products', isNew: false },
    { label: '📋 Show orders', message: 'show orders', isNew: false },
    { label: '⚙️ Check mappings', message: 'show mappings', isNew: false },
    { label: '🏥 Listing health check', message: 'show listing health', isNew: false },
];
const categoryEmoji = {
    shopify: '🛍️', ebay: '📦', pipeline: '🔄', images: '🖼️', analytics: '📊', settings: '⚙️',
};
const pageQuickActions = {
    '/': [
        { label: '📊 Full status check', message: 'show status' },
        { label: '🏥 Listing health', message: 'show listing health' },
    ],
    '/listings': [
        { label: '🔄 Sync all', message: 'sync all products' },
        { label: '📋 Show stale listings', message: 'show stale listings' },
        { label: '💰 Apply price drops', message: 'apply price drops' },
    ],
    '/orders': [
        { label: '🔄 Sync recent orders', message: 'sync orders' },
        { label: '📋 Show orders', message: 'show orders' },
    ],
    '/listings/:id': [
        { label: '🖼️ Reprocess all photos', message: 'reprocess all photos' },
        { label: '📋 List templates', message: 'list templates' },
        { label: '⬜ More white space', message: 'add more white space' },
        { label: '🚫 Remove shadow', message: 'remove the shadow' },
    ],
    '/mappings': [
        { label: '⚙️ Show current mappings', message: 'show mappings' },
        { label: '🔧 Check mappings', message: 'check mappings' },
    ],
};
// ─── Persistence helpers ─────────────────────────────────────────
const STORAGE_KEY = 'pp-chat-history';
const MAX_STORED = 50;
function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return [];
        const items = JSON.parse(raw);
        return items.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
    }
    catch {
        return [];
    }
}
function saveHistory(messages) {
    try {
        const toStore = messages
            .filter(m => !m.isStreaming)
            .slice(-MAX_STORED)
            .map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp.toISOString() }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    }
    catch { /* quota exceeded, ignore */ }
}
// ─── Usage tracking ──────────────────────────────────────────────
const USAGE_KEY = 'pp-chat-usage';
function trackUsage(command) {
    try {
        const raw = localStorage.getItem(USAGE_KEY);
        const usage = raw ? JSON.parse(raw) : {};
        usage[command] = (usage[command] || 0) + 1;
        localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
    }
    catch { /* ignore */ }
}
function getTopCommands(n = 3) {
    try {
        const raw = localStorage.getItem(USAGE_KEY);
        if (!raw)
            return [];
        const usage = JSON.parse(raw);
        return Object.entries(usage)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([cmd]) => cmd);
    }
    catch {
        return [];
    }
}
// ─── Copy button component ──────────────────────────────────────
const CopyButton = ({ text }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };
    return (_jsxs("button", { onClick: handleCopy, className: "chat-copy-btn", title: "Copy to clipboard", children: [copied ? _jsx(Check, { size: 12 }) : _jsx(Copy, { size: 12 }), copied ? 'Copied' : 'Copy'] }));
};
// ─── Collapsible section ─────────────────────────────────────────
const Collapsible = ({ title, children, defaultOpen = false, }) => {
    const [open, setOpen] = useState(defaultOpen);
    return (_jsxs("div", { className: "chat-collapsible", children: [_jsxs("button", { className: "chat-collapsible-header", onClick: () => setOpen(!open), children: [open ? _jsx(ChevronUp, { size: 14 }) : _jsx(ChevronDown, { size: 14 }), _jsx("span", { children: title })] }), open && _jsx("div", { className: "chat-collapsible-body", children: children })] }));
};
// ─── Markdown message renderer ───────────────────────────────────
const MarkdownMessage = ({ content }) => {
    // Detect large data blocks for collapsible treatment
    const lines = content.split('\n');
    const isLargeData = lines.length > 20;
    const rendered = (_jsx(ReactMarkdown, { remarkPlugins: [remarkGfm], components: {
            // Custom code block with copy button
            code({ children, className, ...props }) {
                const isBlock = className?.startsWith('language-');
                const text = String(children).replace(/\n$/, '');
                if (isBlock) {
                    return (_jsxs("div", { className: "chat-code-block", children: [_jsxs("div", { className: "chat-code-header", children: [_jsx("span", { children: className?.replace('language-', '') || 'code' }), _jsx(CopyButton, { text: text })] }), _jsx("pre", { children: _jsx("code", { className: className, ...props, children: children }) })] }));
                }
                return _jsx("code", { className: "chat-inline-code", ...props, children: children });
            },
            // Tables get horizontal scroll
            table({ children, ...props }) {
                return (_jsx("div", { className: "chat-table-wrapper", children: _jsx("table", { ...props, children: children }) }));
            },
            // Links open in new tab
            a({ children, href, ...props }) {
                return _jsx("a", { href: href, target: "_blank", rel: "noopener noreferrer", ...props, children: children });
            },
        }, children: content }));
    if (isLargeData) {
        return (_jsx(Collapsible, { title: `Results (${lines.length} lines)`, defaultOpen: true, children: rendered }));
    }
    return rendered;
};
// ─── Main ChatWidget ─────────────────────────────────────────────
const ChatWidget = () => {
    const { chatOpen, toggleChat } = useAppStore();
    const location = useLocation();
    const navigate = useNavigate();
    const [messages, setMessages] = useState(() => loadHistory());
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [filteredSuggestions, setFilteredSuggestions] = useState([]);
    const [navToast, setNavToast] = useState(null);
    const [welcomeQuickActions, setWelcomeQuickActions] = useState(defaultQuickActions);
    const [isExpanded, setIsExpanded] = useState(false);
    const [panelSize, setPanelSize] = useState({ width: 420, height: 600 });
    const [isResizing, setIsResizing] = useState(false);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const panelRef = useRef(null);
    const abortRef = useRef(null);
    // Persist messages
    useEffect(() => { saveHistory(messages); }, [messages]);
    // Fetch capabilities
    useEffect(() => {
        let cancelled = false;
        fetch('/api/capabilities')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
            if (cancelled || !data?.capabilities)
                return;
            const caps = data.capabilities;
            const pills = caps
                .filter(c => c.examplePrompts.length > 0)
                .slice(0, 8)
                .map(c => ({
                label: `${categoryEmoji[c.category] || '🔹'} ${c.name}`,
                message: c.examplePrompts[0],
                isNew: !!c.isNew,
            }));
            if (pills.length > 0)
                setWelcomeQuickActions(pills);
        })
            .catch(() => { });
        return () => { cancelled = true; };
    }, []);
    // Scroll to bottom
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, []);
    useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);
    // Focus input when opened
    useEffect(() => {
        if (chatOpen && inputRef.current) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [chatOpen]);
    // Cmd+K global shortcut
    useEffect(() => {
        const handler = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                toggleChat();
            }
            // Escape to close
            if (e.key === 'Escape' && chatOpen) {
                toggleChat();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [chatOpen, toggleChat]);
    // Nav toast auto-dismiss
    useEffect(() => {
        if (navToast) {
            const timer = setTimeout(() => setNavToast(null), 2500);
            return () => clearTimeout(timer);
        }
    }, [navToast]);
    // Resize handling
    const handleResizeStart = useCallback((e) => {
        e.preventDefault();
        setIsResizing(true);
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = panelSize.width;
        const startH = panelSize.height;
        const onMove = (ev) => {
            setPanelSize({
                width: Math.max(340, Math.min(800, startW - (ev.clientX - startX))),
                height: Math.max(400, Math.min(900, startH - (ev.clientY - startY))),
            });
        };
        const onUp = () => {
            setIsResizing(false);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [panelSize]);
    // Page-specific actions
    const currentPageActions = useMemo(() => {
        const exact = pageQuickActions[location.pathname];
        if (exact)
            return exact;
        if (/^\/listings\/\d+/.test(location.pathname))
            return pageQuickActions['/listings/:id'] || [];
        return pageQuickActions['/'] || [];
    }, [location.pathname]);
    // Parse fast-path commands
    const parseCommand = (message) => {
        for (const p of commandPatterns) {
            const match = p.pattern.exec(message);
            if (match)
                return { ...p, match };
        }
        return null;
    };
    const executeApiCall = async (endpoint, method, data) => {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (data && method !== 'GET')
            opts.body = JSON.stringify(data);
        const r = await fetch(endpoint, opts);
        if (!r.ok)
            throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
    };
    const formatApiResponse = (action, data, error) => {
        if (error)
            return `❌ **Error**: ${error}`;
        const d = data;
        switch (action) {
            case 'sync_products': return '✅ **Product sync started!**\nCheck the dashboard for real-time progress.';
            case 'sync_orders':
            case 'sync_orders_dated': return '✅ **Order sync triggered!**\nSyncing orders from eBay to Shopify.';
            case 'sync_inventory': return '✅ **Inventory sync completed!**\nStock levels updated.';
            case 'show_status':
                if (d?.status) {
                    const { products, orders, shopifyConnected, ebayConnected, revenue } = d;
                    return `## 📊 System Status\n\n| Platform | Status |\n|----------|--------|\n| Shopify | ${shopifyConnected ? '✅ Connected' : '❌ Disconnected'} |\n| eBay | ${ebayConnected ? '✅ Connected' : '❌ Disconnected'} |\n\n- **Products:** ${products?.mapped || 0} mapped, ${products?.pending || 0} pending\n- **Orders:** ${orders?.imported || 0} imported today\n- **Revenue:** $${revenue?.today?.toFixed(2) || '0.00'} today`;
                }
                return '✅ **Status check complete**';
            case 'show_stale_listings':
                if (d?.data && Array.isArray(d.data)) {
                    const n = d.data.length;
                    if (n === 0)
                        return '🎉 **No stale listings!** Everything is up to date.';
                    let text = `## 📋 Stale Listings (${n})\n\n`;
                    text += d.data.slice(0, 10).map((item) => `- **${item.title}** — Last updated: ${new Date(item.lastSynced).toLocaleDateString()}`).join('\n');
                    if (n > 10)
                        text += `\n\n...and ${n - 10} more`;
                    return text;
                }
                return '✅ **Stale listings check complete**';
            default:
                return `✅ **Done!**\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
        }
    };
    const handleNavigate = (path) => {
        const names = {
            '/': 'Dashboard', '/listings': 'Products', '/orders': 'Orders',
            '/mappings': 'Mappings', '/logs': 'Analytics', '/settings': 'Settings', '/images': 'Image Processor',
        };
        setNavToast(`Navigating to ${names[path] || path}...`);
        navigate(path);
    };
    // ─── Send message ──────────────────────────────────────────────
    const sendMessage = async (messageText) => {
        const text = messageText.trim();
        if (!text)
            return;
        trackUsage(text);
        const userMsg = { role: 'user', content: text, timestamp: new Date() };
        setMessages(prev => [...prev, userMsg]);
        setInputValue('');
        setShowSuggestions(false);
        setIsLoading(true);
        const command = parseCommand(text);
        try {
            if (command) {
                // Fast path — direct API call
                const cmdData = 'dataFn' in command && command.dataFn ? command.dataFn(command.match) : undefined;
                const result = await executeApiCall(command.endpoint, command.method, cmdData);
                const response = formatApiResponse(command.action, result);
                setMessages(prev => [...prev, { role: 'assistant', content: response, timestamp: new Date() }]);
            }
            else {
                // Stream from AI
                await streamFromAI(text);
            }
        }
        catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `❌ **Error:** ${errMsg}`,
                    timestamp: new Date(),
                }]);
        }
        finally {
            setIsLoading(false);
        }
    };
    const streamFromAI = async (text) => {
        abortRef.current = new AbortController();
        // Build history for context
        const history = messages
            .filter(m => !m.isStreaming)
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));
        const streamingMsg = {
            role: 'assistant', content: '', timestamp: new Date(), isStreaming: true,
        };
        setMessages(prev => [...prev, streamingMsg]);
        try {
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, currentPage: location.pathname, history }),
                signal: abortRef.current.signal,
            });
            if (!response.ok) {
                // Fallback to non-streaming
                const fallback = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text, currentPage: location.pathname }),
                });
                if (fallback.ok) {
                    const data = await fallback.json();
                    setMessages(prev => {
                        const updated = [...prev];
                        updated[updated.length - 1] = {
                            role: 'assistant', content: data.response || 'No response',
                            timestamp: new Date(), actions: data.actions,
                        };
                        return updated;
                    });
                    if (data.navigate)
                        handleNavigate(data.navigate);
                }
                else {
                    throw new Error(`HTTP ${fallback.status}`);
                }
                return;
            }
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error('No response body');
            const decoder = new TextDecoder();
            let buffer = '';
            let fullContent = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        const event = line.slice(7).trim();
                        // Next data line
                        continue;
                    }
                    if (!line.startsWith('data: '))
                        continue;
                    const raw = line.slice(6).trim();
                    if (!raw)
                        continue;
                    try {
                        const data = JSON.parse(raw);
                        // Determine event type from previous event line or data shape
                        if (data.text && !data.response) {
                            // chunk
                            fullContent += data.text;
                            setMessages(prev => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.isStreaming) {
                                    updated[updated.length - 1] = { ...last, content: fullContent };
                                }
                                return updated;
                            });
                        }
                        else if (data.response !== undefined) {
                            // done
                            setMessages(prev => {
                                const updated = [...prev];
                                updated[updated.length - 1] = {
                                    role: 'assistant',
                                    content: data.response || fullContent,
                                    timestamp: new Date(),
                                    actions: data.actions,
                                };
                                return updated;
                            });
                            if (data.navigate)
                                handleNavigate(data.navigate);
                        }
                        else if (data.error) {
                            setMessages(prev => {
                                const updated = [...prev];
                                updated[updated.length - 1] = {
                                    role: 'assistant',
                                    content: `❌ **Error:** ${data.error}`,
                                    timestamp: new Date(),
                                };
                                return updated;
                            });
                        }
                    }
                    catch { /* skip */ }
                }
            }
            // If streaming ended without a "done" event, finalize
            setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.isStreaming) {
                    updated[updated.length - 1] = { ...last, isStreaming: false };
                }
                return updated;
            });
        }
        catch (err) {
            if (err.name === 'AbortError')
                return;
            throw err;
        }
    };
    // ─── Input handling ────────────────────────────────────────────
    const handleInputChange = (e) => {
        const value = e.target.value;
        setInputValue(value);
        if (value.trim().length > 1) {
            const lower = value.toLowerCase();
            const filtered = suggestions.filter(s => s.toLowerCase().includes(lower));
            // Also include top used commands
            const top = getTopCommands().filter(c => c.toLowerCase().includes(lower) && !filtered.includes(c));
            setFilteredSuggestions([...top, ...filtered].slice(0, 6));
            setShowSuggestions(filtered.length > 0 || top.length > 0);
        }
        else {
            setShowSuggestions(false);
        }
        // Auto-resize textarea
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
        }
    };
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(inputValue);
        }
        if (e.key === 'Escape')
            setShowSuggestions(false);
    };
    const clearHistory = () => {
        setMessages([]);
        localStorage.removeItem(STORAGE_KEY);
    };
    const showWelcome = messages.length === 0;
    const effectiveWidth = isExpanded ? Math.min(800, window.innerWidth - 40) : panelSize.width;
    const effectiveHeight = isExpanded ? Math.min(900, window.innerHeight - 100) : panelSize.height;
    // ─── Render ────────────────────────────────────────────────────
    return (_jsxs(_Fragment, { children: [_jsx("style", { children: chatStyles }), _jsxs("div", { className: "chat-widget", children: [_jsxs("div", { ref: panelRef, className: `chat-panel ${chatOpen ? 'chat-panel-open' : 'chat-panel-closed'}`, style: { width: effectiveWidth, height: effectiveHeight }, children: [!isExpanded && (_jsx("div", { className: "chat-resize-handle", onMouseDown: handleResizeStart })), _jsxs("div", { className: "chat-header", children: [_jsxs("div", { className: "chat-header-left", children: [_jsx(Bot, { size: 20 }), _jsx("span", { className: "chat-header-title", children: "ProductPipeline AI" }), _jsx(Sparkles, { size: 14, className: "chat-sparkle" })] }), _jsxs("div", { className: "chat-header-actions", children: [_jsx("button", { onClick: clearHistory, className: "chat-header-btn", title: "Clear history", children: _jsx(Trash2, { size: 14 }) }), _jsx("button", { onClick: () => setIsExpanded(!isExpanded), className: "chat-header-btn", title: isExpanded ? 'Minimize' : 'Maximize', children: isExpanded ? _jsx(Minimize2, { size: 14 }) : _jsx(Maximize2, { size: 14 }) }), _jsx("button", { onClick: toggleChat, className: "chat-header-btn", title: "Close (Esc)", children: _jsx(X, { size: 16 }) })] })] }), navToast && (_jsxs("div", { className: "chat-nav-toast", children: [_jsx(Navigation, { size: 14 }), navToast] })), _jsxs("div", { className: "chat-messages", children: [showWelcome && (_jsxs("div", { className: "chat-welcome", children: [_jsx("div", { className: "chat-welcome-icon", children: _jsx(Bot, { size: 32 }) }), _jsx("h3", { children: "Hey! I'm your AI assistant." }), _jsx("p", { children: "Ask me anything about your products, orders, listings, or sync operations. I can also execute actions for you." }), _jsxs("div", { className: "chat-shortcut-hint", children: [_jsx(Command, { size: 12 }), " ", _jsx("span", { children: "+" }), " ", _jsx("kbd", { children: "K" }), " to toggle"] }), _jsx("div", { className: "chat-welcome-pills", children: welcomeQuickActions.map(qa => (_jsxs("button", { onClick: () => sendMessage(qa.message), className: "chat-pill", children: [qa.label, qa.isNew && _jsx("span", { className: "chat-new-badge", children: "\u2728 New" })] }, qa.message))) })] })), messages.map((msg, i) => (_jsxs("div", { className: `chat-msg chat-msg-${msg.role}`, children: [msg.role === 'assistant' && (_jsx("div", { className: "chat-avatar chat-avatar-bot", children: _jsx(Bot, { size: 14 }) })), _jsxs("div", { className: `chat-bubble chat-bubble-${msg.role}`, children: [msg.role === 'assistant' ? (_jsxs("div", { className: "chat-markdown", children: [_jsx(MarkdownMessage, { content: msg.content }), msg.content && !msg.isStreaming && (_jsx(CopyButton, { text: msg.content }))] })) : (_jsx("div", { className: "chat-user-text", children: msg.content })), msg.actions && msg.actions.length > 0 && (_jsx("div", { className: "chat-actions", children: msg.actions.map((a, j) => (_jsxs("span", { className: `chat-action-badge chat-action-${a.type}`, children: [a.type === 'success' ? '✅' : a.type === 'error' ? '❌' : '🔧', " ", a.detail] }, j))) })), _jsxs("div", { className: "chat-timestamp", children: [_jsx(Clock, { size: 10 }), msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })] })] }), msg.role === 'user' && (_jsx("div", { className: "chat-avatar chat-avatar-user", children: _jsx(User, { size: 14 }) }))] }, i))), isLoading && messages[messages.length - 1]?.role !== 'assistant' && (_jsxs("div", { className: "chat-msg chat-msg-assistant", children: [_jsx("div", { className: "chat-avatar chat-avatar-bot", children: _jsx(Bot, { size: 14 }) }), _jsx("div", { className: "chat-bubble chat-bubble-assistant", children: _jsxs("div", { className: "chat-typing", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {})] }) })] })), _jsx("div", { ref: messagesEndRef })] }), _jsxs("div", { className: "chat-input-area", children: [currentPageActions.length > 0 && !isLoading && messages.length > 0 && (_jsx("div", { className: "chat-chips", children: currentPageActions.map(qa => (_jsx("button", { onClick: () => sendMessage(qa.message), className: "chat-chip", children: qa.label }, qa.message))) })), showSuggestions && (_jsx("div", { className: "chat-suggestions", children: filteredSuggestions.map((s, i) => (_jsxs("button", { onClick: () => { setInputValue(s); setShowSuggestions(false); }, className: "chat-suggestion-item", children: [_jsx(Zap, { size: 12 }), " ", s] }, i))) })), _jsxs("div", { className: "chat-input-row", children: [_jsx("textarea", { ref: inputRef, value: inputValue, onChange: handleInputChange, onKeyDown: handleKeyDown, placeholder: "Ask anything... (\u2318K to toggle)", className: "chat-input", rows: 1 }), _jsx("button", { onClick: () => sendMessage(inputValue), disabled: !inputValue.trim() || isLoading, className: "chat-send-btn", children: _jsx(Send, { size: 16 }) })] })] })] }), _jsxs("button", { onClick: toggleChat, className: `chat-bubble-btn ${chatOpen ? 'chat-bubble-active' : ''}`, children: [chatOpen ? _jsx(X, { size: 24 }) : _jsx(MessageCircle, { size: 24 }), !chatOpen && _jsx("div", { className: "chat-bubble-dot" })] })] })] }));
};
// ─── Styles ──────────────────────────────────────────────────────
const chatStyles = `
/* Reset & Container */
.chat-widget { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

/* Floating Bubble */
.chat-bubble-btn {
  position: fixed; bottom: 20px; right: 20px;
  width: 60px; height: 60px; border-radius: 50%;
  background: linear-gradient(135deg, #00b341, #009933);
  color: white; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 20px rgba(0,179,65,0.4);
  z-index: 10000; transition: all 0.3s ease;
}
.chat-bubble-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,179,65,0.5); }
.chat-bubble-active { background: #333; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.chat-bubble-dot {
  position: absolute; top: -2px; right: -2px;
  width: 14px; height: 14px; background: #ff4757;
  border-radius: 50%; border: 2px solid white;
  animation: pulse 2s infinite;
}

/* Panel */
.chat-panel {
  position: fixed; bottom: 90px; right: 20px;
  background: #1a1a2e; border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  transition: transform 0.3s ease, opacity 0.3s ease;
  overflow: hidden; border: 1px solid #2a2a4a;
}
.chat-panel-open { transform: scale(1) translateY(0); opacity: 1; pointer-events: auto; }
.chat-panel-closed { transform: scale(0.85) translateY(20px); opacity: 0; pointer-events: none; }

/* Resize handle */
.chat-resize-handle {
  position: absolute; top: 0; left: 0;
  width: 20px; height: 20px; cursor: nw-resize;
  z-index: 10;
}
.chat-resize-handle::before {
  content: ''; position: absolute; top: 4px; left: 4px;
  width: 8px; height: 8px;
  border-top: 2px solid #555; border-left: 2px solid #555;
  opacity: 0; transition: opacity 0.2s;
}
.chat-panel:hover .chat-resize-handle::before { opacity: 1; }

/* Header */
.chat-header {
  padding: 14px 16px; background: linear-gradient(135deg, #00b341, #009933);
  color: white; display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.chat-header-left { display: flex; align-items: center; gap: 8px; }
.chat-header-title { font-weight: 700; font-size: 15px; }
.chat-sparkle { animation: sparkle 2s ease-in-out infinite; }
.chat-header-actions { display: flex; gap: 4px; }
.chat-header-btn {
  background: rgba(255,255,255,0.15); border: none; color: white;
  cursor: pointer; padding: 6px; border-radius: 6px;
  transition: background 0.2s;
}
.chat-header-btn:hover { background: rgba(255,255,255,0.3); }

/* Nav toast */
.chat-nav-toast {
  position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  background: #0066cc; color: white; padding: 8px 16px;
  border-radius: 8px; font-size: 13px; display: flex; align-items: center; gap: 6px;
  z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  animation: fadeInOut 2.5s ease forwards;
}

/* Messages */
.chat-messages {
  flex: 1; padding: 16px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px;
  scrollbar-width: thin; scrollbar-color: #333 transparent;
}
.chat-messages::-webkit-scrollbar { width: 6px; }
.chat-messages::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

/* Welcome */
.chat-welcome {
  display: flex; flex-direction: column; align-items: center;
  text-align: center; padding: 20px 10px; gap: 12px;
}
.chat-welcome-icon {
  width: 64px; height: 64px; border-radius: 50%;
  background: linear-gradient(135deg, #00b341, #009933);
  display: flex; align-items: center; justify-content: center; color: white;
}
.chat-welcome h3 { color: #eee; margin: 0; font-size: 18px; }
.chat-welcome p { color: #888; margin: 0; font-size: 13px; line-height: 1.5; max-width: 300px; }
.chat-shortcut-hint {
  display: flex; align-items: center; gap: 4px;
  color: #666; font-size: 12px;
}
.chat-shortcut-hint kbd {
  background: #333; padding: 2px 6px; border-radius: 4px;
  font-size: 11px; color: #aaa; border: 1px solid #444;
}
.chat-welcome-pills {
  display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px;
}

/* Pills & Chips */
.chat-pill {
  padding: 8px 14px; background: #2a2a4a; color: #ccc;
  border: 1px solid #3a3a5a; border-radius: 20px;
  cursor: pointer; font-size: 13px; white-space: nowrap;
  transition: all 0.2s;
}
.chat-pill:hover { background: #00b341; border-color: #00b341; color: white; }
.chat-new-badge {
  margin-left: 6px; font-size: 10px; background: #ff6b00;
  color: white; padding: 1px 6px; border-radius: 8px; font-weight: 600;
}

.chat-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chat-chip {
  padding: 4px 10px; background: transparent; color: #888;
  border: 1px solid #3a3a5a; border-radius: 14px;
  cursor: pointer; font-size: 12px; white-space: nowrap;
  transition: all 0.15s;
}
.chat-chip:hover { background: #2a2a4a; color: white; border-color: #4a4a6a; }

/* Messages */
.chat-msg { display: flex; align-items: flex-start; gap: 8px; }
.chat-msg-user { justify-content: flex-end; }
.chat-msg-assistant { justify-content: flex-start; }

.chat-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-top: 2px; color: white;
}
.chat-avatar-bot { background: #00b341; }
.chat-avatar-user { background: #0066cc; }

.chat-bubble {
  max-width: 85%; padding: 10px 14px;
  font-size: 14px; line-height: 1.5;
  word-break: break-word; position: relative;
}
.chat-bubble-user {
  background: linear-gradient(135deg, #0066cc, #0055aa);
  color: white; border-radius: 16px 16px 4px 16px;
}
.chat-bubble-assistant {
  background: #2a2a4a; color: #e0e0e0;
  border-radius: 16px 16px 16px 4px;
  border: 1px solid #3a3a5a;
}
.chat-user-text { white-space: pre-wrap; }

/* Markdown rendering */
.chat-markdown { position: relative; }
.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
  color: #fff; margin: 8px 0 4px; font-size: 15px;
}
.chat-markdown h2 { font-size: 14px; }
.chat-markdown h3 { font-size: 13px; }
.chat-markdown p { margin: 4px 0; }
.chat-markdown ul, .chat-markdown ol { margin: 4px 0; padding-left: 20px; }
.chat-markdown li { margin: 2px 0; }
.chat-markdown strong { color: #fff; }
.chat-markdown a { color: #4da6ff; text-decoration: none; }
.chat-markdown a:hover { text-decoration: underline; }

/* Code */
.chat-inline-code {
  background: #1a1a2e; padding: 2px 6px; border-radius: 4px;
  font-family: 'SF Mono', Monaco, monospace; font-size: 12px;
  color: #f0c674;
}
.chat-code-block {
  margin: 8px 0; border-radius: 8px; overflow: hidden;
  border: 1px solid #3a3a5a;
}
.chat-code-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 12px; background: #1a1a2e;
  font-size: 11px; color: #888; text-transform: uppercase;
}
.chat-code-block pre {
  margin: 0; padding: 12px; background: #0d0d1a;
  overflow-x: auto; font-size: 12px;
}
.chat-code-block code { color: #e0e0e0; font-family: 'SF Mono', Monaco, monospace; }

/* Tables */
.chat-table-wrapper { overflow-x: auto; margin: 8px 0; }
.chat-markdown table {
  border-collapse: collapse; width: 100%; font-size: 12px;
}
.chat-markdown th, .chat-markdown td {
  padding: 6px 10px; border: 1px solid #3a3a5a; text-align: left;
}
.chat-markdown th { background: #1a1a2e; color: #aaa; font-weight: 600; }

/* Copy button */
.chat-copy-btn {
  display: inline-flex; align-items: center; gap: 4px;
  background: transparent; border: 1px solid #3a3a5a;
  color: #888; cursor: pointer; font-size: 11px;
  padding: 3px 8px; border-radius: 4px;
  transition: all 0.2s; margin-top: 4px;
}
.chat-copy-btn:hover { background: #3a3a5a; color: #ddd; }

/* Collapsible */
.chat-collapsible { margin: 8px 0; border: 1px solid #3a3a5a; border-radius: 8px; overflow: hidden; }
.chat-collapsible-header {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; background: #1a1a2e; border: none;
  color: #aaa; cursor: pointer; font-size: 12px; width: 100%;
  text-align: left; transition: background 0.2s;
}
.chat-collapsible-header:hover { background: #2a2a4a; }
.chat-collapsible-body { padding: 8px 12px; }

/* Actions badges */
.chat-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.chat-action-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  background: #1a1a2e; border: 1px solid #3a3a5a;
}

/* Timestamp */
.chat-timestamp {
  font-size: 11px; opacity: 0.5; margin-top: 6px;
  display: flex; align-items: center; gap: 4px;
}

/* Typing indicator */
.chat-typing { display: flex; gap: 4px; padding: 4px 0; }
.chat-typing span {
  width: 8px; height: 8px; background: #666; border-radius: 50%;
  animation: typing 1.4s ease-in-out infinite;
}
.chat-typing span:nth-child(2) { animation-delay: 0.2s; }
.chat-typing span:nth-child(3) { animation-delay: 0.4s; }

/* Input area */
.chat-input-area {
  padding: 10px 14px 14px; border-top: 1px solid #2a2a4a;
  background: #1a1a2e; flex-shrink: 0;
}
.chat-input-row { display: flex; gap: 8px; align-items: flex-end; }
.chat-input {
  flex: 1; padding: 10px 12px; background: #2a2a4a; color: white;
  border: 1px solid #3a3a5a; border-radius: 12px;
  font-size: 14px; outline: none; resize: none;
  font-family: inherit; line-height: 1.4;
  max-height: 120px; min-height: 40px;
  transition: border-color 0.2s;
}
.chat-input:focus { border-color: #00b341; }
.chat-input::placeholder { color: #666; }
.chat-send-btn {
  padding: 10px 12px; background: #00b341; color: white;
  border: none; border-radius: 12px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  min-width: 44px; min-height: 40px;
  transition: all 0.2s;
}
.chat-send-btn:hover:not(:disabled) { background: #00cc4a; }
.chat-send-btn:disabled { opacity: 0.4; cursor: default; }

/* Suggestions dropdown */
.chat-suggestions {
  position: absolute; bottom: 100%; left: 0; right: 0;
  background: #2a2a4a; border-radius: 12px 12px 0 0;
  border: 1px solid #3a3a5a; border-bottom: none;
  max-height: 240px; overflow-y: auto; z-index: 10;
}
.chat-suggestion-item {
  width: 100%; padding: 10px 14px; background: transparent;
  color: #ccc; border: none; text-align: left; cursor: pointer;
  font-size: 13px; display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid #3a3a5a;
  transition: background 0.15s;
}
.chat-suggestion-item:last-child { border-bottom: none; }
.chat-suggestion-item:hover { background: #3a3a5a; color: white; }

/* Animations */
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.15); }
}
@keyframes typing {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-4px); }
}
@keyframes sparkle {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
@keyframes fadeInOut {
  0% { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  15%, 85% { opacity: 1; transform: translateX(-50%) translateY(0); }
  100% { opacity: 0; transform: translateX(-50%) translateY(-8px); }
}

/* Mobile responsive */
@media (max-width: 640px) {
  .chat-panel {
    bottom: 0 !important; right: 0 !important; left: 0 !important;
    width: 100% !important; height: 100vh !important;
    border-radius: 0 !important;
  }
  .chat-bubble-btn { bottom: 12px; right: 12px; }
  .chat-resize-handle { display: none; }
}
`;
export default ChatWidget;
