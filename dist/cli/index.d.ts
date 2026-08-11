#!/usr/bin/env node
import { Command } from 'commander';
/**
 * The legacy CLI previously exposed live sync/import/publish commands. During
 * shadow mode its executable is intentionally reduced to a read-only status
 * surface. Local reconciliation lives in the isolated `operator` CLI.
 */
export declare function buildLegacyCli(): Command;
