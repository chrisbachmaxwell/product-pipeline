import React from 'react';
import { Navigation } from '@shopify/polaris';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ClipboardChecklistIcon,
  HomeIcon,
  OrderIcon,
  SettingsIcon,
  ViewIcon,
} from '@shopify/polaris-icons';

const AppNavigation: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const items = [
    { label: 'Overview', icon: HomeIcon, path: '/' },
    { label: 'Listings', icon: ViewIcon, path: '/listings' },
    { label: 'Orders', icon: OrderIcon, path: '/orders' },
    { label: 'Reconciliation', icon: ClipboardChecklistIcon, path: '/reconciliation' },
    { label: 'Settings', icon: SettingsIcon, path: '/settings' },
  ];

  return (
    <Navigation location={location.pathname}>
      <Navigation.Section
        items={items.map((item) => ({
          label: item.label,
          icon: item.icon,
          selected: selected(item.path),
          onClick: () => navigate(item.path),
          url: item.path,
        }))}
      />
    </Navigation>
  );
};

export default AppNavigation;
