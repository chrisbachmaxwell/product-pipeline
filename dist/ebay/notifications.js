import { getValidEbayToken } from './token-manager.js';
import { loadEbayCredentials } from '../config/credentials.js';
import { info, error as logError } from '../utils/logger.js';
import { denyExternalWrite } from '../safety/writer-quarantine.js';
const EBAY_TRADING_API = 'https://api.ebay.com/ws/api.dll';
/**
 * Subscribe to eBay Platform Notifications.
 * Uses the Trading API SetNotificationPreferences call.
 */
export async function subscribeToNotifications(notificationUrl) {
    denyExternalWrite('externalCommerce', 'change eBay notification preferences');
    const token = await getValidEbayToken();
    if (!token)
        throw new Error('No valid eBay token');
    const creds = await loadEbayCredentials();
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <ApplicationDeliveryPreferences>
    <ApplicationEnable>Enable</ApplicationEnable>
    <ApplicationURL>${escapeXml(notificationUrl)}</ApplicationURL>
    <DeviceType>Platform</DeviceType>
  </ApplicationDeliveryPreferences>
  <UserDeliveryPreferenceArray>
    <NotificationEnable>
      <EventType>FixedPriceTransaction</EventType>
      <EventEnable>Enable</EventEnable>
    </NotificationEnable>
    <NotificationEnable>
      <EventType>AuctionCheckoutComplete</EventType>
      <EventEnable>Enable</EventEnable>
    </NotificationEnable>
    <NotificationEnable>
      <EventType>ItemSold</EventType>
      <EventEnable>Enable</EventEnable>
    </NotificationEnable>
    <NotificationEnable>
      <EventType>BestOffer</EventType>
      <EventEnable>Enable</EventEnable>
    </NotificationEnable>
  </UserDeliveryPreferenceArray>
</SetNotificationPreferencesRequest>`;
    const response = await fetch(EBAY_TRADING_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
            'X-EBAY-API-DEV-NAME': creds.devId,
            'X-EBAY-API-APP-NAME': creds.appId,
            'X-EBAY-API-CERT-NAME': creds.certId,
            'X-EBAY-API-CALL-NAME': 'SetNotificationPreferences',
            'X-EBAY-API-SITEID': '0',
        },
        body: xmlBody,
    });
    const responseText = await response.text();
    if (responseText.includes('<Ack>Success</Ack>') || responseText.includes('<Ack>Warning</Ack>')) {
        info(`[eBay Notifications] Successfully subscribed to: ${notificationUrl}`);
    }
    else {
        logError(`[eBay Notifications] Subscription failed: ${responseText.substring(0, 500)}`);
        throw new Error('Failed to subscribe to eBay notifications');
    }
}
/**
 * Get current notification preferences from eBay.
 */
export async function getNotificationPreferences() {
    const token = await getValidEbayToken();
    if (!token)
        throw new Error('No valid eBay token');
    const creds = await loadEbayCredentials();
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <PreferenceLevel>Application</PreferenceLevel>
</GetNotificationPreferencesRequest>`;
    const response = await fetch(EBAY_TRADING_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
            'X-EBAY-API-DEV-NAME': creds.devId,
            'X-EBAY-API-APP-NAME': creds.appId,
            'X-EBAY-API-CERT-NAME': creds.certId,
            'X-EBAY-API-CALL-NAME': 'GetNotificationPreferences',
            'X-EBAY-API-SITEID': '0',
        },
        body: xmlBody,
    });
    return await response.text();
}
/**
 * Unsubscribe from all eBay Platform Notifications.
 */
export async function unsubscribeFromNotifications() {
    denyExternalWrite('externalCommerce', 'change eBay notification preferences');
    const token = await getValidEbayToken();
    if (!token)
        throw new Error('No valid eBay token');
    const creds = await loadEbayCredentials();
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <ApplicationDeliveryPreferences>
    <ApplicationEnable>Disable</ApplicationEnable>
  </ApplicationDeliveryPreferences>
</SetNotificationPreferencesRequest>`;
    const response = await fetch(EBAY_TRADING_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
            'X-EBAY-API-DEV-NAME': creds.devId,
            'X-EBAY-API-APP-NAME': creds.appId,
            'X-EBAY-API-CERT-NAME': creds.certId,
            'X-EBAY-API-CALL-NAME': 'SetNotificationPreferences',
            'X-EBAY-API-SITEID': '0',
        },
        body: xmlBody,
    });
    const responseText = await response.text();
    if (responseText.includes('<Ack>Success</Ack>')) {
        info('[eBay Notifications] Unsubscribed from all notifications');
    }
    else {
        logError(`[eBay Notifications] Unsubscribe failed: ${responseText.substring(0, 500)}`);
    }
}
function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
