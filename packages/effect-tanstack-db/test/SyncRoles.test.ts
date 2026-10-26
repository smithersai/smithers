import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Effect, Exit, Layer, Logger, Metric, References, Scope } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import type { Outbox } from "../src/index.ts"
import { Collection, Persistence } from "../src/index.ts"
import { databaseFile, id, Note, persistenceOn, sqlite, webLocks } from "./fixtures.ts"

// What a program logs about its persisted synced collections' writer elections (src/internal/elections.ts): one
// Info line once their first roles are taken (`Persistence.reportRoles`), each first role at Debug, and every role
// after it, such as a watcher taking the lock when the writing program closes, at Info. A browser tab made 23 such
// collections and logged 23 Info lines per load before. Programs share one SQLite file, coordinator and lock, as a
// browser's tabs do.

type Line = { readonly message: unknown; readonly level: string; readonly annotations: Record<string, unknown> }

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** A device: its SQLite file, its coordinator's name, and one metric registry for its programs. */
const device = () => ({ path: databaseFile(), device: id("device"), metrics: new Map() })
type Device = ReturnType<typeof device>

/** A lock manager that never answers, as one that has hung would. */
const silent: Outbox.Lock = { hold: () => Effect.never, tryHold: () => Effect.never }

/** A database that opens, then fails every statement, as a disk that broke does. */
const broken = (): ReturnType<typeof sqlite> => ({
  execute: () => Promise.reject(new Error("disk")),
  close: () => undefined
})

/**
 * A program on `on`: its `Persistence` over the device's file (or `open`'s database), coordinator and `lock`, and
 * every line it logs at Debug and above. `collection` makes a persisted synced collection whose source answers its
 * cleanup, or throws.
 */
const program = async (
  on: Device,
  options: { readonly lock?: Outbox.Lock; readonly open?: () => ReturnType<typeof sqlite> } = {}
) => {
  const lock = options.lock ?? webLocks({ prefix: `${on.device}/` })
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const lines: Array<Line> = []
  const recorder = Logger.make(({ message, logLevel, fiber }) => {
    const parts = Array.isArray(message) ? message : [message]
    lines.push({
      message: parts.length === 1 ? parts[0] : parts,
      level: logLevel,
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) }
    })
  })
  const layer = Persistence.layer({
    open: options.open ?? (() => sqlite(on.path)),
    make: (database, coordinator) =>
      createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
    coordinator: () => new BrowserCollectionCoordinator({ dbName: on.device }),
    lock
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(
      Logger.layer([recorder]),
      Layer.succeed(References.MinimumLogLevel, "Debug"),
      Layer.succeed(Metric.MetricRegistry, on.metrics as never)
    ))
  )
  const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(layer)))
  const run = <A>(effect: Effect.Effect<A, never, Persistence.Persistence | Scope.Scope>, within: Scope.Scope) =>
    Effect.runPromise(effect.pipe(Effect.provide(context), Scope.provide(within)))
  return {
    lines,
    collection: (collection: string, options: { readonly scope?: Scope.Scope; readonly throws?: boolean } = {}) =>
      run(
        Collection.make(
          Note,
          {
            id: collection,
            getKey: (row: Note) => row.id,
            sync: {
              sync: () => {
                if (options.throws === true) throw new Error("the source broke")
                return () => undefined
              }
            }
          } as never,
          { persist: { schemaVersion: 1 } }
        ),
        options.scope ?? scope
      ),
    report: () => run(Persistence.reportRoles, scope),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

/** The program's lines with `message`, as level and annotations. */
const logged = (lines: ReadonlyArray<Line>, message: string) =>
  lines.filter((line) => line.message === message).map(({ annotations, level }) => ({ level, ...annotations }))

/** Polls until `check` holds: a condition, never a fixed wait. */
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition never held")
}

const roles = (on: Device, collection: string, role: string) =>
  Effect.runSync(
    Metric.value(Metric.withAttributes(Persistence.syncRoles, { collection, role })).pipe(
      Effect.provideService(Metric.MetricRegistry, on.metrics as never)
    )
  ).count

