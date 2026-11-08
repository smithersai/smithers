import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { Context, Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect"
import { expect, test } from "vitest"
import { Collection, Outbox } from "../src/index.ts"
import { id, memoryStorage, Note, note } from "./fixtures.ts"

type Config = Parameters<typeof startOfflineExecutor>[0]
const leader: Outbox.Leader = {
  requestLeadership: () => Promise.resolve(true),
  releaseLeadership: () => undefined,
  isLeader: () => true,
  onLeadershipChange: () => () => undefined
}
const start = (storage: ReturnType<typeof memoryStorage>, options: Partial<Outbox.Options<never>> = {}) =>
  Effect.gen(function*() {
    const notes = yield* Collection.local({ id: id("recovery"), schema: Note, getKey: (row) => row.id })
    let config!: Config
    const context = yield* Layer.build(Outbox.layer({
      storage,
      collections: { notes },
      leader,
      online: { ...Outbox.Online.always(), isOnline: () => false },
      mutations: { save: () => Effect.void },
      ...options,
      // Observe the storage port supplied to the real offline executor. Its
      // predecessor's persisted callbacks can arrive after another tab acts.
      start: (supplied) => {
        config = supplied
        return (options.start ?? startOfflineExecutor)(supplied)
      }
    }))
    const outbox = Context.get(context, Outbox.Outbox)
    const save = (name: string) =>
      outbox.transact("save", { idempotencyKey: name }, Effect.asVoid(notes.insert(note(name, 1))))
    return { outbox, save, config, bridge: config.storage! }
  })
const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const rows = (storage: ReturnType<typeof memoryStorage>) =>
  [...storage.entries].filter(([key]) => key.startsWith("tx:"))
const seed = async (storage: ReturnType<typeof memoryStorage>, names: string[], principal?: Outbox.Principal) => {
  await scoped(Effect.gen(function*() {
    const service = yield* start(storage, principal ? { principal } : {})
    for (const name of names) yield* (yield* service.save(name)).admitted
  }))
}

test("a predecessor's storage callbacks cannot resurrect deleted or settled rows, or delete another principal's row", async () => {
  const storage = memoryStorage()
  let principal = "alice"
  await scoped(Effect.gen(function*() {
    const { save, bridge } = yield* start(storage, { principal: { now: () => principal, ownsUnstamped: () => false } })
    yield* (yield* save("first")).admitted
    const [key, snapshot] = rows(storage)[0]!
    storage.entries.delete(key)
    yield* Effect.promise(() => bridge.set(key, snapshot))
    expect(storage.entries.has(key)).toBe(false)
    const settled = JSON.stringify({ ...JSON.parse(snapshot), outboxPhase: "settled" })
    storage.entries.set(key, settled)
    yield* Effect.promise(() => bridge.set(key, snapshot))
    expect(storage.entries.get(key)).toBe(settled)
    storage.entries.set(key, snapshot)
    principal = "bob"
    yield* Effect.promise(() => bridge.delete(key))
    expect(storage.entries.get(key)).toBe(snapshot)
  }))
})

test("storage clear removes rows and support keys, clears held status and publishes the change", async () => {
  const storage = memoryStorage()
  let published = 0
  await scoped(Effect.gen(function*() {
    const { save, bridge, outbox } = yield* start(storage, {
      changes: {
        publish: () => {
          published++
        },
        subscribe: () => () => undefined
      }
    })
    yield* (yield* save("held")).admitted
    const [key, snapshot] = rows(storage)[0]!
    const held = JSON.parse(snapshot)
    held.metadata.held = true
    delete held.metadata.admissionSequence
    storage.entries.set(key, JSON.stringify(held))
    yield* Effect.promise(() => bridge.set(key, JSON.stringify(held)))
    expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(true)
    const before = published
    yield* Effect.promise(() => bridge.set("support", "{}"))
    yield* Effect.promise(() => bridge.clear())
    expect([...storage.entries]).toEqual([])
    expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(false)
    expect(published).toBeGreaterThan(before)
  }))
})

for (const when of ["recovery", "admission"] as const) {
  test(`an invalid counter refuses ${when} without storing a new write`, async () => {
    const storage = memoryStorage()
    if (when === "recovery") storage.entries.set("outbox:admission-counter", "invalid")
    await scoped(Effect.gen(function*() {
      const { save } = yield* start(storage)
      storage.entries.set("outbox:admission-counter", "invalid")
      const exit = yield* Effect.exit(save("refused").pipe(Effect.flatMap((write) => write.admitted)))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(rows(storage)).toEqual([])
      expect(storage.entries.get("outbox:admission-counter")).toBe("invalid")
    }))
  })
}

test("legacy ordering recovery retains sealed migration assignments and drops disappeared rows", async () => {
  const storage = memoryStorage()
  await seed(storage, ["foreign"], { now: () => "alice", ownsUnstamped: () => false })
  const [foreignKey, foreign] = rows(storage)[0]!
  const foreignRow = JSON.parse(foreign)
  delete foreignRow.metadata.admissionSequence
  foreignRow.createdAt = "invalid"
  storage.entries.set(foreignKey, JSON.stringify(foreignRow))
  await seed(storage, ["legacy-bob"], { now: () => "bob", ownsUnstamped: () => false })
  const [bobKey, bob] = rows(storage).find(([key]) => key !== foreignKey)!
  const bobRow = JSON.parse(bob)
  delete bobRow.metadata.admissionSequence
  storage.entries.set(bobKey, JSON.stringify(bobRow))
  const keys = storage.keys
  storage.keys = async () => [...await keys(), "tx:disappeared"]
  storage.entries.set(
    "outbox:admission-migration",
    JSON.stringify([
      { key: "tx:gone", sequence: 1 },
      { key: foreignKey, sequence: 2 }
    ])
  )
  const retained = storage.entries.get(foreignKey)
  await scoped(Effect.gen(function*() {
    const { save } = yield* start(storage, { principal: { now: () => "bob", ownsUnstamped: () => false } })
    yield* (yield* save("own")).admitted
    expect(JSON.parse(storage.entries.get("outbox:admission-migration")!)).toEqual([{ key: foreignKey, sequence: 2 }])
    expect(storage.entries.get(foreignKey)).toBe(retained)
    expect(rows(storage)).toHaveLength(3)
  }))
  await scoped(Effect.gen(function*() {
    yield* start(storage, { principal: { now: () => "alice", ownsUnstamped: () => false } })
    expect(storage.entries.has("outbox:admission-migration")).toBe(false)
    expect(JSON.parse(storage.entries.get(foreignKey)!).metadata.admissionSequence).toBe(2)
  }))
})

test("legacy rows with equal timestamps keep held rows first and break remaining ties by key", async () => {
  const storage = memoryStorage()
  await seed(storage, ["one", "two", "three"])
  for (const [index, [key, stored]] of rows(storage).entries()) {
    const row = JSON.parse(stored)
    row.createdAt = 0
    row.metadata = index === 2 ? {} : { held: true }
    storage.entries.set(key, JSON.stringify(row))
  }
  const expected = rows(storage).sort(([a, av], [b, bv]) =>
    Number(JSON.parse(bv).metadata.held === true) - Number(JSON.parse(av).metadata.held === true) || a.localeCompare(b)
  ).map(([key]) => key)
  await scoped(Effect.gen(function*() {
    yield* start(storage)
    const ordered = rows(storage).sort(([, a], [, b]) =>
      JSON.parse(a).metadata.admissionSequence - JSON.parse(b).metadata.admissionSequence
    ).map(([key]) => key)
    expect(ordered).toEqual(expected)
    expect(new Set(rows(storage).map(([, row]) => JSON.parse(row).metadata.admissionSequence)).size).toBe(3)
  }))
})

for (const lost of ["scope", "leadership"] as const) {
  test(`a queued storage admission refuses after ${lost} ends`, async () => {
    const storage = memoryStorage()
    let entered!: () => void
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = true
    const guarded = {
      ...storage,
      withLock: <A>(key: string, action: () => Promise<A>) =>
        storage.withLock(key, async () => {
          if (key.startsWith("tx:")) {
            entered()
            await gate
          }
          return action()
        })
    }
    try {
      await scoped(Effect.gen(function*() {
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const { save } = yield* start(guarded, {
          leader: {
            ...leader,
            isLeader: () => active,
            withAdmission: (action) => storage.withLock("admission", action)
          }
        }).pipe(Effect.provideService(Scope.Scope, scope))
        const write = yield* save("pending")
        yield* Effect.promise(() => pending)
        if (lost === "scope") yield* Scope.close(scope, Exit.void)
        else active = false
        release()
        expect(yield* Effect.flip(write.admitted)).toEqual(new Outbox.NotAdmitted({ reason: "follower" }))
        expect(rows(storage)).toEqual([])
        if (lost === "leadership") yield* Scope.close(scope, Exit.void)
      }))
    } finally {
      release()
    }
  })
}

test("a failed held-index repair remains held and the next retry repairs the durable index", async () => {
  const storage = memoryStorage()
  let fail = true
  let attempts = 0
  let failedAgain!: () => void
  const failed = new Promise<void>((resolve) => {
    failedAgain = resolve
  })
  let repaired!: () => void
  const repair = new Promise<void>((resolve) => {
    repaired = resolve
  })
  const faulty = {
    ...storage,
    set: async (key: string, value: string) => {
      if (key === "outbox:held" && fail) {
        if (++attempts === 2) failedAgain()
        throw new Error("index unavailable")
      }
      const result = await storage.set(key, value)
      if (key === "outbox:held") repaired()
      return result
    }
  }
  await scoped(Effect.gen(function*() {
    const { save, bridge, outbox } = yield* start(faulty)
    yield* (yield* save("held")).admitted
    const [key, snapshot] = rows(storage)[0]!
    const held = JSON.parse(snapshot)
    held.metadata.held = true
    yield* Effect.promise(() => bridge.set(key, JSON.stringify(held)))
    yield* outbox.retryNow
    yield* Effect.promise(() => failed)
    expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(true)
    expect(storage.entries.has("outbox:held")).toBe(false)
    fail = false
    yield* outbox.retryNow
    yield* Effect.promise(() => repair)
    expect(JSON.parse(storage.entries.get("outbox:held")!)).toEqual([key])
  }))
})

test("cached held ownership follows principal changes back to the owning principal", async () => {
  const storage = memoryStorage()
  let principal = "alice"
  await scoped(Effect.gen(function*() {
    const { save, bridge, outbox } = yield* start(storage, {
      principal: { now: () => principal, ownsUnstamped: () => false }
    })
    yield* (yield* save("held")).admitted
    const [key, value] = rows(storage)[0]!
    const row = JSON.parse(value)
    row.metadata.held = true
    yield* Effect.promise(() => bridge.set(key, JSON.stringify(row)))
    principal = "bob"
    yield* Effect.promise(() => bridge.set("support", "{}"))
    expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(false)
    principal = "alice"
    yield* Effect.promise(() => bridge.set("support", "{}"))
    expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(true)
  }))
})

test("legacy retry comparison retains creation order when admission sequences are absent", async () => {
  const storage = memoryStorage()
  await seed(storage, ["older", "newer"])
  await scoped(Effect.gen(function*() {
    const { config } = yield* start(storage)
    const transactions = rows(storage).map(([, value], index) => ({
      ...JSON.parse(value),
      metadata: {},
      createdAt: new Date(index * 100)
    }))
    const ordered = [...transactions].reverse().sort(config.retryScheduling!.compare)
    expect(ordered.map((transaction) => transaction.idempotencyKey)).toEqual(["older", "newer"])
  }))
})

test("leadership recovery cannot admit after its scope closes while recovery is pending", async () => {
  const storage = memoryStorage()
  let changed: (value: boolean) => void = () => undefined
  let armed = false
  let entered!: () => void
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const election: Outbox.Leader = {
    ...leader,
    onLeadershipChange: (listener) => {
      changed = listener
      return () => undefined
    },
    withAdmission: (action) =>
      storage.withLock("admission", async () => {
        if (armed) {
          entered()
          await gate
        }
        return action()
      })
  }
  try {
    await scoped(Effect.gen(function*() {
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const { save } = yield* start(storage, { leader: election }).pipe(Effect.provideService(Scope.Scope, scope))
      armed = true
      changed(false)
      changed(true)
      yield* Effect.promise(() => pending)
      const admitting = yield* Effect.forkScoped(save("too-late"))
      yield* Effect.yieldNow
      yield* Scope.close(scope, Exit.void)
      release()
      expect(yield* Effect.flip(Fiber.join(admitting))).toEqual(new Outbox.NotAdmitted({ reason: "follower" }))
      expect(rows(storage)).toEqual([])
    }))
  } finally {
    release()
  }
})

test("admission allocates from the durable counter when a storage client omits queuedAt", async () => {
  const storage = memoryStorage()
  await scoped(Effect.gen(function*() {
    const { save } = yield* start(storage, {
      start: (config) =>
        startOfflineExecutor({
          ...config,
          storage: {
            ...config.storage!,
            set: (key, value) => {
              const row = JSON.parse(value)
              if (key.startsWith("tx:")) delete row.metadata.queuedAt
              return config.storage!.set(key, JSON.stringify(row))
            }
          }
        })
    })
    yield* (yield* save("legacy-admission")).admitted
    const stored = JSON.parse(rows(storage)[0]![1])
    expect(stored.metadata.admissionSequence).toBe(1)
    expect(stored.metadata.queuedAt).toBeUndefined()
    expect(storage.entries.get("outbox:admission-counter")).toBe("1")
  }))
})

test("leadership keeps an unindexed hold through failed publication and repairs it on retry", async () => {
  const storage = memoryStorage()
  let changed: (value: boolean) => void = () => undefined
  let fail = false
  let failures = 0
  let failedAgain!: () => void
  const failed = new Promise<void>((resolve) => {
    failedAgain = resolve
  })
  let repaired!: () => void
  const repair = new Promise<void>((resolve) => {
    repaired = resolve
  })
  const faulty = {
    ...storage,
    set: async (key: string, value: string) => {
      if (key === "outbox:held" && fail) {
        if (++failures === 2) failedAgain()
        throw new Error("index unavailable")
      }
      const result = await storage.set(key, value)
      if (key === "outbox:held" && failures > 0) repaired()
      return result
    }
  }
  await scoped(Effect.gen(function*() {
    const { save, bridge, outbox } = yield* start(faulty, {
      leader: {
        ...leader,
        onLeadershipChange: (listener) => {
          changed = listener
          return () => undefined
        }
      }
    })
    yield* (yield* save("held")).admitted
    const [key, snapshot] = rows(storage)[0]!
    const held = JSON.parse(snapshot)
    held.metadata.held = true
    yield* Effect.promise(() => bridge.set(key, JSON.stringify(held)))
    storage.entries.delete("outbox:held")
    fail = true
    yield* outbox.retryNow
    // Retry schedules refresh after its maintenance step. These real queued
    // storage writes cross both boundaries before the leadership transition.
    yield* Effect.promise(() => bridge.set("support", "{}"))
    yield* Effect.promise(() => bridge.set("support", "{}"))
    changed(false)
    changed(true)
    yield* Effect.promise(() => failed)
    expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(true)
    expect(storage.entries.has("outbox:held")).toBe(false)
    fail = false
    yield* outbox.retryNow
    yield* Effect.promise(() => repair)
    expect(JSON.parse(storage.entries.get("outbox:held")!)).toEqual([key])
  }))
})

test("an invalidation during a held-row read schedules another refresh and observes the newer row", async () => {
  const storage = memoryStorage()
  let invalidate: () => void = () => undefined
  let armed = false
  let entered!: () => void
  let release!: () => void
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  const interleaved = {
    ...storage,
    get: async (key: string) => {
      const value = await storage.get(key)
      if (key.startsWith("tx:")) {
        reads++
        if (armed) {
          armed = false
          entered()
          await gate
        }
      }
      return value
    }
  }
  try {
    await scoped(Effect.gen(function*() {
      const { save, bridge, outbox } = yield* start(interleaved, {
        changes: {
          publish: () => undefined,
          subscribe: (listener) => {
            invalidate = listener
            return () => undefined
          }
        }
      })
      yield* (yield* save("held")).admitted
      const [key, snapshot] = rows(storage)[0]!
      const row = JSON.parse(snapshot)
      row.metadata.held = true
      yield* Effect.promise(() => bridge.set(key, JSON.stringify(row)))
      expect(Option.getOrThrow(yield* Stream.runHead(outbox.status)).held).toBe(true)
      const cleared = yield* outbox.status.pipe(
        Stream.filter((state) => !state.held),
        Stream.runHead,
        Effect.forkScoped
      )
      const before = reads
      armed = true
      invalidate()
      yield* Effect.promise(() => reading)
      row.metadata.held = false
      storage.entries.set(key, JSON.stringify(row))
      invalidate()
      release()
      expect(Option.getOrThrow(yield* Fiber.join(cleared)).held).toBe(false)
      expect(reads - before).toBe(2)
    }))
  } finally {
    release()
  }
})
