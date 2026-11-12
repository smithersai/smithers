import { startOfflineExecutor } from "@tanstack/offline-transactions"
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  Queue,
  References,
  Scope,
  Stream,
  Tracer
} from "effect"
import { describe, expect, test, vi } from "vitest"
import { Collection, Outbox } from "../src/index.ts"
import { id, memoryStorage, Note, note, webLocks, withLogs } from "./fixtures.ts"

// The outbox over TanStack DB's real offline executor, in Node: its storage is the library's `StorageAdapter` in
// memory, shared by every executor a test starts on it, as IndexedDB is shared by a tab's reloads. The only scripted
// piece is the mutation, a test's stand-in for a server: each send takes the next outcome the test queued.

type Outcome = "ok" | Outbox.Refused | Outbox.Retry | "defect"

// One program alone: it always leads, so tests never wait on an election. Tests of the election pass `leader: undefined`.
const single: Outbox.Leader = {
  requestLeadership: () => Promise.resolve(true),
  releaseLeadership: () => undefined,
  isLeader: () => true,
  onLeadershipChange: () => () => undefined
}

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 4_000, interval: 5 })

const ownMetrics = () => Layer.succeed(Metric.MetricRegistry, new Map())

/** One program's outbox over `storage`: a `notes` collection, and the `save` mutation, scripted by `outcomes`. */
const start = (options: {
  readonly storage: ReturnType<typeof memoryStorage>
  readonly outcomes: Queue.Queue<Outcome>
  readonly sent: Array<{ readonly rows: ReadonlyArray<unknown>; readonly idempotencyKey: string }>
  readonly leader?: Outbox.Leader | undefined
  readonly orderingKeys?: Outbox.Options<never>["orderingKeys"]
  readonly changes?: Outbox.Options<never>["changes"]
  readonly mutation?: Outbox.Mutation<never>
  readonly notes?: string
  readonly online?: Outbox.Online
  readonly principal?: Outbox.Principal
  readonly upgrade?: Outbox.Options<never>["upgrade"]
  readonly parked?: Outbox.Options<never>["parked"]
}) =>
  Effect.gen(function*() {
    const notes = yield* Collection.local({ id: options.notes ?? id("notes"), schema: Note, getKey: (row) => row.id })
    const online = options.online ?? Outbox.Online.always()
    const context = yield* Layer.build(
      Outbox.layer({
        start: startOfflineExecutor,
        collections: { notes },
        storage: options.storage,
        ...("leader" in options ? (options.leader ? { leader: options.leader } : {}) : { leader: single }),
        online,
        orderingKeys: options.orderingKeys,
        changes: options.changes,
        ...(options.principal === undefined ? {} : { principal: options.principal }),
        ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade }),
        ...(options.parked === undefined ? {} : { parked: options.parked }),
        mutations: {
          save: options.mutation ?? ((params) =>
            Effect.gen(function*() {
              options.sent.push(params)
              const outcome = yield* Queue.take(options.outcomes)
              if (outcome === "defect") return yield* Effect.die(new Error("boom"))
              if (outcome !== "ok") return yield* outcome
            }))
        }
      })
    )
    return { notes, outbox: Context.get(context, Outbox.Outbox), online }
  })

const setup = async (outcomes: ReadonlyArray<Outcome>) => {
  const queue = Effect.runSync(Queue.unbounded<Outcome>())
  for (const outcome of outcomes) Effect.runSync(Queue.offer(queue, outcome))
  return {
    storage: memoryStorage(),
    outcomes: queue,
    sent: [] as Array<{ rows: ReadonlyArray<unknown>; idempotencyKey: string }>
  }
}

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(ownMetrics())))

const save = (outbox: Outbox.Service, notes: Collection.Collection<Note, string>, row: Note) =>
  outbox.transact("save", { idempotencyKey: row.id }, Effect.asVoid(notes.insert(row)))

/** Give admissions equal timestamps without changing the executor's clock or the process clock. */
const saveAt = (queuedAt: number) => (outbox: Outbox.Service, notes: Collection.Collection<Note, string>, row: Note) =>
  Clock.clockWith((clock) =>
    save(outbox, notes, row).pipe(Effect.provideService(Clock.Clock, {
      ...clock,
      currentTimeMillis: Effect.succeed(queuedAt),
      currentTimeMillisUnsafe: () => queuedAt
    }))
  )

// Counter metadata survives an empty queue; assertions about retained writes exclude only that support row.
const retainedKeys = (storage: ReturnType<typeof memoryStorage>) =>
  [...storage.entries.keys()].filter((key) => key !== "outbox:admission-counter")

const texts = (rows: ReadonlyArray<Note>) => rows.map(({ id }) => id)

/** A network detector that starts offline; `connect` brings it online and tells the outbox, as a browser does. */
const offline = () => {
  const detector = Outbox.Online.always()
  const state = { online: false }
  return {
    ...detector,
    isOnline: () => state.online,
    disconnect: () => {
      state.online = false
    },
    connect: () => {
      state.online = true
      detector.notifyOnline()
    }
  }
}

const withdrawnCount = Metric.value(Metric.withAttributes(Outbox.attempts, { name: "save", outcome: "withdrawn" }))

describe("a write", () => {
  test("shows its rows at once, is stored before it is sent, is sent once with its key, and settles", async () => {
    const world = await setup([])
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const write = yield* save(outbox, notes, note("a", 1))
      const shown = texts(yield* notes.toArray)
      yield* write.admitted
      const stored = retainedKeys(world.storage)
      yield* Queue.offer(world.outcomes, "ok")
      yield* write.settled
      return {
        shown,
        stored,
        sent: world.sent,
        after: texts(yield* notes.toArray),
        left: retainedKeys(world.storage),
        sends: (yield* Metric.value(Metric.withAttributes(Outbox.attempts, { name: "save", outcome: "sent" }))).count,
        queued: (yield* Metric.value(Metric.withAttributes(Outbox.queuedMs, { name: "save" }))).count
      }
    }))
    expect(seen.shown).toEqual(["a"])
    expect(seen.stored).toHaveLength(1)
    expect(seen.sent).toEqual([{ rows: [note("a", 1)], idempotencyKey: "a" }])
    // The rows were optimistic: the source never got them, so they go once the write settles.
    expect(seen.after).toEqual([])
    expect(seen.left).toEqual([])
    expect(seen.sends).toBe(1)
    expect(seen.queued).toBe(1)
  })

  test("that doesn't get through is sent again, whatever its status, until it does", async () => {
    const world = await setup([new Outbox.Retry({}), new Outbox.Retry({ status: 400 })])
    const { result: statuses, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start(world)
        const seen: Array<Outbox.Status> = []
        yield* outbox.status.pipe(
          Stream.runForEach((status) => Effect.sync(() => seen.push(status))),
          Effect.forkScoped
        )
        const write = yield* save(outbox, notes, note("a", 1))
        // The library waits 1 s, then 2 s; retryNow sends at once.
        yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
        yield* outbox.retryNow
        yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(2)))
        yield* Queue.offer(world.outcomes, "ok")
        yield* outbox.retryNow
        yield* write.settled
        return seen
      })).pipe(Effect.provide(ownMetrics()))
    )
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a", "a", "a"])
    // Logged on its first retry only, by its status; every send is counted.
    const retrying = logs.filter(({ message }) => (message as Array<unknown>)[0] === "outbox write retrying")
    expect(retrying.map(({ level, annotations }) => [level, annotations])).toEqual([
      ["Warn", { name: "save", status: "none", outcome: "retry" }]
    ])
    expect(statuses.map(({ failing }) => failing)).toEqual(expect.arrayContaining(["network", "server", null]))
    expect(statuses.at(-1)).toEqual({ leader: true, failing: null, held: false })
  })

  test("the server refuses is never sent again, rolls back, and is logged and counted", async () => {
    const world = await setup([new Outbox.Refused({ status: 409 })])
    const { result: seen, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start(world)
        const write = yield* save(outbox, notes, note("a", 1))
        const settled = yield* Effect.exit(write.settled)
        return {
          settled: Exit.isFailure(settled),
          rows: texts(yield* notes.toArray),
          refused: (yield* Metric.value(Metric.withAttributes(Outbox.refused, { name: "save", status: "409" }))).count,
          left: retainedKeys(world.storage)
        }
      })).pipe(Effect.provide(ownMetrics()))
    )
    expect(seen).toEqual({ settled: true, rows: [], refused: 1, left: [] })
    expect(logs).toContainEqual(expect.objectContaining({
      message: ["outbox write refused"],
      level: "Warn",
      annotations: { name: "save", status: "409", outcome: "refused" }
    }))
    expect(world.sent).toHaveLength(1)
  })

  test("refused without a status is counted as none", async () => {
    const world = await setup([new Outbox.Refused({})])
    const refused = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      yield* Effect.exit((yield* save(outbox, notes, note("a", 1))).settled)
      return (yield* Metric.value(Metric.withAttributes(Outbox.refused, { name: "save", status: "none" }))).count
    }))
    expect(refused).toBe(1)
  })

  test("whose mutation dies is never sent again, rolls back, and is logged without its error", async () => {
    const world = await setup(["defect"])
    const { result, logs } = await withLogs(Effect.scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const write = yield* save(outbox, notes, note("a", 1))
      return { settled: Exit.isFailure(yield* Effect.exit(write.settled)), rows: texts(yield* notes.toArray) }
    })))
    expect(result).toEqual({ settled: true, rows: [] })
    expect(logs).toContainEqual(expect.objectContaining({
      message: ["outbox write failed"],
      level: "Error",
      annotations: { name: "save", outcome: "defect", "error.type": "Error" }
    }))
    expect(JSON.stringify(logs)).not.toContain("boom")
  })

  test("queued by one program is restored and sent once by the next", async () => {
    const world = await setup([new Outbox.Retry({})])
    const collection = id("notes")
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, notes: collection })
      yield* (yield* save(outbox, notes, note("a", 1))).admitted
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
    }))
    const restored = await scoped(Effect.gen(function*() {
      const { notes } = yield* start({ ...world, notes: collection })
      // Its rows are back before it is sent again.
      const shown = texts(yield* notes.toArray)
      yield* Queue.offer(world.outcomes, "ok")
      yield* Effect.promise(() => until(() => expect(retainedKeys(world.storage).length).toBe(0)))
      return shown
    }))
    expect(restored).toEqual(["a"])
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a", "a"])
  })

  test("links every send to the span it was made in", async () => {
    const world = await setup(["ok"])
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    await scoped(
      Effect.gen(function*() {
        const { notes, outbox } = yield* start(world)
        const write = yield* save(outbox, notes, note("a", 1)).pipe(Effect.withSpan("ask"))
        yield* write.settled
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )
    const ask = spans.find(({ name }) => name === "ask")!
    const send = spans.find(({ name }) => name === "outbox.send")!
    expect(send.attributes.get("name")).toBe("save")
    expect(send.attributes.get("attempt")).toBe(1)
    expect(send.attributes.get("outcome")).toBe("sent")
    expect(send.links.map(({ span }) => span.spanId)).toEqual([ask.spanId])
  })

  test("whose change TanStack DB refuses fails with MutationRefused, and nothing is stored or sent", async () => {
    const world = await setup([])
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      yield* notes.insert(note("a", 1))
      const exit = yield* Effect.exit(save(outbox, notes, note("a", 2)))
      return {
        refused: Exit.isFailure(exit) && exit.cause.toString().includes("MutationRefused"),
        rows: texts(yield* notes.toArray)
      }
    }))
    expect(seen).toEqual({ refused: true, rows: ["a"] })
    expect(retainedKeys(world.storage).length).toBe(0)
    expect(world.sent).toEqual([])
  })
})

