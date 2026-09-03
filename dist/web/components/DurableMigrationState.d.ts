import React from 'react';
import type { MigrationStatusResponse } from '../hooks/useApi';
export declare const DurableMigrationState: React.FC<{
    status?: MigrationStatusResponse;
    compact?: 'listings' | 'orders';
}>;
