import { DatabaseSync, type SQLInputValue } from "node:sqlite"

/**
 * A real SQLite connection with SharedSqlite's host contract: another connection waits until an open transaction
 * ends, and a batch executes without yielding between statements. Synchronous SQLite cannot wait for another
 * connection on its own JavaScript thread to commit; the host's Web Lock waits without blocking that thread.
 * TanStack's driver serializes calls on each connection; this fixture keeps that same caller contract.
 */
export const sqlite = (path: string) => {
  const database = new DatabaseSync(path)
  const execute = <T>(sql: string, params: ReadonlyArray<unknown> = []): ReadonlyArray<T> => {
    const statement = database.prepare(sql)
    if (statement.columns().length > 0) return statement.all(...(params as Array<SQLInputValue>)) as Array<T>
    statement.run(...(params as Array<SQLInputValue>))
    return []
  }
  let release: (() => void) | undefined
  const unlock = () => {
    release?.()
    release = undefined
  }
  const locked = async <T>(operation: () => T): Promise<T> => {
    if (release === undefined) {
      await new Promise<void>((acquired) => {
        void navigator.locks.request(`electric-sqlite:${path}`, () =>
          new Promise<void>((resume) => {
            release = resume
            acquired()
          }))
      })
    }
    try {
      return operation()
    } finally {
      if (!database.isOpen || !database.isTransaction) unlock()
    }
  }
  return {
    execute: async <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>> =>
      locked(() => execute<T>(sql, params)),
    // No await between BEGIN and COMMIT: another connection on this JavaScript thread cannot acquire SQLite's
    // writer lock while this connection holds it. The browser host runs a whole batch in its database worker.
    executeBatch: async (
      statements: ReadonlyArray<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }>
    ) => locked(() => statements.map(({ sql, params }) => execute(sql, params))),
    close: () => {
      try {
        database.close()
      } finally {
        unlock()
      }
    }
  }
}
