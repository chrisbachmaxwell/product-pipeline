export type IncidentEmailPayload = Readonly<{
    severity: string;
    title: string;
    detail: string;
    diagnosis: string | null;
    githubIssueUrl: string | null;
    detectedAtUtc: string;
}>;
/** Pure message builder — unit-tested; the transport stays thin. */
export declare function buildIncidentEmail(input: {
    from: string;
    to: readonly string[];
    payload: IncidentEmailPayload;
}): {
    subject: string;
    data: string;
};
type SmtpConfig = Readonly<{
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
    to: readonly string[];
}>;
export declare function readSmtpConfigFromEnv(env?: NodeJS.ProcessEnv): SmtpConfig | null;
/**
 * Minimal SMTPS conversation: EHLO → AUTH LOGIN → MAIL FROM → RCPT TO …
 * → DATA → QUIT. Implicit TLS only (no STARTTLS downgrade surface).
 */
export declare function sendIncidentEmail(payload: IncidentEmailPayload, config?: SmtpConfig | null): Promise<boolean>;
export {};
