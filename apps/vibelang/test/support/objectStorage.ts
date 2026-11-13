// Stays .ts: node:sqlite is a Node host API. This in-memory Durable Object storage is the unit tests' host
// adapter (the role ctx.storage plays in workerd), not product code.
import { DatabaseSync } from "node:sqlite"
import { AsyncLocalStorage } from "node:async_hooks"
import type * as Context from "effect/Context"
import * as Fiber from "effect/Fiber"
import type * as SqlClient from "effect/sql/SqlClient"

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

interface TransactionScope {
  active: boolean
  tail: Promise<void>
  readonly parent: TransactionScope | undefined
  readonly fiber: ReturnType<typeof Fiber.getCurrent>
  readonly entryContext: Context.Context<never> | undefined
}

/** The public SQL transaction frame, without depending on a driver's private service key. */
const isSqlTransaction = (value: unknown): value is SqlClient.TransactionConnection.Service => {
  if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[1]) || value[1] < 0
    || typeof value[0] !== "object" || value[0] === null) return false
  const connection = value[0] as Record<string, unknown>
  return ["execute", "executeRaw", "executeValues", "executeValuesUnprepared", "executeUnprepared", "executeStream"]
    .every(method => typeof connection[method] === "function")
}

/** ctx.storage for one object, in memory: key-value, alarm, and a real SQLite database. */
export function objectStorage(): ObjectStorage {
  const db = new DatabaseSync(":memory:")
  const kv = new Map<string, unknown>()
  let depth = 0
  const transactions = new AsyncLocalStorage<TransactionScope>()
  const fiberScopes = new WeakMap<NonNullable<ReturnType<typeof Fiber.getCurrent>>, Array<TransactionScope>>()
  const activeScopes = new Set<TransactionScope>()
  const root = { tail: Promise.resolve() }
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
      const level = depth
      const savepoint = `vibelang_sync_${level}`
      db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`)
      depth++
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
      // Each parent serializes its children: independent callers share the root; actual nesting gets savepoints.
      const fiber = Fiber.getCurrent()
      const entryContext = fiber?.context
      const frames = entryContext ? [...entryContext.mapUnsafe].filter(([, value]) => isSqlTransaction(value)) : []
      let parent = transactions.getStore()
      while (parent && !parent.active) parent = parent.parent
      // The SQL driver parks its callback and runs the body on a fiber. Forks inherit the fresh transaction tuple,
      // even when a layer has consumed the SqlClient service. Compare that tuple by identity, never by depth alone.
      const sqlParent = [...activeScopes].reverse().find(scope => scope.active && scope.fiber && scope.entryContext
        && frames.some(([key, value]) => scope.fiber!.context.mapUnsafe.get(key) === value
          && scope.entryContext!.mapUnsafe.get(key) !== value))
      if (sqlParent) {
        if (!parent) parent = sqlParent
        else for (let ancestor = sqlParent.parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor === parent) { parent = sqlParent; break }
        }
      } else if (parent?.fiber && parent.entryContext && fiber && frames.length === 0
        && [...parent.fiber.context.mapUnsafe].some(([key, value]) => isSqlTransaction(value)
          && parent!.entryContext!.mapUnsafe.get(key) !== value)) {
        // A different root fiber cannot inherit ownership merely from a scheduler's native async context.
        parent = undefined
      }
      if (!parent && fiber && frames.length === 0) parent = fiberScopes.get(fiber)?.slice().reverse().find(scope => scope.active)
      const owner = parent ?? root
      const previous = owner.tail
      let release!: () => void
      owner.tail = new Promise<void>(resolve => { release = resolve })
      await previous
      const scope: TransactionScope = { active: true, tail: Promise.resolve(), parent, fiber, entryContext }
      const scopes = fiber ? fiberScopes.get(fiber) ?? [] : undefined
      if (fiber && scopes) { scopes.push(scope); fiberScopes.set(fiber, scopes) }
      activeScopes.add(scope)
      try {
        return await transactions.run(scope, async () => {
          const level = depth
          const savepoint = "vibelang_sp_" + level
          db.exec(level === 0 ? "BEGIN" : "SAVEPOINT " + savepoint)
          depth++
          let aborted = false
          const end = (commit: boolean) => {
            // rollback() is an outcome, not an exception, on real Durable Object storage.
            if (level === 0) db.exec(commit ? "COMMIT" : "ROLLBACK")
            else db.exec(commit ? "RELEASE " + savepoint : "ROLLBACK TO " + savepoint + "; RELEASE " + savepoint)
          }
          try {
            let result: Awaited<ReturnType<typeof closure>>
            try {
              result = await closure({ sql: storage.sql, rollback: () => { aborted = true } })
            } finally {
              // A parent must not finalize while a previously started child still owns a savepoint.
              scope.active = false
              await scope.tail
            }
            end(!aborted)
            return result
          } catch (error) {
            // A deferred constraint can reject COMMIT while SQLite still owns the transaction.
            if (db.isTransaction) end(false)
            throw error
          } finally {
            depth--
          }
        })
      } finally {
        scope.active = false
        activeScopes.delete(scope)
        if (scopes) scopes.splice(scopes.indexOf(scope), 1)
        release()
      }
    },
  }
  return storage
}
