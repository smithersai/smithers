import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import type { ObjectDatabase } from "../src/index.ts"

/** A Durable Object's storage over one SQLite file, until `hibernate` closes it. */
export const openStorage = (path: string) => {
  const db = new DatabaseSync(path)
  let depth = 0
  const cursor = (query: string, params: ReadonlyArray<unknown>) => {
    if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b/i.test(query)) {
      throw new Error("To execute a transaction, please use the state.storage.transaction() API")
    }
    const statement = db.prepare(query)
    const columnNames = statement.columns().map((column) => column.name)
    const rows = columnNames.length === 0
      ? (statement.run(...(params as Array<SQLInputValue>)), [])
      : statement.all(...(params as Array<SQLInputValue>)) as Array<Record<string, unknown>>
    return {
      columnNames,
      toArray: () => rows,
      raw: function*() {
        for (const row of rows) yield columnNames.map((name) => row[name])
      }
    }
  }
  const enter = () => {
    const level = depth++
    db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT level_${level}`)
    return (commit: boolean) => {
      depth--
      if (level === 0) db.exec(commit ? "COMMIT" : "ROLLBACK")
      else db.exec(commit ? `RELEASE level_${level}` : `ROLLBACK TO level_${level}; RELEASE level_${level}`)
    }
  }
  const transactionSync = <T>(closure: () => T): T => {
    const end = enter()
    try {
      const value = closure()
      end(true)
      return value
    } catch (cause) {
      end(false)
      throw cause
    }
  }
  const transaction = async <T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T> => {
    const end = enter()
    let rolledBack = false
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
    storage: {
      sql: { exec: (query: string, ...params: Array<unknown>) => cursor(query, params) },
      transaction,
      transactionSync
    } as unknown as ObjectDatabase.Storage,
    count: (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    hibernate: () => db.close()
  }
}

