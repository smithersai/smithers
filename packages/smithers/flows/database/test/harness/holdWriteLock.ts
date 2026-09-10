/**
 * Holds a SQLite file's write lock from a detached `node:sqlite` connection,
 * as a peer process mid-transaction would hold it.
 *
 * `BEGIN EXCLUSIVE` takes the lock synchronously and `busy_timeout = 0` makes
 * the take refuse at once rather than wait, so a case that expects to be the
 * lock holder learns immediately when it is not.
 *
 * @since 1.0.0
 */
import { DatabaseSync } from "node:sqlite"

/**
 * A held write lock.
 *
 * @since 1.0.0
 * @category models
 */
export interface HeldWriteLock {
  /** Commits and closes, letting writers through again. Idempotent. */
  readonly release: () => void
}

/**
 * Takes the file's write lock until `release` is called.
 *
 * @since 1.0.0
 * @category constructors
 */
export const holdWriteLock = (filename: string): HeldWriteLock => {
  const db = new DatabaseSync(filename)
  let released = false
  db.exec("PRAGMA busy_timeout = 0")
  db.exec("BEGIN EXCLUSIVE")
  return {
    release: () => {
      if (released) return
      released = true
      db.exec("COMMIT")
      db.close()
    }
  }
}