describe("admission", () => {
  test("a follower admits nothing: no rows, nothing stored", async () => {
    const world = await setup([])
    const follower: Outbox.Leader = {
      ...single,
      requestLeadership: () => Promise.resolve(false),
      isLeader: () => false
    }
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, leader: follower })
      const exit = yield* Effect.exit(save(outbox, notes, note("a", 1)))
      return { exit, rows: yield* notes.toArray, status: yield* Stream.runHead(outbox.status) }
    }))
    expect(seen.exit).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "follower" })))
    expect(seen.rows).toEqual([])
    expect(seen.status).toEqual(Option.some({ leader: false, failing: null, held: false }))
  })

  test("leadership lost before persistence reports follower without writing storage", async () => {
    const world = await setup([])
    let leading = true
    let change = (_leader: boolean) => {}
    const leader: Outbox.Leader = {
      ...single,
      isLeader: () => leading,
      onLeadershipChange: (listener) => {
        change = (now) => {
          leading = now
          listener(now)
        }
        return () => undefined
      }
    }
    let stores = 0
    const storage = {
      ...world.storage,
      set: async (key: string, value: string) => {
        stores++
        return await world.storage.set(key, value)
      }
    }
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, storage, leader })
      const write = yield* outbox.transact(
        "save",
        { idempotencyKey: "a" },
        Effect.gen(function*() {
          yield* notes.insert(note("a", 1))
          change(false)
        })
      )
      const admitted = yield* Effect.exit(write.admitted)
      yield* Effect.exit(write.settled)
      return { admitted, rows: yield* notes.toArray }
    }))
    expect(seen.admitted).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "follower" })))
    expect(leader.isLeader()).toBe(false)
    expect(seen.rows).toEqual([])
    expect(stores).toBe(0)
    expect(retainedKeys(world.storage).length).toBe(0)
    expect(world.sent).toEqual([])
  })

  test.each([false, true])(
    "storage failure reports the current leadership state (lost: %s)",
    async (loseLeadership) => {
      const world = await setup([])
      let leading = true
      let change = (_leader: boolean) => {}
      const leader: Outbox.Leader = {
        ...single,
        isLeader: () => leading,
        onLeadershipChange: (listener) => {
          change = (now) => {
            leading = now
            listener(now)
          }
          return () => undefined
        }
      }
      let stores = 0
      const storage = {
        ...world.storage,
        set: async () => {
          stores++
          if (loseLeadership) change(false)
          throw new Error("quota")
        }
      }
      const seen = await scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start({ ...world, storage, leader })
        const write = yield* save(outbox, notes, note("a", 1))
        const admitted = yield* Effect.exit(write.admitted)
        yield* Effect.exit(write.settled)
        return { admitted, rows: yield* notes.toArray }
      }))
      expect(seen.admitted).toEqual(
        Exit.fail(new Outbox.NotAdmitted({ reason: loseLeadership ? "follower" : "storage" }))
      )
      expect(leader.isLeader()).toBe(!loseLeadership)
      expect(stores).toBe(1)
      expect(seen.rows).toEqual([])
      expect(retainedKeys(world.storage).length).toBe(0)
      expect(world.sent).toEqual([])
    }
  )

  test("a restored write whose settlement cannot be stored retains its durable record", async () => {
    const world = await setup([new Outbox.Retry({})])
    const collection = id("notes")
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, notes: collection })
      yield* (yield* save(outbox, notes, note("a", 1))).admitted
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
    }))
    const storage = { ...world.storage, set: () => Promise.reject(new Error("quota")) }
    await scoped(Effect.gen(function*() {
      yield* Queue.offer(world.outcomes, "ok")
      yield* start({ ...world, notes: collection, storage: storage as never })
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(2)))
    }))
    expect(retainedKeys(world.storage).length).toBe(1)
  })

  test("a storage that can't be read at start is logged, and the outbox starts", async () => {
    const world = await setup([])
    const storage = { ...world.storage, keys: () => Promise.reject(new Error("blocked")) }
    const { logs } = await withLogs(Effect.scoped(start({ ...world, storage: storage as never })))
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: ["outbox couldn't load its writes"],
        level: "Warn",
        annotations: { error: expect.stringMatching(/^\w+$/) }
      })
    )
  })
})

describe("handoff", () => {
  test("keeps recovery until the recipient's durable receipt, without sending the original", async () => {
    const world = await setup(["ok"])
    const online = offline()
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({ ...world, online })
      const write = yield* save(outbox, notes, note("a", 1))
      yield* write.admitted
      const entered = yield* Deferred.make<void>()
      const persisted = yield* Deferred.make<void>()
      const handoff = yield* outbox.handoff(
        "a",
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(persisted))
      )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      expect(world.storage.entries.has(`tx:${write.id}`)).toBe(false)
      expect(yield* outbox.parked).toMatchObject([{ id: write.id, reason: "withdrawn", rows: [note("a", 1)] }])
      online.connect()
      yield* outbox.retryNow
      expect(world.sent).toEqual([])
      yield* Deferred.succeed(persisted, undefined)
      yield* Fiber.join(handoff)
      expect(yield* outbox.parked).toEqual([])
      expect(retainedKeys(world.storage)).toEqual([])
    }))
  })

  test.each(["failure", "interruption"] as const)(
    "a recipient %s leaves recovery across restart, never a sendable write",
    async (failure) => {
      const world = await setup(["ok"])
      await scoped(Effect.gen(function*() {
        const { outbox, notes } = yield* start({ ...world, online: offline() })
        yield* (yield* save(outbox, notes, note("a", 1))).admitted
        if (failure === "failure") {
          expect(yield* Effect.flip(outbox.handoff("a", Effect.fail("disk full")))).toBe("disk full")
        } else {
          const entered = yield* Deferred.make<void>()
          const fiber = yield* outbox.handoff("a", Effect.andThen(Deferred.succeed(entered, undefined), Effect.never))
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
        }
        expect(yield* outbox.parked).toMatchObject([{ reason: "withdrawn", rows: [note("a", 1)] }])
      }))
      const recovered: Array<unknown> = []
      await scoped(Effect.gen(function*() {
        const { outbox, notes } = yield* start({
          ...world,
          parked: {
            save: (write) =>
              Effect.sync(() => {
                recovered.push(...write.rows)
                return true
              })
          }
        })
        expect(yield* notes.toArray).toEqual([])
        expect(yield* outbox.parked).toEqual([])
        expect(retainedKeys(world.storage)).toEqual([])
      }))
      expect(recovered).toEqual([note("a", 1)])
      expect(world.sent).toEqual([])
    }
  )

  test("a crash after recovery is recorded but before removal cannot resend on reload", async () => {
    const world = await setup(["ok"])
    let refuse = false
    const storage = {
      ...world.storage,
      delete: (key: string) =>
        refuse && key.startsWith("tx:") ? Promise.reject(new Error("disk unavailable")) : world.storage.delete(key)
    }
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({ ...world, storage, online: offline() })
      const write = yield* save(outbox, notes, note("a", 1))
      yield* write.admitted
      refuse = true
      const failure = yield* Effect.flip(outbox.handoff("a", Effect.die("recipient must not run")))
      expect(failure).toMatchObject({ reason: "storage" })
      expect(world.storage.entries.has(`tx:${write.id}`)).toBe(true)
      expect(yield* outbox.parked).toHaveLength(1)
    }))
    const recovered: Array<unknown> = []
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({
        ...world,
        parked: {
          save: (write) =>
            Effect.sync(() => {
              recovered.push(...write.rows)
              return true
            })
        }
      })
      expect(yield* notes.toArray).toEqual([])
      expect(yield* outbox.parked).toEqual([])
      expect(retainedKeys(world.storage)).toEqual([])
    }))
    expect(recovered).toEqual([note("a", 1)])
    expect(world.sent).toEqual([])
  })

  test("refusing the recovery record leaves the original queued and does not run the recipient", async () => {
    const world = await setup(["ok"])
    const storage = {
      ...world.storage,
      set: (key: string, value: string) =>
        key.startsWith("parked:") ? Promise.reject(new Error("disk full")) : world.storage.set(key, value)
    }
    const online = offline()
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({ ...world, storage, online })
      const write = yield* save(outbox, notes, note("a", 1))
      yield* write.admitted
      expect(yield* Effect.flip(outbox.handoff("a", Effect.die("recipient must not run")))).toMatchObject({
        reason: "storage"
      })
      expect(yield* outbox.parked).toEqual([])
      expect(world.storage.entries.has(`tx:${write.id}`)).toBe(true)
      online.connect()
      yield* write.settled
    }))
    expect(world.sent).toMatchObject([{ idempotencyKey: "a" }])
  })

  test.each(
    [
      ["gone", () => Promise.resolve(null)],
      ["storage", () => Promise.reject(new Error("disk unavailable"))]
    ] as const
  )("a recovery read that finds the write %s leaves it queued, and the recipient doesn't run", async (reason, read) => {
    const world = await setup(["ok"])
    // The outbox's own read finds the write; the next read, for the recovery record, finds it deleted or fails.
    let reads: number | undefined
    const storage = {
      ...world.storage,
      get: (key: string) =>
        reads !== undefined && key.startsWith("tx:") && reads++ > 0 ? read() : world.storage.get(key)
    }
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({ ...world, storage, online: offline() })
      const write = yield* save(outbox, notes, note("a", 1))
      yield* write.admitted
      reads = 0
      expect(yield* Effect.flip(outbox.handoff("a", Effect.die("recipient must not run")))).toMatchObject({ reason })
      expect(yield* outbox.parked).toEqual([])
      expect(world.storage.entries.has(`tx:${write.id}`)).toBe(true)
    }))
  })
})

