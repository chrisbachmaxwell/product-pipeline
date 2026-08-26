import { describe, expect, it, vi } from 'vitest';
import {
  assertAutomationGlobalEnabled,
  AUTOMATION_GLOBAL_STOPPED,
  AUTOMATION_KILL_SWITCH_ENABLED_VALUE,
  AUTOMATION_KILL_SWITCH_ENV,
  AutomationQuarantinedError,
  getAutomationGlobalGate,
} from './quarantine.js';

describe('G18 global automation quarantine', () => {
  it.each([
    undefined,
    '',
    'true',
    '1',
    'ENABLED',
    'enabled ',
    ' enabled',
    'disabled',
    'stop',
  ])('default-stops the exact global gate for %j', (value) => {
    const environment = value === undefined ? {} : { [AUTOMATION_KILL_SWITCH_ENV]: value };
    expect(getAutomationGlobalGate(environment)).toEqual({
      code: AUTOMATION_GLOBAL_STOPPED,
      globalGateOpen: false,
      externalWritesAuthorized: false,
    });
    expect(() => assertAutomationGlobalEnabled(environment)).toThrow(
      AutomationQuarantinedError,
    );
  });

  it.each(['production', 'test', 'development']) (
    'ignores unrelated NODE_ENV=%s and remains stopped by default',
    (nodeEnv) => {
      expect(getAutomationGlobalGate({ NODE_ENV: nodeEnv })).toMatchObject({
        globalGateOpen: false,
        externalWritesAuthorized: false,
      });
    },
  );

  it('accepts only the one exact enabled value without consulting other flags', () => {
    const environment = {
      [AUTOMATION_KILL_SWITCH_ENV]: AUTOMATION_KILL_SWITCH_ENABLED_VALUE,
      WRITES_ENABLED: 'false',
      AUTO_SYNC_ENABLED: 'false',
      NODE_ENV: 'test',
    };
    expect(getAutomationGlobalGate(environment)).toEqual({
      code: 'AUTOMATION_GLOBAL_ENABLED',
      globalGateOpen: true,
      externalWritesAuthorized: false,
    });
    expect(() => assertAutomationGlobalEnabled(environment)).not.toThrow();
  });

  it('has no import-time reads, timers, network calls, or writes', async () => {
    vi.resetModules();
    const fetchSpy = vi.fn();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('fetch', fetchSpy);

    await import('./quarantine.js');
    await import('./contracts.js');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    intervalSpy.mockRestore();
    timeoutSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
