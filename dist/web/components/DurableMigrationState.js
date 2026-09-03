import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge, BlockStack, Card, InlineGrid, InlineStack, Text, } from '@shopify/polaris';
import { durableMigrationStateView } from '../migration-state';
import { humanize } from './MigrationSafety';
const count = (counts, key) => counts[key] ?? 0;
const CountMetric = ({ label, value }) => (_jsx(Card, { children: _jsxs(BlockStack, { gap: "100", children: [_jsx(Text, { as: "p", tone: "subdued", children: label }), _jsx(Text, { variant: "headingMd", as: "p", children: value.toLocaleString() })] }) }));
export const DurableMigrationState = ({ status, compact }) => {
    const state = status?.migrationState;
    const view = durableMigrationStateView(status);
    const scope = view.locallyVerified ? state?.scope : null;
    const audit = view.locallyVerified ? state?.audit : null;
    const counts = view.counts;
    if (compact) {
        const relevantCounts = compact === 'listings'
            ? [
                ['External identities', count(counts, 'externalIdentities')],
                ['Ownership versions', count(counts, 'ownershipVersions')],
                ['Reconciliation runs', count(counts, 'reconciliationRuns')],
            ]
            : [
                ['Order observations', count(counts, 'orderObservations')],
                ['Order links', count(counts, 'orderLinks')],
                ['Eligible for creation', view.eligibleOrderCount],
            ];
        return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Local durable state" }), _jsx(Badge, { tone: view.available ? 'info' : 'critical', children: view.statusLabel })] }), _jsx(Text, { as: "p", tone: "subdued", children: "These are inert local control-plane counts, not current Shopify, eBay, or Marketplace Connect records and not production parity proof." }), _jsx(InlineGrid, { columns: { xs: 1, sm: 3 }, gap: "300", children: relevantCounts.map(([label, value]) => (_jsx(CountMetric, { label: label, value: value }, label))) })] }) }));
    }
    const blockerCount = Array.isArray(state?.readiness?.blockers)
        ? state.readiness.blockers.length
        : 1;
    return (_jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [_jsx(Text, { variant: "headingMd", as: "h2", children: "Local durable migration state" }), _jsx(Badge, { tone: view.available ? 'info' : 'critical', children: view.statusLabel })] }), _jsx(Text, { as: "p", children: "This is ProductPipeline's inert local control-plane state. It is not authoritative Shopify, eBay, or Marketplace Connect truth and cannot authorize a canary or cutover." }), scope ? (_jsxs(BlockStack, { gap: "100", children: [_jsxs(Text, { as: "p", tone: "subdued", children: ["Shopify scope: ", scope.shopifyStoreDomain ?? 'Unavailable'] }), _jsxs(Text, { as: "p", tone: "subdued", children: ["eBay scope: ", scope.ebayEnvironment ?? 'Unavailable', " \u00B7 ", scope.ebayMarketplaceId ?? 'Unavailable'] })] })) : (_jsx(Text, { as: "p", tone: "critical", children: "No verified local durable scope is available. ProductPipeline remains fail-closed." })), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 4 }, gap: "300", children: [_jsx(CountMetric, { label: "External identities", value: count(counts, 'externalIdentities') }), _jsx(CountMetric, { label: "Order observations", value: count(counts, 'orderObservations') }), _jsx(CountMetric, { label: "Reconciliation runs", value: count(counts, 'reconciliationRuns') }), _jsx(CountMetric, { label: "Audit records", value: audit?.recordCount ?? 0 })] }), _jsxs(InlineGrid, { columns: { xs: 1, sm: 2, md: 4 }, gap: "300", children: [_jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", children: "Audit chain" }), _jsx(Badge, { tone: audit?.valid === true ? 'info' : 'critical', children: audit?.valid === true ? 'Locally verified' : 'Unavailable' })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", children: "Eligible orders" }), _jsx(Badge, { tone: "info", children: "0" })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", children: "Canary authorized" }), _jsx(Badge, { tone: "critical", children: "No" })] }), _jsxs(InlineStack, { gap: "200", blockAlign: "center", children: [_jsx(Text, { as: "span", children: "Cutover authorized" }), _jsx(Badge, { tone: "critical", children: "No" })] })] }), _jsxs(Text, { as: "p", tone: "subdued", children: [blockerCount.toLocaleString(), " local readiness ", blockerCount === 1 ? 'blocker' : 'blockers', " \u00B7 Schema ", state?.schemaVersion ?? 'unavailable', " \u00B7 ", humanize(state?.status)] })] }) }));
};