describe("withdraw", () => {
  const keys = (sent: ReadonlyArray<{ readonly idempotencyKey: string }>) =>
    sent.map(({ idempotencyKey }) => idempotencyKey)
  // Why `withdraw` refused, failing the test if it took the write back.
  const refusal = (outbox: Outbox.Service, key: string) =>
    Effect.map(Effect.flip(outbox.withdraw(key)), (error: Outbox.NotWithdrawn) => error.reason)

  test("takes back a write waiting to be sent: its rows and stored copy go at once, it is never sent, and the writes after it are", async () => {
    const world = await setup(["ok", "ok"])
    const network = offline()
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, online: network })
      const a = yield* save(outbox, notes, note("a", 1))
      yield* a.admitted
      const b = yield* save(outbox, notes, note("b", 2))
      yield* b.admitted
      yield* outbox.withdraw("a")
      const rows = texts(yield* notes.toArray)
      const stored = world.storage.entries.has(`tx:${a.id}`)
      const settled = yield* Effect.flip(a.settled)
      const c = yield* save(outbox, notes, note("c", 3))
      yield* c.admitted
      // Offline, asking to send now sends nothing.
      yield* outbox.retryNow
      const sentOffline = keys(world.sent)
      network.connect()
      yield* b.settled
      yield* c.settled
      return {
        rows,
        stored,
        cause: (settled.cause as Error).name,
        sentOffline,
        withdrawn: (yield* withdrawnCount).count,
        left: retainedKeys(world.storage).length
      }
    }))
    expect(seen).toEqual({
      rows: ["b"],
      stored: false,
      cause: "OutboxWithdrawn",
      sentOffline: [],
      withdrawn: 1,
      left: 0
    })
    expect(keys(world.sent)).toEqual(["b", "c"])
  })

  test("takes back a write waiting out its backoff, and the write behind it is sent", async () => {
    const world = await setup([new Outbox.Retry({})])
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const a = yield* save(outbox, notes, note("a", 1))
      // Its send didn't get through: the library stores its next attempt, at least a second away.
      yield* Effect.promise(() =>
        until(() => expect(JSON.parse(world.storage.entries.get(`tx:${a.id}`)!).retryCount).toBe(1))
      )
      const b = yield* save(outbox, notes, note("b", 2))
      yield* b.admitted
      yield* outbox.withdraw("a")
      yield* Queue.offer(world.outcomes, "ok")
      yield* outbox.retryNow
      yield* b.settled
      return { withdrawn: (yield* withdrawnCount).count, left: retainedKeys(world.storage).length }
    }))
    expect(seen).toEqual({ withdrawn: 1, left: 0 })
    expect(keys(world.sent)).toEqual(["a", "b"])
  })

  /** `storage` whose next store, once `close` is called, waits until `open`: the library's write after a send. */
  const gated = (storage: ReturnType<typeof memoryStorage>) => {
    const gate = { closed: false, reached: false, open: () => {} }
    return {
      gate,
      storage: {
        ...storage,
        set: async (key: string, value: string) => {
          if (gate.closed) {
            gate.closed = false
            gate.reached = true
            await new Promise<void>((open) => {
              gate.open = open
            })
          }
          return storage.set(key, value)
        }
      }
    }
  }

  test("leaves a write alone until the library has stored its next attempt, so one taken back never comes back", async () => {
    const world = await setup([])
    const { gate, storage } = gated(world.storage)
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, storage })
      const a = yield* save(outbox, notes, note("a", 1))
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
      gate.closed = true
      yield* Queue.offer(world.outcomes, new Outbox.Retry({}))
      // The send didn't get through, and the library is storing the write's next attempt.
      yield* Effect.promise(() => until(() => expect(gate.reached).toBe(true)))
      const storing = yield* refusal(outbox, "a")
      gate.open()
      yield* Effect.promise(() =>
        until(() => expect(JSON.parse(world.storage.entries.get(`tx:${a.id}`)!).retryCount).toBe(1))
      )
      yield* outbox.withdraw("a")
      const b = yield* save(outbox, notes, note("b", 2))
      yield* Queue.offer(world.outcomes, "ok")
      yield* outbox.retryNow
      yield* b.settled
      return { storing, withdrawn: (yield* withdrawnCount).count, left: retainedKeys(world.storage).length }
    }))
    expect(seen).toEqual({ storing: "sending", withdrawn: 1, left: 0 })
    expect(keys(world.sent)).toEqual(["a", "b"])
  })

  test("leaves a write the server just took alone while the library deletes it: it fails with sending", async () => {
    const world = await setup([])
    const { gate, storage } = gated(world.storage)
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, storage })
      const a = yield* save(outbox, notes, note("a", 1))
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
      gate.closed = true
      yield* Queue.offer(world.outcomes, "ok")
      // The server took it; the library is marking it sent before deleting it.
      yield* Effect.promise(() => until(() => expect(gate.reached).toBe(true)))
      const deleting = yield* refusal(outbox, "a")
      gate.open()
      yield* a.settled
      return { deleting, rows: texts(yield* notes.toArray), left: retainedKeys(world.storage).length }
    }))
    expect(seen).toEqual({ deleting: "sending", rows: [], left: 0 })
    expect(keys(world.sent)).toEqual(["a"])
  })

  test("leaves a write being sent alone: it fails with sending, and the write is sent once and settles", async () => {
    const world = await setup([])
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const a = yield* save(outbox, notes, note("a", 1))
      // Its mutation is running, waiting for the server's answer.
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
      const refused = yield* refusal(outbox, "a")
      const rows = texts(yield* notes.toArray)
      yield* Queue.offer(world.outcomes, "ok")
      yield* a.settled
      return { refused, rows, left: retainedKeys(world.storage).length }
    }))
    expect(seen).toEqual({ refused: "sending", rows: ["a"], left: 0 })
    expect(keys(world.sent)).toEqual(["a"])
  })

  test("leaves a sent write whose deletion was cut short alone: it fails with sending, and it isn't sent again", async () => {
    const world = await setup([])
    const collection = id("notes")
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, notes: collection, online: offline() })
      yield* (yield* save(outbox, notes, note("a", 1))).admitted
    }))
    // As the library stores a write the server took, before it deletes it: the program closed in between.
    const [key, value] = [...world.storage.entries].find(([key]) => key.startsWith("tx:"))!
    world.storage.entries.set(key, JSON.stringify({ ...JSON.parse(value), outboxPhase: "deletion-pending" }))
    const network = offline()
    const refused = await scoped(Effect.gen(function*() {
      const { outbox } = yield* start({ ...world, notes: collection, online: network })
      const refused = yield* refusal(outbox, "a")
      network.connect()
      yield* Effect.promise(() => until(() => expect(retainedKeys(world.storage).length).toBe(0)))
      return refused
    }))
    expect(refused).toBe("sending")
    expect(world.sent).toEqual([])
  })

  test("takes back a write restored by the next program: its restored rows roll back and it is never sent", async () => {
    const world = await setup(["ok"])
    const collection = id("notes")
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, notes: collection, online: offline() })
      yield* (yield* save(outbox, notes, note("a", 1))).admitted
    }))
    const network = offline()
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, notes: collection, online: network })
      const restored = texts(yield* notes.toArray)
      yield* outbox.withdraw("a")
      const rows = texts(yield* notes.toArray)
      const left = retainedKeys(world.storage).length
      // A write made after it is sent once the network is back; the outbox reaches the withdrawn one first.
      const b = yield* save(outbox, notes, note("b", 2))
      network.connect()
      yield* b.settled
      return { restored, rows, left, withdrawn: (yield* withdrawnCount).count }
    }))
    expect(seen).toEqual({ restored: ["a"], rows: [], left: 0, withdrawn: 1 })
    expect(keys(world.sent)).toEqual(["b"])
  })

  test("by a follower changes nothing: it fails with follower, and the leader sends the write", async () => {
    const world = await setup(["ok"])
    const follower: Outbox.Leader = {
      ...single,
      requestLeadership: () => Promise.resolve(false),
      isLeader: () => false
    }
    const network = offline()
    const seen = await scoped(Effect.gen(function*() {
      const leading = yield* start({ ...world, online: network })
      const a = yield* save(leading.outbox, leading.notes, note("a", 1))
      yield* a.admitted
      const following = yield* start({ ...world, leader: follower })
      const refused = yield* refusal(following.outbox, "a")
      const stored = world.storage.entries.has(`tx:${a.id}`)
      const rows = texts(yield* leading.notes.toArray)
      network.connect()
      yield* a.settled
      return { refused, stored, rows }
    }))
    expect(seen).toEqual({
      refused: "follower",
      stored: true,
      rows: ["a"]
    })
    expect(keys(world.sent)).toEqual(["a"])
  })

  test("of a key no waiting write has fails with gone: one never made, or one sent already", async () => {
    const world = await setup(["ok"])
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const never = yield* refusal(outbox, "a")
      yield* (yield* save(outbox, notes, note("a", 1))).settled
      return { never, sent: yield* refusal(outbox, "a") }
    }))
    expect(seen).toEqual({ never: "gone", sent: "gone" })
  })

  test("over a storage that can't be read or deleted from fails with storage, and the write is still sent", async () => {
    const world = await setup(["ok"])
    // How many of the next calls fail.
    const failing = { keys: 0, deletes: 0 }
    const fails = (call: "keys" | "deletes") => {
      if (failing[call] === 0) return false
      failing[call]--
      return true
    }
    const storage = {
      ...world.storage,
      keys: () => fails("keys") ? Promise.reject(new Error("unreadable")) : world.storage.keys(),
      delete: (key: string) => fails("deletes") ? Promise.reject(new Error("blocked")) : world.storage.delete(key)
    }
    const network = offline()
    const { result, logs } = await withLogs(Effect.scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, storage, online: network })
      const a = yield* save(outbox, notes, note("a", 1))
      yield* a.admitted
      failing.keys = 1
      const unread = yield* refusal(outbox, "a")
      failing.deletes = 1
      const undeleted = yield* refusal(outbox, "a")
      const rows = texts(yield* notes.toArray)
      network.connect()
      yield* a.settled
      return { unread, undeleted, rows }
    })))
    expect(result).toEqual({ unread: "storage", undeleted: "storage", rows: ["a"] })
    expect(keys(world.sent)).toEqual(["a"])
    expect(logs).toContainEqual(expect.objectContaining({
      message: ["outbox write not withdrawn"],
      level: "Warn",
      annotations: { reason: "storage" }
    }))
  })

  test("is a span with its outcome, and is logged without the write's rows", async () => {
    const world = await setup([])
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const { logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start({ ...world, online: offline() })
        yield* Effect.exit(outbox.withdraw("a"))
        yield* (yield* save(outbox, notes, note("a", 1, "a private question"))).admitted
        yield* outbox.withdraw("a")
      })).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )
    expect(
      spans.filter(({ name }) => name === "outbox.withdraw").map(({ attributes }) => attributes.get("outcome"))
    ).toEqual(["gone", "withdrawn"])
    expect(logs).toContainEqual(expect.objectContaining({
      message: ["outbox write not withdrawn"],
      level: "Debug",
      annotations: { reason: "gone" }
    }))
    expect(logs).toContainEqual(expect.objectContaining({
      message: ["outbox write withdrawn"],
      level: "Info",
      annotations: { name: "save" }
    }))
    expect(JSON.stringify(logs)).not.toContain("private")
  })
})

describe("Online.always and leadership", () => {
  test("always is always online and notifies its listeners until disposed", async () => {
    const online = Outbox.Online.always()
    let notified = 0
    const unsubscribe = online.subscribe(() => notified++)
    online.notifyOnline()
    unsubscribe()
    online.notifyOnline()
    online.subscribe(() => notified++)
    online.dispose()
    online.notifyOnline()
    expect([online.isOnline(), notified]).toEqual([true, 1])
  })

  test("without a leader, the library's Web Lock elects the first program, and the second follows", async () => {
    const world = await setup(["ok"])
    const seen = await scoped(Effect.gen(function*() {
      const first = yield* start({ ...world, leader: undefined })
      const second = yield* start({ ...world, leader: undefined })
      const following = yield* Effect.exit(save(second.outbox, second.notes, note("a", 1)))
      yield* (yield* save(first.outbox, first.notes, note("b", 2))).settled
      return {
        following,
        counted: (yield* Metric.value(Metric.withAttributes(Outbox.leaderChanges, { leader: "true" }))).count
      }
    }))
    expect(seen.following).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "follower" })))
    expect(seen.counted).toBe(1)
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["b"])
  })

  test("default executor disposal drains a paused admission before reopening can allocate or replay", async () => {
    const world = await setup([])
    const queuedAt = 1_800_000_000_000
    const saveAtSameTime = saveAt(queuedAt)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const counters: number[] = []
    const storage = {
      ...world.storage,
      setMany: async (entries: ReadonlyArray<readonly [string, string]>) => {
        if (entries.some(([key, value]) => key.startsWith("tx:") && JSON.parse(value).idempotencyKey === "first")) {
          enter()
          await gate
        }
        await world.storage.setMany(entries)
        const counter = entries.find(([key]) => key === "outbox:admission-counter")
        if (counter !== undefined) counters.push(Number(counter[1]))
      }
    }
    const sent: string[] = []
    const mutation: Outbox.Mutation<never> = ({ idempotencyKey }) =>
      Effect.sync(() => {
        sent.push(idempotencyKey)
      })
    const options = { ...world, storage, leader: undefined, orderingKeys: { save: () => ["same"] }, mutation }
    try {
      await scoped(
        Effect.gen(function*() {
          const firstScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
          const first = yield* Scope.provide(start({ ...options, online: offline() }), firstScope)
          const firstWrite = yield* saveAtSameTime(first.outbox, first.notes, note("first", 1))
          yield* Effect.promise(() => entered)
          const closing = yield* Scope.close(firstScope, Exit.void).pipe(Effect.forkScoped)
          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
          expect(yield* Effect.exit(saveAtSameTime(first.outbox, first.notes, note("late", 4))))
            .toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "follower" })))
          const secondScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
          const second = yield* Scope.provide(start({ ...options, online: offline() }), secondScope)
          // A reopen that still follows retries after disposal completes. If it leads early, expose both allocations
          // before releasing the older batch so the counter history catches regression, not merely a duplicated value.
          const early = yield* Effect.exit(saveAtSameTime(second.outbox, second.notes, note("second", 2)))
          if (Exit.isSuccess(early)) {
            yield* early.value.admitted
            yield* (yield* saveAtSameTime(second.outbox, second.notes, note("third", 3))).admitted
          }
          release()
          yield* firstWrite.admitted
          yield* Fiber.join(closing)
          yield* Scope.close(secondScope, Exit.void)
          const network = offline()
          const reopened = yield* start({ ...options, online: network })
          if (Exit.isFailure(early)) {
            expect(early).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "follower" })))
            yield* (yield* saveAtSameTime(reopened.outbox, reopened.notes, note("second", 2))).admitted
            yield* (yield* saveAtSameTime(reopened.outbox, reopened.notes, note("third", 3))).admitted
          }
          expect(counters.every((value, index) => index === 0 || value > counters[index - 1]!)).toBe(true)
          const rows = [...storage.entries.values()].map((value) => JSON.parse(value)).filter((row) =>
            row.idempotencyKey
          )
          expect(rows.map((row) => row.metadata.queuedAt)).toEqual([queuedAt, queuedAt, queuedAt])
          const sequence = (key: string) => rows.find((row) => row.idempotencyKey === key).metadata.admissionSequence
          expect(sequence("first")).toBeLessThan(sequence("second"))
          expect(sequence("second")).toBeLessThan(sequence("third"))
          expect(Number(storage.entries.get("outbox:admission-counter"))).toBe(sequence("third"))
          network.connect()
          yield* reopened.outbox.retryNow
          yield* Effect.promise(() => until(() => expect(sent).toEqual(["first", "second", "third"])))
        }).pipe(Effect.ensuring(Effect.sync(release)))
      )
    } finally {
      release()
    }
  })
})

