import { Command } from 'commander';
export type SandboxCanaryIo = {
    stdout(message: string): void;
    stderr(message: string): void;
    setExitCode(code: number): void;
};
export type Dependencies = {
    io?: SandboxCanaryIo;
    stdin?: NodeJS.ReadableStream;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    uuid?: () => string;
};
export declare function buildSandboxListingCanaryProgram(deps?: Dependencies): Command;
