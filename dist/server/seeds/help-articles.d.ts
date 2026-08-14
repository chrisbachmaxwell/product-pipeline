/**
 * Help article seed — upserts FAQ articles for all shipped features.
 *
 * Idempotent: uses INSERT OR IGNORE by question text.
 * The current shadow server does not run seeds at startup. Keep this source
 * aligned for the separately administered Help database.
 *
 * ## Help Documentation Rule
 * When shipping a new feature, add an article here:
 *   1. Add an entry to the `articles` array below.
 *   2. Use the appropriate category string.
 *   3. Write the answer in clear, concise language with step-by-step instructions.
 */
import type Database from 'better-sqlite3';
/**
 * Seed help articles into the help_questions table.
 * Uses INSERT OR IGNORE so existing articles are never overwritten.
 * Safe to call on every server startup.
 */
export declare function seedHelpArticles(db: InstanceType<typeof Database>): void;
