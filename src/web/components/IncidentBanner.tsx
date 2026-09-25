import React, { useEffect, useState } from 'react';
import { Banner, BlockStack, Text } from '@shopify/polaris';
import { apiClient } from '../hooks/useApi';

type Incident = {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  diagnosis: string | null;
  githubIssueUrl: string | null;
};

/**
 * The alarm L75 was missing: critical incidents (a sold item still buyable
 * on eBay, the guard being rejected by eBay) render at the top of every
 * page within minutes of detection, with the AI diagnosis when available.
 */
export const IncidentBanner: React.FC = () => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const body = await apiClient.get<{ incidents: Incident[] }>('/incidents');
        if (!cancelled) setIncidents(body.incidents ?? []);
      } catch { /* transient; keep last state */ }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 60_000);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);
  const critical = incidents.filter((incident) => incident.severity === 'critical');
  const warnings = incidents.filter((incident) => incident.severity === 'warning');
  if (critical.length === 0 && warnings.length === 0) return null;
  return (
    <BlockStack gap="200">
      {critical.map((incident) => (
        <Banner
          key={incident.id}
          tone="critical"
          title={incident.title}
          action={incident.githubIssueUrl
            ? { content: 'View fix proposal', url: incident.githubIssueUrl, external: true }
            : undefined}
        >
          <BlockStack gap="100">
            <Text as="p">{incident.detail}</Text>
            {incident.diagnosis && (
              <Text as="p" variant="bodySm">{incident.diagnosis}</Text>
            )}
          </BlockStack>
        </Banner>
      ))}
      {warnings.length > 0 && (
        <Banner tone="warning" title={`${warnings.length} sync warning${warnings.length > 1 ? 's' : ''}`}>
          <BlockStack gap="100">
            {warnings.map((incident) => (
              <Text as="p" variant="bodySm" key={incident.id}>{incident.title}</Text>
            ))}
          </BlockStack>
        </Banner>
      )}
    </BlockStack>
  );
};
