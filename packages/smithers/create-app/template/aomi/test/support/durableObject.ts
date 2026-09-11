/**
 * `AppSession` on Node, over real SQLite.
 *
 * The routing suite (`worker.test.ts`) replaces the Durable Object with an
 * in-memory double, so nothing there proves a row was written, read back in
 * order, or survived the object being recreated. This harness constructs the
 * real class instead. Its storage is `node:sqlite`, which is the SQLite engine
 * Durable Object storage is, behind the `SqlStorage` surface `AppSession`
 * calls: `exec` with positional bindings, `toArray`, and `transactionSync`.
 *
 * What it does not do is run workerd. Input gates, output gates, and the
 * per-request I/O rule are workerd's, and a test here cannot see them. The SQL
 * and the code around it are what this covers.
 *
 * One database per object name. {@link DurableObjectHarness.recreate} builds a
 * new instance over the same database, which is what an eviction looks like
 * from inside the object: every field resets, every row stays.
 */
import { DatabaseSync } from "node:sqlite"
import type { Env } from "../../worker/env.ts"
import { AppSession } from "../../worker/AppSession.ts"

export interface DurableObjectHarness {
  /** The bindings, with `SESSIONS` resolving names to objects of this harness. */
  readonly env: Env
  /** The object named `name`, constructed on first use. */
  readonly session: (name: string) => AppSession
  /** A fresh instance over `name`'s existing storage: the object after an eviction. */
  readonly recreate: (name: string) => AppSession
  /** `name`'s database, for reading rows back raw or planting rows a build never writes. */
  readonly database: (name: string) => DatabaseSync
  /** Makes `name`'s next SQL statement throw `message` instead of running. */
  readonly failNext: (name: string, message: string) => void
  /** Resolves once every promise any object handed `ctx.waitUntil` has settled. */
  readonly settled: () => Promise<void>
}

/** The bindings and the objects behind them, one set per test. */
export const durableObjects = (env: Partial<Env> = {}): DurableObjectHarness => {
  const databases = new Map<string, DatabaseSync>()
  const objects = new Map<string, AppSession>()
  const faults = new Map<string, string>()
  const pending: Array<Promise<unknown>> = []

  const database = (name: string): DatabaseSync => {
    const existing = databases.get(name)
    if (existing !== undefined) return existing
    const created = new DatabaseSync(":memory:")
    databases.set(name, created)
    return created
  }

  const sqlStorage = (name: string): SqlStorage => {
    const db = database(name)
    const exec = (query: string, ...bindings: Array<unknown>) => {
      const fault = faults.get(name)
      if (fault !== undefined) {
        faults.delete(name)
        throw new Error(fault)
      }
      const rows = db.prepare(query).all(...(bindings as Array<null | number | bigint | string | Uint8Array>))
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`)
          return rows[0]
        },
        [Symbol.iterator]: () => rows[Symbol.iterator]()
      }
    }
    return { exec } as unknown as SqlStorage
  }

  const state = (name: string): DurableObjectState => {
    const db = database(name)
    const sql = sqlStorage(name)
    return {
      id: { toString: () => name, name, equals: (other: { toString(): string }) => other.toString() === name },
      storage: {
        sql,
        transactionSync: <T>(closure: () => T): T => {
          db.exec("BEGIN")
          try {
            const result = closure()
            db.exec("COMMIT")
            return result
          } catch (cause) {
            db.exec("ROLLBACK")
            throw cause
          }
        }
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(Promise.resolve(promise))
      },
      blockConcurrencyWhile: <T>(closure: () => Promise<T>): Promise<T> => closure()
    } as unknown as DurableObjectState
  }

  const bindings = {
    APP_NAME: "aomi",
    APP_API_OPEN: "1",
    APP_MOCK_TURN: "1",
    ...env
  } as Env

  const recreate = (name: string): AppSession => {
    const created = new AppSession(state(name), bindings)
    objects.set(name, created)
    return created
  }

  const session = (name: string): AppSession => objects.get(name) ?? recreate(name)

  /**
   * A stub for `name`: every method call is a message that lands on a later
   * tick, in the order it was sent, which is what a Durable Object stub is
   * from the caller's side. Cloudflare orders calls within one stub, and the
   * registry write ordering `AppSession` relies on depends on exactly that.
   */
  const stub = (name: string): AppSession =>
    new Proxy({} as AppSession, {
      get: (_target, property) => {
        const target = session(name)
        const value = Reflect.get(target, property) as unknown
        if (typeof value !== "function") return value
        return (...args: Array<unknown>) => Promise.resolve().then(() => Reflect.apply(value, target, args))
      }
    })

  Object.assign(bindings, {
    SESSIONS: {
      idFromName: (name: string) => name,
      get: (id: string) => stub(id)
    }
  })

  return {
    env: bindings,
    session,
    recreate,
    database,
    failNext: (name, message) => {
      faults.set(name, message)
    },
    settled: async () => {
      // A settled promise may have queued another (a flow's settle registers
      // the session), so drain until nothing new arrives.
      let seen = 0
      while (seen < pending.length) {
        const batch = pending.slice(seen)
        seen = pending.length
        await Promise.allSettled(batch)
      }
    }
  }
}
