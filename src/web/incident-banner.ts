export type IncidentBannerItem = {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  diagnosis: string | null;
  githubIssueUrl: string | null;
  operatorOnly?: boolean;
};

export const toggleIncidentDisclosure = (
  expanded: ReadonlySet<string>,
  incidentId: string,
): ReadonlySet<string> => {
  const next = new Set(expanded);
  if (next.has(incidentId)) next.delete(incidentId);
  else next.add(incidentId);
  return next;
};

export const visibleIncidentDiagnosis = (
  incident: IncidentBannerItem,
  expanded: ReadonlySet<string>,
): string | null => incident.operatorOnly !== true
  && expanded.has(incident.id)
  && incident.diagnosis
  ? incident.diagnosis
  : null;

export const incidentIssueAction = (
  incident: IncidentBannerItem,
): { content: string; url: string; external: true } | undefined =>
  incident.operatorOnly !== true && incident.githubIssueUrl
    ? { content: 'Open incident', url: incident.githubIssueUrl, external: true }
    : undefined;