describe("Persistence.reportRoles", () => {
  test("logs a program's first roles in one Info line, each first role at Debug, and a later change at Info", async () => {
    const on = device()
    const collections = [id("notes"), id("tasks"), id("runs")]
    const writing = await program(on)
    for (const collection of collections) await writing.collection(collection)
    expect(await writing.report()).toEqual({ writers: 3, watchers: 0 })
    // A second program finds every lock held: its first roles come at once, watching.
    const watching = await program(on)
    for (const collection of collections) await watching.collection(collection)
    expect(await watching.report()).toEqual({ writers: 0, watchers: 3 })

    expect(logged(writing.lines, "persisted sync roles")).toEqual([{ level: "Info", writers: 3, watchers: 0 }])
    expect(logged(watching.lines, "persisted sync roles")).toEqual([{ level: "Info", writers: 0, watchers: 3 }])
    expect(logged(writing.lines, "persisted sync role")).toEqual(
      collections.map((collection) => ({ level: "Debug", collection, role: "writer" }))
    )
    expect(logged(watching.lines, "persisted sync role")).toEqual(
      collections.map((collection) => ({ level: "Debug", collection, role: "watcher" }))
    )

    // The writing program closes: each collection's watcher takes its lock, a change logged at Info.
    await writing.close()
    await until(() => logged(watching.lines, "persisted sync role").length === 6)
    expect(logged(watching.lines, "persisted sync role").slice(3)).toEqual(
      expect.arrayContaining(collections.map((collection) => ({ level: "Info", collection, role: "writer" })))
    )
    // Every role counts, whatever its line's level.
    for (const collection of collections) {
      expect({ writer: roles(on, collection, "writer"), watcher: roles(on, collection, "watcher") }).toEqual({
        writer: 2,
        watcher: 1
      })
    }
  })

  test("a collection made after the report logs its first role at Info, and no report counts it", async () => {
    const on = device()
    const first = id("notes")
    const later = id("tasks")
    const alone = await program(on)
    await alone.collection(first)
    expect(await alone.report()).toEqual({ writers: 1, watchers: 0 })
    await alone.collection(later)
    await until(() => logged(alone.lines, "persisted sync role").length === 2)
    expect(logged(alone.lines, "persisted sync role")).toEqual([
      { level: "Debug", collection: first, role: "writer" },
      { level: "Info", collection: later, role: "writer" }
    ])
    expect(await alone.report()).toEqual({ writers: 1, watchers: 0 })
  })

  test("never waits for a collection whose source threw, whose database failed, or that closed before the lock answered", async () => {
    const throwing = await program(device())
    await throwing.collection(id("notes"), { throws: true })
    expect(await throwing.report()).toEqual({ writers: 0, watchers: 0 })

    // The collection fails reading what the device stored, before its source starts, so it never takes a role.
    const failing = await program(device(), { open: broken })
    const notes = await failing.collection(id("notes"))
    expect(await failing.report()).toEqual({ writers: 0, watchers: 0 })
    expect(notes.tanstack.status).toBe("error")

    const stuck = await program(device(), { lock: silent })
    const collectionScope = Effect.runSync(Scope.make())
    await stuck.collection(id("notes"), { scope: collectionScope })
    const reported = stuck.report()
    await Effect.runPromise(Scope.close(collectionScope, Exit.void))
    expect(await reported).toEqual({ writers: 0, watchers: 0 })
    expect(logged(stuck.lines, "persisted sync role")).toEqual([])
  })

  test("with no database, or no lock, no collection takes a role, and the report answers zero of each", async () => {
    for (const layer of [Persistence.memory, persistenceOn(databaseFile())]) {
      const scope = Effect.runSync(Scope.make())
      scopes.push(scope)
      const report = await Effect.runPromise(
        Effect.gen(function*() {
          yield* Collection.make(
            Note,
            { id: id("notes"), getKey: (row: Note) => row.id, sync: { sync: () => () => undefined } } as never,
            { persist: { schemaVersion: 1 } }
          )
          return yield* Persistence.reportRoles
        }).pipe(Effect.provide(layer), Scope.provide(scope))
      )
      expect(report).toEqual({ writers: 0, watchers: 0 })
    }
  })
})
