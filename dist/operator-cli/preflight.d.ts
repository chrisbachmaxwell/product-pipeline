import { type OperatorConfig } from './config.js';
export type InspectionCommand = 'preflight' | 'ownership';
export type OperatorInspection = {
    command: InspectionCommand;
    status: 'configuration-safe' | 'blocked';
    guarantees: {
        mode: 'read-only';
        dryRun: true;
        externalNetworkAccess: false;
        externalWrites: false;
        historicalBackfill: false;
        orderImportEnabled: false;
    };
    declaredIdentity: OperatorConfig['identities'];
    identityProof: 'configuration-only';
    ownership: OperatorConfig['ownership'];
    blockers: string[];
    config: {
        path: string;
        digest: string;
    };
    audit: {
        path: string;
        sequence: number;
        recordHash: string;
    };
};
export declare function runOperatorInspection(options: {
    command: InspectionCommand;
    repoRoot: string;
    configPath: string;
    now?: () => Date;
    createRunId?: () => string;
}): Promise<OperatorInspection>;
