import { Command } from 'commander';
import { verifyAuditLog } from './audit.js';
import { RESPONSIBILITIES, validateRepositoryRoot } from './config.js';
import { runOperatorInspection, type OperatorInspection } from './preflight.js';
import {
  runSnapshotReconciliation,
  type ReconciliationResult,
} from './reconciliation.js';

export type OperatorIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  setExitCode: (code: number) => void;
};

const defaultIo: OperatorIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

function printInspection(result: OperatorInspection, json: boolean, io: OperatorIo): void {
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }

  io.stdout(`Operator ${result.command}: ${result.status.toUpperCase()}`);
  io.stdout('Safety: read-only, dry-run, no network, no external writes, no order import/backfill');
  io.stdout(
    `Declared target (not remotely verified): ${result.declaredIdentity.shopifyStoreDomain} / ${result.declaredIdentity.ebayEnvironment}:${result.declaredIdentity.ebaySellerAccount}`,
  );
  io.stdout('Ownership:');
  for (const responsibility of RESPONSIBILITIES) {
    const entry = result.ownership[responsibility];
    io.stdout(
      `  ${responsibility}: owner=${entry.currentOwner}; ProductPipeline=${entry.productPipelineAccess}`,
    );
  }
  if (result.blockers.length > 0) {
    io.stdout('Blockers:');
    result.blockers.forEach((blocker) => io.stdout(`  - ${blocker}`));
  }
  io.stdout(`Audit: ${result.audit.path} #${result.audit.sequence} ${result.audit.recordHash}`);
}

function addInspectionCommand(program: Command, commandName: 'preflight' | 'ownership', io: OperatorIo) {
  program
    .command(commandName)
    .description(
      commandName === 'preflight'
        ? 'Validate a local shadow-mode configuration and record the decision'
        : 'Print the declared responsibility ownership matrix and blockers',
    )
    .requiredOption('--config <path>', 'Repository-local nonsecret operator config')
    .option('--repo-root <path>', 'ProductPipeline repository root', '.')
    .option('--dry-run', 'Required safety posture; always enabled', true)
    .option('--json', 'Emit one JSON object')
    .action(
      async (options: {
        config: string;
        repoRoot: string;
        dryRun: boolean;
        json?: boolean;
      }) => {
        if (options.dryRun !== true) {
          io.stderr('Denied: dry-run cannot be disabled');
          io.setExitCode(1);
          return;
        }
        try {
          const result = await runOperatorInspection({
            command: commandName,
            repoRoot: options.repoRoot,
            configPath: options.config,
          });
          printInspection(result, Boolean(options.json), io);
          if (result.status === 'blocked') io.setExitCode(2);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Operator command denied';
          io.stderr(options.json ? JSON.stringify({ command: commandName, status: 'denied', error: message }) : message);
          io.setExitCode(1);
        }
      },
    );
}

function printReconciliation(result: ReconciliationResult, json: boolean, io: OperatorIo): void {
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }

  io.stdout(`Operator reconcile: ${result.status.toUpperCase()}`);
  io.stdout(
    'Evidence: supplied snapshots only; no network, application database, external writes, order creation, or historical backfill',
  );
  io.stdout('Live proof: NO; production parity: NO; order creation eligible: NO');
  io.stdout(`Generated: ${result.generatedAtUtc}`);
  io.stdout(
    `Observed: ${result.counts.shopifyVariants} Shopify variant(s), ${result.counts.ebayListings} eBay listing(s), ${result.counts.ebayOrders} eBay order(s)`,
  );
  if (result.discrepancies.length > 0) {
    io.stdout(`Exceptions (${result.discrepancies.length}):`);
    result.discrepancies.forEach((item) =>
      io.stdout(
        `  - [${item.severity}] ${item.code}: ${item.entityKey} (owner=${item.owner}) — ${item.summary}`,
      ),
    );
  }
  io.stdout(`Snapshot digest: ${result.snapshot.digest}`);
  io.stdout(`Result digest: ${result.resultDigest}`);
  io.stdout(`Audit: ${result.audit.path} #${result.audit.sequence} ${result.audit.recordHash}`);
}

export function buildOperatorProgram(io: OperatorIo = defaultIo): Command {
  const program = new Command();
  program
    .name('product-pipeline-operator')
    .description(
      'Local-only ProductPipeline migration controls. This CLI has no network or commerce mutation adapter.',
    )
    .version('0.1.0')
    .showHelpAfterError();

  addInspectionCommand(program, 'preflight', io);
  addInspectionCommand(program, 'ownership', io);

  program
    .command('reconcile')
    .description('Compare a bounded, redacted repository-local shadow snapshot without external access')
    .requiredOption('--config <path>', 'Repository-local nonsecret operator config')
    .requiredOption(
      '--snapshot <path>',
      'Redacted JSON snapshot beneath .local/operator-reconciliation/',
    )
    .option('--repo-root <path>', 'ProductPipeline repository root', '.')
    .option('--dry-run', 'Required safety posture; always enabled', true)
    .option('--json', 'Emit one JSON object')
    .action(
      async (options: {
        config: string;
        snapshot: string;
        repoRoot: string;
        dryRun: boolean;
        json?: boolean;
      }) => {
        if (options.dryRun !== true) {
          io.stderr('Denied: dry-run cannot be disabled');
          io.setExitCode(1);
          return;
        }
        try {
          const result = await runSnapshotReconciliation({
            repoRoot: options.repoRoot,
            configPath: options.config,
            snapshotPath: options.snapshot,
          });
          printReconciliation(result, Boolean(options.json), io);
          if (result.status === 'exceptions-found') io.setExitCode(2);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Reconciliation denied';
          io.stderr(
            options.json
              ? JSON.stringify({ command: 'reconcile', status: 'denied', error: message })
              : message,
          );
          io.setExitCode(1);
        }
      },
    );

  const audit = program.command('audit').description('Inspect the local tamper-evident audit chain');
  audit
    .command('verify')
    .description('Verify every hash link in a repository-local JSONL audit log')
    .requiredOption('--file <path>', 'Repository-local audit JSONL path')
    .option('--repo-root <path>', 'ProductPipeline repository root', '.')
    .option('--json', 'Emit one JSON object')
    .action(async (options: { file: string; repoRoot: string; json?: boolean }) => {
      try {
        const repoRoot = await validateRepositoryRoot(options.repoRoot);
        const verification = await verifyAuditLog(repoRoot, options.file, false);
        if (options.json) io.stdout(JSON.stringify(verification));
        else if (verification.valid) {
          io.stdout(
            `Audit valid: ${verification.recordCount} record(s); head=${verification.headHash ?? 'none'}`,
          );
        } else {
          io.stderr(`Audit invalid: ${verification.error ?? 'unknown integrity failure'}`);
        }
        if (!verification.valid) io.setExitCode(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Audit verification failed';
        io.stderr(options.json ? JSON.stringify({ command: 'audit verify', status: 'denied', error: message }) : message);
        io.setExitCode(1);
      }
    });

  return program;
}
