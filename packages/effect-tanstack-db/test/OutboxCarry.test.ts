import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { Context, Effect, Layer, Metric, Schema, Scope } from "effect"
import { describe, expect, test, vi } from "vitest"
import { Collection, Migrations, Outbox } from "../src/index.ts"
import { id, memoryStorage, Note, withLogs } from "./fixtures.ts"

// The outbox across builds, over TanStack DB's real offline executor in Node: a program of the old build queues a
// write that can't get through and closes; a program of the next build opens the same storage. Its outbox upgrades
// the write before the library loads it, or parks it, and never drops it.

const NoteV2 = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  n: Schema.Number,
  tags: Schema.Array(Schema.String)
})
type NoteV2 = typeof NoteV2.Type
const toV2 = Migrations.step(
  Note,
  NoteV2,
  (row) => row.n < 0 ? new Migrations.Unmigratable({ reason: "negative" }) : { ...row, tags: [] }
)

const upgrade = Migrations.outbox(Migrations.registry({
  stores: [],
  outbox: {
    payloads: [Migrations.payload({ key: "notes", versions: [Note, NoteV2], migrations: [toV2] })],
    mutations: ["save"],
    unstamped: { notes: 1 }
  }
}))

const single: Outbox.Leader = {
  requestLeadership: () => Promise.resolve(true),
  releaseLeadership: () => undefined,
  isLeader: () => true,
  onLeadershipChange: () => () => undefined
}

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 4_000, interval: 5 })

const ownMetrics = () => Layer.succeed(Metric.MetricRegistry, new Map())

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(ownMetrics())))

type Storage = Outbox.Options<never>["storage"]

/** The old build: no upgrade, version 1's rows, and a server that never answers, so its write stays stored. */
const oldBuild = (storage: Storage, rows: ReadonlyArray<typeof Note.Type>) =>
  scoped(Effect.gen(function*() {
    const notes = yield* Collection.local({ id: id("notes"), schema: Note, getKey: (row) => row.id })
    const outbox = Context.get(
      yield* Layer.build(Outbox.layer({
        start: startOfflineExecutor,
        collections: { notes },
        storage,
        leader: single,
        online: Outbox.Online.always(),
        mutations: { save: () => Effect.fail(new Outbox.Retry({})) }
      })),
      Outbox.Outbox
    )
    for (const row of rows) {
      const write = yield* outbox.transact("save", { idempotencyKey: row.id }, Effect.asVoid(notes.insert(row)))
      yield* write.admitted
    }
  }))

/** The next build over the same storage: version 2's rows, a server that takes every write, and `parked`'s handler. */
const nextBuildProgram = <A>(
  storage: Storage,
  use: (context: {
    readonly outbox: Outbox.Service
    readonly notes: Collection.Collection<NoteV2, string>
    readonly sent: Array<{ readonly rows: ReadonlyArray<unknown>; readonly idempotencyKey: string }>
  }) => Effect.Effect<A, unknown, Scope.Scope>,
  parked?: Outbox.Options<never>["parked"]
) =>
  Effect.scoped(Effect.gen(function*() {
    const sent: Array<{ readonly rows: ReadonlyArray<unknown>; readonly idempotencyKey: string }> = []
    const notes = yield* Collection.local({ id: id("notes"), schema: NoteV2, getKey: (row) => row.id })
    const outbox = Context.get(
      yield* Layer.build(Outbox.layer({
        start: startOfflineExecutor,
        collections: { notes },
        storage,
        leader: single,
        online: Outbox.Online.always(),
        mutations: {
          save: (params) => Effect.sync(() => void sent.push(params))
        },
        upgrade,
        ...(parked === undefined ? {} : { parked })
      })),
      Outbox.Outbox
    )
    return yield* use({ outbox, notes, sent })
  })).pipe(Effect.provide(ownMetrics()))

const nextBuild = <A>(...args: Parameters<typeof nextBuildProgram<A>>) => Effect.runPromise(nextBuildProgram(...args))

const note = (key: string, n: number) => ({ id: key, text: key, n })

