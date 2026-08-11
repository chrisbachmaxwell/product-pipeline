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
const Orders = React.lazy(() => import('./pages/Orders'));
const Reconciliation = React.lazy(() => import('./pages/Reconciliation'));
const Settings = React.lazy(() => import('./pages/Settings'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

let testModeCache: boolean | null = null;
const checkTestMode = async (): Promise<boolean> => {
  if (testModeCache !== null) return testModeCache;
  try {
    const response = await fetch('/api/test-mode');
    const data = (await response.json()) as { testMode?: boolean };
    testModeCache = data.testMode === true;
  } catch {
    testModeCache = false;
  }
  return testModeCache;
};

void checkTestMode();

const isEmbedded = (): boolean => {
  if (testModeCache) return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

const PageLoader: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
    <Spinner accessibilityLabel="Loading page" size="large" />
  </div>
);

const ShopifyNavMenu: React.FC = () => (
  <NavMenu>
    <Link to="/" rel="home">Overview</Link>
    <Link to="/listings">Listings</Link>
    <Link to="/orders">Orders</Link>
    <Link to="/reconciliation">Reconciliation</Link>
    <Link to="/settings">Settings</Link>
  </NavMenu>
);

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('REACT ERROR BOUNDARY:', error.message, error.stack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', color: 'red' }}>
          <h2>Unable to render this page</h2>
          <p>{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const AppFrame: React.FC = () => {
  const { sidebarOpen, toggleSidebar } = useAppStore();
  const embedded = isEmbedded();
  const topBar = embedded ? undefined : (
    <TopBar
      showNavigationToggle
      onNavigationToggle={toggleSidebar}
      searchField={undefined}
      searchResults={undefined}
      searchResultsVisible={false}
      onSearchResultsDismiss={() => undefined}
    />
  );

  return (
    <>
      {embedded && <ShopifyNavMenu />}
      <Frame
        navigation={embedded ? undefined : <AppNavigation />}
        topBar={topBar}
        showMobileNavigation={embedded ? false : !sidebarOpen}
        onNavigationDismiss={toggleSidebar}
      >
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/listings" element={<Listings />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/reconciliation" element={<Reconciliation />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </Frame>
    </>
  );
};

const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AppProvider i18n={enTranslations}>
        <AppFrame />
      </AppProvider>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;
