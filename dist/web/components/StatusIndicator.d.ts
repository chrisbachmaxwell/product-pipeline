import React from 'react';
interface StatusIndicatorProps {
    type: 'sync' | 'connection';
    status: 'idle' | 'syncing' | 'error' | 'connected' | 'disconnected';
    label?: string;
    platform?: 'shopify' | 'ebay';
    size?: 'sm' | 'md' | 'lg';
    showIcon?: boolean;
}
declare const StatusIndicator: React.FC<StatusIndicatorProps>;
export default StatusIndicator;