describe("a write an older build stored", () => {
  test("is upgraded before the outbox loads it, then sent once, as this build's row, under its key", async () => {
    const storage = memoryStorage()
    await oldBuild(storage, [note("a", 1)])
    const [stored] = [...storage.entries.values()]
    expect(JSON.parse(stored!).metadata.versions).toBeUndefined()
    const seen = await nextBuild(storage, ({ sent }) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => until(() => expect(sent).toHaveLength(1)))
        return {
          sent,
          upgraded: (yield* Metric.value(
            Metric.withAttributes(Outbox.carried, { name: "save", outcome: "upgraded", reason: "none" })
          )).count
        }
      }))
    expect(seen.sent).toEqual([{ rows: [{ id: "a", text: "a", n: 1, tags: [] }], idempotencyKey: "a" }])
    expect(seen.upgraded).toBe(1)
    await until(() => expect([...storage.entries.keys()]).toEqual([]))
  })

  test("already at this build's versions is left as stored, and sent", async () => {
    const storage = memoryStorage()
    await oldBuild(storage, [note("a", 1)])
    for (const [key, value] of storage.entries) {
      const upgraded = upgrade.write(value)
      storage.entries.set(key, (upgraded as { readonly value: string }).value)
    }
    const before = [...storage.entries.values()]
    const seen = await nextBuild(storage, ({ sent }) =>
      Effect.gen(function*() {
        const stored = [...storage.entries.values()]
        yield* Effect.promise(() => until(() => expect(sent).toHaveLength(1)))
        return {
          stored,
          upgraded: (yield* Metric.value(
            Metric.withAttributes(Outbox.carried, { name: "save", outcome: "upgraded", reason: "none" })
          )).count
        }
      }))
    expect(seen.stored).toEqual(before)
    expect(seen.upgraded).toBe(0)
  })

  test("that this build can't send is parked: never sent, listed, kept across a restart, and discarded on request", async () => {
    const storage = memoryStorage()
    await oldBuild(storage, [note("a", -1), note("b", 2)])
    const { logs, result } = await withLogs(nextBuildProgram(storage, ({ outbox, sent }) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => until(() => expect(sent).toHaveLength(1)))
        return {
          sent: sent.map(({ idempotencyKey }) => idempotencyKey),
          parked: yield* outbox.parked,
          counted: (yield* Metric.value(
            Metric.withAttributes(Outbox.carried, { name: "save", outcome: "parked", reason: "negative" })
          )).count
        }
      })))
    expect(result.sent).toEqual(["b"])
    expect(result.parked).toEqual([{ id: expect.any(String), name: "save", reason: "negative", rows: [note("a", -1)] }])
    expect(result.counted).toBe(1)
    const line = logs.find(({ message }) => (message as Array<unknown>)[0] === "outbox write parked")!
    expect(line.annotations).toMatchObject({ name: "save", reason: "negative", stage: "upgrade" })
    // Never the row's content.
    expect(JSON.stringify(line)).not.toContain("\"text\"")
    // The next program finds it parked still, and discards it.
    const after = await nextBuild(storage, ({ outbox, sent }) =>
      Effect.gen(function*() {
        const [parked] = yield* outbox.parked
        yield* outbox.discard(parked!.id)
        yield* outbox.discard("not-parked")
        return { sent, parked: yield* outbox.parked }
      }))
    expect(after).toEqual({ sent: [], parked: [] })
    expect([...storage.entries.keys()]).toEqual([])
  })

  test("parked goes to its feature as the outbox starts: one it takes leaves the outbox, one it leaves stays", async () => {
    const storage = memoryStorage()
    await oldBuild(storage, [note("a", -1)])
    const offered: Array<Outbox.Parked> = []
    const parkedLines = (logs: ReadonlyArray<{ readonly message: unknown; readonly annotations: unknown }>) =>
      logs.filter(({ message }) => (message as Array<unknown>)[0] === "outbox write parked").map(({ annotations }) =>
        annotations
      )
    const leaving = await withLogs(nextBuildProgram(storage, ({ outbox }) => outbox.parked, {
      save: (write) => Effect.sync(() => (offered.push(write), false))
    }))
    expect(leaving.result).toHaveLength(1)
    // Parked as the outbox upgraded it, then, left by its feature, logged again as it loads: never forgotten silently.
    expect(parkedLines(leaving.logs)).toEqual([
      { name: "save", reason: "negative", stage: "upgrade" },
      { name: "save", reason: "negative", stage: "load" }
    ])
    const taking = await withLogs(nextBuildProgram(storage, ({ outbox }) => outbox.parked, {
      save: (write) => Effect.sync(() => (offered.push(write), true))
    }))
    expect(taking.result).toEqual([])
    expect(parkedLines(taking.logs)).toEqual([])
    expect(offered.map(({ reason, rows }) => [reason, rows])).toEqual([
      ["negative", [note("a", -1)]],
      ["negative", [note("a", -1)]]
    ])
    // A parked write for a mutation no handler names stays.
    await oldBuild(storage, [note("c", -3)])
    const kept = await nextBuild(storage, ({ outbox }) => outbox.parked, { other: () => Effect.succeed(true) })
    expect(kept.map(({ rows }) => rows)).toEqual([[note("c", -3)]])
  })
})

