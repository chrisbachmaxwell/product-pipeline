/**
 * Query-only projection of the migration store's order poll/import state for
 * the isolated order-import operator CLI. The canonical store API deliberately
 * exposes no observation/page/link getters, so this reader opens its own
 * strictly read-only (SQLite `query_only`) handle to answer the CLI's
 * pre-checks: has an order already been observed, is it linked, which page is
 * still unadvanced, and where does the durable cursor stand. It contains no
 * write statement of any kind and returns only identifiers, timestamps, flags,
 * and counts — never customer data (the store persists none).
 */
import Database from 'better-sqlite3';
export function openOrderImportStateReader(input) {
    const database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    try {
        database.pragma('busy_timeout = 5000');
        database.pragma('query_only = ON');
        if (database.pragma('query_only', { simple: true }) !== 1) {
            throw new Error('SQLite query_only could not be enforced');
        }
    }
    catch (error) {
        database.close();
        throw error;
    }
    const scopeKey = input.scopeKey;
    return Object.freeze({
        getObservationByIdentity: (ebayOrderIdentityKey) => {
            const row = database.prepare(`SELECT observation.observation_id AS observationId,
           observation.eligible_after_watermark AS eligible,
           observation.source_created_at_utc AS sourceCreatedAtUtc,
           resolution.disposition AS disposition
         FROM order_observations observation
         LEFT JOIN order_observation_resolutions resolution
           ON resolution.observation_id = observation.observation_id
         WHERE observation.scope_key = ? AND observation.ebay_order_identity_key = ?
         ORDER BY observation.observed_epoch_ms DESC LIMIT 1`).get(scopeKey, ebayOrderIdentityKey);
            return row
                ? Object.freeze({
                    observationId: row.observationId,
                    eligibleAfterWatermark: row.eligible === 1,
                    sourceCreationDateUtc: row.sourceCreatedAtUtc,
                    resolved: row.disposition !== null,
                    resolutionDisposition: row.disposition,
                })
                : null;
        },
        getOrderLinkByIdentity: (ebayOrderIdentityKey) => {
            const row = database.prepare(`SELECT link_id AS linkId, link_kind AS linkKind FROM order_links
         WHERE scope_key = ? AND ebay_order_identity_key = ? LIMIT 1`).get(scopeKey, ebayOrderIdentityKey);
            return row ? Object.freeze({ linkId: row.linkId, linkKind: row.linkKind }) : null;
        },
        getCurrentCursor: () => {
            const row = database.prepare(`SELECT ordinal, cursor_value AS cursorValue FROM cursor_advances
         WHERE scope_key = ? ORDER BY ordinal DESC LIMIT 1`).get(scopeKey);
            return row ? Object.freeze({ ordinal: row.ordinal, cursorValue: row.cursorValue }) : null;
        },
        getUnadvancedPage: () => {
            const row = database.prepare(`SELECT page.page_id AS pageId, page.cursor_after AS cursorAfter,
           (SELECT COUNT(*) FROM order_observations observation
            WHERE observation.page_id = page.page_id) AS observedCount,
           (SELECT COUNT(*) FROM order_observations observation
            JOIN order_observation_resolutions resolution
              ON resolution.observation_id = observation.observation_id
            WHERE observation.page_id = page.page_id) AS resolvedCount
         FROM order_pages page
         LEFT JOIN cursor_advances advance ON advance.page_id = page.page_id
         WHERE page.scope_key = ? AND advance.page_id IS NULL LIMIT 1`).get(scopeKey);
            return row
                ? Object.freeze({
                    pageId: row.pageId,
                    cursorAfter: row.cursorAfter,
                    observedCount: row.observedCount,
                    resolvedCount: row.resolvedCount,
                })
                : null;
        },
        close: () => {
            database.close();
        },
    });
}
