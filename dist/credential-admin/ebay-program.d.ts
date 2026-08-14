import { type EbayRotationDependencies, type EbayRotationErrorCode } from './ebay-rotation.js';
export declare const EBAY_ROTATION_RAILWAY_PROJECT_ID: "f8c050c9-11c3-4611-8805-092289941aa4";
export declare const EBAY_ROTATION_RAILWAY_ENVIRONMENT_ID: "544d8896-b900-48ad-b42e-95272e1ad397";
export declare const EBAY_ROTATION_RAILWAY_SERVICE_ID: "32ef14cc-2c85-447d-a890-53c422d81de1";
export type CredentialAdminIo = Readonly<{
    stdout: (value: string) => void;
    stderr: (value: string) => void;
    readSecret: () => Promise<string>;
    setExitCode: (value: number) => void;
}>;
export type CredentialAdminEnvironment = Readonly<{
    EBAY_APP_ID?: string;
    EBAY_RU_NAME?: string;
    EBAY_ROTATION_NEW_CERT_ID?: string;
    RAILWAY_PROJECT_ID?: string;
    RAILWAY_ENVIRONMENT_ID?: string;
    RAILWAY_SERVICE_ID?: string;
    LISTING_CONTROL_SINGLE_WRITER_ACK?: string;
    SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK?: string;
    SHOPIFY_ROTATION_REFRESH_TOKEN?: string;
}>;
type ParsedCommand = Readonly<{
    command: 'help';
}> | Readonly<{
    command: 'prepare-consent';
    localWorkDirectory: string;
}> | Readonly<{
    command: 'register-consent';
    stateDigest: string;
    requestDigest: string;
}> | Readonly<{
    command: 'archive-reset-after-reconciliation';
    stateDigest: string;
    requestDigest: string;
    confirmation: string;
}> | Readonly<{
    command: 'recover-stale-lock';
    ownerId: string;
    createdAtUtc: string;
    confirmation: string;
}> | Readonly<{
    command: 'install';
}> | Readonly<{
    command: 'verify';
}> | Readonly<{
    command: 'revoke-new-grant';
    confirmation: string;
}>;
export declare const EBAY_CREDENTIAL_ADMIN_HELP: string;
export declare function parseCredentialAdminArguments(argv: readonly string[]): ParsedCommand;
export declare function assertEbayProductionRailwayBoundary(environment: CredentialAdminEnvironment): void;
export declare function credentialAdminExitCode(code: EbayRotationErrorCode, reconciliationRequired?: boolean): number;
export declare function defaultNoEchoSecretReader(): Promise<string>;
export declare function runCredentialAdmin(input: {
    argv: readonly string[];
    environment?: CredentialAdminEnvironment;
    io?: CredentialAdminIo;
    dependencies?: EbayRotationDependencies;
}): Promise<void>;
export {};
