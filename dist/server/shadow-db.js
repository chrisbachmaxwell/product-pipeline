import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
export function applicationDatabasePath() {
    return process.env.DATABASE_PATH || path.join(os.homedir(), '.clawdbot', 'ebaysync.db');
}
/**
 * Open the existing ProductPipeline ledger without creating a file, schema,
 * migration, seed row, journal policy, or write-capable connection.
 */
export function openShadowDatabase(databasePath = applicationDatabasePath()) {
    const database = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
    });
    try {
        database.pragma('query_only = ON');
        const queryOnly = database.pragma('query_only', { simple: true });
        if (queryOnly !== 1) {
            throw new Error('SQLite query_only could not be enforced');
        }
        return database;
    }
    catch (error) {
        database.close();
        throw error;
    }
}
