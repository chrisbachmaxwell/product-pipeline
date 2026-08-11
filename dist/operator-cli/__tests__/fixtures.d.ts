import { type OperatorConfig } from '../config.js';
import { type ReconciliationSnapshot, type ReconciliationSource, type SourceUnavailableReason } from '../reconciliation-schema.js';
export declare function validConfig(overrides?: Partial<OperatorConfig>): OperatorConfig;
export declare function refreshReconciliationSource(snapshot: ReconciliationSnapshot, source: ReconciliationSource): void;
export declare function markSourceUnavailable(snapshot: ReconciliationSnapshot, source: ReconciliationSource, reason?: SourceUnavailableReason): void;
export declare function validReconciliationSnapshot(overrides?: Partial<ReconciliationSnapshot>): ReconciliationSnapshot;
