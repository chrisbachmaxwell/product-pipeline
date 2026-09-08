/** Larger bodies are dropped unread; real notifications are a few KB. */
export declare const MAX_NOTIFICATION_BYTES: number;
export type EbayNotificationVerdict = Readonly<{
    outcome: 'verified' | 'rejected';
    /** Fixed code describing a rejection; never caller-controlled text. */
    reason: 'ok' | 'body_invalid' | 'timestamp_missing' | 'timestamp_stale' | 'signature_missing' | 'signature_mismatch' | 'credentials_unavailable';
    eventName: string | null;
    itemId: string | null;
    alignmentRelevant: boolean;
}>;
export declare function verifyEbayNotification(input: Readonly<{
    body: unknown;
    credentials: Readonly<{
        devId: string;
        appId: string;
        certId: string;
    }> | null;
    nowMs: number;
}>): EbayNotificationVerdict;
