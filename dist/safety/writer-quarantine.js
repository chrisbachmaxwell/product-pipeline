export const WRITER_QUARANTINE_CODE = 'WRITER_QUARANTINED';
export const MARKETPLACE_CONNECT_BASELINE = Object.freeze({
    policyVersion: 1,
    phase: 'marketplace-connect-incumbent',
    effectiveMode: 'shadow-read-only',
    externalWritesAllowed: false,
    historicalBackfillAllowed: false,
    cutoverWatermarkUtc: null,
    remoteVerification: 'not-performed',
    responsibilities: Object.freeze({
        orderImport: Object.freeze({
            owner: 'marketplace-connect',
            productPipelineAccess: 'disabled',
            writesAllowed: false,
        }),
        price: Object.freeze({
            owner: 'marketplace-connect',
            productPipelineAccess: 'read-only',
            writesAllowed: false,
        }),
        inventory: Object.freeze({
            owner: 'marketplace-connect',
            productPipelineAccess: 'read-only',
            writesAllowed: false,
        }),
        listingLifecycle: Object.freeze({
            owner: 'unverified',
            productPipelineAccess: 'read-only',
            writesAllowed: false,
        }),
        fulfillment: Object.freeze({
            owner: 'unverified',
            productPipelineAccess: 'read-only',
            writesAllowed: false,
        }),
    }),
    quarantineChannels: Object.freeze([
        'api',
        'shopify-webhooks',
        'ebay-webhooks',
        'scheduler',
        'legacy-cli',
        'authentication-routes',
        'ebay-adapter',
        'shopify-order-adapter',
        'shopify-inventory-adapter',
    ]),
});
export class WriterQuarantinedError extends Error {
    code = WRITER_QUARANTINE_CODE;
    responsibility;
    operation;
    incumbentOwner;
    constructor(responsibility, operation) {
        super(`ProductPipeline ${operation} is quarantined in shadow mode; a separately authorized responsibility cutover is required`);
        this.name = 'WriterQuarantinedError';
        this.responsibility = responsibility;
        this.operation = operation;
        this.incumbentOwner = ['orderImport', 'price', 'inventory'].includes(responsibility)
            ? 'marketplace-connect'
            : 'unverified';
    }
    toResponse() {
        return {
            error: 'ProductPipeline is in shadow read-only mode',
            code: this.code,
            responsibility: this.responsibility,
            operation: this.operation,
            incumbentOwner: this.incumbentOwner,
            effectiveMode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
            externalWritesAllowed: false,
            historicalBackfillAllowed: false,
            cutoverWatermarkUtc: null,
            requiredDecision: 'separately-authorized-cutover',
        };
    }
}
/**
 * The current migration phase has no runtime override. Every call fails before
 * credentials, databases, platform reads, or writes are reached.
 */
export function denyExternalWrite(responsibility, operation) {
    throw new WriterQuarantinedError(responsibility, operation);
}
export function responsibilityForApiPath(pathname) {
    if (/order|sync\/trigger|cleanup/i.test(pathname))
        return 'orderImport';
    if (/price/i.test(pathname))
        return 'price';
    if (/inventory/i.test(pathname))
        return 'inventory';
    if (/fulfill/i.test(pathname))
        return 'fulfillment';
    if (/listing|product|draft|mapping|template|image|pipeline|watcher|tim/i.test(pathname)) {
        return 'listingLifecycle';
    }
    return 'externalCommerce';
}
export function isReadOnlyHttpMethod(method) {
    return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
/** Default-deny every state-changing API method during shadow mode. */
export function writerQuarantineMiddleware(req, res, next) {
    if (isReadOnlyHttpMethod(req.method)) {
        next();
        return;
    }
    const error = new WriterQuarantinedError(responsibilityForApiPath(req.originalUrl || req.path), `${req.method.toUpperCase()} ${req.originalUrl || req.path}`);
    res.status(423).json(error.toResponse());
}
export function getMigrationPolicyStatus(observedAt = new Date().toISOString()) {
    return {
        phase: MARKETPLACE_CONNECT_BASELINE.phase,
        effectiveMode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
        externalWritesAllowed: false,
        historicalBackfillAllowed: false,
        cutoverWatermarkUtc: null,
        remoteVerification: MARKETPLACE_CONNECT_BASELINE.remoteVerification,
        observedAt,
        responsibilities: Object.entries(MARKETPLACE_CONNECT_BASELINE.responsibilities).map(([responsibility, policy]) => ({ responsibility, ...policy })),
        quarantine: {
            enabled: true,
            channels: [...MARKETPLACE_CONNECT_BASELINE.quarantineChannels],
            runtimeOverrideAvailable: false,
        },
    };
}
