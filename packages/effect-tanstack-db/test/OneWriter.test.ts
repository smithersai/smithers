import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Cause, Effect, Exit, Layer, Metric, Option, Scope } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { Collection, Persistence } from "../src/index.ts"
import { databaseFile, id, Note, note, persistenceOn, sqlite, webLocks, withLogs } from "./fixtures.ts"

// A persisted synced collection on a device whose programs share one SQLite file through TanStack DB's coordinator,
// as a browser's tabs do, and elect its writer with the device's lock (Persistence's `lock`): only the program holding
// it stores what its source syncs (src/internal/oneWriter.ts). The source here is a test's own: it records each session
// TanStack DB starts, with the params it was given, and the test drives begin, write and commit as Electric does.

type Params = {
  readonly begin: () => void
  readonly write: (message: { readonly type: "insert" | "delete"; readonly value: Note }) => void
  readonly commit: (signal?: AbortSignal) => unknown
  readonly truncate: () => void
  readonly markReady: () => void
  readonly metadata?: unknown
}

/** One session of a program's source: the params it was given, whether it was stopped. */
type Session = { readonly params: Params; stopped: boolean }

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** What a test's source answers when a session starts: its cleanup, an object with one, nothing, or it throws. */
type Answer = "cleanup" | "object" | "nothing" | "throws"

/**
 * TanStack DB's coordinator between a device's programs, handing the database what this program committed `late.ms`
 * late, as a busy tab does.
 */
class LateCoordinator extends BrowserCollectionCoordinator {
  readonly late: { readonly ms: number }
  constructor(dbName: string, late: { readonly ms: number }) {
    super({ dbName })
    this.late = late
  }
  override async requestApplyCommittedTx(...args: Parameters<BrowserCollectionCoordinator["requestApplyCommittedTx"]>) {
    await new Promise((resume) => setTimeout(resume, this.late.ms))
    return super.requestApplyCommittedTx(...args)
  }
}

/**
 * A program on `device`: the device's SQLite file at `path`, its coordinator and its lock, and a persisted synced
 * collection whose source records its sessions. Metrics go to `metrics`.
 */
const program = async (options: {
  readonly path: string
  readonly device: string
  readonly collection: string
  readonly metrics: Map<string, unknown>
  readonly answer?: Answer
  readonly late?: { readonly ms: number }
}) => {
  const scope = Effect.runSync(Scope.make())
  // The collection's own scope, inside the program's: closing it stops the collection, and the database stays open.
  const collectionScope = Effect.runSync(Scope.make())
  scopes.push(scope, collectionScope)
  const sessions: Array<Session> = []
  const answer = options.answer ?? "cleanup"
  const layer = Persistence.layer({
    open: () => sqlite(options.path),
    make: (database, coordinator) =>
      createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
    coordinator: () =>
      options.late === undefined
        ? new BrowserCollectionCoordinator({ dbName: options.device })
        : new LateCoordinator(options.device, options.late),
    lock: webLocks({ prefix: `${options.device}/` })
  }).pipe(Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, options.metrics as never)))
  const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(layer)))
  const sync = (params: Params) => {
    const session: Session = { params, stopped: false }
    sessions.push(session)
    const cleanup = () => void (session.stopped = true)
    if (answer === "throws") throw new Error("the source broke")
    return answer === "cleanup" ? cleanup : answer === "object" ? { cleanup } : undefined
  }
  const { result: notes, logs } = await withLogs(
    Collection.make(
      Note,
      {
        id: options.collection,
        getKey: (row: Note) => row.id,
        sync: { sync }
      } as never,
      { persist: { schemaVersion: 1 } }
    ).pipe(
      Effect.tap((made) =>
        Effect.sync(() => (made as Collection.Collection<Note, string>).tanstack.startSyncImmediate())
      ),
      Effect.provide(context),
      Scope.provide(collectionScope)
    ) as Effect.Effect<Collection.Collection<Note, string>>
  )
  return {
    notes,
    sessions,
    scope,
    logs,
    /** The session running now. */
    now: () => sessions.at(-1)!,
    close: () =>
      Effect.runPromise(Effect.andThen(Scope.close(collectionScope, Exit.void), Scope.close(scope, Exit.void))),
    /** Stops the collection; the program and its database stay. */
    stop: () => Effect.runPromise(Scope.close(collectionScope, Exit.void))
  }
}

