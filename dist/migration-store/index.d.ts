/**
 * Dedicated migration-state persistence. This module is intentionally not
 * imported by server startup, legacy sync code, or any external adapter.
 */
export { MigrationStoreError, createMigrationStore, deriveExternalIdentityKey, deriveIdempotencyKey, deriveScopeKey, openMigrationStore, openMigrationStoreReadOnly, sha256Digest, upgradeMigrationStore, } from './store.js';
export type { MigrationStore } from './store.js';
export { CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema.js';
export { inspectMigrationStoreReadOnly } from './projection.js';
export type { MigrationStoreOwnershipProjection, MigrationStoreProjection, MigrationStoreProjectionCounts, } from './projection.js';
export * from './types.js';