describe("lockLeader", () => {
  const lock = webLocks()

  test("the first program leads; the next waits, and when the first closes it leads and sends what was stored", async () => {
    const world = await setup([new Outbox.Retry({}), "ok"])
    const name = id("outbox")
    const seen = await scoped(Effect.gen(function*() {
      const firstScope = yield* Scope.make()
      const first = yield* Scope.provide(
        Effect.flatMap(Outbox.lockLeader({ lock, name }), (leader) => start({ ...world, leader })),
        firstScope
      )
      const write = yield* save(first.outbox, first.notes, note("a", 1))
      yield* write.admitted
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
      const leader = yield* Outbox.lockLeader({ lock, name })
      const second = yield* start({ ...world, leader })
      const waited = (yield* Stream.runHead(second.outbox.status)).pipe(Option.map(({ leader }) => leader))
      yield* Scope.close(firstScope, Exit.void)
      yield* Effect.promise(() => until(() => expect(leader.isLeader()).toBe(true)))
      yield* Effect.promise(() => until(() => expect(retainedKeys(world.storage).length).toBe(0)))
      leader.dispose()
      return { waited, after: leader.isLeader() }
    }))
    expect(seen).toEqual({ waited: Option.some(false), after: false })
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a", "a"])
  })

  test("a released leader lets the lock go, and releasing again changes nothing", async () => {
    const name = id("outbox")
    const changes: Array<boolean> = []
    await scoped(Effect.gen(function*() {
      const leader = yield* Outbox.lockLeader({ lock, name })
      const unsubscribe = leader.onLeadershipChange((now) => changes.push(now))
      expect(yield* Effect.promise(() => leader.requestLeadership())).toBe(true)
      leader.releaseLeadership()
      yield* Effect.promise(() => until(() => expect(changes).toEqual([true, false])))
      leader.releaseLeadership()
      unsubscribe()
    }))
    expect(changes).toEqual([true, false])
  })

  test("take leads at once: the program that led stops leading, waits again, and leads again once the taker closes", async () => {
    const world = await setup(["ok", "ok"])
    const name = id("outbox")
    const seen = await scoped(Effect.gen(function*() {
      const notes = id("notes")
      const firstLeader = yield* Outbox.lockLeader({ lock, name })
      const first = yield* start({ ...world, leader: firstLeader, notes })
      const secondScope = yield* Scope.make()
      const secondLeader = yield* Scope.provide(
        Outbox.lockLeader({ lock, name }),
        secondScope
      )
      const second = yield* Scope.provide(start({ ...world, leader: secondLeader, notes }), secondScope)
      const following = yield* Effect.exit(save(second.outbox, second.notes, note("a", 1)))

      yield* secondLeader.take
      const taken = secondLeader.isLeader()
      // The program it took the lead from hears so a moment later, as a browser tells a lock's holder it was stolen.
      yield* Effect.promise(() => until(() => expect(firstLeader.isLeader()).toBe(false)))
      yield* (yield* save(second.outbox, second.notes, note("b", 2))).settled
      // Taking the lead again changes nothing.
      yield* secondLeader.take
      yield* Scope.close(secondScope, Exit.void)
      yield* Effect.promise(() => until(() => expect(firstLeader.isLeader()).toBe(true)))
      yield* (yield* save(first.outbox, first.notes, note("c", 3))).settled
      return { following, taken }
    }))
    expect(seen.following).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "follower" })))
    expect(seen.taken).toBe(true)
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["b", "c"])
  })

  test("a write sent by the program that took the lead isn't sent again when this one leads again", async () => {
    const world = await setup([new Outbox.Retry({}), "ok", "ok"])
    const name = id("outbox")
    const seen = await scoped(Effect.gen(function*() {
      const notes = id("notes")
      const firstLeader = yield* Outbox.lockLeader({ lock, name })
      const first = yield* start({ ...world, leader: firstLeader, notes })
      // The first program's send doesn't get through: the write waits out its backoff, still queued here.
      const write = yield* save(first.outbox, first.notes, note("a", 1))
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))

      // The second takes the lead, sends the write and deletes it, then closes.
      const secondScope = yield* Scope.make()
      const secondLeader = yield* Scope.provide(
        Outbox.lockLeader({ lock, name }),
        secondScope
      )
      yield* Scope.provide(start({ ...world, leader: secondLeader, notes }), secondScope)
      yield* secondLeader.take
      yield* Effect.promise(() => until(() => expect(retainedKeys(world.storage).length).toBe(0)))
      yield* Scope.close(secondScope, Exit.void)

      // The first leads again: its queued copy settles without a third send.
      yield* Effect.promise(() => until(() => expect(firstLeader.isLeader()).toBe(true)))
      yield* write.settled
      return (yield* Metric.value(Metric.withAttributes(Outbox.attempts, { name: "save", outcome: "sent_elsewhere" })))
        .count
    }))
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a", "a"])
    expect(seen).toBe(1)
  })

  test("a storage read that fails doesn't stop a send", async () => {
    const world = await setup(["ok"])
    // The next read fails, once: the send's own look at the storage.
    const unreadable = { reads: 0 }
    const storage = {
      ...world.storage,
      get: (key: string) =>
        key.startsWith("tx:") && unreadable.reads > 0 && unreadable.reads-- > 0
          ? Promise.reject(new Error("unreadable"))
          : world.storage.get(key)
    }
    await scoped(Effect.gen(function*() {
      const { notes, outbox, online } = yield* start({ ...world, storage: storage as typeof world.storage })
      unreadable.reads = 1
      yield* (yield* save(outbox, notes, note("a", 1))).settled
      online.dispose()
    }))
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a"])
  })

  test("a program that took the lead answers requestLeadership at once", async () => {
    const name = id("outbox")
    await scoped(Effect.gen(function*() {
      const leader = yield* Outbox.lockLeader({ lock, name })
      yield* leader.take
      expect(yield* Effect.promise(() => leader.requestLeadership())).toBe(true)
    }))
  })

  test("a take the lock never grants leaves the program following, and can be interrupted", async () => {
    const name = id("outbox")
    const never: Outbox.Lock = { hold: () => Effect.never, tryHold: () => Effect.never }
    await scoped(Effect.gen(function*() {
      const leader = yield* Outbox.lockLeader({ lock: never, name })
      const taking = yield* Effect.forkChild(leader.take, { startImmediately: true })
      // The take's hold is in line: asking to lead adds no second one, and isn't granted.
      expect(yield* Effect.promise(() => leader.requestLeadership())).toBe(false)
      // Let go, the program doesn't lead, so the take doesn't complete: it waits to be interrupted.
      leader.releaseLeadership()
      yield* Effect.yieldNow
      expect(taking.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(taking)
      expect(leader.isLeader()).toBe(false)
    }))
  })

  test("a program alone leads before requestLeadership answers, however late its lock manager answers", async () => {
    const world = await setup(["ok"])
    const name = id("outbox")
    const seen = await scoped(Effect.gen(function*() {
      const leader = yield* Outbox.lockLeader({ lock: webLocks({ answerAfter: 300 }), name })
      const { notes, outbox } = yield* start({ ...world, leader })
      // The outbox has started: its first write is admitted at once, never refused as a follower's.
      const write = yield* Effect.exit(save(outbox, notes, note("a", 1)))
      if (Exit.isSuccess(write)) yield* write.value.settled
      return { write: Exit.isSuccess(write), leads: leader.isLeader() }
    }))
    expect(seen).toEqual({ write: true, leads: true })
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a"])
  })

  test("a program whose lock another holds is told at once, waits in line, and leads once the other closes", async () => {
    const name = id("outbox")
    const seen = await scoped(Effect.gen(function*() {
      const firstScope = yield* Scope.make()
      const first = yield* Scope.provide(Outbox.lockLeader({ lock, name }), firstScope)
      const firstLeads = yield* Effect.promise(() => first.requestLeadership())
      const second = yield* Outbox.lockLeader({ lock, name })
      const changes: Array<boolean> = []
      second.onLeadershipChange((now) => changes.push(now))
      const secondLeads = yield* Effect.promise(() => second.requestLeadership())
      // Asking again while its hold waits in line adds no second one.
      const again = yield* Effect.promise(() => second.requestLeadership())
      yield* Scope.close(firstScope, Exit.void)
      yield* Effect.promise(() => until(() => expect(changes).toEqual([true])))
      return { firstLeads, secondLeads, again }
    }))
    expect(seen).toEqual({ firstLeads: true, secondLeads: false, again: false })
  })

  test("a lock manager that refuses the request leaves the program not leading, logged, and asked again next time", async () => {
    const name = id("outbox")
    const asked: Array<string> = []
    // A lock manager refuses with an error, or with anything else a browser throws.
    const refusals: Array<unknown> = [new DOMException("reserved", "NotSupportedError"), "refused"]
    const refusing: Outbox.Lock = {
      hold: () => Effect.never,
      tryHold: (lockName) => Effect.andThen(Effect.sync(() => asked.push(lockName)), Effect.die(refusals.shift()))
    }
    const { result, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const leader = yield* Outbox.lockLeader({ lock: refusing, name })
        const first = yield* Effect.promise(() => leader.requestLeadership())
        const again = yield* Effect.promise(() => leader.requestLeadership())
        return { first, again, leads: leader.isLeader() }
      })).pipe(Effect.provide(ownMetrics()))
    )
    expect(result).toEqual({ first: false, again: false, leads: false })
    expect(asked).toEqual([name, name])
    expect(
      logs.filter(({ message }) => (message as Array<unknown>)[0] === "outbox lock refused").map(({ annotations }) =>
        annotations.error
      )
    ).toEqual(["NotSupportedError", "string"])
  })

  test("a program let go before its lock manager answers answers that it doesn't lead", async () => {
    const name = id("outbox")
    const silent: Outbox.Lock = { hold: () => Effect.never, tryHold: () => Effect.never }
    const seen = await scoped(Effect.gen(function*() {
      const leader = yield* Outbox.lockLeader({ lock: silent, name })
      const asked = leader.requestLeadership()
      yield* Effect.yieldNow
      leader.releaseLeadership()
      return yield* Effect.promise(() => asked)
    }))
    expect(seen).toBe(false)
  })
})

describe("principal", () => {
  // Who a program writes as; `now` and `ownsUnstamped` are read each time the outbox asks.
  const as = (now: string | undefined, ownsUnstamped = false) => {
    const state = { now, ownsUnstamped }
    return { state, principal: { now: () => state.now, ownsUnstamped: () => state.ownsUnstamped } }
  }
  const sent = (world: Awaited<ReturnType<typeof setup>>) => world.sent.map(({ idempotencyKey }) => idempotencyKey)

  // Queues `rows` as `principal`, offline so none is sent, then lets the program go, as a tab that closes does.
  const queue = (
    world: Awaited<ReturnType<typeof setup>>,
    principal: Outbox.Principal | undefined,
    rows: Array<Note>
  ) =>
    scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({
        ...world,
        online: offline(),
        ...(principal === undefined ? {} : { principal })
      })
      for (const row of rows) yield* (yield* save(outbox, notes, row)).admitted
    }))

  test("a write queued as one principal is never loaded, shown or sent as another; the storage keeps it", async () => {
    const world = await setup(["ok", "ok"])
    await queue(world, as("ann").principal, [note("a", 1)])
    const stored = retainedKeys(world.storage)
    const { result, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start({ ...world, principal: as("ben").principal })
        const shown = texts(yield* notes.toArray)
        // Ben's own write goes; had Ann's loaded, it would have gone first.
        yield* (yield* save(outbox, notes, note("b", 2))).settled
        return { shown, ben: retainedKeys(world.storage) }
      })).pipe(Effect.provide(ownMetrics()))
    )
    expect(result.shown).toEqual([])
    expect(sent(world)).toEqual(["b"])
    expect(result.ben).toEqual(stored)
    expect(
      logs.filter(({ message }) => (message as Array<unknown>)[0] === "outbox write sealed").map(({ annotations }) =>
        annotations
      )
    ).toContainEqual(expect.objectContaining({ name: "save", stage: "load" }))
    // Ann's comes back as hers, and leaves the storage once sent.
    await scoped(Effect.gen(function*() {
      yield* start({ ...world, principal: as("ann").principal })
      yield* Effect.promise(() => until(() => expect(sent(world)).toEqual(["b", "a"])))
      yield* Effect.promise(() => until(() => expect(retainedKeys(world.storage).length).toBe(0)))
    }))
  })

  test("another owner's write is never passed to an upgrade or moved into parking", async () => {
    const world = await setup([])
    await queue(world, as("ann").principal, [note("a", 1)])
    const before = [...world.storage.entries]
    const inspected: Array<string> = []
    await scoped(Effect.gen(function*() {
      yield* start({
        ...world,
        principal: as("ben").principal,
        upgrade: {
          stamp: {},
          write: (stored) => {
            inspected.push(stored)
            return { _tag: "Parked", reason: "unsupported" }
          }
        }
      })
    }))
    expect(inspected).toEqual([])
    expect([...world.storage.entries]).toEqual(before)
  })

  test("a write stored before writes were stamped is the principal's only when it owns unstamped writes", async () => {
    const world = await setup(["ok", "ok", "ok"])
    await queue(world, undefined, [note("a", 1)])
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, principal: as("ben", false).principal })
      yield* (yield* save(outbox, notes, note("b", 2))).settled
    }))
    expect(sent(world)).toEqual(["b"])
    await scoped(Effect.gen(function*() {
      yield* start({ ...world, principal: as("ann", true).principal })
      yield* Effect.promise(() => until(() => expect(sent(world)).toEqual(["b", "a"])))
    }))
  })

  test("a write whose principal changed before it was sent is sealed: its rows roll back, settled fails, the storage keeps it", async () => {
    const world = await setup([])
    const { state, principal } = as("visitor")
    const seen = await scoped(Effect.gen(function*() {
      const network = offline()
      const { notes, outbox } = yield* start({ ...world, online: network, principal })
      const write = yield* save(outbox, notes, note("a", 1))
      yield* write.admitted
      // The device is adopted by Ann before the write goes out.
      state.now = "ann"
      network.connect()
      const settled = yield* Effect.exit(write.settled)
      return {
        settled: Exit.isFailure(settled),
        rows: texts(yield* notes.toArray),
        sealed: (yield* Metric.value(Metric.withAttributes(Outbox.attempts, { name: "save", outcome: "sealed" }))).count
      }
    }))
    expect(seen).toEqual({ settled: true, rows: [], sealed: 1 })
    expect(sent(world)).toEqual([])
    expect(retainedKeys(world.storage)).toHaveLength(1)
    await Effect.runPromise(Queue.offer(world.outcomes, "ok"))
    await scoped(Effect.gen(function*() {
      yield* start({ ...world, principal: as("visitor").principal })
      yield* Effect.promise(() => until(() => expect(sent(world)).toEqual(["a"])))
    }))
  })

  test("a parked write goes to its feature only for the principal that queued it", async () => {
    const world = await setup([])
    const parked = (id: string, principal: string) =>
      world.storage.entries.set(
        `parked:${id}`,
        JSON.stringify({
          reason: "negative",
          name: "save",
          write: JSON.stringify({
            mutationFnName: "save",
            mutations: [{ modified: note(id, -1) }],
            metadata: { principal }
          })
        })
      )
    parked("ann-1", "ann")
    parked("ben-1", "ben")
    const offered: Array<string> = []
    const listed = await scoped(Effect.gen(function*() {
      const { outbox } = yield* start({
        ...world,
        principal: as("ben").principal,
        parked: { save: (write) => Effect.sync(() => (offered.push(write.id), false)) }
      })
      yield* outbox.discard("ann-1")
      expect(world.storage.entries.has("parked:ann-1")).toBe(true)
      return (yield* outbox.parked).map(({ id }) => id)
    }))
    expect({ offered, listed }).toEqual({ offered: ["ben-1"], listed: ["ben-1"] })
  })
})