/** Polls until `check` holds: a condition, never a fixed wait. */
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition never held")
}

const ids = (notes: Collection.Collection<Note, string>) => [...notes.tanstack.keys()].sort()

/** A session that stores what it syncs gets the sync metadata; a watching one gets none. */
const writes = (session: Session | undefined) => session !== undefined && session.params.metadata !== undefined
const watches = (session: Session | undefined) => session !== undefined && session.params.metadata === undefined

/** Stores `rows` in one source transaction, as Electric commits a batch. */
const commit = (session: Session, rows: ReadonlyArray<Note>, options: { readonly truncate?: boolean } = {}) => {
  session.params.begin()
  if (options.truncate === true) session.params.truncate()
  for (const value of rows) session.params.write({ type: "insert", value })
  const applied = session.params.commit()
  session.params.markReady()
  return applied
}

/** A device: its SQLite file, its coordinator's name, one collection id and one metric registry for its programs. */
const device = () => ({ path: databaseFile(), device: id("device"), collection: id("notes"), metrics: new Map() })

const roles = async (metrics: Map<string, unknown>, collection: string, role: string) =>
  (await Effect.runPromise(
    Metric.value(Metric.withAttributes(Persistence.syncRoles, { collection, role })).pipe(
      Effect.provideService(Metric.MetricRegistry, metrics as never)
    )
  )).count

