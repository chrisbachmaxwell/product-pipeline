export declare const AUTOMATION_KILL_SWITCH_ENV: "PRODUCT_PIPELINE_AUTOMATION";
export declare const AUTOMATION_KILL_SWITCH_ENABLED_VALUE: "enabled";
export declare const AUTOMATION_GLOBAL_STOPPED: "AUTOMATION_GLOBAL_STOPPED";
export type AutomationGlobalGate = Readonly<{
    code: typeof AUTOMATION_GLOBAL_STOPPED | 'AUTOMATION_GLOBAL_ENABLED';
    globalGateOpen: boolean;
    externalWritesAuthorized: false;
}>;
export declare class AutomationQuarantinedError extends Error {
    readonly code: "AUTOMATION_GLOBAL_STOPPED";
    constructor();
}
/**
 * The one global automation gate. Missing, malformed, differently-cased, or
 * padded values all stop automation. It does not inspect any other flag.
 */
export declare function getAutomationGlobalGate(environment: Readonly<Record<string, string | undefined>>): AutomationGlobalGate;
export declare function assertAutomationGlobalEnabled(environment: Readonly<Record<string, string | undefined>>): void;
