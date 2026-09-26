/** L78: incident email formatting and env-arming contracts. */
import { describe, expect, it } from 'vitest';
import { buildIncidentEmail, readSmtpConfigFromEnv } from './incident-email.js';

const PAYLOAD = {
  severity: 'critical',
  title: 'eBay ORDERS ARE NOT IMPORTING — blocked 40h behind order 21-15190-74821',
  detail: 'The order poll is strictly ordered.',
  diagnosis: 'WHAT HAPPENED: ...',
  githubIssueUrl: 'https://github.com/x/y/issues/9',
  detectedAtUtc: '2026-09-26T15:00:00.000Z',
};

describe('buildIncidentEmail', () => {
  it('builds a plain-text alert with subject, diagnosis, and issue link', () => {
    const email = buildIncidentEmail({
      from: 'alerts@pictureline.com',
      to: ['chrism@pictureline.com', 'nick@pictureline.com'],
      payload: PAYLOAD,
    });
    expect(email.subject).toContain('[ProductPipeline CRITICAL]');
    expect(email.data).toContain('To: chrism@pictureline.com, nick@pictureline.com');
    expect(email.data).toContain('WHAT HAPPENED');
    expect(email.data).toContain('https://github.com/x/y/issues/9');
  });

  it('never lets incident text smuggle SMTP headers or terminate DATA early', () => {
    const email = buildIncidentEmail({
      from: 'alerts@pictureline.com',
      to: ['chrism@pictureline.com'],
      payload: {
        ...PAYLOAD,
        title: 'evil\r\nBcc: attacker@example.com',
        detail: '.\r\nQUIT',
      },
    });
    expect(email.subject).not.toContain('\r');
    // The attempt lands flattened INSIDE the subject text; no header line
    // may ever START with an injected name.
    const headerSection = email.data.split('\r\n\r\n')[0]!;
    expect(headerSection.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false);
    // RFC 5321 dot-stuffing: a body line starting '.' is doubled.
    expect(email.data).toContain('\r\n..\r\n');
  });
});

describe('readSmtpConfigFromEnv', () => {
  const ARMED = {
    INCIDENT_SMTP_HOST: 'smtp.gmail.com',
    INCIDENT_SMTP_PORT: '465',
    INCIDENT_SMTP_USER: 'alerts@pictureline.com',
    INCIDENT_SMTP_PASS: 'app-password',
    INCIDENT_EMAIL_TO: 'chrism@pictureline.com, nick@pictureline.com',
  };
  it('arms with the full set and defaults FROM to the SMTP user', () => {
    const config = readSmtpConfigFromEnv(ARMED as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      from: 'alerts@pictureline.com',
      to: ['chrism@pictureline.com', 'nick@pictureline.com'],
      port: 465,
    });
  });
  it('stays unarmed on any missing or malformed piece', () => {
    expect(readSmtpConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readSmtpConfigFromEnv({ ...ARMED, INCIDENT_EMAIL_TO: 'not-an-email' } as NodeJS.ProcessEnv)).toBeNull();
    expect(readSmtpConfigFromEnv({ ...ARMED, INCIDENT_SMTP_PASS: '' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