for (const accepts of [true, false]) {
  test(`live admission lookup and joining share a ${accepts ? "stored" : "refused"} receipt`, async () => {
    const world = await setup(["ok"])
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const online = offline()
    const storage = {
      ...world.storage,
      set: async (key: string, value: string) => {
        await held
        if (!accepts) throw new Error("quota")
        return world.storage.set(key, value)
      }
    }
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({ ...world, storage, online })
      expect(yield* outbox.admission("save", "a")).toEqual(Option.none())
      const first = yield* outbox.transact(
        "save",
        { idempotencyKey: "a", joinExisting: true },
        Effect.asVoid(notes.insert(note("a", 1)))
      )
      const joined = yield* outbox.transact(
        "save",
        { idempotencyKey: "a", joinExisting: true },
        Effect.die("must not mutate twice")
      )
      expect(joined.id).toBe(first.id)
      expect((yield* outbox.admission("save", "a")).pipe(Option.map((write) => write.id))).toEqual(
        Option.some(first.id)
      )
      expect(yield* outbox.admission("another-mutation", "a")).toEqual(Option.none())
      release()
      const admitted = yield* Effect.result(joined.admitted)
      expect(admitted._tag).toBe(accepts ? "Success" : "Failure")
      if (accepts) online.connect()
      yield* Effect.result(first.settled)
      yield* Effect.promise(() =>
        until(async () => expect(await Effect.runPromise(outbox.admission("save", "a"))).toEqual(Option.none()))
      )
      expect(world.sent).toHaveLength(accepts ? 1 : 0)
    }))
  })
}

test("an older non-joined write settling cannot erase a newer receipt with the same key", async () => {
  const world = await setup([])
  await scoped(Effect.gen(function*() {
    const { outbox, notes } = yield* start(world)
    const first = yield* outbox.transact(
      "save",
      { idempotencyKey: "shared" },
      Effect.asVoid(notes.insert(note("first", 1)))
    )
    const second = yield* outbox.transact(
      "save",
      { idempotencyKey: "shared" },
      Effect.asVoid(notes.insert(note("second", 1)))
    )
    yield* first.admitted
    yield* second.admitted
    yield* Queue.offer(world.outcomes, "ok")
    yield* first.settled
    expect((yield* outbox.admission("save", "shared")).pipe(Option.map((write) => write.id))).toEqual(
      Option.some(second.id)
    )
    yield* Queue.offer(world.outcomes, "ok")
    yield* second.settled
  }))
})

describe("held writes", () => {
  const changes = () => {
    const listeners = new Set<() => void>()
    return {
      publish: () => {
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
  const orderingKeys = { save: (rows: ReadonlyArray<unknown>) => (rows as ReadonlyArray<Note>).map((row) => row.text) }

  test("a permanent hold lets another key pass, retains same-key order through reload and leadership change, and delivers each once", async () => {
    const world = await setup([])
    let signedIn = false
    const delivered: Array<string> = []
    const attempted: Array<string> = []
    const mutation: Outbox.Mutation<never> = ({ rows, idempotencyKey }) =>
      Effect.suspend(() => {
        attempted.push(idempotencyKey)
        if ((rows[0] as Note).text === "a" && !signedIn) return new Outbox.Retry({ status: 401, held: true })
        delivered.push(idempotencyKey)
        return Effect.void
      })
    await scoped(Effect.gen(function*() {
      const firstScope = yield* Scope.make()
      const lock = webLocks({ prefix: id("held-lock") })
      const firstLeader = yield* Outbox.lockLeader({ lock, name: "outbox" }).pipe(
        Effect.provideService(Scope.Scope, firstScope)
      )
      const first = yield* start({ ...world, leader: firstLeader, notes: id("first"), orderingKeys, mutation }).pipe(
        Effect.provideService(Scope.Scope, firstScope)
      )
      const takeoverScope = yield* Scope.make()
      const takeoverLeader = yield* Outbox.lockLeader({ lock, name: "outbox" }).pipe(
        Effect.provideService(Scope.Scope, takeoverScope)
      )
      const takeover = yield* start({ ...world, leader: takeoverLeader, notes: id("takeover"), orderingKeys, mutation })
        .pipe(Effect.provideService(Scope.Scope, takeoverScope))
      yield* (yield* save(first.outbox, first.notes, note("a1", 1, "a"))).admitted
      yield* Effect.promise(() => until(() => expect(attempted).toContain("a1")))
      yield* (yield* save(first.outbox, first.notes, note("a2", 2, "a"))).admitted
      yield* (yield* save(first.outbox, first.notes, note("b1", 3, "b"))).admitted
      yield* Effect.promise(() => until(() => expect(delivered).toEqual(["b1"])))
      expect(attempted).not.toContain("a2")
      expect(retainedKeys(world.storage).filter((key) => key.startsWith("tx:"))).toHaveLength(2)
      expect((yield* Metric.value(Metric.withAttributes(Outbox.attempts, { name: "save", outcome: "held" }))).count)
        .toBeGreaterThan(0)
      // Earlier builds stored payloads without dependency metadata. A new leader must recover their keys from rows.
      for (const [key, value] of world.storage.entries) {
        if (!key.startsWith("tx:")) continue
        const legacy = JSON.parse(value)
        delete legacy.metadata.orderingKeys
        world.storage.entries.set(key, JSON.stringify(legacy))
      }
      yield* takeoverLeader.take
      yield* (yield* save(takeover.outbox, takeover.notes, note("c1", 4, "c"))).admitted
      yield* (yield* save(takeover.outbox, takeover.notes, note("a3", 5, "a"))).admitted
      yield* Effect.promise(() => until(() => expect(delivered).toEqual(["b1", "c1"])))
      expect(attempted).not.toContain("a2")
      yield* Scope.close(firstScope, Exit.void)
      yield* Scope.close(takeoverScope, Exit.void)
      const network = offline()
      const next = yield* start({ ...world, notes: id("next"), orderingKeys, mutation, online: network })
      expect(attempted).not.toContain("a2")
      signedIn = true
      network.connect()
      yield* Effect.promise(() => until(() => expect(delivered).toEqual(["b1", "c1", "a1", "a2", "a3"])))
      expect(retainedKeys(world.storage).length).toBe(0)
    }))
  })

  test("held status comes from storage in a follower and after reload while offline, before any send", async () => {
    const world = await setup([])
    const bus = changes()
    let calls = 0
    let signedIn = false
    const mutation: Outbox.Mutation<never> = () =>
      Effect.suspend(() => {
        calls++
        return signedIn ? Effect.void : new Outbox.Retry({ status: 401, held: true })
      })
    await scoped(Effect.gen(function*() {
      const leaderScope = yield* Scope.make()
      const leader = yield* start({ ...world, orderingKeys, changes: bus, mutation }).pipe(
        Effect.provideService(Scope.Scope, leaderScope)
      )
      const follower: Outbox.Leader = { ...single, requestLeadership: async () => false, isLeader: () => false }
      const following = yield* start({ ...world, leader: follower, orderingKeys, changes: bus, mutation })
      const states: Array<Outbox.Status> = []
      yield* following.outbox.status.pipe(
        Stream.runForEach((state) => Effect.sync(() => states.push(state))),
        Effect.forkScoped
      )
      yield* (yield* save(leader.outbox, leader.notes, note("a", 1))).admitted
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(true)))
      yield* Scope.close(leaderScope, Exit.void)
      const before = calls
      const network = offline()
      const reloaded = yield* start({ ...world, online: network, orderingKeys, changes: bus, mutation })
      const restored = yield* Stream.runHead(reloaded.outbox.status)
      expect(Option.getOrThrow(restored).held).toBe(true)
      expect(calls).toBe(before)
      signedIn = true
      network.connect()
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(false)))
      expect(calls).toBe(before + 1)
      expect(retainedKeys(world.storage).length).toBe(0)
    }))
  })

  test("a selector defect rolls back an uncommitted write, and a notification failure cannot revoke admission", async () => {
    const world = await setup(["ok"])
    const { logs } = await withLogs(Effect.scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({
        ...world,
        orderingKeys: {
          save: (rows) => {
            if ((rows[0] as Note).id === "bad") throw new TypeError("private sentinel")
            return ["safe"]
          }
        },
        changes: {
          publish: () => {
            throw new Error("private sentinel")
          },
          subscribe: () => () => {}
        }
      })
      const defect = yield* Effect.exit(save(outbox, notes, note("bad", 1)))
      expect(Exit.isFailure(defect)).toBe(true)
      expect(yield* notes.toArray).toEqual([])
      expect(retainedKeys(world.storage).length).toBe(0)
      const write = yield* save(outbox, notes, note("good", 2))
      yield* write.admitted
      yield* write.settled
      expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["good"])
      expect(retainedKeys(world.storage).length).toBe(0)
    })))
    expect(logs).toContainEqual(expect.objectContaining({
      message: ["outbox couldn't publish its change"],
      annotations: { error: "Error" }
    }))
    expect(JSON.stringify(logs)).not.toContain("private sentinel")
  })
})

