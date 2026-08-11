/**
 * Canonical responsibility vocabulary for ownership, evidence, approvals,
 * durable jobs, audit, UI projection, and canary evaluation.
 *
 * Do not translate unknown legacy strings into these values. Missing or
 * unsupported responsibility values must remain blocked.
 */
export declare const MIGRATION_RESPONSIBILITIES: readonly ["orderImport", "price", "inventory", "listingCreate", "listingRevise", "listingEndRelist", "mapping", "fulfillment", "feedback", "reconciliation"];
export type MigrationResponsibility = (typeof MIGRATION_RESPONSIBILITIES)[number];
/** Reconciliation observes and decides; it is not an external writer action. */
export declare const WRITER_RESPONSIBILITIES: readonly ["orderImport", "price", "inventory", "listingCreate", "listingRevise", "listingEndRelist", "mapping", "fulfillment", "feedback"];
export type WriterResponsibility = (typeof WRITER_RESPONSIBILITIES)[number];
export declare function isMigrationResponsibility(value: unknown): value is MigrationResponsibility;
export declare function isWriterResponsibility(value: unknown): value is WriterResponsibility;
