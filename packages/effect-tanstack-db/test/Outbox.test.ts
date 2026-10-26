import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { Context, Effect, Exit, Fiber, Layer, Metric, Option, Queue, References, Scope, Stream, Tracer } from "effect"
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
        ...(options.principal === undefined ? {} : { principal: options.principal }),
        ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade }),
        ...(options.parked === undefined ? {} : { parked: options.parked }),
        mutations: {
          save: (params) =>
            Effect.gen(function*() {
              options.sent.push(params)
              const outcome = yield* Queue.take(options.outcomes)
              if (outcome === "defect") return yield* Effect.die(new Error("boom"))
              if (outcome !== "ok") return yield* outcome
            })
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

const texts = (rows: ReadonlyArray<Note>) => rows.map(({ id }) => id)

/** A network detector that starts offline; `connect` brings it online and tells the outbox, as a browser does. */
const offline = () => {
  const detector = Outbox.Online.always()
  const state = { online: false }
  return {
    ...detector,
    isOnline: () => state.online,
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
      const stored = [...world.storage.entries.keys()]
      yield* Queue.offer(world.outcomes, "ok")
      yield* write.settled
      return {
        shown,
        stored,
        sent: world.sent,
        after: texts(yield* notes.toArray),
        left: [...world.storage.entries.keys()],
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
    const { result: statuses, logs } = await withLogs(Effect.scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const seen: Array<Outbox.Status> = []
      yield* outbox.status.pipe(Stream.runForEach((status) => Effect.sync(() => seen.push(status))), Effect.forkScoped)
      const write = yield* save(outbox, notes, note("a", 1))
      // The library waits 1 s, then 2 s; retryNow sends at once.
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(1)))
      yield* outbox.retryNow
      yield* Effect.promise(() => until(() => expect(world.sent).toHaveLength(2)))
      yield* Queue.offer(world.outcomes, "ok")
      yield* outbox.retryNow
      yield* write.settled
      return seen
    })).pipe(Effect.provide(ownMetrics())))
    expect(world.sent.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["a", "a", "a"])
    // Logged on its first retry only, by its status; every send is counted.
    const retrying = logs.filter(({ message }) => (message as Array<unknown>)[0] === "outbox write retrying")
    expect(retrying.map(({ level, annotations }) => [level, annotations])).toEqual([
      ["Warn", { name: "save", status: "none", outcome: "retry" }]
    ])
    expect(statuses.map(({ failing }) => failing)).toEqual(expect.arrayContaining(["network", "server", null]))
    expect(statuses.at(-1)).toEqual({ leader: true, failing: null })
  })

  test("the server refuses is never sent again, rolls back, and is logged and counted", async () => {
    const world = await setup([new Outbox.Refused({ status: 409 })])
    const { result: seen, logs } = await withLogs(Effect.scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start(world)
      const write = yield* save(outbox, notes, note("a", 1))
      const settled = yield* Effect.exit(write.settled)
      return {
        settled: Exit.isFailure(settled),
        rows: texts(yield* notes.toArray),
        refused: (yield* Metric.value(Metric.withAttributes(Outbox.refused, { name: "save", status: "409" }))).count,
        left: [...world.storage.entries.keys()]
      }
    })).pipe(Effect.provide(ownMetrics())))
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
      yield* Effect.promise(() => until(() => expect(world.storage.entries.size).toBe(0)))
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
    expect(world.storage.entries.size).toBe(0)
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
    expect(seen.status).toEqual(Option.some({ leader: false, failing: null }))
  })

  test.each([false, true])(
    "leadership lost before persistence reports follower (storage fault: %s)",
    async (storageFault) => {
      const world = await setup([])
      let change = (_leader: boolean) => {}
      const leader: Outbox.Leader = {
        ...single,
        onLeadershipChange: (listener) => {
          change = listener
          return () => undefined
        }
      }
      let stores = 0
      const storage = {
        ...world.storage,
        set: async (key: string, value: string) => {
          stores++
          if (storageFault) throw new Error("quota")
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
      expect(seen.rows).toEqual([])
      expect(stores).toBe(0)
      expect(world.storage.entries.size).toBe(0)
      expect(world.sent).toEqual([])
    }
  )

  test.each([false, true])("storage failure stays storage when leadership is lost: %s", async (loseLeadership) => {
    const world = await setup([])
    let change = (_leader: boolean) => {}
    const leader: Outbox.Leader = {
      ...single,
      onLeadershipChange: (listener) => {
        change = listener
        return () => undefined
      }
    }
    const storage = {
      ...world.storage,
      set: () => {
        if (loseLeadership) change(false)
        return Promise.reject(new Error("quota"))
      }
    }
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...world, storage: storage as never, leader })
      const write = yield* save(outbox, notes, note("a", 1))
      const admitted = yield* Effect.exit(write.admitted)
      yield* Effect.exit(write.settled)
      return { admitted, rows: yield* notes.toArray }
    }))
    expect(seen.admitted).toEqual(Exit.fail(new Outbox.NotAdmitted({ reason: "storage" })))
    expect(seen.rows).toEqual([])
    expect(world.sent).toEqual([])
  })

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
    expect(world.storage.entries.size).toBe(1)
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
        left: world.storage.entries.size
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
      return { withdrawn: (yield* withdrawnCount).count, left: world.storage.entries.size }
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
      return { storing, withdrawn: (yield* withdrawnCount).count, left: world.storage.entries.size }
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
      return { deleting, rows: texts(yield* notes.toArray), left: world.storage.entries.size }
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
      return { refused, rows, left: world.storage.entries.size }
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
    const [key, value] = [...world.storage.entries][0]!
    world.storage.entries.set(key, JSON.stringify({ ...JSON.parse(value), outboxPhase: "deletion-pending" }))
    const network = offline()
    const refused = await scoped(Effect.gen(function*() {
      const { outbox } = yield* start({ ...world, notes: collection, online: network })
      const refused = yield* refusal(outbox, "a")
      network.connect()
      yield* Effect.promise(() => until(() => expect(world.storage.entries.size).toBe(0)))
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
      const left = world.storage.entries.size
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
      yield* Effect.promise(() => until(() => expect(world.storage.entries.size).toBe(0)))
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
      yield* Effect.promise(() => until(() => expect(world.storage.entries.size).toBe(0)))
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
        unreadable.reads > 0 && unreadable.reads-- > 0
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
    const stored = [...world.storage.entries.keys()]
    const { result, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start({ ...world, principal: as("ben").principal })
        const shown = texts(yield* notes.toArray)
        // Ben's own write goes; had Ann's loaded, it would have gone first.
        yield* (yield* save(outbox, notes, note("b", 2))).settled
        return { shown, ben: [...world.storage.entries.keys()] }
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
      yield* Effect.promise(() => until(() => expect(world.storage.entries.size).toBe(0)))
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
    expect([...world.storage.entries.keys()]).toHaveLength(1)
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