describe("round 2 admission regressions", () => {
  test("equal timestamps restore in IndexedDB key order without reversing admission order", async () => {
    const world = await setup([])
    // IndexedDB getAllKeys returns lexical primary-key order, independently of insertion order.
    world.storage.keys = async () => retainedKeys(world.storage).sort()
    const attempted: string[] = []
    let held = true
    const orderingKeys = { save: () => ["same"] }
    const mutation: Outbox.Mutation<never> = ({ idempotencyKey }) =>
      Effect.suspend(() => {
        attempted.push(idempotencyKey)
        return held && idempotencyKey === "first" ? new Outbox.Retry({ held: true }) : Effect.void
      })
    await scoped(Effect.gen(function*() {
      const originalScope = yield* Scope.make()
      const original = yield* start({ ...world, online: offline(), orderingKeys, mutation }).pipe(
        Effect.provideService(Scope.Scope, originalScope)
      )
      yield* (yield* save(original.outbox, original.notes, note("first", 1))).admitted
      yield* (yield* save(original.outbox, original.notes, note("second", 2))).admitted
      yield* Scope.close(originalScope, Exit.void)
      const saved = [...world.storage.entries].filter(([key]) => key.startsWith("tx:"))
      for (const [key, value] of saved) {
        const row = JSON.parse(value)
        world.storage.entries.delete(key)
        row.id = row.idempotencyKey === "first" ? "z-first" : "a-second"
        row.createdAt = 1000
        if (row.idempotencyKey === "first") {
          row.metadata.held = true
          row.nextAttemptAt = Date.now() + 60_000
        }
        world.storage.entries.set(`tx:${row.id}`, JSON.stringify(row))
      }
      const network = offline()
      const next = yield* start({ ...world, online: network, orderingKeys, mutation })
      network.connect()
      // retryNow waits for the executor's current processing pass.
      yield* next.outbox.retryNow
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      expect(attempted).not.toContain("second")
      held = false
      yield* next.outbox.retryNow
      yield* Effect.promise(() => until(() => expect(attempted.slice(-2)).toEqual(["first", "second"])))
    }))
  })

  test("empty dependency keys retain the conservative barrier", async () => {
    const world = await setup([])
    const attempted: string[] = []
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({
        ...world,
        orderingKeys: { save: () => [] },
        mutation: ({ idempotencyKey }) =>
          Effect.suspend(() => {
            attempted.push(idempotencyKey)
            return idempotencyKey === "first" ? new Outbox.Retry({ held: true }) : Effect.void
          })
      })
      yield* (yield* save(outbox, notes, note("first", 1))).admitted
      yield* Effect.promise(() => until(() => expect(attempted).toContain("first")))
      yield* (yield* save(outbox, notes, note("second", 2))).admitted
      yield* outbox.retryNow
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      expect(attempted).not.toContain("second")
    }))
  })

  test("a missing held index is rebuilt from rows without exposing A's hold to B", async () => {
    const world = await setup([])
    let principal = "alice"
    const sent: string[] = []
    const ownership = { now: () => principal, ownsUnstamped: () => false }
    const mutation: Outbox.Mutation<never> = ({ idempotencyKey }) =>
      Effect.suspend(() => {
        sent.push(`${principal}:${idempotencyKey}`)
        return idempotencyKey === "a" ? new Outbox.Retry({ held: true }) : Effect.void
      })
    await scoped(Effect.gen(function*() {
      const firstScope = yield* Scope.make()
      const first = yield* start({ ...world, principal: ownership, mutation }).pipe(
        Effect.provideService(Scope.Scope, firstScope)
      )
      yield* (yield* save(first.outbox, first.notes, note("a", 1))).admitted
      yield* Effect.promise(() =>
        until(() =>
          expect([...world.storage.entries.values()].some((row) => JSON.parse(row).metadata?.held)).toBe(true)
        )
      )
      yield* Scope.close(firstScope, Exit.void)
      // A crash between the durable row write and index update leaves this exact state.
      yield* Effect.promise(() => world.storage.delete("outbox:held"))
      principal = "bob"
      const next = yield* start({ ...world, principal: ownership, mutation })
      expect(Option.getOrThrow(yield* Stream.runHead(next.outbox.status)).held).toBe(false)
      expect(yield* next.notes.toArray).toEqual([])
      yield* (yield* save(next.outbox, next.notes, note("b", 2))).settled
      expect(sent).toEqual(["alice:a", "bob:b"])
      const queued = [...world.storage.entries].filter(([key]) => key.startsWith("tx:"))
      expect(queued).toHaveLength(1)
      expect(JSON.parse(queued[0]![1]).metadata.principal).toBe("alice")
      expect(JSON.parse(queued[0]![1]).metadata.held).toBe(true)
      expect(JSON.parse((yield* Effect.promise(() => world.storage.get("outbox:held")))!)).toEqual([queued[0]![0]])
    }))
  })

  test("a transient held-index write or delete failure recovers live followers without rescanning admissions", async () => {
    const world = await setup([])
    let rejectSet = true
    let rejectDelete = false
    let indexSets = 0
    const storage = {
      ...world.storage,
      set: async (key: string, value: string) => {
        if (key === "outbox:held") {
          indexSets++
          if (rejectSet) {
            rejectSet = false
            throw new Error("Index unavailable")
          }
        }
        return await world.storage.set(key, value)
      },
      delete: async (key: string) => {
        if (key === "outbox:held" && rejectDelete) {
          rejectDelete = false
          throw new Error("Index unavailable")
        }
        return await world.storage.delete(key)
      }
    }
    const listeners = new Set<() => void>()
    const changes = {
      publish: () => {
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
    let signedIn = false
    const states: Outbox.Status[] = []
    await scoped(Effect.gen(function*() {
      const leading = yield* start({
        ...world,
        storage,
        changes,
        mutation: () => signedIn ? Effect.void : new Outbox.Retry({ held: true })
      })
      const follower: Outbox.Leader = { ...single, requestLeadership: async () => false, isLeader: () => false }
      const following = yield* start({ ...world, storage, changes, leader: follower })
      yield* following.outbox.status.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            states.push(state)
          })
        ),
        Effect.forkScoped
      )
      const write = yield* save(leading.outbox, leading.notes, note("held", 1))
      yield* write.admitted
      yield* Effect.promise(() => until(() => expect(indexSets).toBeGreaterThanOrEqual(1)))
      yield* leading.outbox.retryNow
      yield* Effect.promise(() => until(() => expect(indexSets).toBeGreaterThanOrEqual(2)))
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(true)))
      expect(hasIndex()).toBe(true)
      rejectDelete = true
      signedIn = true
      yield* leading.outbox.retryNow
      yield* write.settled
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(false)))
      yield* Effect.promise(() => until(() => expect(hasIndex()).toBe(false)))
      expect([...storage.entries.keys()].filter((key) => key.startsWith("tx:"))).toEqual([])
    }))
    function hasIndex() {
      return storage.entries.has("outbox:held")
    }
  })

  test("an in-place principal change recomputes held status without sending A's row as B", async () => {
    const world = await setup([])
    let principal = "alice"
    const sent: string[] = []
    await scoped(Effect.gen(function*() {
      const { outbox, notes } = yield* start({
        ...world,
        principal: { now: () => principal, ownsUnstamped: () => false },
        orderingKeys: { save: (rows) => (rows as Note[]).map((row) => row.id) },
        mutation: ({ idempotencyKey }) =>
          Effect.suspend(() => {
            sent.push(`${principal}:${idempotencyKey}`)
            return idempotencyKey === "a" ? new Outbox.Retry({ held: true }) : Effect.void
          })
      })
      yield* (yield* save(outbox, notes, note("a", 1))).admitted
      yield* Effect.promise(() =>
        until(() =>
          expect([...world.storage.entries.values()].some((row) => JSON.parse(row).metadata?.held)).toBe(true)
        )
      )
      expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(true)
      principal = "bob"
      yield* (yield* save(outbox, notes, note("b", 2))).settled
      expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(false)
      expect(sent).toContain("bob:b")
      expect(sent).not.toContain("bob:a")
      const queued = [...world.storage.entries].filter(([key]) => key.startsWith("tx:"))
      expect(queued).toHaveLength(1)
      expect(JSON.parse(queued[0]![1]).metadata.principal).toBe("alice")
    }))
  })

  test("a transient notification failure republishes a held index on the existing retry path", async () => {
    const world = await setup([])
    const listeners = new Set<() => void>()
    let reject = true
    const changes = {
      publish: () => {
        if (reject && world.storage.entries.has("outbox:held")) {
          reject = false
          throw new Error("Channel unavailable")
        }
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
    const states: Outbox.Status[] = []
    await scoped(Effect.gen(function*() {
      const leading = yield* start({ ...world, changes, mutation: () => new Outbox.Retry({ held: true }) })
      const follower: Outbox.Leader = { ...single, requestLeadership: async () => false, isLeader: () => false }
      const following = yield* start({ ...world, changes, leader: follower })
      yield* following.outbox.status.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            states.push(state)
          })
        ),
        Effect.forkScoped
      )
      yield* (yield* save(leading.outbox, leading.notes, note("held", 1))).admitted
      yield* Effect.promise(() => until(() => expect(reject).toBe(false)))
      expect(world.storage.entries.has("outbox:held")).toBe(true)
      expect(states.at(-1)?.held).toBe(false)
      yield* leading.outbox.retryNow
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(true)))
    }))
  })

  test(
    "1000 offline admissions read a bounded number of rows while status invalidations avoid backlog scans",
    async () => {
      const world = await setup([])
      let reads = 0
      const get = world.storage.get
      world.storage.get = async (key) => {
        reads++
        return get(key)
      }
      let invalidate = () => {}
      const listeners = new Set<() => void>()
      const changes = {
        publish: () => {
          for (const listener of listeners) listener()
        },
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          invalidate = listener
          return () => {
            listeners.delete(listener)
          }
        }
      }
      await scoped(Effect.gen(function*() {
        const { outbox, notes } = yield* start({
          ...world,
          online: offline(),
          principal: { now: () => "alice", ownsUnstamped: () => false },
          changes
        })
        const follower: Outbox.Leader = { ...single, requestLeadership: async () => false, isLeader: () => false }
        yield* start({
          ...world,
          leader: follower,
          online: offline(),
          principal: { now: () => "alice", ownsUnstamped: () => false },
          changes
        })
        for (let n = 0; n < 1000; n++) yield* (yield* save(outbox, notes, note(`row-${n}`, n))).admitted
        // Neither admission nor status maintenance may rescan the retained backlog.
        expect(reads).toBeLessThan(4000)
        expect(Number(world.storage.entries.get("outbox:admission-counter"))).toBeGreaterThan(999)
        const before = reads
        for (let n = 0; n < 1000; n++) invalidate()
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
        expect(reads - before).toBeLessThan(2000)
        console.info("outbox.row_reads", {
          admissions: 1000,
          admissionReads: before,
          invalidationReads: reads - before
        })
      }))
    },
    120_000
  )
})

