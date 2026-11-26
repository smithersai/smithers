import { Collection, Outbox } from "@smthrs/effect-tanstack-db"
import { WebLock } from "@smthrs/platform-browser"
import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { Context, Effect, Layer, Metric, Option, Schema, Scope, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { sendingAdmitted } from "./outboxAdmission.vibe"
import { followingOutbox } from "./outboxFollower"
import { memoryStorage } from "./wipe"

// Two tabs of one device over the real outbox and TanStack DB's real offline executor: one storage, one Web Lock and
// one channel of notices between them, as main.tsx gives every tab IndexedDB, `navigator.locks` and a
// BroadcastChannel. Nothing waits on a clock: each step waits for the row, the lead or the settlement it names.

const Note = Schema.Struct({ id: Schema.String })
type Note = typeof Note.Type

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
    },
  }
}

/** One device: its outbox storage, its lock, what its tabs sent, and a channel that tells every other tab, as a BroadcastChannel does. */
const device = () => {
  const id = crypto.randomUUID()
  const ports = new Set<Set<() => void>>()
  return {
    storage: memoryStorage(),
    sent: [] as Array<string>,
    lock: WebLock.make({ request: (name, options, callback) => navigator.locks.request(`${id}/${name}`, options, callback) }),
    channel: (): NonNullable<Outbox.Options<never>["changes"]> => {
      const mine = new Set<() => void>()
      ports.add(mine)
      return {
        publish: () => {
          for (const port of ports) if (port !== mine) for (const listener of port) listener()
        },
        subscribe: (listener) => {
          mine.add(listener)
          return () => void mine.delete(listener)
        },
      }
    },
  }
}

/** A tab of `on`: its own collection, as a tab's memory is its own, network and outbox. `follow` is what main.tsx does to the outbox's host. */
const tab = (on: ReturnType<typeof device>, follow = followingOutbox) =>
  Effect.gen(function* () {
    const notes = yield* Collection.local<Note, string>({ id: `notes-${crypto.randomUUID()}`, schema: Note, getKey: (row) => row.id })
    const leader = yield* Outbox.lockLeader({ lock: on.lock, name: "outbox" })
    const network = offline()
    const context = yield* Layer.build(
      Outbox.layer({
        ...follow({ start: startOfflineExecutor, storage: on.storage, changes: on.channel() }),
        leader,
        collections: { notes },
        online: network,
        mutations: { save: ({ idempotencyKey }) => Effect.sync(() => void on.sent.push(idempotencyKey)) },
      }),
    )
    const outbox = Context.get(context, Outbox.Outbox)
    const ids = Effect.map(notes.toArray, (rows) => rows.map((row) => row.id).sort())
    return {
      notes,
      network,
      outbox,
      ids,
      /** Queues a note, stored before this returns. */
      save: (id: string) =>
        Effect.gen(function* () {
          const write = yield* outbox.transact("save", { idempotencyKey: id }, Effect.asVoid(notes.insert({ id })))
          yield* write.admitted
          return write
        }),
      /** Waits until this tab shows exactly these notes. */
      shows: (expected: ReadonlyArray<string>) =>
        notes.changes({ initial: true }).pipe(
          Stream.mapEffect(() => ids),
          Stream.filter((now) => now.join() === [...expected].sort().join()),
          Stream.runHead,
        ),
      /** Takes the lead, or waits until another tab took it. */
      lead: leader.take,
      follows: outbox.status.pipe(Stream.filter((status) => !status.leader), Stream.runHead),
    }
  })

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(Layer.succeed(Metric.MetricRegistry, new Map()))))

test("sending rows use live admission receipts when present", async () => {
  await scoped(Effect.gen(function* () {
    const { outbox, save } = yield* tab(device())
    expect(yield* sendingAdmitted(outbox, "save", "restored")).toBe(true)

    yield* save("live")
    expect(yield* sendingAdmitted(outbox, "save", "live")).toBe(true)

    let rolledBack = false
    const faulty: Outbox.Service = {
      ...outbox,
      admission: () => Effect.succeed(Option.some({
        id: "refused",
        admitted: Effect.fail(new Outbox.NotAdmitted({ reason: "storage" })),
        settled: Effect.sync(() => { rolledBack = true }).pipe(
          Effect.andThen(Effect.fail(new Collection.TransactionFailed({ cause: "quota" }))),
        ),
      })),
    }
    expect(yield* sendingAdmitted(faulty, "save", "refused")).toBe(false)
    expect(rolledBack).toBe(true)
  }))
})

/**
 * Tab 1 queues `ghost` and `kept` offline; tab 2 takes the lead and shows both; tab 1 leads again, so tab 2 follows.
 * `takeBack` is what `Outbox.withdraw` does to the storage in the tab that leads, from a third tab's handle: it
 * deletes the write's key. The outbox's own `withdraw` can't stand in for it here: this process is one JavaScript
 * realm, where TanStack DB rolls a write back in every tab's collection at once, as it never does across real tabs.
 */
const twoTabs = (follow = followingOutbox) =>
  Effect.gen(function* () {
    const on = device()
    const one = yield* tab(on, follow)
    const ghost = yield* one.save("ghost")
    const kept = yield* one.save("kept")
    const two = yield* tab(on, follow)
    yield* two.lead
    yield* two.shows(["ghost", "kept"])
    yield* one.follows
    yield* one.lead
    yield* two.follows
    const other = follow({ start: startOfflineExecutor, storage: on.storage, changes: on.channel() })
    const takeBack = Effect.promise(() => other.storage.delete(`tx:${ghost.id}`))
    return { on, one, two, kept, takeBack }
  })

describe("followingOutbox", () => {
  test("a write another tab takes back leaves the tab that follows; the write still stored stays, and so does the leading tab's", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { on, one, two, kept, takeBack } = yield* twoTabs()
      yield* takeBack
      yield* two.shows(["kept"])
      return {
        one: yield* one.ids,
        two: yield* two.ids,
        stored: (yield* Effect.promise(() => on.storage.keys())).filter((key) => key.startsWith("tx:")),
        kept: `tx:${kept.id}`,
        sent: [...on.sent],
      }
    }))
    // Tab 1 leads: its outbox settles its own writes, so a notice releases nothing there.
    expect(seen.one).toEqual(["ghost", "kept"])
    expect(seen.two).toEqual(["kept"])
    expect(seen.stored).toEqual([seen.kept])
    expect(seen.sent).toEqual([])
  })

  test("without it, the tab that follows keeps the row of the write taken back", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { two, takeBack } = yield* twoTabs((host) => host)
      yield* takeBack
      // Tab 2 hears nothing, so there is nothing to wait for: its rows are as they were.
      return yield* two.ids
    }))
    expect(seen).toEqual(["ghost", "kept"])
  })

  test("a write the leading tab sends settles in the tab that made it and now follows", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const on = device()
      const one = yield* tab(on)
      const made = yield* one.save("made")
      const two = yield* tab(on)
      yield* two.lead
      yield* two.shows(["made"])
      yield* one.follows
      two.network.connect()
      yield* made.settled
      yield* one.shows([])
      return { one: yield* one.ids, sent: [...on.sent] }
    }))
    expect(seen).toEqual({ one: [], sent: ["made"] })
  })

  test("a host whose tabs can't hear each other is left as it is", () => {
    const host = { start: startOfflineExecutor, storage: memoryStorage() }
    expect(followingOutbox(host)).toBe(host)
  })
})
