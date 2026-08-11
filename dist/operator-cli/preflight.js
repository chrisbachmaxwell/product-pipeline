import path from 'node:path';
import { appendAuditRecord, DEFAULT_AUDIT_LOG_PATH, } from './audit.js';
import { evaluateReadiness, loadOperatorConfig, RESPONSIBILITIES, sha256Digest, validateRepositoryRoot, } from './config.js';
function checksFor(blockers) {
    return [
        { id: 'config.schema-valid', result: 'pass' },
        { id: 'safety.read-only', result: 'pass' },
        { id: 'safety.dry-run', result: 'pass' },
        { id: 'safety.external-writes-disabled', result: 'pass' },
        { id: 'safety.order-import-disabled', result: 'pass' },
        { id: 'safety.historical-backfill-disabled', result: 'pass' },
        { id: 'safety.cutover-watermark-inactive', result: 'pass' },
        {
            id: 'ownership.no-unverified-declarations',
            result: blockers.length === 0 ? 'pass' : 'block',
        },
        {
            id: 'test-lane.inactive',
            result: 'pass',
        },
    ];
}
export async function runOperatorInspection(options) {
    const repoRoot = await validateRepositoryRoot(options.repoRoot);
    let loaded;
    try {
        loaded = await loadOperatorConfig(repoRoot, options.configPath);
    }
    catch (error) {
        const denial = {
            command: options.command,
            lane: 'unavailable',
            mode: 'unavailable',
            outcome: 'denied',
            configDigest: null,
            target: {
                shopifyStoreDomain: null,
                ebayEnvironment: null,
                ebaySellerAccount: null,
                marketplaceConnectAccount: null,
            },
            ownershipDigest: null,
            checks: [{ id: 'config.schema-valid', result: 'deny' }],
        };
        try {
            await appendAuditRecord(repoRoot, DEFAULT_AUDIT_LOG_PATH, denial, {
                now: options.now,
                createRunId: options.createRunId,
            });
        }
        catch (auditError) {
            const reason = error instanceof Error ? error.message : 'Operator config denied';
            const auditReason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
            throw new Error(`${reason}; denial audit failed: ${auditReason}`);
        }
        throw error;
    }
    const blockers = evaluateReadiness(loaded.config);
    const outcome = blockers.length === 0 ? 'passed' : 'blocked';
    const event = {
        command: options.command,
        lane: loaded.config.lane,
        mode: loaded.config.mode,
        outcome,
        configDigest: loaded.digest,
        target: loaded.config.identities,
        ownershipDigest: sha256Digest(loaded.config.ownership),
        checks: checksFor(blockers),
    };
    const auditRecord = await appendAuditRecord(repoRoot, loaded.config.audit.logPath, event, {
        now: options.now,
        createRunId: options.createRunId,
    });
    return {
        command: options.command,
        status: blockers.length === 0 ? 'configuration-safe' : 'blocked',
        guarantees: {
            mode: 'read-only',
            dryRun: true,
            externalNetworkAccess: false,
            externalWrites: false,
            historicalBackfill: false,
            orderImportEnabled: false,
        },
        declaredIdentity: loaded.config.identities,
        identityProof: 'configuration-only',
        ownership: Object.fromEntries(RESPONSIBILITIES.map((responsibility) => [
            responsibility,
            loaded.config.ownership[responsibility],
        ])),
        blockers,
        config: {
            path: path.relative(repoRoot, loaded.configPath),
            digest: loaded.digest,
        },
        audit: {
            path: loaded.config.audit.logPath,
            sequence: auditRecord.sequence,
            recordHash: auditRecord.recordHash,
        },
    };
}
