import { Command } from 'commander';
import { type BackupPlatform } from './core.js';
type Io = {
    out: (value: string) => void;
    error: (value: string) => void;
    exit: (code: number) => void;
};
export declare function buildControlStateBackupProgram(io?: Io, platform?: BackupPlatform): Command;
export {};
