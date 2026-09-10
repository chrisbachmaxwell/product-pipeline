export const WRITER_QUARANTINE_CODE = 'WRITER_QUARANTINED';
export const MARKETPLACE_CONNECT_BASELINE = Object.freeze({
    // DESCRIPTION vs ENFORCEMENT: `owner` and `productPipelineAccess` describe
    // who runs each responsibility and are updated when ownership ceremonies
    // transfer it. `writesAllowed`, `externalWritesAllowed`, and the quarantine
    // remain the ENFORCEMENT truth about THIS SERVER PROCESS: it mounts no
    // provider writers, ever — every write happens in the standalone ceremony
    // CLIs. Those fields stay false permanently and must never be edited to
    // reflect ceremony-side capability.
    policyVersion: 2,
    phase: 'product-pipeline-steady-state',
    effectiveMode: 'shadow-read-only',
    externalWritesAllowed: false,
    historicalBackfillAllowed: false,
    // The permanent order watermark established 2026-09-08 (G13 cutover).
    cutoverWatermarkUtc: '2026-09-08T21:50:00.000Z',
    remoteVerification: 'not-performed',
    responsibilities: Object.freeze({
        orderImport: Object.freeze({
            // Ownership v3, permanent watermark 2026-09-08T21:50Z (G13 cutover).
            // Imports run via order-import-admin ceremonies; the server-side
            // trigger only SPAWNS them — no writer is mounted in this process.
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        price: Object.freeze({
            // Ownership 2026-09-01; MC "Sync price" recorded off 2026-09-08
            // (correction — the toggle was found alive after being recorded off).
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        inventory: Object.freeze({
            // Ownership 2026-09-01; MC "Sync inventory" confirmed off 2026-09-03.
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        listingCreate: Object.freeze({
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        listingRevise: Object.freeze({
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        listingEndRelist: Object.freeze({
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        mapping: Object.freeze({
            owner: 'unverified',
            productPipelineAccess: 'read-only',
            writesAllowed: false,
        }),
        fulfillment: Object.freeze({
            // Ownership v3 established 2026-09-09; tracking pushes run via the
            // fulfillment-tracking-admin ceremonies.
            owner: 'product-pipeline',
            productPipelineAccess: 'ceremony',
            writesAllowed: false,
        }),
        feedback: Object.freeze({
            owner: 'unverified',
            productPipelineAccess: 'read-only',
            writesAllowed: false,
        }),
        reconciliation: Object.freeze({
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
    if (/feedback/i.test(pathname))
        return 'feedback';
    if (/mapping/i.test(pathname))
        return 'mapping';
    if (/end|relist|withdraw/i.test(pathname))
        return 'listingEndRelist';
    if (/create|publish|draft/i.test(pathname))
        return 'listingCreate';
    if (/listing|product|template|image|pipeline|watcher|tim/i.test(pathname))
        return 'listingRevise';
    return 'externalCommerce';
}
export function isReadOnlyHttpMethod(method) {
    return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
/** One local-only append exception. It grants no provider or publish authority. */
export function isExactLocalDraftAppend(method, originalUrl) {
    return method === 'POST' && originalUrl === '/api/listing-draft';
}
/** Default-deny every state-changing API method during shadow mode. */
export function writerQuarantineMiddleware(req, res, next) {
    if (isReadOnlyHttpMethod(req.method)) {
        next();
        return;
    }
    if (isExactLocalDraftAppend(req.method, req.originalUrl || '')) {
        next();
        return;
    }
    const error = new WriterQuarantinedError(responsibilityForApiPath(req.originalUrl || req.path), `${req.method.toUpperCase()} ${req.originalUrl || req.path}`);
    res.status(423).json(error.toResponse());
}
export function getMigrationPolicyStatus(servedAt = new Date().toISOString()) {
    return {
        phase: MARKETPLACE_CONNECT_BASELINE.phase,
        effectiveMode: MARKETPLACE_CONNECT_BASELINE.effectiveMode,
        externalWritesAllowed: false,
        historicalBackfillAllowed: false,
        cutoverWatermarkUtc: MARKETPLACE_CONNECT_BASELINE.cutoverWatermarkUtc,
        remoteVerification: MARKETPLACE_CONNECT_BASELINE.remoteVerification,
        servedAt,
        responsibilities: Object.entries(MARKETPLACE_CONNECT_BASELINE.responsibilities).map(([responsibility, policy]) => ({ responsibility, ...policy })),
        quarantine: {
            enabled: true,
            channels: [...MARKETPLACE_CONNECT_BASELINE.quarantineChannels],
            runtimeOverrideAvailable: false,
        },
    };
}
