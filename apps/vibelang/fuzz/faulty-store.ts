// Stays .ts: SqlStorage.exec fails by throwing synchronously, and VibeLang code never throws outside effect code.
//
// An engine-store fault for steered fuzz targets: a faulty storage service, never request interception.
import type { Storage } from "../worker/Objects.vibe"

/**
 * The object's storage whose SQL statements matching `fail`'s pattern throw, as a reset or full SQLite does. Key-value
 * reads and writes pass through. `fail(pattern, skip)` lets the first `skip` matching statements run; `fail()` heals.
 * `log` holds every statement's text (no parameters), so a target can count what one healthy request runs.
 */
/** @throws {never} */
export function faultyStore(storage: Storage) {
  let failing: RegExp | undefined
  let skipped = 0
  let faults = 0
  const log: Array<string> = []
  const sql = {
    exec: (query: string, ...params: Array<string>) => {
      log.push(query)
      if (failing !== undefined && failing.test(query) && skipped-- <= 0) {
        faults += 1
        throw new Error("engine store unavailable")
      }
      return storage.sql.exec(query, ...params)
    },
  }
  return {
    storage: { ...storage, sql } as unknown as Storage,
    /** @throws {never} */
    fail: (pattern?: RegExp, skip = 0): void => { failing = pattern; skipped = skip },
    /** @throws {never} */
    faults: (): number => faults,
    log: log as ReadonlyArray<string>,
  }
}
