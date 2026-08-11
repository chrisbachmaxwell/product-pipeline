import { type OperatorConfig } from '../config.js';
import type { ReconciliationSnapshot } from '../reconciliation.js';
export declare function validConfig(overrides?: Partial<OperatorConfig>): OperatorConfig;
export declare function validReconciliationSnapshot(overrides?: Partial<ReconciliationSnapshot>): ReconciliationSnapshot;
