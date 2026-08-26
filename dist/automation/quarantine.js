export const AUTOMATION_KILL_SWITCH_ENV = 'PRODUCT_PIPELINE_AUTOMATION';
export const AUTOMATION_KILL_SWITCH_ENABLED_VALUE = 'enabled';
export const AUTOMATION_GLOBAL_STOPPED = 'AUTOMATION_GLOBAL_STOPPED';
export class AutomationQuarantinedError extends Error {
    code = AUTOMATION_GLOBAL_STOPPED;
    constructor() {
        super('Automation is globally stopped');
        this.name = 'AutomationQuarantinedError';
    }
}
/**
 * The one global automation gate. Missing, malformed, differently-cased, or
 * padded values all stop automation. It does not inspect any other flag.
 */
export function getAutomationGlobalGate(environment) {
    const enabled = environment[AUTOMATION_KILL_SWITCH_ENV]
        === AUTOMATION_KILL_SWITCH_ENABLED_VALUE;
    return Object.freeze({
        code: enabled ? 'AUTOMATION_GLOBAL_ENABLED' : AUTOMATION_GLOBAL_STOPPED,
        globalGateOpen: enabled,
        // The environment is only the global stop. A future durable,
        // per-responsibility operator authorization is independently required.
        externalWritesAuthorized: false,
    });
}
export function assertAutomationGlobalEnabled(environment) {
    if (!getAutomationGlobalGate(environment).globalGateOpen) {
        throw new AutomationQuarantinedError();
    }
}
