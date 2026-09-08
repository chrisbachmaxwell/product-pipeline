import { Command } from 'commander';
/**
 * Every event that can change what is listed, available, or sold on eBay.
 * The receiver aligns on these; anything else would be noise against the
 * notification quota.
 */
export declare const SUBSCRIBED_EVENTS: readonly string[];
export type NotificationAdminIo = Readonly<{
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
}>;
export declare function buildNotificationAdminProgram(dependencies?: Readonly<{
    fetchImpl?: typeof fetch;
    getAccessToken?: () => Promise<string>;
    io?: NotificationAdminIo;
}>): Command;
