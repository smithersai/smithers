import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Deferred, Effect, Exit, Logger, Option, References, Schema } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import type { Outbox } from "../src/index.ts"
import { Persistence } from "../src/index.ts"

// Rows the suites store, and a logger that records what the package logs.

export const Note = Schema.Struct({ id: Schema.String, text: Schema.String, n: Schema.Number })
export type Note = typeof Note.Type

export const note = (id: string, n: number, text = id): Note => ({ id, text, n })

/** A test's own id, so collections never share TanStack DB's id space. */
export const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

/** Runs `program` with a logger that records each line's message and annotations, and returns both. */
export const withLogs = async <A, E>(program: Effect.Effect<A, E>) => {
  const logs: Array<
    { readonly message: unknown; readonly level: string; readonly annotations: Record<string, unknown> }
  > = []
  const recorder = Logger.make(({ message, logLevel, fiber }) => {
    logs.push({ message, level: logLevel, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const result = await Effect.runPromise(program.pipe(Effect.provide(Logger.layer([recorder]))))
  return { result, logs }
}

/** A SQLite file in Node, as TanStack DB's browser persistence reads a database: `execute` and `close`. */
export const sqlite = (path: string) => {
  const database = new DatabaseSync(path)
  return {
    execute: async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> => {
      const statement = database.prepare(sql)
      if (statement.columns().length > 0) return statement.all(...(params as Array<SQLInputValue>)) as Array<T>
      statement.run(...(params as Array<SQLInputValue>))
      return []
    },
    close: () => database.close()
  }
}

/** A database file of the test's own. */
export const databaseFile = () => join(tmpdir(), `effect-tanstack-db-${crypto.randomUUID()}.sqlite`)

/** `Persistence.layer` over a SQLite file, as a Node host opens it. */
export const persistenceOn = (path: string) =>
  Persistence.layer({
    open: () => sqlite(path),
    make: (database, coordinator) =>
      createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) })
  })

/** An outbox's storage in memory, shared by the executors a test starts on it: the library's `StorageAdapter`. */
export const memoryStorage = () => {
  const entries = new Map<string, string>()
  const lock = id("outbox-storage")
  return {
    entries,
    withLock: <A>(name: string, action: () => Promise<A>): Promise<A> =>
      navigator.locks.request(`${lock}:${name}`, action),
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: string) => void entries.set(key, value),
    async setMany(rows: ReadonlyArray<readonly [string, string]>) {
      const before = new Map(entries)
      try {
        for (const [key, value] of rows) await this.set(key, value)
      } catch (error) {
        entries.clear()
        for (const [key, value] of before) entries.set(key, value)
        throw error
      }
    },
    delete: async (key: string) => void entries.delete(key),
    keys: async () => [...entries.keys()],
    clear: async () => entries.clear()
  }
}

/**
 * A lock service over Node's own Web Locks, shaped as @smthrs/platform-browser's WebLock: `hold` waits for the lock,
 * or takes it at once with `steal`, and holds it until the scope closes; `tryHold` takes it only if it is free; `lost`
 * completes when another program steals it. Interrupting the wait withdraws the request. Lock names are `prefix`'s,
 * as each browser has its own Web Locks; with `answerAfter`, the lock manager answers each request that much later, as
 * a busy browser does.
 */
export const webLocks = (options: { readonly prefix?: string; readonly answerAfter?: number } = {}): Outbox.Lock => {
  const prefix = options.prefix ?? ""
  const answerAfter = options.answerAfter ?? 0
  const request = (name: string, how: { readonly steal?: boolean; readonly ifAvailable?: boolean }) =>
    Effect.gen(function*() {
      const lost = yield* Deferred.make<void>()
      const release = yield* Effect.acquireRelease(
        Effect.callback<(() => void) | undefined>((resume, signal) => {
          let granted = false
          const ask = () =>
            navigator.locks.request(
              `${prefix}${name}`,
              how.steal === true ? { steal: true } : how.ifAvailable === true ? { ifAvailable: true } : { signal },
              (held) => {
                if (held === null) return void resume(Effect.succeed(undefined))
                if (signal.aborted) return Promise.resolve()
                granted = true
                return new Promise<void>((release) => resume(Effect.succeed(release)))
              }
            ).catch(() => {
              if (granted) Deferred.doneUnsafe(lost, Exit.void)
            })
          if (answerAfter === 0) ask()
          else setTimeout(ask, answerAfter)
        }).pipe(Effect.interruptible),
        (release) => Effect.sync(() => release?.())
      )
      return release === undefined ? Option.none() : Option.some({ lost: Deferred.await(lost) })
    })
  return {
    hold: (name, how) => Effect.map(request(name, how ?? {}), Option.getOrThrow),
    tryHold: (name) => request(name, { ifAvailable: true })
  }
}
