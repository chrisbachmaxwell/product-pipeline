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
export type SmtpConfig = Readonly<{
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
    to: readonly string[];
}>;
/**
 * Vault-stored email settings (L83): the operator connects alerts from
 * Settings like every other connection. Fixed Google Workspace transport
 * (smtp.gmail.com:465, from = the sending mailbox); only the mailbox, its
 * app password, and the recipients are stored (as one JSON secret in the
 * connections vault). Env config, when complete, always wins.
 */
export declare function smtpConfigFromVaultJson(raw: string | null): SmtpConfig | null;
export declare function readSmtpConfigFromEnv(env?: NodeJS.ProcessEnv): SmtpConfig | null;
/**
 * Minimal SMTPS conversation: EHLO → AUTH LOGIN → MAIL FROM → RCPT TO …
 * → DATA → QUIT. Implicit TLS only (no STARTTLS downgrade surface).
 */
export declare function resolveSmtpConfig(): Promise<SmtpConfig | null>;
export declare function sendIncidentEmail(payload: IncidentEmailPayload, config?: SmtpConfig | null): Promise<boolean>;
