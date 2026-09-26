/**
 * Incident email alerts (L78): the operator asked for critical incidents to
 * land in real inboxes (chrism@/nick@pictureline.com), not just the app
 * banner. Sends through the store's OWN mail server over SMTPS with a
 * dependency-free minimal client (node:tls) — no new vendors, no new npm
 * packages. Armed entirely by env:
 *
 *   INCIDENT_EMAIL_TO    comma-separated recipients
 *   INCIDENT_EMAIL_FROM  the sending address (the SMTP user's mailbox)
 *   INCIDENT_SMTP_HOST   e.g. smtp.gmail.com
 *   INCIDENT_SMTP_PORT   e.g. 465 (implicit TLS only)
 *   INCIDENT_SMTP_USER / INCIDENT_SMTP_PASS  (Google App Password)
 *
 * Credentials live only in env, are never logged, and the message carries
 * only the incident's already-sanitized text.
 */
import tls from 'node:tls';
const RESPONSE_TIMEOUT_MS = 15_000;
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** Strip anything that could smuggle extra SMTP headers or commands. */
function headerSafe(value) {
    return value.replace(/[\r\n]+/g, ' ').slice(0, 300);
}
/** Pure message builder — unit-tested; the transport stays thin. */
export function buildIncidentEmail(input) {
    const subject = headerSafe(`[ProductPipeline ${input.payload.severity.toUpperCase()}] ${input.payload.title}`);
    const bodyLines = [
        input.payload.title,
        '',
        `Detected: ${input.payload.detectedAtUtc}`,
        '',
        input.payload.detail,
        ...(input.payload.diagnosis ? ['', '--- Diagnosis ---', input.payload.diagnosis] : []),
        ...(input.payload.githubIssueUrl ? ['', `Fix proposal: ${input.payload.githubIssueUrl}`] : []),
        '',
        'Open the ProductPipeline app for live status. This alert repeats only if the incident clears and recurs.',
    ];
    // Dot-stuffing per RFC 5321 and CRLF line endings.
    const body = bodyLines
        .join('\r\n')
        .split('\r\n')
        .map((line) => (line.startsWith('.') ? `.${line}` : line))
        .join('\r\n');
    const data = [
        `From: ProductPipeline <${input.from}>`,
        `To: ${input.to.join(', ')}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
    ].join('\r\n');
    return { subject, data };
}
export function readSmtpConfigFromEnv(env = process.env) {
    const host = env.INCIDENT_SMTP_HOST;
    const port = Number(env.INCIDENT_SMTP_PORT ?? '465');
    const user = env.INCIDENT_SMTP_USER;
    const pass = env.INCIDENT_SMTP_PASS;
    const from = env.INCIDENT_EMAIL_FROM ?? user;
    const to = (env.INCIDENT_EMAIL_TO ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    if (!host || !user || !pass || !from
        || !Number.isSafeInteger(port) || port < 1 || port > 65_535
        || !ADDRESS.test(from) || to.length === 0 || to.length > 10
        || !to.every((address) => ADDRESS.test(address))) {
        return null;
    }
    return Object.freeze({ host, port, user, pass, from, to });
}
/**
 * Minimal SMTPS conversation: EHLO → AUTH LOGIN → MAIL FROM → RCPT TO …
 * → DATA → QUIT. Implicit TLS only (no STARTTLS downgrade surface).
 */
export async function sendIncidentEmail(payload, config = readSmtpConfigFromEnv()) {
    if (config === null)
        return false;
    const { data } = buildIncidentEmail({ from: config.from, to: config.to, payload });
    return new Promise((resolve) => {
        const socket = tls.connect({ host: config.host, port: config.port, servername: config.host });
        let buffer = '';
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.end();
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), RESPONSE_TIMEOUT_MS * 4);
        const steps = [
            { expect: /^220 /m, send: `EHLO productpipeline.local\r\n` },
            { expect: /^250[ -]/m, send: 'AUTH LOGIN\r\n' },
            { expect: /^334 /m, send: `${Buffer.from(config.user).toString('base64')}\r\n` },
            { expect: /^334 /m, send: `${Buffer.from(config.pass).toString('base64')}\r\n` },
            { expect: /^235 /m, send: `MAIL FROM:<${config.from}>\r\n` },
            ...config.to.map((address) => ({ expect: /^250 /m, send: `RCPT TO:<${address}>\r\n` })),
            { expect: /^250 /m, send: 'DATA\r\n' },
            { expect: /^354 /m, send: `${data}\r\n.\r\n` },
            { expect: /^250 /m, send: 'QUIT\r\n' },
            { expect: /^221 /m, send: null },
        ];
        let step = 0;
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            // Advance through every step the buffered responses satisfy.
            while (step < steps.length) {
                const current = steps[step];
                if (!current.expect.test(buffer)) {
                    if (/^[45]\d\d[ -]/m.test(buffer))
                        finish(false);
                    return;
                }
                buffer = '';
                step += 1;
                if (current.send !== null)
                    socket.write(current.send);
                if (step === steps.length)
                    finish(true);
            }
        });
        socket.on('error', () => finish(false));
        socket.on('close', () => finish(step === steps.length));
    });
}
