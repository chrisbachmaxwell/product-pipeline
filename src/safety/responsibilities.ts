/**
 * Canonical responsibility vocabulary for ownership, evidence, approvals,
 * durable jobs, audit, UI projection, and canary evaluation.
 *
 * Do not translate unknown legacy strings into these values. Missing or
 * unsupported responsibility values must remain blocked.
 */
export const MIGRATION_RESPONSIBILITIES = [
  'orderImport',
  'price',
  'inventory',
  'listingCreate',
  'listingRevise',
  'listingEndRelist',
  'mapping',
  'fulfillment',
  'feedback',
  'reconciliation',
] as const;

export type MigrationResponsibility = (typeof MIGRATION_RESPONSIBILITIES)[number];

/** Reconciliation observes and decides; it is not an external writer action. */
export const WRITER_RESPONSIBILITIES = [
  'orderImport',
  'price',
  'inventory',
  'listingCreate',
  'listingRevise',
  'listingEndRelist',
  'mapping',
  'fulfillment',
  'feedback',
] as const satisfies readonly MigrationResponsibility[];

export type WriterResponsibility = (typeof WRITER_RESPONSIBILITIES)[number];

export function isMigrationResponsibility(value: unknown): value is MigrationResponsibility {
  return typeof value === 'string'
    && (MIGRATION_RESPONSIBILITIES as readonly string[]).includes(value);
}

export function isWriterResponsibility(value: unknown): value is WriterResponsibility {
  return typeof value === 'string'
    && (WRITER_RESPONSIBILITIES as readonly string[]).includes(value);
}
