import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersError } from "@smithers/errors";
/** @typedef {import("./FindDbWaitOptions.ts").FindDbWaitOptions} FindDbWaitOptions */

/**
 * Walk from `from` (default: cwd) upward looking for smithers.db.
 * Returns the absolute path to the database file.
 *
 * @param {string} [from]
 * @returns {string}
 */
export function findSmithersDb(from) {
    let dir = resolve(from ?? process.cwd());
    const root = resolve("/");
    while (true) {
        const candidate = resolve(dir, "smithers.db");
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir || dir === root) {
            throw new SmithersError("CLI_DB_NOT_FOUND", "No smithers.db found. Run this command from a directory containing a smithers.db, or use 'smithers up <workflow>' to start a run first.");
        }
        dir = parent;
    }
}
/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @returns {Promise<string>}
 */
export async function waitForSmithersDb(from, opts = {}) {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
    const intervalMs = Math.max(1, opts.intervalMs ?? 100);
    const startedAt = Date.now();
    while (true) {
        try {
            return findSmithersDb(from);
        }
        catch (err) {
            if (!(err instanceof SmithersError) || err.code !== "CLI_DB_NOT_FOUND") {
                throw err;
            }
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= timeoutMs) {
                throw err;
            }
            await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
        }
    }
}
/**
 * Open a smithers.db file and return a SmithersDb adapter with cleanup function.
 *
 * @param {string} dbPath
 * @returns {Promise<{ adapter: SmithersDb; cleanup: () => void }>}
 */
export async function openSmithersDb(dbPath) {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        adapter: new SmithersDb(db),
        cleanup: () => {
            try {
                sqlite.close();
            }
            catch { }
        },
    };
}
/**
 * Find and open the nearest smithers.db.
 *
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @returns {Promise<{ adapter: SmithersDb; dbPath: string; cleanup: () => void }>}
 */
export async function findAndOpenDb(from, opts) {
    const dbPath = await waitForSmithersDb(from, opts);
    const { adapter, cleanup } = await openSmithersDb(dbPath);
    return { adapter, dbPath, cleanup };
}
