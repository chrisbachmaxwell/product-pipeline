import { Command } from 'commander';
export type OperatorIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
export declare function buildOperatorProgram(io?: OperatorIo): Command;
