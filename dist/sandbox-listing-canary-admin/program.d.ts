import { Command } from 'commander';
import { type SandboxSnapshot } from './adapter.js';
import { type SandboxListingManifest } from './manifest.js';
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
export declare function assertSandboxCreatedState(snapshot: SandboxSnapshot, offerId: string, listingId: string, manifest: SandboxListingManifest): void;
type RecoveryStage = 'created' | 'inventory_only' | 'inventory_only_ended' | 'offer_unpublished' | 'offer_unpublished_ended' | 'absent' | 'cleaned' | 'drift';
type RecoveryDiscovery = {
    stage: RecoveryStage;
    offerId: string | null;
    listingId: string | null;
};
export declare function discoverSandboxRecovery(snapshot: SandboxSnapshot, manifest: SandboxListingManifest): RecoveryDiscovery;
export declare function buildSandboxListingCanaryProgram(deps?: Dependencies): Command;
export {};
