/**
 * A SQLite-backed Durable Object's `storage.sql` and `storage.transaction`
 * over `node:sqlite`, for the Node suite: Node cannot host a Durable Object,
 * and the coverage gate runs in Node. It keeps the two behaviors
 * `ObjectDatabase` relies on: `exec` returns a cursor of column names and raw
 * rows, and `transaction` commits when its closure settles, rolls back when it
 * rejects or calls `txn.rollback()`, and nests as a savepoint. The workerd
 * smoke (`ObjectDatabaseWorkerd.test.ts`) runs the same layer on the real
 * storage, which also refuses `BEGIN`.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import type { ObjectDatabase } from "../../src/index.ts"

export interface SqliteStorage {
  readonly storage: ObjectDatabase.Storage
  /** How many `storage.transaction()` calls have run, nested ones included. */
  readonly transactions: () => number
}

export const make = (): SqliteStorage => {
  const db = new DatabaseSync(":memory:")
  let depth = 0
  let opened = 0
  const exec = (query: string, ...params: ReadonlyArray<unknown>) => {
    if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b/i.test(query)) {
      throw new Error("To execute a transaction, please use the state.storage.transaction() API")
    }
    const statement = db.prepare(query)
    const columnNames = statement.columns().map((column) => column.name)
    const rows = columnNames.length === 0
      ? (statement.run(...(params as Array<SQLInputValue>)), [])
      : statement.all(...(params as Array<SQLInputValue>))
    return {
      columnNames,
      raw: function*() {
        for (const row of rows) yield columnNames.map((name) => (row as Record<string, unknown>)[name])
      }
    }
  }
  const transaction = async <T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T> => {
    opened++
    const level = depth++
    const name = `level_${level}`
    db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${name}`)
    let rolledBack = false
    const end = (commit: boolean) => {
      depth--
      if (level === 0) db.exec(commit ? "COMMIT" : "ROLLBACK")
      else db.exec(commit ? `RELEASE ${name}` : `ROLLBACK TO ${name}; RELEASE ${name}`)
    }
    try {
      const value = await closure({ rollback: () => void (rolledBack = true) })
      end(!rolledBack)
      return value
    } catch (cause) {
      end(false)
      throw cause
    }
  }
  return {
    storage: { sql: { exec }, transaction } as unknown as ObjectDatabase.Storage,
    transactions: () => opened
  }
}
