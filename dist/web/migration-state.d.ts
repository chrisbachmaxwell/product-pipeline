import type { MigrationStatusResponse } from './hooks/useApi';
export type DurableMigrationStateView = {
    available: boolean;
    statusLabel: string;
    counts: Record<string, number>;
    eligibleOrderCount: 0;
    canaryAuthorized: false;
    cutoverAuthorized: false;
    locallyVerified: boolean;
};
/**
 * Fail-closed browser view of local durable migration state. The global
 * quarantine response remains authoritative even if a future projection adds
 * optimistic or unknown fields.
 */
export declare function durableMigrationStateView(response: MigrationStatusResponse | undefined): DurableMigrationStateView;
