import { Command } from 'commander';
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
import { loadEbayCredentials } from '../config/credentials.js';
import { deriveScopeKey } from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
/** The exact one-store scope every ceremony in this migration confirms. */
const MIGRATION_SCOPE = Object.freeze({
    shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
    ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
    ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
    ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});
/**
 * Standalone operator ceremony for eBay Platform Notification preferences.
 *
 * Subscribing points eBay's push notifications at a receiver URL -- an
 * account-level provider write, so it lives here as an explicit operator
 * command and is never mounted in the server. The receiver itself
 * (src/server/routes/ebay-notifications.ts) is read-only: a verified event
 * only triggers the already-armed alignment machinery.
 *
 * One command, exact arguments, scope-key confirmation, one bounded provider
 * call: the same ceremony shape as every other write in this migration.
 */
const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const COMPATIBILITY_LEVEL = '1349';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
/**
 * Every event that can change what is listed, available, or sold on eBay.
 * The receiver aligns on these; anything else would be noise against the
 * notification quota.
 */
export const SUBSCRIBED_EVENTS = Object.freeze([
    'FixedPriceTransaction',
    'AuctionCheckoutComplete',
    'ItemSold',
    'ItemClosed',
    'ItemRevised',
    'ItemListed',
    'ItemUnsold',
]);
const SAFE_URL = /^https:\/\/[a-z0-9.-]+\/webhooks\/ebay\/notifications$/u;
const defaultIo = Object.freeze({
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
    setExitCode: (code) => { process.exitCode = code; },
});
class NotificationAdminError extends Error {
    code;
    constructor(code) {
        super('Notification preference ceremony denied');
        this.code = code;
    }
}
const deny = (code) => { throw new NotificationAdminError(code); };
function buildSetPreferencesXml(input) {
    const application = input.enable
        ? '<ApplicationDeliveryPreferences>'
            + '<ApplicationEnable>Enable</ApplicationEnable>'
            + `<ApplicationURL>${input.notificationUrl}</ApplicationURL>`
            + '<DeviceType>Platform</DeviceType>'
            + '</ApplicationDeliveryPreferences>'
        : '<ApplicationDeliveryPreferences>'
            + '<ApplicationEnable>Disable</ApplicationEnable>'
            + '</ApplicationDeliveryPreferences>';
    const events = input.enable
        ? `<UserDeliveryPreferenceArray>${SUBSCRIBED_EVENTS.map((event) => `<NotificationEnable><EventType>${event}</EventType><EventEnable>Enable</EventEnable></NotificationEnable>`).join('')}</UserDeliveryPreferenceArray>`
        : '';
    return '<?xml version="1.0" encoding="utf-8"?>'
        + '<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        + application + events
        + '</SetNotificationPreferencesRequest>';
}
export function buildNotificationAdminProgram(dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const getAccessToken = dependencies.getAccessToken
        ?? createProductionDispatchTokenProvider();
    const getAppCredentials = dependencies.getAppCredentials
        ?? (async () => {
            const loaded = await loadEbayCredentials();
            return Object.freeze({
                devId: loaded.devId, appId: loaded.appId, certId: loaded.certId,
            });
        });
    async function boundedTradingCall(callName, body) {
        const token = await getAccessToken();
        // Notification preferences are APPLICATION-level calls: unlike the
        // listing calls, eBay requires the three application credential headers
        // alongside the user token, and rejects the call without them.
        const credentials = await getAppCredentials();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(EBAY_TRADING_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml',
                    'X-EBAY-API-COMPATIBILITY-LEVEL': COMPATIBILITY_LEVEL,
                    'X-EBAY-API-CALL-NAME': callName,
                    'X-EBAY-API-SITEID': '0',
                    'X-EBAY-API-IAF-TOKEN': token,
                    'X-EBAY-API-DEV-NAME': credentials.devId,
                    'X-EBAY-API-APP-NAME': credentials.appId,
                    'X-EBAY-API-CERT-NAME': credentials.certId,
                },
                body,
                redirect: 'error',
                signal: controller.signal,
            });
            const text = await response.text();
            if (response.status !== 200
                || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                deny('NOTIFICATION_CALL_FAILED');
            }
            if (!/(<Ack>Success<\/Ack>|<Ack>Warning<\/Ack>)/u.test(text)) {
                // Carry eBay's NUMERIC error code only -- never message text, which
                // can contain caller- or account-identifying detail.
                const errorCode = /<ErrorCode>([0-9]{1,8})<\/ErrorCode>/u.exec(text)?.[1];
                deny(errorCode
                    ? `NOTIFICATION_CALL_REJECTED_EBAY_${errorCode}`
                    : 'NOTIFICATION_CALL_REJECTED');
            }
            return text;
        }
        catch (error) {
            if (error instanceof NotificationAdminError)
                throw error;
            return deny('NOTIFICATION_CALL_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    const requireScope = (supplied) => {
        if (supplied !== deriveScopeKey(MIGRATION_SCOPE)) {
            deny('NOTIFICATION_SCOPE_CONFIRMATION_MISMATCH');
        }
    };
    const program = new Command();
    program
        .name('notification-admin')
        .description('Operator ceremony for eBay Platform Notification preferences')
        .showHelpAfterError();
    program
        .command('show')
        .description('READ-ONLY: print the current application notification preferences')
        .action(async () => {
        try {
            const text = await boundedTradingCall('GetNotificationPreferences', '<?xml version="1.0" encoding="utf-8"?>'
                + '<GetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
                + '<PreferenceLevel>Application</PreferenceLevel>'
                + '</GetNotificationPreferencesRequest>');
            const url = /<ApplicationURL>([^<]{0,512})<\/ApplicationURL>/u.exec(text)?.[1] ?? null;
            const enabled = /<ApplicationEnable>([A-Za-z]{1,16})<\/ApplicationEnable>/u.exec(text)?.[1] ?? null;
            const events = [...text.matchAll(/<EventType>([A-Za-z]{1,64})<\/EventType>\s*<EventEnable>Enable<\/EventEnable>/gu)].map((match) => match[1]);
            io.stdout(JSON.stringify({
                command: 'show', applicationEnable: enabled, applicationUrl: url,
                enabledEvents: events, externalWritesPerformed: 0,
            }));
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'show', status: 'denied',
                code: error instanceof NotificationAdminError ? error.code : 'NOTIFICATION_DENIED',
            }));
            io.setExitCode(1);
        }
    });
    program
        .command('subscribe')
        .description('Point eBay Platform Notifications at the read-only receiver (one provider write)')
        .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
        .requiredOption('--notification-url <url>', 'Exact https receiver URL ending in /webhooks/ebay/notifications')
        .requiredOption('--confirm-subscribe', 'Literal acknowledgement that this enables push delivery to the URL')
        .action(async (options) => {
        try {
            requireScope(options.confirmScope);
            if (!SAFE_URL.test(options.notificationUrl))
                deny('NOTIFICATION_URL_INVALID');
            await boundedTradingCall('SetNotificationPreferences', buildSetPreferencesXml({ enable: true, notificationUrl: options.notificationUrl }));
            io.stdout(JSON.stringify({
                command: 'subscribe', status: 'subscribed',
                notificationUrl: options.notificationUrl,
                events: SUBSCRIBED_EVENTS,
                externalWritesPerformed: 1,
            }));
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'subscribe', status: 'denied',
                code: error instanceof NotificationAdminError ? error.code : 'NOTIFICATION_DENIED',
            }));
            io.setExitCode(1);
        }
    });
    program
        .command('unsubscribe')
        .description('Disable application push delivery (one provider write)')
        .requiredOption('--confirm-scope <sha256>', 'Exact migration scope key confirming the store')
        .requiredOption('--confirm-unsubscribe', 'Literal acknowledgement')
        .action(async (options) => {
        try {
            requireScope(options.confirmScope);
            await boundedTradingCall('SetNotificationPreferences', buildSetPreferencesXml({ enable: false, notificationUrl: null }));
            io.stdout(JSON.stringify({
                command: 'unsubscribe', status: 'unsubscribed', externalWritesPerformed: 1,
            }));
        }
        catch (error) {
            io.stderr(JSON.stringify({
                command: 'unsubscribe', status: 'denied',
                code: error instanceof NotificationAdminError ? error.code : 'NOTIFICATION_DENIED',
            }));
            io.setExitCode(1);
        }
    });
    return program;
}
