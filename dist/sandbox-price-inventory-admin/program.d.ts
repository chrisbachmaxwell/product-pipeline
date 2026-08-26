import { Command } from 'commander';
import { SANDBOX_ALIGNMENT_SCOPE, SANDBOX_ALIGNMENT_SCOPE_DIGEST } from './contracts.js';
import { type SandboxAlignmentAdapters } from './adapters.js';
import { initializeSandboxAlignmentStore, openSandboxAlignmentStore } from './store.js';
export type SandboxAlignmentIo = Readonly<{
    stdout: (value: string) => void;
    stderr: (value: string) => void;
    setExitCode: (value: number) => void;
}>;
export type SandboxAlignmentDependencies = Readonly<{
    createAdapters?: () => SandboxAlignmentAdapters | Promise<SandboxAlignmentAdapters>;
    openStore?: typeof openSandboxAlignmentStore;
    initializeStore?: typeof initializeSandboxAlignmentStore;
    now?: () => Date;
    io?: SandboxAlignmentIo;
    onWriteAttempt?: () => void;
}>;
export declare function buildSandboxPriceInventoryProgram(dependencies?: SandboxAlignmentDependencies): Command;
export declare function runSandboxPriceInventoryAdmin(argv: string[], dependencies?: SandboxAlignmentDependencies): Promise<void>;
export { SANDBOX_ALIGNMENT_SCOPE, SANDBOX_ALIGNMENT_SCOPE_DIGEST };
