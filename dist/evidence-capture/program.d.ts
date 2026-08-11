import { Command } from 'commander';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { runEvidenceCapturePreflight, runEvidenceCollection, verifyLocalEvidenceArtifact, type EvidenceCaptureRuntimeBuildIdentity } from './capture.js';
import type { EvidenceFetch } from './network.js';
export type EvidenceCaptureIo = Readonly<{
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
}>;
export type EvidenceCaptureProgramDependencies = Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    fetch: EvidenceFetch;
    now: () => Date;
    inspectRuntimeBuild: (repositoryRoot: string) => EvidenceCaptureRuntimeBuildIdentity;
    preflight?: typeof runEvidenceCapturePreflight;
    collect?: typeof runEvidenceCollection;
    verify?: typeof verifyLocalEvidenceArtifact;
}>;
export type EvidenceCaptureGitExecutor = (executable: string, arguments_: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
export declare function inspectEvidenceCaptureRuntimeBuild(repositoryRoot: string, execute?: EvidenceCaptureGitExecutor): EvidenceCaptureRuntimeBuildIdentity;
export declare function buildEvidenceCaptureProgram(io?: EvidenceCaptureIo, dependencies?: EvidenceCaptureProgramDependencies): Command;
