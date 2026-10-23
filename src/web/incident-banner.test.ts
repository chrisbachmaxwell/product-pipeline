import { describe, expect, it } from 'vitest';
import {
  incidentIssueAction,
  toggleIncidentDisclosure,
  visibleIncidentDiagnosis,
  type IncidentBannerItem,
} from './incident-banner';

const incident = (overrides: Partial<IncidentBannerItem> = {}): IncidentBannerItem => ({
  id: 'PRICE_SYNC_REJECTED:listing 147000000001',
  severity: 'critical',
  title: 'eBay is rejecting price updates',
  detail: 'Change the markdown sale setting in Seller Hub.',
  diagnosis: 'A long technical diagnosis that is hidden by default.',
  githubIssueUrl: 'https://github.com/example/project/issues/1',
  ...overrides,
});

describe('incident banner disclosure', () => {
  it('keeps the diagnosis hidden until its incident is expanded', () => {
    const row = incident();
    expect(visibleIncidentDiagnosis(row, new Set())).toBeNull();
    expect(visibleIncidentDiagnosis(row, new Set([row.id]))).toBe(row.diagnosis);
  });

  it('toggles only the selected incident without mutating prior state', () => {
    const before = new Set(['one']);
    const added = toggleIncidentDisclosure(before, 'two');
    expect([...before]).toEqual(['one']);
    expect([...added].sort()).toEqual(['one', 'two']);
    expect([...toggleIncidentDisclosure(added, 'one')]).toEqual(['two']);
  });

  it('never exposes stale fix-agent material for an operator-owned setting', () => {
    const row = incident({ operatorOnly: true });
    expect(visibleIncidentDiagnosis(row, new Set([row.id]))).toBeNull();
    expect(incidentIssueAction(row)).toBeUndefined();
  });

  it('keeps a non-operator incident link as optional technical context', () => {
    expect(incidentIssueAction(incident())).toEqual({
      content: 'Open incident',
      url: 'https://github.com/example/project/issues/1',
      external: true,
    });
    expect(incidentIssueAction(incident({ githubIssueUrl: null }))).toBeUndefined();
  });
});
