import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { Context, Effect, Layer, Metric, Scope } from "effect"
import { describe, expect, test, vi } from "vitest"
import { Collection, Outbox } from "../src/index.ts"
import { id, memoryStorage, Note, note, withLogs } from "./fixtures.ts"

// The outbox over TanStack DB's real offline executor, with two mutations, so two writes can wait under one
// idempotency key, and over a storage a test damages before the outbox starts. Each mutation's stand-in for a server
// records the send and accepts it.

const single: Outbox.Leader = {
  requestLeadership: () => Promise.resolve(true),
  releaseLeadership: () => undefined,
  isLeader: () => true,
  onLeadershipChange: () => () => undefined
}

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 4_000, interval: 5 })

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

interface World {
  readonly storage: ReturnType<typeof memoryStorage>
  readonly sent: Array<string>
  readonly notes: string
}

const world = (): World => ({ storage: memoryStorage(), sent: [], notes: id("notes") })

/** One program's outbox over the world's storage: `save` and `archive`, each recording `name:key` as it is sent. */
const start = (
  options: World & { readonly online?: Outbox.Online; readonly parked?: Outbox.Options<never>["parked"] }
) =>
  Effect.gen(function*() {
    const notes = yield* Collection.local({ id: options.notes, schema: Note, getKey: (row) => row.id })
    const send = (name: string): Outbox.Mutation<never> => ({ idempotencyKey }) =>
      Effect.sync(() => void options.sent.push(`${name}:${idempotencyKey}`))
    const context = yield* Layer.build(
      Outbox.layer({
        start: startOfflineExecutor,
        collections: { notes },
        storage: options.storage,
        leader: single,
        online: options.online ?? Outbox.Online.always(),
        ...(options.parked === undefined ? {} : { parked: options.parked }),
        mutations: { save: send("save"), archive: send("archive") }
      })
    )
    return { notes, outbox: Context.get(context, Outbox.Outbox) }
  })

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(Layer.succeed(Metric.MetricRegistry, new Map()))))

const reason = (effect: Effect.Effect<void, Outbox.NotWithdrawn>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason)

describe("two mutations under one idempotency key", () => {
  /** `save` and `archive` each queue a write under key `k`, stored and waiting for the network. */
  const queued = (options: World & { readonly online: Outbox.Online }) =>
    Effect.gen(function*() {
      const { notes, outbox } = yield* start(options)
      const saved = yield* outbox.transact("save", { idempotencyKey: "k" }, Effect.asVoid(notes.insert(note("s", 1))))
      yield* saved.admitted
      const archived = yield* outbox.transact(
        "archive",
        { idempotencyKey: "k" },
        Effect.asVoid(notes.insert(note("a", 2)))
      )
      yield* archived.admitted
      return { notes, outbox, saved, archived }
    })

  test("withdrawing the second by its name takes back that one, and the first is still sent", async () => {
    const shared = world()
    const network = offline()
    const seen = await scoped(Effect.gen(function*() {
      const { notes, outbox, saved, archived } = yield* queued({ ...shared, online: network })
      yield* outbox.withdraw("k", "archive")
      const rows = (yield* notes.toArray).map((row) => row.id)
      const stored = {
        saved: shared.storage.entries.has(`tx:${saved.id}`),
        archived: shared.storage.entries.has(`tx:${archived.id}`)
      }
      const cause = ((yield* Effect.flip(archived.settled)).cause as Error).name
      // The one taken back is gone for its own name too, and the other's name still finds the other.
      const again = yield* reason(outbox.withdraw("k", "archive"))
      network.connect()
      yield* saved.settled
      return { rows, stored, cause, again }
    }))
    expect(seen).toEqual({
      rows: ["s"],
      stored: { saved: true, archived: false },
      cause: "OutboxWithdrawn",
      again: "gone"
    })
    expect(shared.sent).toEqual(["save:k"])
  })

  test("withdrawing the first by its name leaves the second, whichever was queued first", async () => {
    const shared = world()
    const network = offline()
    await scoped(Effect.gen(function*() {
      const { outbox, archived } = yield* queued({ ...shared, online: network })
      yield* outbox.withdraw("k", "save")
      network.connect()
      yield* archived.settled
    }))
    expect(shared.sent).toEqual(["archive:k"])
  })

  test("without a name the key is ambiguous: neither is taken back, and both are sent", async () => {
    const shared = world()
    const network = offline()
    const { result: seen, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox, saved, archived } = yield* queued({ ...shared, online: network })
        const withdrawn = yield* reason(outbox.withdraw("k"))
        const handedOff = yield* reason(outbox.handoff("k", Effect.die("recipient must not run")))
        const unknown = yield* reason(outbox.withdraw("k", "rename"))
        const rows = (yield* notes.toArray).map((row) => row.id).sort()
        const parked = yield* outbox.parked
        network.connect()
        yield* saved.settled
        yield* archived.settled
        return { withdrawn, handedOff, unknown, rows, parked }
      })).pipe(Effect.provide(Layer.succeed(Metric.MetricRegistry, new Map())))
    )
    expect(seen).toEqual({
      withdrawn: "ambiguous",
      handedOff: "ambiguous",
      unknown: "gone",
      rows: ["a", "s"],
      parked: []
    })
    expect([...shared.sent].sort()).toEqual(["archive:k", "save:k"])
    expect(logs.filter(({ level }) => level === "Warn")).toEqual([])
  })

  test("a handoff by name parks that mutation's write only, and the other is sent", async () => {
    const shared = world()
    const network = offline()
    const seen = await scoped(Effect.gen(function*() {
      const { outbox, saved, archived } = yield* queued({ ...shared, online: network })
      const accepted: Array<ReadonlyArray<Outbox.Parked>> = []
      yield* outbox.handoff(
        "k",
        Effect.flatMap(outbox.parked, (parked) => Effect.sync(() => void accepted.push(parked))),
        "archive"
      )
      network.connect()
      yield* saved.settled
      return { accepted, archivedId: archived.id, parked: yield* outbox.parked }
    }))
    expect(seen.accepted).toMatchObject([[{
      id: seen.archivedId,
      name: "archive",
      reason: "withdrawn",
      rows: [note("a", 2)]
    }]])
    expect(seen.parked).toEqual([])
    expect(shared.sent).toEqual(["save:k"])
  })

  test("one mutation under a key is taken back without a name, as before", async () => {
    const shared = world()
    const network = offline()
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...shared, online: network })
      const only = yield* outbox.transact("save", { idempotencyKey: "k" }, Effect.asVoid(notes.insert(note("s", 1))))
      yield* only.admitted
      yield* outbox.withdraw("k")
      const next = yield* outbox.transact("archive", { idempotencyKey: "n" }, Effect.asVoid(notes.insert(note("a", 2))))
      network.connect()
      yield* next.settled
    }))
    expect(shared.sent).toEqual(["archive:n"])
  })
})

