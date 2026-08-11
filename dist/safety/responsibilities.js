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
];
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
];
export function isMigrationResponsibility(value) {
    return typeof value === 'string'
        && MIGRATION_RESPONSIBILITIES.includes(value);
}
export function isWriterResponsibility(value) {
    return typeof value === 'string'
        && WRITER_RESPONSIBILITIES.includes(value);
}
