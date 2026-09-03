import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckCircle, Clock, AlertCircle, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useAppStore } from '../store';
const StatusIndicator = ({ type, status, label, platform, size = 'md', showIcon = true, }) => {
    const { activeSyncOperations } = useAppStore();
    const getStatusConfig = () => {
        if (type === 'sync') {
            switch (status) {
                case 'idle':
                    return {
                        color: 'status-idle',
                        icon: _jsx(CheckCircle, { className: "w-4 h-4" }),
                        text: label || 'Ready',
                    };
                case 'syncing':
                    return {
                        color: 'status-syncing',
                        icon: _jsx(RefreshCw, { className: "w-4 h-4 animate-spin" }),
                        text: label || `Syncing (${activeSyncOperations.length})`,
                    };
                case 'error':
                    return {
                        color: 'status-error',
                        icon: _jsx(AlertCircle, { className: "w-4 h-4" }),
                        text: label || 'Error',
                    };
                default:
                    return {
                        color: 'status-idle',
                        icon: _jsx(Clock, { className: "w-4 h-4" }),
                        text: label || 'Unknown',
                    };
            }
        }
        else {
            // Connection status
            const platformColors = {
                shopify: status === 'connected' ? 'bg-shopify-100 text-shopify-700' : 'bg-gray-100 text-gray-700',
                ebay: status === 'connected' ? 'bg-ebay-100 text-ebay-700' : 'bg-gray-100 text-gray-700',
            };
            return {
                color: platform ? platformColors[platform] : 'status-idle',
                icon: status === 'connected' ? _jsx(Wifi, { className: "w-4 h-4" }) : _jsx(WifiOff, { className: "w-4 h-4" }),
                text: label || `${platform?.toUpperCase() || 'Platform'} ${status}`,
            };
        }
    };
    const config = getStatusConfig();
    const sizeClasses = {
        sm: 'text-xs px-2 py-1',
        md: 'text-sm px-3 py-1',
        lg: 'text-base px-4 py-2',
    };
    return (_jsxs("div", { className: `status-indicator ${config.color} ${sizeClasses[size]}`, children: [showIcon && config.icon, _jsx("span", { children: config.text })] }));
};
export default StatusIndicator;
