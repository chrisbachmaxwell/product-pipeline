import { jsx as _jsx } from "react/jsx-runtime";
import { Navigation } from '@shopify/polaris';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircleIcon, HomeIcon, OrderIcon, SettingsIcon, ViewIcon, } from '@shopify/polaris-icons';
const AppNavigation = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const selected = (path) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
    const items = [
        { label: 'Overview', icon: HomeIcon, path: '/' },
        { label: 'Listings', icon: ViewIcon, path: '/listings' },
        { label: 'Orders', icon: OrderIcon, path: '/orders' },
        { label: 'Issues', icon: AlertCircleIcon, path: '/issues' },
        { label: 'Settings', icon: SettingsIcon, path: '/settings' },
    ];
    return (_jsx(Navigation, { location: location.pathname, children: _jsx(Navigation.Section, { items: items.map((item) => ({
                label: item.label,
                icon: item.icon,
                selected: selected(item.path),
                onClick: () => navigate(item.path),
                url: item.path,
            })) }) }));
};
export default AppNavigation;
