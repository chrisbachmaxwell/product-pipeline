import React from 'react';
interface MetricCardProps {
    title: string;
    value: number | string;
    trend?: {
        value: number;
        period: string;
    };
    icon?: React.ReactNode;
    tone?: 'default' | 'success' | 'warning' | 'critical';
    loading?: boolean;
    onClick?: () => void;
}
declare const MetricCard: React.FC<MetricCardProps>;
export default MetricCard;
