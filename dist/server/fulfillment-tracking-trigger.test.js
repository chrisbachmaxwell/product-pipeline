import { describe, expect, it } from 'vitest';
import { createFulfillmentTrackingTrigger } from './fulfillment-tracking-trigger.js';
const DISCOVER = ['dist/fulfillment-tracking-admin/index.js', 'discover', '--lookback-hours', '48', '--max-orders', '20'];
const PREFLIGHT = ['dist/fulfillment-tracking-admin/index.js', 'preflight', '--shopify-order-gid', '{shopifyOrderGid}', '--shopify-fulfillment-gid', '{fulfillmentGid}', '--ebay-order-id', '{ebayOrderId}'];
const DISPATCH = ['dist/fulfillment-tracking-admin/index.js', 'dispatch', '--shopify-order-gid', '{shopifyOrderGid}', '--shopify-fulfillment-gid', '{fulfillmentGid}', '--ebay-order-id', '{ebayOrderId}', '--manifest-digest', '{manifestDigest}', '--migration-store', '/data/x'];
const CANDIDATE = {
    ebayOrderId: '11-15140-20146',
    shopifyOrderGid: 'gid://shopify/Order/7941384143139',
    shopifyFulfillmentGid: 'gid://shopify/Fulfillment/5555555555',
};
const MANIFEST = `sha256:${'a'.repeat(64)}`;
function harness(outputs) {
    const calls = [];
    const warns = [];
    const trigger = createFulfillmentTrackingTrigger({
        discoverArgv: DISCOVER,
        preflightArgv: PREFLIGHT,
        dispatchArgv: DISPATCH,
        runStep: async (argv) => {
            calls.push([...argv]);
            const command = argv[1];
            if (command === 'discover')
                return { json: outputs.discover ?? null };
            if (command === 'preflight')
                return { json: outputs.preflight ?? null };
            return { json: outputs.dispatch ?? null };
        },
        setTicker: () => { },
    });
    return { trigger, calls, warns };
}
describe('fulfillment tracking trigger', () => {
    it('is inert without all three argvs', () => {
        const trigger = createFulfillmentTrackingTrigger({
            discoverArgv: null, preflightArgv: PREFLIGHT, dispatchArgv: DISPATCH,
            runStep: async () => { throw new Error('must not run'); },
            setTicker: () => { throw new Error('must not schedule'); },
        });
        expect(trigger.armed).toBe(false);
        trigger.startSchedule();
    });
    it('chains discover -> preflight -> dispatch with substituted, validated values', async () => {
        const h = harness({
            discover: { candidates: [CANDIDATE] },
            preflight: { status: 'preview', manifestDigest: MANIFEST },
            dispatch: { status: 'dispatched-and-reconciled' },
        });
        await h.trigger.runCycle();
        expect(h.calls).toHaveLength(3);
        expect(h.calls[1]).toContain(CANDIDATE.shopifyOrderGid);
        expect(h.calls[1]).toContain(CANDIDATE.ebayOrderId);
        expect(h.calls[2]).toContain(MANIFEST);
        expect(h.calls[2].join(' ')).not.toContain('{');
    });
    it('drops candidates whose identifiers fail the strict grammars', async () => {
        const h = harness({
            discover: { candidates: [
                    { ...CANDIDATE, ebayOrderId: 'DROP TABLE orders' },
                    { ...CANDIDATE, shopifyOrderGid: 'gid://shopify/Order/../secret' },
                    { ...CANDIDATE, shopifyFulfillmentGid: 'not-a-gid' },
                ] },
        });
        await h.trigger.runCycle();
        expect(h.calls).toHaveLength(1); // discover only
    });
    it('treats link-required and already-recorded as quiet skips, not failures', async () => {
        // Discovery over-reports by design: incumbent-era orders and repeats are
        // refused by the ceremony and must not spam the log as failures.
        const h = harness({
            discover: { candidates: [CANDIDATE] },
            preflight: { status: 'denied', code: 'FULFILLMENT_ALREADY_RECORDED' },
        });
        await h.trigger.runCycle();
        expect(h.calls).toHaveLength(2); // discover + preflight, no dispatch
    });
    it('never dispatches without a valid manifest digest from preflight', async () => {
        const h = harness({
            discover: { candidates: [CANDIDATE] },
            preflight: { status: 'preview', manifestDigest: 'sha256:short' },
        });
        await h.trigger.runCycle();
        expect(h.calls).toHaveLength(2);
    });
});
