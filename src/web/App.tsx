import React, { Suspense } from 'react';
import { AppProvider, Frame, TopBar, Spinner } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { BrowserRouter, Route, Routes, useLocation, Link } from 'react-router-dom';
import { NavMenu } from '@shopify/app-bridge-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Main app shell components — always in the main chunk
import Dashboard from './pages/Dashboard';
import AppNavigation from './components/AppNavigation';
import ChatWidget from './components/ChatWidget';
import PipelineToasts from './components/PipelineToasts';
import { useAppStore } from './store';

// Lazy-loaded route pages — split into separate chunks
const Listings = React.lazy(() => import('./pages/Listings'));
const ShopifyProducts = React.lazy(() => import('./pages/ShopifyProducts'));
const Orders = React.lazy(() => import('./pages/Orders'));
const Settings = React.lazy(() => import('./pages/Settings'));
const Analytics = React.lazy(() => import('./pages/Analytics'));
const Logs = React.lazy(() => import('./pages/Logs'));
const Mappings = React.lazy(() => import('./pages/Mappings'));
const ImageProcessor = React.lazy(() => import('./pages/ImageProcessor'));
const Pipeline = React.lazy(() => import('./pages/Pipeline'));
const CategoryMapping = React.lazy(() => import('./pages/CategoryMapping'));
const HelpCenter = React.lazy(() => import('./pages/HelpCenter'));
const HelpArticlePage = React.lazy(() => import('./pages/HelpArticle'));
const HelpCategoryPage = React.lazy(() => import('./pages/HelpCategory'));
const HelpAsk = React.lazy(() => import('./pages/HelpAsk'));
const HelpAdmin = React.lazy(() => import('./pages/HelpAdmin'));
const FeatureRequests = React.lazy(() => import('./pages/FeatureRequests'));
const FeatureAdmin = React.lazy(() => import('./pages/FeatureAdmin'));
const ReviewQueue = React.lazy(() => import('./pages/ReviewQueue'));
const ReviewDetail = React.lazy(() => import('./pages/ReviewDetail'));
// EbayListingPrep is the largest page — always lazy-load it
const EbayListingPrep = React.lazy(() => import('./pages/EbayListingPrep'));
const EbayOrders = React.lazy(() => import('./pages/EbayOrders'));

// Lazy wrappers that re-export named exports as default
const ListingDetail = React.lazy(() =>
  import('./pages/Listings').then((m) => ({ default: m.ListingDetail }))
);
const ShopifyProductDetail = React.lazy(() =>
  import('./pages/ShopifyProducts').then((m) => ({ default: m.ShopifyProductDetail }))
);

// Create React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000, // 30 seconds
      refetchOnWindowFocus: false,
    },
  },
});

/** Check if TEST_MODE is active (set by backend, cached on first call) */
let testModeCache: boolean | null = null;
const checkTestMode = async (): Promise<boolean> => {
  if (testModeCache !== null) return testModeCache;
  try {
    const res = await fetch('/api/test-mode');
    const data = await res.json();
    testModeCache = data.testMode === true;
  } catch {
    testModeCache = false;
  }
  return testModeCache;
};

// Eagerly check on load (result cached for sync access)
checkTestMode();

/** Detect whether the app is embedded inside Shopify Admin */
const isEmbedded = (): boolean => {
  // In TEST_MODE, never treat as embedded — skip App Bridge
  if (testModeCache) return false;
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin iframe = embedded
  }
};

/** Full-page loading fallback shown while lazy chunks download */
const PageLoader: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
    <Spinner size="large" />
  </div>
);

/**
 * Shopify App Bridge NavMenu — renders navigation items in Shopify's sidebar.
 * Only rendered when embedded in Shopify Admin.
 */
const ShopifyNavMenu: React.FC = () => (
  <NavMenu>
    <Link to="/" rel="home">Dashboard</Link>
    <Link to="/listings">Products</Link>
    <Link to="/ebay/listings">eBay Listings</Link>
    <Link to="/orders">Orders</Link>
    <Link to="/ebay-orders">eBay Orders</Link>
    <Link to="/mappings">Mappings</Link>
    <Link to="/pipeline">Pipeline</Link>
    <Link to="/review">Review Queue</Link>
    <Link to="/images">Images</Link>
    <Link to="/category-mapping">Category Mapping</Link>
    <Link to="/analytics">Analytics</Link>
    <Link to="/logs">Logs</Link>
    <Link to="/settings">Settings</Link>
    <Link to="/help">Help</Link>
    <Link to="/features">Feature Requests</Link>
  </NavMenu>
);

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  constructor(props: {children: React.ReactNode}) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('REACT ERROR BOUNDARY:', error.message, error.stack); }
  render() {
    if (this.state.error) {
      return React.createElement('div', {style: {padding: '2rem', color: 'red', fontFamily: 'monospace'}},
        React.createElement('h2', null, 'React Render Error'),
        React.createElement('pre', {style: {whiteSpace: 'pre-wrap'}}, this.state.error.message),
        React.createElement('pre', {style: {fontSize: '11px', whiteSpace: 'pre-wrap'}}, this.state.error.stack)
      );
    }
    return this.props.children;
  }
}

const AppFrame: React.FC = () => {
  const location = useLocation();
  const { sidebarOpen, toggleSidebar } = useAppStore();
  const embedded = isEmbedded();

  // When embedded in Shopify, don't render the Polaris sidebar or top bar —
  // Shopify Admin provides its own chrome via App Bridge NavMenu.
  const topBarMarkup = embedded ? undefined : (
    <TopBar
      showNavigationToggle
      onNavigationToggle={toggleSidebar}
      searchField={undefined}
      searchResults={undefined}
      searchResultsVisible={false}
      onSearchResultsDismiss={() => {}}
    />
  );

  return (
    <>
      {embedded && <ShopifyNavMenu />}
      <Frame
        navigation={embedded ? undefined : <AppNavigation />}
        topBar={topBarMarkup}
        showMobileNavigation={embedded ? false : !sidebarOpen}
        onNavigationDismiss={toggleSidebar}
      >
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/listings" element={<ShopifyProducts />} />
              <Route path="/listings/:id" element={<ShopifyProductDetail />} />
              <Route path="/ebay/listings" element={<Listings />} />
              <Route path="/ebay/listings/:id" element={<ListingDetail />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/ebay-orders" element={<EbayOrders />} />
              <Route path="/mappings" element={<Mappings />} />
              <Route path="/pipeline" element={<Pipeline />} />
              <Route path="/review" element={<ReviewQueue />} />
              <Route path="/review/:id" element={<ReviewDetail />} />
              <Route path="/review/:id/ebay-prep" element={<EbayListingPrep />} />
              <Route path="/images" element={<ImageProcessor />} />
              <Route path="/category-mapping" element={<CategoryMapping />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/help" element={<HelpCenter />}>
                <Route path="article/:id" element={<HelpArticlePage />} />
                <Route path="category/:category" element={<HelpCategoryPage />} />
                <Route path="ask" element={<HelpAsk />} />
              </Route>
              <Route path="/help/admin" element={<HelpAdmin />} />
              <Route path="/features" element={<FeatureRequests />} />
              <Route path="/features/admin" element={<FeatureAdmin />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>

        <ChatWidget />
        <PipelineToasts />
      </Frame>
    </>
  );
};

const App: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppProvider i18n={enTranslations}>
          <AppFrame />
        </AppProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
};

export default App;
