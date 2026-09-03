import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { Suspense } from 'react';
import { AppProvider, Frame, Spinner, TopBar } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { NavMenu } from '@shopify/app-bridge-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from './pages/Dashboard';
import AppNavigation from './components/AppNavigation';
import { useAppStore } from './store';
const Listings = React.lazy(() => import('./pages/Listings'));
const ListingDetail = React.lazy(() => import('./pages/ListingDetail'));
const Orders = React.lazy(() => import('./pages/Orders'));
const Issues = React.lazy(() => import('./pages/Issues'));
const Settings = React.lazy(() => import('./pages/Settings'));
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
        },
    },
});
let testModeCache = null;
const checkTestMode = async () => {
    if (testModeCache !== null)
        return testModeCache;
    try {
        const response = await fetch('/api/test-mode');
        const data = (await response.json());
        testModeCache = data.testMode === true;
    }
    catch {
        testModeCache = false;
    }
    return testModeCache;
};
void checkTestMode();
const isEmbedded = () => {
    if (testModeCache)
        return false;
    try {
        return window.self !== window.top;
    }
    catch {
        return true;
    }
};
const PageLoader = () => (_jsx("div", { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }, children: _jsx(Spinner, { accessibilityLabel: "Loading page", size: "large" }) }));
const ShopifyNavMenu = () => (_jsxs(NavMenu, { children: [_jsx(Link, { to: "/", rel: "home", children: "Overview" }), _jsx(Link, { to: "/listings", children: "Listings" }), _jsx(Link, { to: "/orders", children: "Orders" }), _jsx(Link, { to: "/issues", children: "Issues" }), _jsx(Link, { to: "/settings", children: "Settings" })] }));
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error) {
        console.error('REACT ERROR BOUNDARY:', error.message, error.stack);
    }
    render() {
        if (this.state.error) {
            return (_jsxs("div", { style: { padding: '2rem', color: 'red' }, children: [_jsx("h2", { children: "Unable to render this page" }), _jsx("p", { children: this.state.error.message })] }));
        }
        return this.props.children;
    }
}
const AppFrame = () => {
    const { sidebarOpen, toggleSidebar } = useAppStore();
    const embedded = isEmbedded();
    const topBar = embedded ? undefined : (_jsx(TopBar, { showNavigationToggle: true, onNavigationToggle: toggleSidebar, searchField: undefined, searchResults: undefined, searchResultsVisible: false, onSearchResultsDismiss: () => undefined }));
    return (_jsxs(_Fragment, { children: [embedded && _jsx(ShopifyNavMenu, {}), _jsx(Frame, { navigation: embedded ? undefined : _jsx(AppNavigation, {}), topBar: topBar, showMobileNavigation: embedded ? false : !sidebarOpen, onNavigationDismiss: toggleSidebar, children: _jsx(ErrorBoundary, { children: _jsx(Suspense, { fallback: _jsx(PageLoader, {}), children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Dashboard, {}) }), _jsx(Route, { path: "/listings", element: _jsx(Listings, {}) }), _jsx(Route, { path: "/listings/:id", element: _jsx(ListingDetail, {}) }), _jsx(Route, { path: "/orders", element: _jsx(Orders, {}) }), _jsx(Route, { path: "/issues", element: _jsx(Issues, {}) }), _jsx(Route, { path: "/reconciliation", element: _jsx(Navigate, { to: "/issues", replace: true }) }), _jsx(Route, { path: "/settings", element: _jsx(Settings, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }) }) }) })] }));
};
const App = () => (_jsx(QueryClientProvider, { client: queryClient, children: _jsx(BrowserRouter, { children: _jsx(AppProvider, { i18n: enTranslations, children: _jsx(AppFrame, {}) }) }) }));
export default App;
