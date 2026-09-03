import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, Banner, BlockStack, Card, InlineGrid, InlineStack, Text, } from '@shopify/polaris';
import { booleanPolicyState } from '../evidence';
import { MIGRATION_RESPONSIBILITIES } from '../../safety/responsibilities.js';
const BASELINE_RESPONSIBILITIES = ['orderImport', 'price', 'inventory'];
const ALL_RESPONSIBILITIES = MIGRATION_RESPONSIBILITIES;
const LABELS = {
    orderImport: 'eBay → Shopify orders',
    price: 'Price sync',
    inventory: 'Inventory sync',
    listingCreate: 'Listing creation',
    listingRevise: 'Listing revision',
    listingEndRelist: 'Listing end / relist',
    mapping: 'Listing mapping',
    fulfillment: 'Fulfillment',
    feedback: 'Buyer feedback',
    reconciliation: 'Reconciliation',
};
export const humanize = (value) => {
    if (!value)
        return 'Unavailable';
    return value
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
};
export const responsibilityLabel = (responsibility) => LABELS[responsibility] ?? humanize(responsibility);
export const findResponsibility = (status, responsibility) => status?.responsibilities?.find((item) => item.responsibility === responsibility);
export const MigrationSafetyBanner = ({ status, error }) => {
    const baselinePolicyAccepted = BASELINE_RESPONSIBILITIES.every((responsibility) => {
        const item = findResponsibility(status, responsibility);
        return (item?.owner === 'marketplace-connect' &&
            item.writesAllowed === false &&
            ['disabled', 'read-only'].includes(item.productPipelineAccess));
    });
    const safelyQuarantined = status?.quarantine?.enabled === true &&
        Boolean(status.quarantine.channels?.length) &&
        status.externalWritesAllowed === false &&
        status.historicalBackfillAllowed === false &&
        status.cutoverWatermarkUtc === null &&
        baselinePolicyAccepted;
    if (!status || error) {
        return (_jsx(Banner, { tone: "critical", title: "Migration safety state unavailable", children: _jsx(Text, { as: "p", children: "Shopify and eBay writes remain blocked. Local draft availability is shown on each listing." }) }));
    }
    const backfill = booleanPolicyState(status.historicalBackfillAllowed, { safe: 'blocked', unsafe: 'allowed' });
    const watermark = status.cutoverWatermarkUtc === undefined
        ? 'unavailable'
        : status.cutoverWatermarkUtc === null
            ? 'not established'
            : status.cutoverWatermarkUtc;
    const remoteParity = status.remoteVerification === undefined
        ? 'unavailable'
        : status.remoteVerification === 'not-performed'
            ? 'not verified'
            : humanize(status.remoteVerification).toLowerCase();
    return (_jsx(Banner, { tone: safelyQuarantined ? 'success' : 'critical', title: safelyQuarantined
            ? 'Shadow mode — Shopify and eBay writes are blocked'
            : 'Provider-write quarantine is not verified', children: _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "p", children: baselinePolicyAccepted
                        ? 'Accepted ownership policy assigns orders, price, and inventory to Marketplace Connect. This is policy, not current cross-platform parity evidence.'
                        : 'The required Marketplace Connect ownership policy is unavailable or inconsistent. Shopify and eBay write actions remain blocked.' }), _jsx(Text, { as: "p", tone: "subdued", children: "Local draft availability is shown on each listing." }), _jsxs(Text, { as: "p", tone: "subdued", children: ["Historical order backfill: ", backfill.label.toLowerCase(), " \u00B7 Cutover watermark: ", watermark, " \u00B7 Remote parity: ", remoteParity] })] }) }));
};
export const OwnershipCards = ({ status, includeAll = false }) => {
    const keys = includeAll ? ALL_RESPONSIBILITIES : BASELINE_RESPONSIBILITIES;
    return (_jsx(InlineGrid, { columns: { xs: 1, sm: 3 }, gap: "300", children: keys.map((responsibility) => {
            const item = findResponsibility(status, responsibility);
            const owner = item?.owner;
            const access = item?.productPipelineAccess;
            return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { variant: "headingSm", as: "h3", children: responsibilityLabel(responsibility) }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", tone: "subdued", children: "Accepted policy owner" }), _jsx(Badge, { tone: owner === 'marketplace-connect' ? 'attention' : 'critical', children: owner === 'marketplace-connect' ? 'Marketplace Connect' : humanize(owner ?? 'unverified') })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", tone: "subdued", children: "ProductPipeline policy" }), _jsx(Badge, { tone: access ? 'info' : 'critical', children: humanize(access) })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", tone: "subdued", children: "Provider writes" }), _jsx(Badge, { tone: item?.writesAllowed === false ? 'success' : 'critical', children: item?.writesAllowed === false
                                        ? 'Blocked'
                                        : item?.writesAllowed === true
                                            ? 'Allowed'
                                            : 'Unavailable' })] })] }) }, responsibility));
        }) }));
};