describe("a parked value the outbox can't read", () => {
  const readable = (name: string) =>
    JSON.stringify({
      reason: "negative",
      name,
      write: JSON.stringify({ mutationFnName: name, mutations: [{ modified: note("p", -1) }] })
    })
  // Not JSON, JSON that isn't a record, and a record missing each field in turn.
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["cut", "{"],
    ["null", "null"],
    ["text", "\"a private question\""],
    ["no-reason", JSON.stringify({ name: "save", write: "a private question" })],
    ["no-name", JSON.stringify({ reason: "negative", write: "a private question" })],
    ["no-write", JSON.stringify({ reason: "negative", name: "save", text: "a private question" })]
  ]

  test("never stops the outbox: it starts, lists and offers the readable ones, logs the rest, and still sends", async () => {
    const shared = world()
    for (const [key, value] of malformed) shared.storage.entries.set(`parked:${key}`, value)
    shared.storage.entries.set("parked:good", readable("save"))
    const offered: Array<string> = []
    const { result: seen, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const { notes, outbox } = yield* start({
          ...shared,
          parked: { save: (write) => Effect.sync(() => (offered.push(write.id), false)) }
        })
        const listed = (yield* outbox.parked).map((parked) => parked.id)
        // Whose an unreadable value is can't be told, so discarding it leaves it; a readable one goes.
        for (const [key] of malformed) yield* outbox.discard(key)
        yield* outbox.discard("good")
        const write = yield* outbox.transact(
          "save",
          { idempotencyKey: "k" },
          Effect.asVoid(notes.insert(note("s", 1)))
        )
        yield* write.settled
        return { listed, after: yield* outbox.parked }
      })).pipe(Effect.provide(Layer.succeed(Metric.MetricRegistry, new Map())))
    )
    expect(seen).toEqual({ listed: ["good"], after: [] })
    expect(offered).toEqual(["good"])
    expect(shared.sent).toEqual(["save:k"])
    expect([...shared.storage.entries.keys()].filter((key) => key.startsWith("parked:")).sort()).toEqual(
      malformed.map(([key]) => `parked:${key}`).sort()
    )
    const unreadable = logs.filter(({ message }) => (message as Array<unknown>)[0] === "outbox parked write unreadable")
    expect(unreadable.every(({ level }) => level === "Warn")).toBe(true)
    // Once as the outbox starts, and once for each of the two times the test lists the parked writes.
    expect(unreadable.map(({ annotations }) => annotations["id"]).sort()).toEqual(
      [...malformed, ...malformed, ...malformed].map(([key]) => key).sort()
    )
    // The stored value is never logged.
    expect(JSON.stringify(logs)).not.toContain("private")
  })

  test("beside a write waiting to be sent is no tombstone: the write is restored and sent", async () => {
    const shared = world()
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...shared, online: offline() })
      const write = yield* outbox.transact("save", { idempotencyKey: "k" }, Effect.asVoid(notes.insert(note("s", 1))))
      yield* write.admitted
      // As a park whose record was cut short: the sendable copy is still stored.
      shared.storage.entries.set(`parked:${write.id}`, "{")
    }))
    expect(shared.sent).toEqual([])
    await scoped(Effect.gen(function*() {
      yield* start(shared)
      yield* Effect.promise(() => until(() => expect(shared.sent).toEqual(["save:k"])))
    }))
  })

  test("a readable handoff record beside its write still keeps that write from being sent", async () => {
    const shared = world()
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({ ...shared, online: offline() })
      const write = yield* outbox.transact("save", { idempotencyKey: "k" }, Effect.asVoid(notes.insert(note("s", 1))))
      yield* write.admitted
      // As a handoff that stopped after parking the write and before deleting its sendable copy.
      shared.storage.entries.set(
        `parked:${write.id}`,
        JSON.stringify({ reason: "withdrawn", name: "save", write: shared.storage.entries.get(`tx:${write.id}`) })
      )
    }))
    const taken: Array<string> = []
    await scoped(Effect.gen(function*() {
      const { notes, outbox } = yield* start({
        ...shared,
        parked: { save: (write) => Effect.sync(() => (taken.push(write.name), true)) }
      })
      const next = yield* outbox.transact("archive", { idempotencyKey: "n" }, Effect.asVoid(notes.insert(note("a", 2))))
      yield* next.settled
    }))
    expect(taken).toEqual(["save"])
    expect(shared.sent).toEqual(["archive:n"])
    expect([...shared.storage.entries.keys()].filter((key) => key !== "outbox:admission-counter")).toEqual([])
  })
})