describe("round 3 admission regressions", () => {
  test("legacy tied timestamps migrate held rows before ambiguous dependent rows once at open", async () => {
    const world = await setup([])
    world.storage.keys = async () => retainedKeys(world.storage).sort()
    const attempted: string[] = []
    let held = true
    const orderingKeys = { save: () => ["same"] }
    const mutation: Outbox.Mutation<never> = ({ idempotencyKey }) =>
      Effect.suspend(() => {
        attempted.push(idempotencyKey)
        return held && idempotencyKey === "first" ? new Outbox.Retry({ held: true }) : Effect.void
      })
    await scoped(Effect.gen(function*() {
      const originalScope = yield* Scope.make()
      const original = yield* start({ ...world, online: offline(), orderingKeys, mutation }).pipe(
        Effect.provideService(Scope.Scope, originalScope)
      )
      yield* (yield* save(original.outbox, original.notes, note("first", 1))).admitted
      yield* (yield* save(original.outbox, original.notes, note("second", 2))).admitted
      yield* Scope.close(originalScope, Exit.void)
      for (const [key, value] of [...world.storage.entries]) {
        if (!key.startsWith("tx:")) continue
        const row = JSON.parse(value)
        world.storage.entries.delete(key)
        row.id = row.idempotencyKey === "first" ? "z-first" : "a-second"
        row.createdAt = 1000
        delete row.metadata.admissionSequence
        if (row.idempotencyKey === "first") {
          row.metadata.held = true
          row.nextAttemptAt = Date.now() + 60_000
        }
        world.storage.entries.set(`tx:${row.id}`, JSON.stringify(row))
      }
      const network = offline()
      const reloadScope = yield* Scope.make()
      yield* start({ ...world, online: network, orderingKeys, mutation }).pipe(
        Effect.provideService(Scope.Scope, reloadScope)
      )
      const rows = [...world.storage.entries.values()].map((value) => JSON.parse(value)).filter((row) =>
        row.idempotencyKey
      )
      const first = rows.find((row) => row.idempotencyKey === "first")
      const second = rows.find((row) => row.idempotencyKey === "second")
      expect(first.metadata.admissionSequence).toBeTypeOf("number")
      expect(first.metadata.admissionSequence).toBeLessThan(second.metadata.admissionSequence)
      const snapshot = rows.map((row) => [row.id, row.metadata.admissionSequence])
      yield* Scope.close(reloadScope, Exit.void)
      const next = yield* start({ ...world, online: network, orderingKeys, mutation })
      expect(
        [...world.storage.entries.values()].map((value) => JSON.parse(value)).filter((row) => row.idempotencyKey).map((
          row
        ) => [row.id, row.metadata.admissionSequence])
      ).toEqual(snapshot)
      network.connect()
      yield* next.outbox.retryNow
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      expect(attempted).not.toContain("second")
      held = false
      yield* next.outbox.retryNow
      yield* Effect.promise(() => until(() => expect(attempted.slice(-2)).toEqual(["first", "second"])))
    }))
  })

  test("leadership transfer drains paused durable admission before allocating the next sequence", async () => {
    const world = await setup([])
    const queuedAt = 1_800_000_000_000
    const saveAtSameTime = saveAt(queuedAt)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const storage = {
      ...world.storage,
      set: async (key: string, value: string): Promise<undefined> => {
        if (key.startsWith("tx:") && JSON.parse(value).idempotencyKey === "first") {
          enter()
          await gate
        }
        return await world.storage.set(key, value)
      }
    }
    const attempted: string[] = []
    let held = true
    const orderingKeys = { save: () => ["same"] }
    const mutation: Outbox.Mutation<never> = ({ idempotencyKey }) =>
      Effect.suspend(() => {
        attempted.push(idempotencyKey)
        return held && idempotencyKey === "first" ? new Outbox.Retry({ held: true }) : Effect.void
      })
    const network = offline()
    try {
      await scoped(Effect.gen(function*() {
        const lock = webLocks({ prefix: id("admission-handoff") })
        const leaderA = yield* Outbox.lockLeader({ lock, name: "outbox" })
        const leaderB = yield* Outbox.lockLeader({ lock, name: "outbox" })
        const a = yield* start({ ...world, storage, leader: leaderA, online: offline(), orderingKeys, mutation })
        const b = yield* start({ ...world, storage, leader: leaderB, online: network, orderingKeys, mutation })
        const first = yield* saveAtSameTime(a.outbox, a.notes, note("first", 1))
        yield* Effect.promise(() => entered)
        yield* leaderB.take
        const second = yield* saveAtSameTime(b.outbox, b.notes, note("second", 2)).pipe(Effect.forkScoped)
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
        release()
        yield* first.admitted
        yield* (yield* Fiber.join(second)).admitted
        const rows = [...storage.entries.values()].map((value) => JSON.parse(value)).filter((row) => row.idempotencyKey)
        expect(rows.map((row) => row.metadata.queuedAt)).toEqual([queuedAt, queuedAt])
        const firstSequence = rows.find((row) => row.idempotencyKey === "first").metadata.admissionSequence
        const secondSequence = rows.find((row) => row.idempotencyKey === "second").metadata.admissionSequence
        expect(secondSequence).toBeGreaterThan(firstSequence)
        network.connect()
        yield* b.outbox.retryNow
        yield* Effect.promise(() => until(() => expect(attempted).toContain("first")))
        expect(attempted).not.toContain("second")
        held = false
        yield* b.outbox.retryNow
        yield* Effect.promise(() => until(() => expect(attempted.slice(-2)).toEqual(["first", "second"])))
      }))
    } finally {
      release()
    }
  })

  test("closing a fenced leader returns while its paused admission still fences its successor", async () => {
    const world = await setup([])
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const storage = {
      ...world.storage,
      setMany: async (entries: ReadonlyArray<readonly [string, string]>) => {
        if (entries.some(([key, value]) => key.startsWith("tx:") && JSON.parse(value).idempotencyKey === "first")) {
          enter()
          await gate
        }
        await world.storage.setMany(entries)
      }
    }
    const attempted: string[] = []
    const mutation: Outbox.Mutation<never> = ({ idempotencyKey }) =>
      Effect.sync(() => {
        attempted.push(idempotencyKey)
      })
    const network = offline()
    try {
      await scoped(
        Effect.gen(function*() {
          const lock = webLocks({ prefix: id("closing-admission") })
          const firstScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
          const first = yield* Scope.provide(
            Effect.flatMap(
              Outbox.lockLeader({ lock, name: "outbox" }),
              (leader) => start({ ...world, storage, leader, online: offline(), mutation })
            ),
            firstScope
          )
          const leader = yield* Outbox.lockLeader({ lock, name: "outbox" })
          const second = yield* start({ ...world, storage, leader, online: network, mutation })
          const firstWrite = yield* save(first.outbox, first.notes, note("first", 1))
          yield* Effect.promise(() => entered)
          let closed = false
          const closing = yield* Scope.close(firstScope, Exit.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                closed = true
              })
            ),
            Effect.forkScoped
          )
          yield* Effect.promise(() => until(() => expect(closed).toBe(true)))
          yield* Fiber.join(closing)
          let admitted = false
          const next = yield* save(second.outbox, second.notes, note("second", 2)).pipe(
            Effect.tap((write) => write.admitted),
            Effect.tap(() =>
              Effect.sync(() => {
                admitted = true
              })
            ),
            Effect.forkScoped
          )
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
          expect(admitted).toBe(false)
          expect([...storage.entries.keys()].some((key) => key.startsWith("tx:"))).toBe(false)
          release()
          yield* firstWrite.admitted
          yield* Fiber.join(next)
          const rows = [...storage.entries.values()].map((value) => JSON.parse(value)).filter((row) =>
            row.idempotencyKey
          )
          const sequence = (key: string) => rows.find((row) => row.idempotencyKey === key).metadata.admissionSequence
          expect(sequence("first")).toBeLessThan(sequence("second"))
          expect(Number(storage.entries.get("outbox:admission-counter"))).toBe(sequence("second"))
          network.connect()
          yield* second.outbox.retryNow
          yield* Effect.promise(() => until(() => expect(attempted).toEqual(["first", "second"])))
        }).pipe(Effect.ensuring(Effect.sync(release)))
      )
    } finally {
      release()
    }
  })

  test.each(["retry", "notification"])("an empty backlog repairs a stale follower hold through %s", async (repair) => {
    const world = await setup([])
    let failDelete = false
    let signedIn = false
    let deletions = 0
    const storage = {
      ...world.storage,
      delete: async (key: string): Promise<undefined> => {
        if (key === "outbox:held" && failDelete) {
          deletions++
          throw new Error("Index unavailable")
        }
        return await world.storage.delete(key)
      }
    }
    const listeners = new Set<() => void>()
    const changes = {
      publish: () => {
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
    await scoped(Effect.gen(function*() {
      const leading = yield* start({
        ...world,
        storage,
        changes,
        mutation: () => signedIn ? Effect.void : new Outbox.Retry({ held: true })
      })
      const follower: Outbox.Leader = { ...single, requestLeadership: async () => false, isLeader: () => false }
      const following = yield* start({ ...world, storage, changes, leader: follower })
      const states: Outbox.Status[] = []
      yield* following.outbox.status.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            states.push(state)
          })
        ),
        Effect.forkScoped
      )
      const write = yield* save(leading.outbox, leading.notes, note("held", 1))
      yield* write.admitted
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(true)))
      failDelete = true
      signedIn = true
      yield* leading.outbox.retryNow
      yield* write.settled
      yield* Effect.promise(() =>
        until(() => expect([...storage.entries.keys()].filter((key) => key.startsWith("tx:"))).toEqual([]))
      )
      expect(deletions).toBeGreaterThanOrEqual(2)
      expect(storage.entries.has("outbox:held")).toBe(true)
      failDelete = false
      if (repair === "retry") yield* Effect.sync(() => Effect.runSync(leading.outbox.retryNow))
      else changes.publish()
      yield* Effect.promise(() => until(() => expect(states.at(-1)?.held).toBe(false)))
      if (repair === "retry") expect(storage.entries.has("outbox:held")).toBe(false)
    }))
  })
})

test("a partially persisted legacy migration stays closed and resumes its saved order", async () => {
  const world = await setup([])
  await scoped(Effect.gen(function*() {
    const originalScope = yield* Scope.make()
    const original = yield* start({ ...world, online: offline() }).pipe(
      Effect.provideService(Scope.Scope, originalScope)
    )
    yield* (yield* save(original.outbox, original.notes, note("first", 1))).admitted
    yield* (yield* save(original.outbox, original.notes, note("second", 2))).admitted
    yield* Scope.close(originalScope, Exit.void)
    for (const [key, value] of world.storage.entries) {
      if (!key.startsWith("tx:")) continue
      const row = JSON.parse(value)
      delete row.metadata.admissionSequence
      row.createdAt = row.idempotencyKey === "first" ? 1000 : 2000
      world.storage.entries.set(key, JSON.stringify(row))
    }
    const interruptedScope = yield* Scope.make()
    const interrupted = yield* start({
      ...world,
      online: offline(),
      storage: {
        ...world.storage,
        set: async (key, value) => {
          if (key.startsWith("tx:") && JSON.parse(value).idempotencyKey === "second") {
            throw new Error("Storage unavailable")
          }
          return world.storage.set(key, value)
        }
      }
    }).pipe(Effect.provideService(Scope.Scope, interruptedScope))
    const refusal = yield* Effect.exit(save(interrupted.outbox, interrupted.notes, note("third", 3)))
    expect(Exit.isFailure(refusal)).toBe(true)
    expect(world.storage.entries.has("outbox:admission-migration")).toBe(true)
    yield* Scope.close(interruptedScope, Exit.void)
    const attempted: string[] = []
    yield* start({
      ...world,
      mutation: ({ idempotencyKey }) =>
        Effect.sync(() => {
          attempted.push(idempotencyKey)
        })
    })
    yield* Effect.promise(() => until(() => expect(attempted).toEqual(["first", "second"])))
    expect(world.storage.entries.has("outbox:admission-migration")).toBe(false)
  }))
})

describe("round 4 recovery regressions", () => {
  test("persisted duplicate sequences recover with a held predecessor before replay", async () => {
    const world = await setup([])
    await scoped(Effect.gen(function*() {
      const initialScope = yield* Scope.make()
      const initial = yield* start({ ...world, online: offline() }).pipe(
        Effect.provideService(Scope.Scope, initialScope)
      )
      yield* (yield* save(initial.outbox, initial.notes, note("held", 1))).admitted
      yield* (yield* save(initial.outbox, initial.notes, note("dependent", 2))).admitted
      yield* Scope.close(initialScope, Exit.void)
      for (const [key, value] of world.storage.entries) {
        if (!key.startsWith("tx:")) continue
        const row = JSON.parse(value)
        row.metadata.admissionSequence = 1000
        row.metadata.held = row.idempotencyKey === "held"
        world.storage.entries.set(key, JSON.stringify(row))
      }
      const network = offline()
      const attempted: string[] = []
      const recovered = yield* start({
        ...world,
        online: network,
        orderingKeys: { save: () => ["same"] },
        mutation: ({ idempotencyKey }) =>
          Effect.suspend(() => {
            attempted.push(idempotencyKey)
            return idempotencyKey === "held" ? new Outbox.Retry({ held: true }) : Effect.void
          })
      })
      const rows = [...world.storage.entries.values()].map((value) => JSON.parse(value)).filter((row) =>
        row.idempotencyKey
      )
      expect(rows.find((row) => row.idempotencyKey === "held").metadata.admissionSequence).toBeLessThan(
        rows.find((row) => row.idempotencyKey === "dependent").metadata.admissionSequence
      )
      network.connect()
      yield* recovered.outbox.retryNow
      yield* Effect.promise(() => until(() => expect(attempted).toContain("held")))
      expect(attempted).not.toContain("dependent")
    }))
  })

  test("leadership reacquisition allocates a queued admission after the intervening leader's stored maximum", async () => {
    const world = await setup([])
    const queuedAt = 1_000
    const saveAtSameTime = saveAt(queuedAt)
    let entered!: () => void
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let pause = true
    const storage = {
      ...world.storage,
      set: async (key: string, value: string): Promise<undefined> => {
        if (pause && key.startsWith("tx:") && JSON.parse(value).lastError?.name === "OutboxHeld") {
          pause = false
          entered()
          await gate
        }
        return world.storage.set(key, value)
      }
    }
    try {
      await scoped(Effect.gen(function*() {
        const lock = webLocks({ prefix: id("reacquire") })
        const leaderA = yield* Outbox.lockLeader({ lock, name: "outbox" })
        const leaderB = yield* Outbox.lockLeader({ lock, name: "outbox" })
        const a = yield* start({
          ...world,
          storage,
          leader: leaderA,
          orderingKeys: { save: () => ["same"] },
          mutation: () => new Outbox.Retry({ held: true })
        })
        const b = yield* start({ ...world, storage, leader: leaderB, online: offline() })
        yield* (yield* saveAtSameTime(a.outbox, a.notes, note("held", 1))).admitted
        yield* Effect.promise(() => paused)
        const queued = yield* saveAtSameTime(a.outbox, a.notes, note("queued", 2))
        yield* leaderB.take
        yield* (yield* saveAtSameTime(b.outbox, b.notes, note("intervening", 3))).admitted
        yield* leaderA.take
        release()
        yield* queued.admitted
        const rows = [...storage.entries.values()].map((value) => JSON.parse(value)).filter((row) => row.idempotencyKey)
        expect(rows.map((row) => row.metadata.queuedAt)).toEqual([queuedAt, queuedAt, queuedAt])
        const sequence = (id: string) => rows.find((row) => row.idempotencyKey === id).metadata.admissionSequence
        expect(sequence("queued")).toBeGreaterThan(sequence("intervening"))
        expect(new Set(rows.map((row) => row.metadata.admissionSequence)).size).toBe(3)
      }))
    } finally {
      release()
    }
  })

  test.each(["before retry", "while retry is queued"])(
    "an invalidation %s cannot erase a hold whose index publication failed",
    async (ordering) => {
      const world = await setup([])
      let failIndex = true
      let failures = 0
      let intercept = false
      let entered!: () => void
      let release!: () => void
      const reading = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const storage = {
        ...world.storage,
        get: async (key: string) => {
          const value = await world.storage.get(key)
          if (intercept && key === "outbox:held") {
            intercept = false
            entered()
            await gate
          }
          return value
        },
        set: async (key: string, value: string): Promise<undefined> => {
          if (failIndex && key === "outbox:held") {
            failures++
            throw new Error("Index unavailable")
          }
          return world.storage.set(key, value)
        }
      }
      let invalidate = () => {}
      const changes = {
        publish: () => {},
        subscribe: (listener: () => void) => {
          invalidate = listener
          return () => {}
        }
      }
      let online = true
      const network = { ...Outbox.Online.always(), isOnline: () => online }
      try {
        await scoped(Effect.gen(function*() {
          const { outbox, notes } = yield* start({
            ...world,
            storage,
            changes,
            online: network,
            mutation: () => new Outbox.Retry({ held: true })
          })
          const states: Outbox.Status[] = []
          const observedHold = yield* Deferred.make<void>()
          yield* outbox.status.pipe(
            Stream.runForEach((state) =>
              Effect.gen(function*() {
                states.push(state)
                if (state.held) yield* Deferred.succeed(observedHold, undefined)
              })
            ),
            Effect.forkScoped
          )
          const write = yield* save(outbox, notes, note("held", 1))
          yield* write.admitted
          yield* Effect.promise(() => until(() => expect(failures).toBeGreaterThan(0)))
          // Storage can fail before the status stream's consumer is scheduled.
          yield* Deferred.await(observedHold)
          expect(states.at(-1)?.held).toBe(true)
          online = false
          failIndex = false
          intercept = true
          invalidate()
          yield* Effect.promise(() => reading)
          if (ordering === "while retry is queued") yield* outbox.retryNow
          release()
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
          expect(states.at(-1)?.held).toBe(true)
          if (ordering === "before retry") yield* outbox.retryNow
          yield* Effect.promise(() =>
            until(() => expect(JSON.parse(storage.entries.get("outbox:held") ?? "[]")).toContain(`tx:${write.id}`))
          )
          expect(JSON.parse(storage.entries.get(`tx:${write.id}`)!).metadata.held).toBe(true)
        }))
      } finally {
        release()
      }
    }
  )
})

