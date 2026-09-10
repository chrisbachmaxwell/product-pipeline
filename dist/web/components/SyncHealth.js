import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Badge, BlockStack, Button, Card, Collapsible, InlineStack, Text, } from '@shopify/polaris';
import { useOperationalMonitoring } from '../hooks/useApi';
const Row = ({ label, children }) => (_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { as: "span", children: label }), children] }));
/**
 * The system's health in operator words. The raw counters exist behind a
 * collapsible for debugging conversations; nothing on the surface uses
 * internal vocabulary, digests, or milestone codes.
 */
export const SyncHealth = () => {
    const monitoring = useOperationalMonitoring();
    const [showDetails, setShowDetails] = useState(false);
    const data = monitoring.data;
    if (monitoring.isLoading || !data)
        return null;
    const catalog = data.health.catalogRead;
    const store = data.health.migrationStore === 'verified' && data.health.auditChain === 'verified';
    const writes = data.dailyDigest.writes;
    const shadow = data.dailyDigest.shadow;
    return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsx(Text, { as: "h3", variant: "headingMd", children: "Sync health" }), _jsx(Row, { label: "eBay connection", children: catalog === 'current'
                        ? _jsx(Badge, { tone: "success", children: "Live" })
                        : catalog === 'pending'
                            ? _jsx(Badge, { tone: "attention", children: "Refreshing" })
                            : _jsx(Badge, { tone: "critical", children: "Trouble reading eBay" }) }), _jsx(Row, { label: "Change history", children: store ? _jsx(Badge, { tone: "success", children: "Intact" }) : _jsx(Badge, { tone: "attention", children: "Being verified" }) }), writes.performed > 0 && (_jsx(Row, { label: "Updates sent to eBay (last day)", children: _jsxs(Text, { as: "span", children: [writes.succeeded, " of ", writes.performed, " confirmed", writes.unresolved > 0 ? ` · ${writes.unresolved} still confirming` : ''] }) })), shadow.observedCount > 0 && (_jsx(Row, { label: "eBay orders in Shopify", children: _jsxs(Text, { as: "span", children: [shadow.matchedCount, " of ", shadow.observedCount, " confirmed"] }) })), _jsx(Button, { variant: "plain", onClick: () => setShowDetails((current) => !current), ariaExpanded: showDetails, ariaControls: "sync-health-details", children: showDetails ? 'Hide technical details' : 'Technical details' }), _jsx(Collapsible, { id: "sync-health-details", open: showDetails, children: _jsxs(BlockStack, { gap: "100", children: [_jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["status ", data.status, " \u00B7 unresolved jobs ", data.counters.unresolvedJobs, " \u00B7 failed jobs ", data.counters.failedJobs, " \u00B7 reconciliation exceptions", ' ', data.counters.reconciliationExceptions, " \u00B7 catalog read failures", ' ', data.counters.catalogReadFailures, " \u00B7 shadow unmatched", ' ', data.counters.shadowUnmatchedOrders, " \u00B7 blocked ", data.counters.shadowBlockedOrders] }), _jsxs(Text, { as: "p", variant: "bodySm", tone: "subdued", children: ["digest window ", data.dailyDigest.dateUtc ?? '—', " \u00B7 generated ", data.generatedAtUtc] })] }) })] }) }));
};
export default SyncHealth;
