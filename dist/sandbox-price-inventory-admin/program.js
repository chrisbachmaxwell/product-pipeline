import { Command } from 'commander';
import { SANDBOX_ALIGNMENT_SCOPE, SANDBOX_ALIGNMENT_SCOPE_DIGEST, SandboxAlignmentError, assertDigest, assertEbay, assertSource, assertTarget, classifyObserved, deny, deriveManifest, digest, } from './contracts.js';
import { createSandboxAlignmentAdapters } from './adapters.js';
import { readSandboxManifest, validateTarget } from '../sandbox-listing-canary-admin/manifest.js';
import { initializeSandboxAlignmentStore, openSandboxAlignmentStore, } from './store.js';
const APPROVAL_TTL_MS = 10 * 60_000;
const defaultIo = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    setExitCode: (value) => { process.exitCode = value; },
};
function exactAction(value) {
    if (value !== 'price-align' && value !== 'quantity-seed' && value !== 'quantity-align') {
        deny('ACTION_INVALID');
    }
    return value;
}
function target(options) {
    const value = { sku: options.sku, offerId: options.offerId, listingId: options.listingId };
    assertTarget(value);
    return value;
}
function iso(date) {
    if (!Number.isFinite(date.getTime()))
        deny('TIME_INVALID');
    return date.toISOString();
}
function emit(io, value, exitCode = 0) {
    io.stdout(JSON.stringify(value));
    io.setExitCode(exitCode);
}
function safeCode(error) {
    return error instanceof SandboxAlignmentError ? error.code : 'SANDBOX_ALIGNMENT_DENIED';
}
async function capture(adapters, exactTarget) {
    const source = await adapters.readShopifySource();
    assertSource(source);
    const ebay = await adapters.readEbayState(exactTarget);
    assertEbay(ebay, exactTarget);
    return { source, ebay };
}
function withStore(openStore, storePath, operation) {
    const store = openStore(storePath);
    try {
        return operation(store);
    }
    finally {
        store.close();
    }
}
export function buildSandboxPriceInventoryProgram(dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    const now = dependencies.now ?? (() => new Date());
    const openStore = dependencies.openStore ?? openSandboxAlignmentStore;
    const initializeStore = dependencies.initializeStore ?? initializeSandboxAlignmentStore;
    const createAdapters = dependencies.createAdapters ?? (() => createSandboxAlignmentAdapters({ now }));
    const program = new Command();
    program.name('sandbox-price-inventory-admin')
        .description('Isolated exact-target eBay Sandbox price/inventory ceremony')
        .showHelpAfterError(false)
        .showSuggestionAfterError(false)
        .exitOverride();
    program.command('scope').description('Print the immutable nonsecret Sandbox scope digest')
        .action(() => emit(io, { command: 'scope', status: 'ok', scopeDigest: SANDBOX_ALIGNMENT_SCOPE_DIGEST, externalWritesPerformed: 0 }));
    program.command('init').requiredOption('--store <absolute-path>')
        .requiredOption('--confirm-scope <sha256>')
        .action((options) => {
        const store = initializeStore(options.store, options.confirmScope, iso(now()));
        try {
            emit(io, { command: 'init', status: 'initialized', ...store.verify(), externalWritesPerformed: 0 });
        }
        finally {
            store.close();
        }
    });
    program.command('verify').requiredOption('--store <absolute-path>')
        .action((options) => {
        const result = withStore(openStore, options.store, (store) => store.verify());
        emit(io, { command: 'verify', status: 'verified', ...result, externalWritesPerformed: 0 });
    });
    const addTarget = (command) => command
        .requiredOption('--store <absolute-path>')
        .requiredOption('--sku <exact-sku>')
        .requiredOption('--offer-id <exact-id>')
        .requiredOption('--listing-id <exact-id>');
    addTarget(program.command('preflight'))
        .requiredOption('--action <price-align|quantity-seed|quantity-align>')
        .requiredOption('--listing-provenance-digest <sha256>')
        .requiredOption('--listing-manifest-file <absolute-path>')
        .requiredOption('--shopify-evidence-digest <sha256>')
        .action(async (options) => {
        const exactTarget = target(options);
        const action = exactAction(options.action);
        assertDigest(options.listingProvenanceDigest);
        const createTarget = validateTarget({
            storeDomain: SANDBOX_ALIGNMENT_SCOPE.shopify.storeDomain,
            productGid: SANDBOX_ALIGNMENT_SCOPE.shopify.productId,
            variantGid: SANDBOX_ALIGNMENT_SCOPE.shopify.variantId,
            sku: SANDBOX_ALIGNMENT_SCOPE.shopify.sku,
            shopifyEvidenceDigest: options.shopifyEvidenceDigest,
        });
        const createManifest = readSandboxManifest(options.listingManifestFile, createTarget);
        if (createManifest.digest !== options.listingProvenanceDigest)
            deny('LISTING_PROVENANCE_MISMATCH');
        const adapters = await createAdapters();
        const state = await capture(adapters, exactTarget);
        const derived = deriveManifest({ action, listingProvenanceDigest: options.listingProvenanceDigest,
            target: exactTarget, source: state.source, ebay: state.ebay });
        withStore(openStore, options.store, (store) => store.recordIntent(derived.manifestDigest, derived.manifest, iso(now())));
        emit(io, {
            command: 'preflight', status: 'approval-required', action,
            manifestDigest: derived.manifestDigest, before: derived.manifest.before, after: derived.manifest.after,
            sourceDigest: derived.manifest.sourceDigest, externalWritesPerformed: 0,
        }, 2);
    });
    program.command('approve').requiredOption('--store <absolute-path>')
        .requiredOption('--manifest-digest <sha256>')
        .requiredOption('--confirm-action <price-align|quantity-seed|quantity-align>')
        .action((options) => {
        const action = exactAction(options.confirmAction);
        const instant = now();
        const expiresAt = new Date(instant.getTime() + APPROVAL_TTL_MS).toISOString();
        const approval = withStore(openStore, options.store, (store) => {
            const intent = store.getIntent(options.manifestDigest);
            if (intent.manifest.action !== action)
                deny('APPROVAL_ACTION_MISMATCH');
            return store.approve(options.manifestDigest, iso(instant), expiresAt);
        });
        emit(io, { command: 'approve', status: 'approved', ...approval, manifestDigest: options.manifestDigest,
            expiresAtUtc: expiresAt, externalWritesPerformed: 0 });
    });
    addTarget(program.command('dispatch')).requiredOption('--manifest-digest <sha256>')
        .requiredOption('--approval-token <exact-token>').requiredOption('--approval-digest <sha256>')
        .action(async (options) => {
        const exactTarget = target(options);
        assertDigest(options.manifestDigest);
        const store = openStore(options.store);
        let writes = 0;
        try {
            const intent = store.getIntent(options.manifestDigest);
            if (intent.status === 'resolved')
                deny('ATTEMPT_ALREADY_RESOLVED');
            if (JSON.stringify(intent.manifest.target) !== JSON.stringify(exactTarget))
                deny('EXACT_TARGET_MISMATCH');
            const adapters = await createAdapters();
            const state = await capture(adapters, exactTarget);
            const rederived = deriveManifest({
                action: intent.manifest.action,
                listingProvenanceDigest: intent.manifest.listingProvenanceDigest,
                target: exactTarget, source: state.source, ebay: state.ebay,
            });
            if (rederived.manifestDigest !== options.manifestDigest)
                deny('MANIFEST_MOVED');
            const attemptId = store.beginDispatch(options.manifestDigest, options.approvalToken, options.approvalDigest, iso(now()));
            let providerOutcome = 'unknown';
            try {
                writes = 1;
                dependencies.onWriteAttempt?.();
                if (intent.manifest.action === 'price-align') {
                    await adapters.updatePrice(exactTarget, intent.manifest.after.price);
                }
                else {
                    await adapters.updateQuantity(exactTarget, intent.manifest.after.quantity);
                }
                providerOutcome = 'reported-success';
            }
            catch {
                providerOutcome = 'unknown';
            }
            store.markReconciliationRequired(options.manifestDigest, providerOutcome, iso(now()));
            let effect = 'read_unavailable';
            try {
                const fresh = await adapters.readEbayState(exactTarget);
                effect = classifyObserved(intent.manifest, fresh);
                store.recordObservation(options.manifestDigest, effect, digest(fresh), iso(now()));
            }
            catch {
                // Unknown response and unavailable read are intentionally left for
                // the zero-write reconcile command. Never retry the write.
            }
            emit(io, { command: 'dispatch', status: effect === 'effect_observed' ? 'reconciled' : 'unresolved',
                manifestDigest: options.manifestDigest, attemptId, providerOutcome, effect,
                resolution: effect === 'effect_observed' ? 'resolved-existing' : null,
                externalWritesPerformed: writes }, effect === 'effect_observed' ? 0 : 2);
        }
        finally {
            store.close();
        }
    });
    addTarget(program.command('reconcile')).requiredOption('--manifest-digest <sha256>')
        .action(async (options) => {
        const exactTarget = target(options);
        const store = openStore(options.store);
        try {
            let intent = store.getIntent(options.manifestDigest);
            if (intent.status === 'resolved')
                deny('ATTEMPT_ALREADY_RESOLVED');
            if (intent.status === 'dispatching') {
                store.markReconciliationRequired(options.manifestDigest, 'unknown', iso(now()));
                intent = store.getIntent(options.manifestDigest);
            }
            if (intent.status !== 'reconciliation_required')
                deny('RECONCILIATION_STATE_CONFLICT');
            if (JSON.stringify(intent.manifest.target) !== JSON.stringify(exactTarget))
                deny('EXACT_TARGET_MISMATCH');
            const adapters = await createAdapters();
            const fresh = await adapters.readEbayState(exactTarget);
            const effect = classifyObserved(intent.manifest, fresh);
            const observationId = store.recordObservation(options.manifestDigest, effect, digest(fresh), iso(now()));
            emit(io, { command: 'reconcile', status: effect === 'effect_observed' ? 'reconciled' : 'unresolved',
                manifestDigest: options.manifestDigest, attemptId: intent.attemptId, observationId, effect,
                resolution: effect === 'effect_observed' ? 'resolved-existing' : null, externalWritesPerformed: 0 }, effect === 'effect_observed' ? 0 : 2);
        }
        finally {
            store.close();
        }
    });
    program.configureOutput({ writeOut: (value) => io.stdout(value.trimEnd()), writeErr: (value) => io.stderr(value.trimEnd()) });
    return program;
}
export async function runSandboxPriceInventoryAdmin(argv, dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    let writeAttempted = false;
    try {
        await buildSandboxPriceInventoryProgram({
            ...dependencies,
            onWriteAttempt: () => {
                writeAttempted = true;
                dependencies.onWriteAttempt?.();
            },
        }).parseAsync(argv, { from: 'user' });
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error
            && error.code === 'commander.helpDisplayed')
            return;
        io.stdout(JSON.stringify({ command: argv[0] ?? 'unknown', status: 'denied', code: safeCode(error),
            externalWritesPerformed: writeAttempted ? 'unknown' : 0 }));
        io.setExitCode(1);
    }
}
export { SANDBOX_ALIGNMENT_SCOPE, SANDBOX_ALIGNMENT_SCOPE_DIGEST };