test("a follower retains an unindexed hold across refreshes and repairs it on leadership", async () => {
  const world = await setup([])
  let failIndex = true
  let leading = false
  let leadership = (_leader: boolean) => {}
  const leader: Outbox.Leader = {
    ...single,
    requestLeadership: async () => leading,
    isLeader: () => leading,
    onLeadershipChange: (listener) => {
      leadership = listener
      return () => {}
    }
  }
  let invalidate = () => {}
  const changes = {
    publish: () => {},
    subscribe: (listener: () => void) => {
      invalidate = listener
      return () => {}
    }
  }
  const storage = {
    ...world.storage,
    set: async (key: string, value: string) => {
      if (key === "outbox:held" && failIndex) throw new Error("Index unavailable")
      return world.storage.set(key, value)
    }
  }
  await scoped(Effect.gen(function*() {
    const original = yield* Scope.make()
    const first = yield* start({ ...world, storage, mutation: () => new Outbox.Retry({ held: true }) }).pipe(
      Effect.provideService(Scope.Scope, original)
    )
    const write = yield* save(first.outbox, first.notes, note("held", 1))
    yield* write.admitted
    yield* Effect.promise(() =>
      until(() => expect(JSON.parse(storage.entries.get(`tx:${write.id}`)!).metadata?.held).toBe(true))
    )
    yield* Scope.close(original, Exit.void)
    const follower = yield* start({ ...world, storage, leader, changes, online: offline() })
    const held = () =>
      Stream.runHead(follower.outbox.status).pipe(Effect.map((status) => Option.getOrThrow(status).held))
    expect(yield* held()).toBe(true)
    invalidate()
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
    expect(yield* held()).toBe(true)
    expect(storage.entries.has(`tx:${write.id}`)).toBe(true)
    failIndex = false
    leading = true
    leadership(true)
    yield* Effect.promise(() =>
      until(() => expect(JSON.parse(storage.entries.get("outbox:held") ?? "[]")).toContain(`tx:${write.id}`))
    )
    expect(yield* held()).toBe(true)
  }))
})

test("an aborted admission persists neither the counter nor the write", async () => {
  const world = await setup([])
  let full = true
  const storage = {
    ...world.storage,
    set: async (key: string, value: string) => {
      if (full && key.startsWith("tx:")) throw new Error("Storage full")
      return world.storage.set(key, value)
    }
  }
  await scoped(Effect.gen(function*() {
    const { outbox, notes } = yield* start({ ...world, storage, online: offline() })
    const refused = yield* save(outbox, notes, note("refused", 1))
    expect(yield* Effect.exit(refused.admitted)).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "storage" })))
    expect(storage.entries.has("outbox:admission-counter")).toBe(false)
    expect(retainedKeys(storage)).toEqual([])
    full = false
    const admitted = yield* save(outbox, notes, note("accepted", 2))
    yield* admitted.admitted
    const row = JSON.parse(storage.entries.get(`tx:${admitted.id}`)!)
    expect(row.metadata.admissionSequence).toBe(Number(storage.entries.get("outbox:admission-counter")))
    expect(retainedKeys(storage)).toEqual([`tx:${admitted.id}`])
  }))
})

test("late predecessor index publication cannot erase a successor hold before a follower reads it", async () => {
  const world = await setup([])
  let finishSend!: () => void
  let sent!: () => void
  let releaseIndex!: () => void
  let readingIndex!: () => void
  let published!: () => void
  const sendGate = new Promise<void>((resolve) => {
    finishSend = resolve
  })
  const sending = new Promise<void>((resolve) => {
    sent = resolve
  })
  const indexGate = new Promise<void>((resolve) => {
    releaseIndex = resolve
  })
  const indexRead = new Promise<void>((resolve) => {
    readingIndex = resolve
  })
  const newIndex = new Promise<void>((resolve) => {
    published = resolve
  })
  let intercept = false
  let held = true
  let nextKey = ""
  const firstStorage = {
    ...world.storage,
    get: async (key: string) => {
      const value = await world.storage.get(key)
      if (intercept && key === "outbox:held") {
        intercept = false
        readingIndex()
        await indexGate
      }
      return value
    }
  }
  const secondStorage = {
    ...world.storage,
    set: async (key: string, value: string): Promise<undefined> => {
      await world.storage.set(key, value)
      if (key === "outbox:held" && nextKey && JSON.parse(value).includes(nextKey)) published()
    }
  }
  let invalidate = () => {}
  const changes = {
    publish: () => {},
    subscribe: (listener: () => void) => {
      invalidate = listener
      return () => {}
    }
  }
  const principal = (owner: string) => ({ now: () => owner, ownsUnstamped: () => false })
  try {
    await scoped(
      Effect.gen(function*() {
        const firstScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
        const first = yield* Scope.provide(
          start({
            ...world,
            storage: firstStorage,
            principal: principal("alice"),
            mutation: () =>
              held ? new Outbox.Retry({ held: true }) : Effect.promise(() => {
                sent()
                return sendGate
              })
          }),
          firstScope
        )
        const old = yield* save(first.outbox, first.notes, note("old", 1))
        yield* old.admitted
        yield* Effect.promise(() =>
          until(() => expect(JSON.parse(world.storage.entries.get("outbox:held") ?? "[]")).toContain(`tx:${old.id}`))
        )
        const network = offline()
        const second = yield* start({
          ...world,
          storage: secondStorage,
          principal: principal("bob"),
          online: network,
          mutation: () => new Outbox.Retry({ held: true })
        })
        const follower = yield* start({
          ...world,
          principal: principal("bob"),
          online: offline(),
          changes,
          leader: { ...single, requestLeadership: async () => false, isLeader: () => false }
        })
        held = false
        yield* first.outbox.retryNow
        yield* Effect.promise(() => sending)
        yield* Scope.close(firstScope, Exit.void)
        intercept = true
        finishSend()
        yield* Effect.promise(() => indexRead)
        const next = yield* save(second.outbox, second.notes, note("new", 2))
        nextKey = `tx:${next.id}`
        yield* next.admitted
        network.connect()
        yield* second.outbox.retryNow
        yield* Effect.promise(() =>
          until(() => expect(JSON.parse(world.storage.entries.get(nextKey)!).metadata.held).toBe(true))
        )
        // The row can be held while its index publication waits on the predecessor's cross-context lock.
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
        releaseIndex()
        yield* old.settled
        yield* Effect.promise(() => newIndex)
        invalidate()
        yield* Effect.promise(() =>
          until(async () => {
            const status = await Effect.runPromise(Stream.runHead(follower.outbox.status))
            expect(Option.getOrThrow(status).held).toBe(true)
          })
        )
        expect(JSON.parse(world.storage.entries.get("outbox:held") ?? "[]")).toContain(nextKey)
        expect(world.storage.entries.has(nextKey)).toBe(true)
      }).pipe(Effect.ensuring(Effect.sync(() => {
        finishSend()
        releaseIndex()
      })))
    )
  } finally {
    finishSend()
    releaseIndex()
  }
})

test.each(["held", "settled"])("a predecessor's late retry preserves a successor's %s write", async (outcome) => {
  const world = await setup([])
  let begin!: () => void
  let release!: () => void
  let updated!: () => void
  let read!: () => void
  let resumeRead!: () => void
  const reading = new Promise<void>((resolve) => {
    read = resolve
  })
  const readGate = new Promise<void>((resolve) => {
    resumeRead = resolve
  })
  let pauseRead = false
  const began = new Promise<void>((resolve) => {
    begin = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const retried = new Promise<void>((resolve) => {
    updated = resolve
  })
  let intercept = false
  const storage = {
    ...world.storage,
    get: async (key: string) => {
      const value = await world.storage.get(key)
      if (pauseRead && key.startsWith("tx:")) {
        pauseRead = false
        read()
        await readGate
      }
      return value
    },
    withLock: <A>(name: string, action: () => Promise<A>): Promise<A> =>
      world.storage.withLock(name, async () => {
        const result = await action()
        if (intercept && name.startsWith("tx:")) updated()
        return result
      }),
    set: async (key: string, value: string): Promise<undefined> => {
      await world.storage.set(key, value)
      if (intercept && key.startsWith("tx:") && JSON.parse(value).lastError?.name === "OutboxRetry") updated()
    }
  }
  const listeners = new Set<() => void>()
  const changes = {
    publish: () => {
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  try {
    await scoped(
      Effect.gen(function*() {
        const lock = webLocks({ prefix: id("late-retry") })
        const firstScope = yield* Scope.make()
        const secondScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
        yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
        const first = yield* Scope.provide(
          Effect.flatMap(Outbox.lockLeader({ lock, name: "outbox" }), (leader) =>
            start({
              ...world,
              storage,
              leader,
              changes: { ...changes, subscribe: () => () => {} },
              mutation: () =>
                Effect.andThen(
                  Effect.promise(() => {
                    begin()
                    return gate
                  }),
                  new Outbox.Retry({})
                )
            })),
          firstScope
        )
        const leader = yield* Scope.provide(Outbox.lockLeader({ lock, name: "outbox" }), secondScope)
        const network = offline()
        const second = yield* Scope.provide(
          start({
            ...world,
            leader,
            online: network,
            changes,
            mutation: () => outcome === "held" ? new Outbox.Retry({ held: true }) : Effect.void
          }),
          secondScope
        )
        const follower = yield* start({
          ...world,
          changes,
          online: offline(),
          leader: { ...single, requestLeadership: async () => false, isLeader: () => false }
        })
        const write = yield* save(first.outbox, first.notes, note("retained", 1))
        yield* write.admitted
        yield* Effect.promise(() => began)
        yield* leader.take
        intercept = true
        pauseRead = true
        release()
        yield* Effect.promise(() => reading)
        network.connect()
        yield* second.outbox.retryNow
        const key = `tx:${write.id}`
        yield* Effect.promise(() =>
          until(() => {
            if (outcome === "held") expect(JSON.parse(world.storage.entries.get(key)!).metadata.held).toBe(true)
            else expect(world.storage.entries.has(key)).toBe(false)
          })
        )
        network.disconnect()
        resumeRead()
        // Await the actual storage action: a terminal row may intentionally require no replacement.
        yield* Effect.promise(() => retried)
        changes.publish()
        yield* Effect.promise(() =>
          until(async () => {
            if (outcome === "held") {
              expect(JSON.parse(world.storage.entries.get(key)!).metadata.held).toBe(true)
              expect(Option.getOrThrow(await Effect.runPromise(Stream.runHead(follower.outbox.status))).held).toBe(true)
            } else expect(world.storage.entries.has(key)).toBe(false)
          })
        )
        yield* Scope.close(firstScope, Exit.void)
        yield* Scope.close(secondScope, Exit.void)
        const reopened = yield* start({ ...world, online: offline() })
        expect(Option.getOrThrow(yield* Stream.runHead(reopened.outbox.status)).held).toBe(outcome === "held")
        if (outcome === "held") expect(JSON.parse(world.storage.entries.get(key)!).idempotencyKey).toBe("retained")
        else expect([...world.storage.entries.keys()].filter((key) => key.startsWith("tx:"))).toEqual([])
      }).pipe(Effect.ensuring(Effect.sync(() => {
        release()
        resumeRead()
      })))
    )
  } finally {
    release()
    resumeRead()
  }
})
