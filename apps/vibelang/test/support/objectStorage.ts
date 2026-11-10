// Stays .ts: node:sqlite is a Node host API. This in-memory Durable Object storage is the unit tests' host
// adapter (the role ctx.storage plays in workerd), not product code.
import { DatabaseSync } from "node:sqlite"

/** One executed statement's rows, as the Durable Object SQL cursor exposes them. */
export class SqlCursor {
  constructor(
    readonly columnNames: ReadonlyArray<string>,
    private readonly rows: ReadonlyArray<ReadonlyArray<unknown>>,
  ) {}
  *raw(): IterableIterator<ReadonlyArray<unknown>> {
    yield* this.rows
  }
  toArray(): Array<Record<string, unknown>> {
    return this.rows.map((row) => Object.fromEntries(this.columnNames.map((name, index) => [name, row[index]])))
  }
  get rowsRead(): number {
    return this.rows.length
  }
}

const binding = (value: unknown): null | number | bigint | string | Uint8Array =>
  value === undefined || value === null ? null
  : typeof value === "boolean" ? (value ? 1 : 0)
  : typeof value === "number" || typeof value === "bigint" || typeof value === "string" ? value
  : value instanceof Uint8Array ? value
  : value instanceof ArrayBuffer ? new Uint8Array(value)
  : JSON.stringify(value)

/** node:sqlite errcodes of the SQLITE_CONSTRAINT family, as workerd's message names them. */
const constraintMessage = (errcode: number, query: string): string | undefined => {
  switch (errcode) {
    case 2067: // SQLITE_CONSTRAINT_UNIQUE
    case 1555: // SQLITE_CONSTRAINT_PRIMARYKEY
      return `UNIQUE constraint failed: ${query}`
    case 1811: // SQLITE_CONSTRAINT_FOREIGNKEY
      return "FOREIGN KEY constraint failed"
    case 1299: // SQLITE_CONSTRAINT_NOTNULL
      return "NOT NULL constraint failed"
    case 275: // SQLITE_CONSTRAINT_CHECK
      return "CHECK constraint failed"
    default:
      return undefined
  }
}

export interface ObjectStorage {
  readonly kv: Map<string, unknown>
  alarmAt: number | undefined
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  put(entries: Record<string, unknown>): Promise<void>
  delete(key: string): Promise<boolean>
  list(options: { readonly prefix: string; readonly start?: string }): Promise<Map<string, unknown>>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
  readonly sql: { exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlCursor }
  transaction<T>(
    closure: (txn: { readonly sql: ObjectStorage["sql"]; rollback(): void }) => Promise<T> | T
  ): Promise<T>
  /** worker/Sandboxes.vibe's synchronous ledger write. */
  transactionSync<A>(body: () => A): A
}

/** ctx.storage for one object, in memory: key-value, alarm, and a real SQLite database. */
export function objectStorage(): ObjectStorage {
  const db = new DatabaseSync(":memory:")
  const kv = new Map<string, unknown>()
  let depth = 0
  const storage: ObjectStorage = {
    kv,
    alarmAt: undefined,
    get: async (key) => kv.get(key),
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === "string") kv.set(keyOrEntries, value)
      else for (const [key, entry] of Object.entries(keyOrEntries)) kv.set(key, entry)
    },
    delete: async (key) => kv.delete(key),
    list: async ({ prefix, start }) => {
      const rows = new Map<string, unknown>()
      for (const key of [...kv.keys()].sort()) {
        if (key.startsWith(prefix) && (start === undefined || key >= start)) rows.set(key, kv.get(key))
      }
      return rows
    },
    setAlarm: async (scheduledTime) => {
      storage.alarmAt = scheduledTime
    },
    deleteAlarm: async () => {
      storage.alarmAt = undefined
    },
    sql: {
      exec(query, ...bindings) {
        try {
          const statement = db.prepare(query)
          const columnNames = statement.columns().map((column) => column.name ?? "")
          const rows = (statement.all(...bindings.map(binding)) as Array<Record<string, unknown>>)
            .map((row) => columnNames.map((name) => row[name]))
          return new SqlCursor(columnNames, rows)
        } catch (error) {
          // workerd surfaces SQLite's own message; node:sqlite carries only its errcode.
          const errcode = typeof error === "object" && error !== null && "errcode" in error
            ? Number((error as { errcode: unknown }).errcode)
            : undefined
          const translated = errcode ? constraintMessage(errcode, query) : undefined
          throw translated === undefined ? error : new Error(translated)
        }
      },
    },
    transactionSync(body) {
      const level = depth++
      const savepoint = `vibelang_sync_${level}`
      db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`)
      try {
        const result = body()
        db.exec(level === 0 ? "COMMIT" : `RELEASE ${savepoint}`)
        return result
      } catch (error) {
        db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
        throw error
      } finally {
        depth--
      }
    },
    async transaction(closure) {
      const level = depth++
      const savepoint = `vibelang_sp_${level}`
      db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`)
      let aborted = false
      const end = (commit: boolean) => {
        depth--
        // Real Durable Object storage resolves transaction() after txn.rollback(): a rollback is
        // an outcome, not an exception, and the closure's value is discarded (see the monorepo's
        // workerd-validated fixture, platform-cloudflare/test/fixtures/SqliteStorage.ts).
        if (level === 0) db.exec(commit ? "COMMIT" : "ROLLBACK")
        else db.exec(commit ? `RELEASE ${savepoint}` : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      }
      try {
        const result = await closure({ sql: storage.sql, rollback: () => { aborted = true } })
        end(!aborted)
        return result
      } catch (error) {
        end(false)
        throw error
      }
    },
  }
  return storage
}
