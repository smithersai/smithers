import { SmithersDb } from "@smithers/db/adapter";
export type FindDbWaitOptions = {
    timeoutMs?: number;
    intervalMs?: number;
};
/**
 * Walk from `from` (default: cwd) upward looking for smithers.db.
 * Returns the absolute path to the database file.
 */
export declare function findSmithersDb(from?: string): string;
export declare function waitForSmithersDb(from?: string, opts?: FindDbWaitOptions): Promise<string>;
/**
 * Open a smithers.db file and return a SmithersDb adapter with cleanup function.
 */
export declare function openSmithersDb(dbPath: string): Promise<{
    adapter: SmithersDb;
    cleanup: () => void;
}>;
/**
 * Find and open the nearest smithers.db.
 */
export declare function findAndOpenDb(from?: string, opts?: FindDbWaitOptions): Promise<{
    adapter: SmithersDb;
    dbPath: string;
    cleanup: () => void;
}>;