describe("one writer per persisted synced collection", () => {
  test("only the program holding the lock stores what its source syncs; another watches and shows the writer's rows", async () => {
    const on = device()
    const first = await program(on)
    await until(() => writes(first.now()))
    const second = await program(on)
    await until(() => watches(second.now()))

    await commit(first.now(), [note("a", 1)])
    await until(() => second.notes.tanstack.has("a"))
    // What the watching source syncs is dropped: it empties nothing and stores nothing, here or on the device.
    expect(commit(second.now(), [note("x", 9)], { truncate: true })).toBe(true)
    await commit(first.now(), [note("b", 2)])
    await until(() => ids(second.notes).join() === "a,b")
    expect(ids(first.notes)).toEqual(["a", "b"])
    expect({
      writer: await roles(on.metrics, on.collection, "writer"),
      watcher: await roles(on.metrics, on.collection, "watcher")
    }).toEqual({ writer: 1, watcher: 1 })
  })

  test("a snapshot a second program's source takes late never erases rows the first stored since", async () => {
    const on = device()
    const first = await program(on)
    await until(() => writes(first.now()))
    const second = await program(on)
    await until(() => second.sessions.length > 0)

    // The first program stores a question; the second's source then commits a snapshot taken before it, as a tab
    // whose fresh shape request answered from an older offset does.
    await commit(first.now(), [note("seed", 1), note("question", 2)])
    await until(() => second.notes.tanstack.has("question"))
    await commit(second.now(), [note("seed", 1)], { truncate: true })

    // The device keeps the question: a program opened now restores it, and neither program lost it.
    const third = await program(on)
    await third.notes.restored.pipe(Effect.runPromise)
    expect(ids(third.notes)).toEqual(["question", "seed"])
    expect(ids(first.notes)).toEqual(["question", "seed"])
    expect(ids(second.notes)).toEqual(["question", "seed"])
  })

  test("the writer closing hands the lock to a watcher, which starts its source again, writing from what the device stored", async () => {
    const on = device()
    const first = await program(on)
    await until(() => writes(first.now()))
    const second = await program(on)
    await until(() => watches(second.now()))
    await commit(first.now(), [note("a", 1)])
    await until(() => second.notes.tanstack.has("a"))

    const watching = second.now()
    await first.close()
    expect(first.now().stopped).toBe(true)
    await until(() => writes(second.now()))
    expect(watching.stopped).toBe(true)
    await commit(second.now(), [note("b", 2)])

    const third = await program(on)
    await third.notes.restored.pipe(Effect.runPromise)
    expect(ids(third.notes)).toEqual(["a", "b"])
    // Its first role, watching, is Debug, out of these Info lines; taking the lock is a change, at Info.
    const lines = second.logs.map(({ message, annotations }) => [message, annotations.role])
    expect(lines).toContainEqual([["persisted sync role"], "writer"])
    expect(lines).not.toContainEqual([["persisted sync role"], "watcher"])
  })

  test("a writer whose lock is stolen watches, and writes again once the lock comes back", async () => {
    const on = device()
    const first = await program(on)
    await until(() => writes(first.now()))
    const writing = first.now()

    const thief = Effect.runSync(Scope.make())
    await Effect.runPromise(
      webLocks({ prefix: `${on.device}/` }).hold(`persisted-sync:${on.collection}`, { steal: true }).pipe(
        Scope.provide(thief)
      )
    )
    await until(() => watches(first.now()))
    expect(writing.stopped).toBe(true)
    await Effect.runPromise(Scope.close(thief, Exit.void))
    await until(() => writes(first.now()))
    expect(first.sessions.map(writes)).toEqual([true, false, true])
  })

  test("a collection that stops syncing stops its source and lets the lock go", async () => {
    const on = device()
    const first = await program(on)
    await until(() => writes(first.now()))
    const second = await program(on)
    await until(() => watches(second.now()))

    await second.close()
    expect(second.now().stopped).toBe(true)
    await first.close()
    // Nobody else waits: the next program writes at once, and the one that stopped never starts again.
    const third = await program(on)
    await until(() => writes(third.now()))
    expect(second.sessions).toHaveLength(1)
  })

  test("a writer that stops lets the lock go only once the database has stored what it committed", async () => {
    const on = device()
    // The writer is busy: what it commits reaches the database 300 ms late.
    const first = await program({ ...on, late: { ms: 300 } })
    await until(() => writes(first.now()))
    const second = await program(on)
    await until(() => watches(second.now()))

    // The writer commits a snapshot, then stops before the database has it. The next writer stores a question; the
    // snapshot, landing after it, would empty the database of it.
    const snapshot = commit(first.now(), [note("seed", 1)], { truncate: true })
    await first.stop()
    await until(() => writes(second.now()))
    await snapshot
    await commit(second.now(), [note("question", 2)])

    const third = await program(on)
    await third.notes.restored.pipe(Effect.runPromise)
    expect(ids(third.notes)).toEqual(["question", "seed"])
  })

  test("a commit the database refuses doesn't hold the lock: the writer that stops lets it go", async () => {
    const on = device()
    const first = await program(on)
    await until(() => writes(first.now()))
    const second = await program(on)
    await until(() => watches(second.now()))

    // A commit abandoned before the database took it, as Electric's cleanup abandons an open transaction.
    const writing = first.now().params
    writing.begin()
    writing.write({ type: "insert", value: note("abandoned", 1) })
    const abandoned = new AbortController()
    abandoned.abort()
    await expect(Promise.resolve(writing.commit(abandoned.signal))).rejects.toMatchObject({
      name: "AbortError"
    })
    await first.stop()
    await until(() => writes(second.now()))
  })

  test("a source that throws as it starts fails the collection, as it would alone, and lets the lock go", async () => {
    const on = device()
    const broken = await program({ ...on, answer: "throws" })
    const exit = await Effect.runPromiseExit(broken.notes.preload)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "LoadFailed" })
    expect(broken.notes.tanstack.status).toBe("error")
    // Logged by the collection and the error's name, never its message.
    const failed = () => broken.logs.filter(({ message }) => (message as Array<unknown>)[0] === "persisted sync failed")
    await until(() => failed().length > 0)
    expect(failed().map(({ level, annotations }) => [level, annotations])).toEqual([
      ["Warn", { collection: on.collection, error: "Error" }]
    ])
    expect(JSON.stringify(broken.logs)).not.toContain("the source broke")
    // Nobody holds the lock: the next program writes.
    const next = await program(on)
    await until(() => writes(next.now()))
  })

  for (const answer of ["object", "nothing"] as const) {
    test(`a source that answers ${answer === "object" ? "an object with its cleanup" : "nothing"} is stopped as it is replaced`, async () => {
      const on = device()
      const first = await program(on)
      await until(() => writes(first.now()))
      const second = await program({ ...on, answer })
      await until(() => watches(second.now()))
      await first.close()
      await until(() => writes(second.now()))
      expect(second.sessions[0]!.stopped).toBe(answer === "object")
    })
  }

  test("a persistence without a lock elects no writer: every program's source stores what it syncs", async () => {
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const { lock } = await Effect.runPromise(
      Effect.provide(Persistence.Persistence, persistenceOn(databaseFile())).pipe(Scope.provide(scope))
    )
    expect(Option.fromUndefinedOr(lock)).toEqual(Option.none())
  })
})
