export const AUTOMATION_KILL_SWITCH_ENV = 'PRODUCT_PIPELINE_AUTOMATION' as const;
export const AUTOMATION_KILL_SWITCH_ENABLED_VALUE = 'enabled' as const;
export const AUTOMATION_GLOBAL_STOPPED = 'AUTOMATION_GLOBAL_STOPPED' as const;

export type AutomationGlobalGate = Readonly<{
  code: typeof AUTOMATION_GLOBAL_STOPPED | 'AUTOMATION_GLOBAL_ENABLED';
  globalGateOpen: boolean;
  externalWritesAuthorized: false;
}>;

export class AutomationQuarantinedError extends Error {
  readonly code = AUTOMATION_GLOBAL_STOPPED;

  constructor() {
    super('Automation is globally stopped');
    this.name = 'AutomationQuarantinedError';
  }
}

/**
 * The one global automation gate. Missing, malformed, differently-cased, or
 * padded values all stop automation. It does not inspect any other flag.
 */
export function getAutomationGlobalGate(
  environment: Readonly<Record<string, string | undefined>>,
): AutomationGlobalGate {
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

export function assertAutomationGlobalEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (!getAutomationGlobalGate(environment).globalGateOpen) {
    throw new AutomationQuarantinedError();
  }
}