describe("a new write", () => {
  test("carries the version of each payload it was made at", async () => {
    const storage = memoryStorage()
    await nextBuild(storage, ({ notes, outbox }) =>
      Effect.gen(function*() {
        const write = yield* outbox.transact(
          "save",
          { idempotencyKey: "a" },
          Effect.asVoid(notes.insert({ id: "a", text: "a", n: 1, tags: [] }))
        )
        yield* write.admitted
        const [stored] = [...storage.entries.values()]
        expect(JSON.parse(stored!).metadata.versions).toEqual({ notes: 2 })
        yield* write.settled
      }))
  })
})

describe("a storage that fails", () => {
  test("leaves the stored writes as they were, logs it, and reads as no parked writes", async () => {
    const storage = memoryStorage()
    await oldBuild(storage, [note("a", 1)])
    const before = [...storage.entries.entries()]
    const failing = {
      ...storage,
      keys: () => Promise.reject(new Error("quota")),
      get: () => Promise.reject(new Error("quota"))
    }
    const { logs, result } = await withLogs(nextBuildProgram(failing, ({ outbox }) =>
      Effect.gen(function*() {
        const parked = yield* outbox.parked
        yield* outbox.discard("any")
        return parked
      })))
    expect(result).toEqual([])
    expect([...storage.entries.entries()]).toEqual(before)
    const lines = logs.map(({ message, level, annotations }) => [(message as Array<unknown>)[0], level, annotations])
    // Each by the storage's error name, never its message.
    expect(lines).toEqual(expect.arrayContaining([
      ["outbox couldn't upgrade its writes", "Warn", { error: "Error" }],
      ["outbox couldn't read its parked writes", "Warn", { error: "Error" }],
      ["outbox couldn't discard a parked write", "Warn", { error: "Error" }]
    ]))
    expect(JSON.stringify(logs)).not.toContain("quota")
  })

  test("a stored write that isn't a write is parked under no name, with no rows", async () => {
    const storage = memoryStorage()
    storage.entries.set("tx:broken", "{not json")
    storage.entries.set("tx:shapeless", JSON.stringify({ mutationFnName: 3, mutations: 3 }))
    const parked = await nextBuild(storage, ({ outbox }) => outbox.parked)
    expect(parked.map(({ id, name, reason, rows }) => [id, name, reason, rows]).sort()).toEqual([
      ["broken", "unknown", "unreadable", []],
      ["shapeless", "unknown", "unreadable", []]
    ])
  })

  test("a write deleted while the outbox upgrades is skipped", async () => {
    const storage = memoryStorage()
    await oldBuild(storage, [note("a", 1)])
    storage.entries.set("parked:gone", JSON.stringify({ reason: "mutation", name: "save", write: "{}" }))
    const vanishing = { ...storage, get: () => Promise.resolve(null) }
    const parked = await nextBuild(vanishing, ({ outbox }) => outbox.parked)
    expect(parked).toEqual([])
  })
})
