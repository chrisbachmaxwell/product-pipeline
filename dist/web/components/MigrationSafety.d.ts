import React from 'react';
import type { MigrationResponsibilityStatus, MigrationStatusResponse } from '../hooks/useApi';
export declare const humanize: (value: string | null | undefined) => string;
export declare const responsibilityLabel: (responsibility: string) => string;
export declare const findResponsibility: (status: MigrationStatusResponse | undefined, responsibility: string) => MigrationResponsibilityStatus | undefined;
export declare const MigrationSafetyBanner: React.FC<{
    status?: MigrationStatusResponse;
    error?: Error | null;
}>;
export declare const OwnershipCards: React.FC<{
    status?: MigrationStatusResponse;
    includeAll?: boolean;
}>;
