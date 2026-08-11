import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { runEvidenceCapturePreflight, runEvidenceCollection, verifyLocalEvidenceArtifact, } from './capture.js';
import { EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH, loadEvidenceCaptureConfig, } from './config.js';
const defaultIo = Object.freeze({
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
    setExitCode: (code) => {
        process.exitCode = code;
    },
});
const defaultDependencies = Object.freeze({
    environment: process.env,
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => new Date(),
    inspectRuntimeBuild: inspectEvidenceCaptureRuntimeBuild,
});
const COLLECTOR_RELEVANT_GIT_PATHS = Object.freeze([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'src/evidence-capture',
    'dist/evidence-capture',
]);
export function inspectEvidenceCaptureRuntimeBuild(repositoryRoot, execute = execFileSync) {
    // This non-executing validation must complete before Git can inspect repository state.
    const loaded = loadEvidenceCaptureConfig({
        repositoryRoot,
        requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
    });
    const commandOptions = {
        cwd: loaded.repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
            LANG: 'C',
            LC_ALL: 'C',
            GIT_OPTIONAL_LOCKS: '0',
        },
    };
    const gitPrefix = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
    const headCommit = execute('/usr/bin/git', [...gitPrefix, 'rev-parse', 'HEAD'], commandOptions).trim();
    const status = execute('/usr/bin/git', [
        ...gitPrefix,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        ...COLLECTOR_RELEVANT_GIT_PATHS,
    ], commandOptions).trim();
    return Object.freeze({ headCommit, collectorTreeClean: status.length === 0 });
}
function safeError(error) {
    return error instanceof Error
        ? error.message
        : 'Evidence capture command failed closed';
}
function printPreflight(result, json, io) {
    if (json) {
        io.stdout(JSON.stringify(result));
        return;
    }
    io.stdout(`Evidence preflight: ${result.status.toUpperCase()}`);
    io.stdout('Network performed: NO; remote authority verified: NO');
    io.stdout(`Lane: ${result.lane}; scope: ${result.scopeDigest}`);
    io.stdout(`Local authority: Shopify=${result.sourceReadiness.shopify ? 'valid' : 'blocked'}; eBay=${result.sourceReadiness.ebay ? 'valid' : 'blocked'}`);
    result.blockers.forEach((blocker) => io.stdout(`Blocker: ${blocker}`));
    io.stdout('Safety: zero external writes; no order import; no historical backfill; no cutover claim');
    io.stdout('Cutover blocker: immutable historical config, key, and build verification context is not archived');
}
function printCollection(result, json, io) {
    if (json) {
        io.stdout(JSON.stringify(result));
        return;
    }
    io.stdout(`Evidence collect: ${result.status.toUpperCase()} (${result.source})`);
    io.stdout(`Artifact: ${result.artifact.relativePath}`);
    io.stdout(`Artifact digest: ${result.artifact.digest}`);
    io.stdout(`Counts: primary=${result.counts.primary}; secondary=${result.counts.secondary}; orders=${result.counts.orders}`);
    io.stdout('Safety: read-only network calls; zero external writes; no import/backfill; parity and cutover remain false');
}
function printVerification(result, json, io) {
    if (json) {
        io.stdout(JSON.stringify(result));
        return;
    }
    io.stdout(`Evidence verify: ${result.status.toUpperCase()} (${result.source})`);
    io.stdout(`Signature/schema: valid; freshness=${result.freshness}`);
    io.stdout(`Artifact digest: ${result.artifactDigest}`);
    io.stdout(`Counts: primary=${result.counts.primary}; secondary=${result.counts.secondary}; orders=${result.counts.orders}`);
    io.stdout(`Current read evidence: ${result.currentReadEvidence ? 'YES' : 'NO'}; parity use allowed: NO`);
    io.stdout('Safety: zero external writes; no import/backfill; parity and cutover remain false');
}
export function buildEvidenceCaptureProgram(io = defaultIo, dependencies = defaultDependencies) {
    const preflight = dependencies.preflight ?? runEvidenceCapturePreflight;
    const collect = dependencies.collect ?? runEvidenceCollection;
    const verify = dependencies.verify ?? verifyLocalEvidenceArtifact;
    const program = new Command();
    program
        .name('product-pipeline-evidence-capture')
        .description('Bounded authoritative-read evidence capture. It cannot import orders, mutate commerce, refresh OAuth, or claim cutover parity.')
        .version('0.1.0')
        .showHelpAfterError();
    program
        .command('preflight')
        .description('Validate fixed local configuration and ephemeral authority without network access')
        .option('--repo-root <path>', 'ProductPipeline repository root', '.')
        .option('--json', 'Emit one safe summary object')
        .action((options) => {
        try {
            const result = preflight({
                repositoryRoot: options.repoRoot,
                environment: dependencies.environment,
                now: dependencies.now,
                runtimeBuild: dependencies.inspectRuntimeBuild(options.repoRoot),
            });
            printPreflight(result, Boolean(options.json), io);
            if (result.status === 'blocked')
                io.setExitCode(2);
        }
        catch (error) {
            io.stderr(options.json
                ? JSON.stringify({ command: 'preflight', status: 'denied', error: safeError(error) })
                : safeError(error));
            io.setExitCode(1);
        }
    });
    program
        .command('collect')
        .description('Perform one bounded Shopify or eBay authoritative read and write one signed local artifact')
        .requiredOption('--source <shopify|ebay>', 'Exact authoritative source')
        .requiredOption('--confirm-scope <sha256>', 'Exact scope digest printed by preflight')
        .requiredOption('--orders-start <utc>', 'Inclusive canonical UTC lower bound')
        .requiredOption('--orders-end <utc>', 'Exclusive canonical UTC upper bound')
        .option('--repo-root <path>', 'ProductPipeline repository root', '.')
        .option('--json', 'Emit one safe summary object')
        .action(async (options) => {
        try {
            const result = await collect({
                repositoryRoot: options.repoRoot,
                environment: dependencies.environment,
                fetch: dependencies.fetch,
                source: options.source,
                confirmScopeDigest: options.confirmScope,
                orderStartUtc: options.ordersStart,
                orderEndUtc: options.ordersEnd,
                now: dependencies.now,
                runtimeBuild: dependencies.inspectRuntimeBuild(options.repoRoot),
            });
            printCollection(result, Boolean(options.json), io);
        }
        catch (error) {
            io.stderr(options.json
                ? JSON.stringify({ command: 'collect', status: 'denied', error: safeError(error) })
                : safeError(error));
            io.setExitCode(1);
        }
    });
    program
        .command('verify')
        .description('Verify one fixed local signed artifact; never performs network access')
        .requiredOption('--artifact <path>', 'Exact .local/evidence-capture artifact path emitted by collect')
        .option('--repo-root <path>', 'ProductPipeline repository root', '.')
        .option('--json', 'Emit one safe summary object')
        .action((options) => {
        try {
            const result = verify({
                repositoryRoot: options.repoRoot,
                requestedArtifactPath: options.artifact,
                now: dependencies.now,
                runtimeBuild: dependencies.inspectRuntimeBuild(options.repoRoot),
            });
            printVerification(result, Boolean(options.json), io);
            if (!result.currentReadEvidence)
                io.setExitCode(2);
        }
        catch (error) {
            io.stderr(options.json
                ? JSON.stringify({ command: 'verify', status: 'denied', error: safeError(error) })
                : safeError(error));
            io.setExitCode(1);
        }
    });
    return program;
}
