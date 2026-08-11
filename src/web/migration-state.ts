import type {
  DurableMigrationStateProjection,
  MigrationStatusResponse,
} from './hooks/useApi';

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
export function durableMigrationStateView(
  response: MigrationStatusResponse | undefined,
): DurableMigrationStateView {
  const state = response?.migrationState;
  const locallyVerified = localProjectionIsVerified(state);
  const statusLabel = locallyVerified
    ? 'Verified local state'
    : state?.status === 'not-configured'
      ? 'Not configured'
      : 'Unavailable';

  return {
    available: locallyVerified,
    statusLabel,
    counts: locallyVerified && state?.counts ? safeCounts(state.counts) : {},
    eligibleOrderCount: 0,
    canaryAuthorized: false,
    cutoverAuthorized: false,
    locallyVerified,
  };
}

function localProjectionIsVerified(
  state: DurableMigrationStateProjection | undefined,
): boolean {
  return (
    state?.status === 'verified' &&
    state.access?.writable === false &&
    state.access?.readOnly === true &&
    state.access?.externallyWired === false &&
    state.access?.externalWritesSupported === false &&
    state.access?.historicalBackfillAllowed === false &&
    state.audit?.valid === true &&
    state.readiness?.canaryReady === false &&
    state.readiness?.cutoverReady === false
  );
}

function safeCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter(
      ([key, value]) => /^[a-z][A-Za-z0-9]{0,63}$/.test(key) && Number.isSafeInteger(value) && value >= 0,
    ),
  );
}
