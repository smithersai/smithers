/**
 * Steering at safe turn boundaries: what a queue may promote, what a drain
 * carries, and what a resumed run replays instead of draining again. See
 * `../docs/concepts.md#notification-queue`.
 */
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Cause, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { HarnessError } from "../src/HarnessError.ts"
import * as Steering from "../src/Steering.ts"

describe("Steering", () => {
  it("keeps an item admitted after the close cutoff for the next turn", () => {
    const before = Steering.enqueue(Steering.empty(), {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: 1,
      message: ModelRequest.Message.user("before")
    })
    const queue = Steering.enqueue(before, {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: 2,
      message: ModelRequest.Message.user("after")
    })
    const drained = Steering.drainAtClose(queue, 1)
    expect(drained.inserts).toEqual([ModelRequest.Message.user("before")])
    expect(drained.remaining.items).toHaveLength(1)
    expect(Steering.drainAtClose(drained.remaining, 2).inserts).toEqual([ModelRequest.Message.user("after")])
  })

  it("preserves FIFO insertion order at close", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("one")
      }),
      {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("two")
      }
    )
    expect(Steering.drainAtClose(queue, 1).inserts).toEqual([
      ModelRequest.Message.user("one"),
      ModelRequest.Message.user("two")
    ])
  })

  it("surfaces seat and thinking changes only in the next frame snapshot", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "SeatChange",
        delivery: "steer",
        admittedAt: 3,
        seat: "sdk:fast"
      }),
      { _tag: "ThinkingChange", delivery: "steer", admittedAt: 3, thinking: "high" }
    )
    expect(Steering.drainAtClose(queue, 2).seatChanges).toEqual([])
    expect(Steering.drainAtClose(queue, 3).seatChanges).toEqual([
      { _tag: "SeatChange", delivery: "steer", admittedAt: 3, seat: "sdk:fast" },
      { _tag: "ThinkingChange", delivery: "steer", admittedAt: 3, thinking: "high" }
    ])
  })

  it("returns immutable serializable values", () => {
    const queue = Steering.enqueue(Steering.empty(), {
      _tag: "SeatChange",
      delivery: "steer",
      admittedAt: 1,
      seat: "sdk:fast"
    })
    expect(Object.isFrozen(queue)).toBe(true)
    expect(Object.isFrozen(queue.items)).toBe(true)
    expect(JSON.parse(JSON.stringify(queue))).toEqual({
      items: [{ _tag: "SeatChange", delivery: "steer", admittedAt: 1, seat: "sdk:fast" }]
    })
    expect(Steering.empty().items).toEqual([])
  })

  it("keeps queue-class inserts out of the immutable steer cutoff", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("steer")
      }),
      {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 1,
        message: ModelRequest.Message.user("queued")
      }
    )
    const drained = Steering.drainAtClose(queue, 1)

    expect(drained.inserts).toEqual([ModelRequest.Message.user("steer")])
    expect(drained.remaining.items).toEqual([
      {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 1,
        message: ModelRequest.Message.user("queued")
      }
    ])
    expect(Object.isFrozen(drained.remaining)).toBe(true)
    expect(Object.isFrozen(drained.remaining.items)).toBe(true)
    expect(queue.items).toHaveLength(2)
  })

  it.each([false, true])("promotes follow-ups only at an idle boundary (%s)", (wouldIdle) => {
    const items: ReadonlyArray<Steering.Insert> = [
      { _tag: "Insert", delivery: "queue", admittedAt: 1, message: ModelRequest.Message.user("first") },
      { _tag: "Insert", delivery: "steer", admittedAt: 2, message: ModelRequest.Message.user("second") },
      { _tag: "Insert", delivery: "queue", admittedAt: 2, message: ModelRequest.Message.user("at cutoff") },
      { _tag: "Insert", delivery: "queue", admittedAt: 3, message: ModelRequest.Message.user("later") }
    ]
    const queue = items.reduce(Steering.enqueue, Steering.empty())
    const drained = Steering.drainAtClose(queue, 2, wouldIdle)
    expect(drained.inserts).toEqual(wouldIdle ? items.slice(0, 3).map((item) => item.message) : [items[1]!.message])
    expect(drained.remaining.items).toEqual(wouldIdle ? [items[3]] : [items[0], items[2], items[3]])
    expect(Steering.drainAtClose(drained.remaining, 3, true).inserts).toEqual(
      (wouldIdle ? [items[3]!] : [items[0]!, items[2]!, items[3]!]).map((item) => item.message)
    )
    expect(queue.items).toEqual(items)
    expect(Object.isFrozen(drained.inserts)).toBe(true)
    expect(Object.isFrozen(drained.remaining.items)).toBe(true)
  })

  it("drains an empty queue into an empty result", () => {
    const drained = Steering.drainAtClose(Steering.empty(), 0)

    expect(drained).toEqual({
      inserts: [],
      seatChanges: [],
      remaining: Steering.empty(),
      duplicate: false
    })
    expect(Object.isFrozen(drained.inserts)).toBe(true)
    expect(Object.isFrozen(drained.seatChanges)).toBe(true)
  })

  it("admits an item at exactly the cutoff and holds the one after it", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 0,
        message: ModelRequest.Message.user("at zero")
      }),
      {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("one past zero")
      }
    )

    expect(Steering.drainAtClose(queue, 0).inserts).toEqual([ModelRequest.Message.user("at zero")])
    expect(Steering.drainAtClose(queue, -1).inserts).toEqual([])
    expect(Steering.drainAtClose(queue, -1).remaining.items).toHaveLength(2)
    expect(Steering.drainAtClose(queue, 1).inserts).toHaveLength(2)
  })

  it("drains one item of every kind in a single close", () => {
    const queue = [
      { _tag: "Insert", delivery: "steer", admittedAt: 5, message: ModelRequest.Message.user("now") },
      { _tag: "SeatChange", delivery: "steer", admittedAt: 5, seat: "sdk:fast" },
      { _tag: "ThinkingChange", delivery: "steer", admittedAt: 5, thinking: "low" },
      { _tag: "Insert", delivery: "queue", admittedAt: 5, message: ModelRequest.Message.user("later") },
      { _tag: "SeatChange", delivery: "steer", admittedAt: 6, seat: "sdk:slow" }
    ].reduce<Steering.Queue>(
      (accumulated, item) => Steering.enqueue(accumulated, item as Steering.Item),
      Steering.empty()
    )

    const drained = Steering.drainAtClose(queue, 5)

    expect(drained.inserts).toEqual([ModelRequest.Message.user("now")])
    expect(drained.seatChanges.map((change) => change._tag)).toEqual(["SeatChange", "ThinkingChange"])

    // Everything held back keeps its FIFO order for the next close.
    expect(drained.remaining.items.map((item) => item._tag)).toEqual(["Insert", "SeatChange"])
  })

  it("freezes every enqueued item without touching the caller's object", () => {
    const item = { _tag: "SeatChange", delivery: "steer", admittedAt: 1, seat: "sdk:fast" } as const
    const queue = Steering.enqueue(Steering.empty(), item)

    expect(Object.isFrozen(queue.items[0])).toBe(true)
    expect(Object.isFrozen(item)).toBe(false)
  })

  it("journals every folded value and deliberately drops the host's remaining queue", () => {
    const drain: Steering.Drain = {
      inserts: [ModelRequest.Message.user("steer")],
      seatChanges: [
        { _tag: "SeatChange", delivery: "steer", admittedAt: 1, seat: "sdk:fast" },
        { _tag: "ThinkingChange", delivery: "steer", admittedAt: 1, thinking: "high" }
      ],
      remaining: Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 2,
        message: ModelRequest.Message.user("queued")
      }),
      duplicate: false
    }

    const record = Steering.drainRecord(drain)

    // The retired provider-tool loop's `activatedToolNames` is gone from the
    // record. A journal written before it was retired always carried it empty,
    // and still decodes: the extra key is dropped, not refused.
    expect(Schema.decodeUnknownSync(Steering.DrainRecord)({ ...record, queued: true })).toEqual({
      ...record,
      queued: true
    })
    expect(Object.keys(record).sort()).toEqual(["inserts", "seatChanges"])
    expect(
      Schema.decodeUnknownSync(Steering.DrainRecord)({
        ...Schema.encodeSync(Steering.DrainRecord)(record),
        activatedToolNames: []
      })
    ).toEqual(record)
    expect(
      Schema.decodeUnknownSync(Steering.DrainRecord)(Schema.encodeSync(Steering.DrainRecord)(record))
    ).toEqual(record)
  })
})

describe("Steering.Source", () => {
  it("reads an empty queue and drains nothing from the noop source", async () => {
    const source = Steering.makeNoop()

    const [queue, drained] = await Effect.runPromise(
      Effect.all([source.read(), source.drain({ boundary: "turn-1", wouldIdle: true })])
    )

    expect(queue.items).toEqual([])
    expect(drained).toEqual({
      inserts: [],
      seatChanges: [],
      remaining: Steering.empty(),
      duplicate: false
    })
  })

  it("replaces only the overridden method of the noop source", async () => {
    const queue = Steering.enqueue(Steering.empty(), {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: 1,
      message: ModelRequest.Message.user("pending")
    })
    const source = Steering.makeNoop({ read: () => Effect.succeed(queue) })

    const [read, drained] = await Effect.runPromise(
      Effect.all([source.read(), source.drain({ boundary: "turn-1", wouldIdle: false })])
    )

    expect(read).toStrictEqual(queue)
    expect(drained.inserts).toEqual([])
  })

  it("provides a live source and an empty one through their layers", async () => {
    const boundaries: Array<Steering.BoundaryInput> = []
    const live = Steering.layer({
      read: () => Effect.succeed(Steering.empty()),
      drain: (input) =>
        Effect.sync(() => {
          boundaries.push(input)
          return {
            inserts: [ModelRequest.Message.user("from the host")],
            seatChanges: [],
            remaining: Steering.empty(),
            duplicate: false
          }
        })
    })
    const drainAt = (input: Steering.BoundaryInput) =>
      Effect.gen(function*() {
        const source = yield* Steering.Source
        return yield* source.drain(input)
      })

    const [fromHost, fromNoop, fromOverride] = await Effect.runPromise(
      Effect.all([
        drainAt({ boundary: "turn-1", wouldIdle: false }).pipe(Effect.provide(live)),
        drainAt({ boundary: "turn-2", wouldIdle: true }).pipe(Effect.provide(Steering.layerNoop())),
        drainAt({ boundary: "turn-3", wouldIdle: true }).pipe(
          Effect.provide(
            Steering.layerNoop({
              drain: () =>
                Effect.succeed({
                  inserts: [],
                  seatChanges: [],
                  remaining: Steering.empty(),
                  duplicate: true
                })
            })
          )
        )
      ])
    )

    expect(boundaries).toEqual([{ boundary: "turn-1", wouldIdle: false }])
    expect(fromHost.inserts).toEqual([ModelRequest.Message.user("from the host")])
    expect(fromNoop.inserts).toEqual([])
    expect(fromOverride.duplicate).toBe(true)
  })

  it("lets a failing source refuse in the typed channel", async () => {
    const unavailable = new HarnessError({ code: "engine_failed", message: "the queue is unreachable" })
    const source = Steering.make({
      read: () => Effect.fail(unavailable),
      drain: () => Effect.fail(unavailable)
    })

    const [readExit, drainExit] = await Promise.all([
      Effect.runPromiseExit(source.read()),
      Effect.runPromiseExit(source.drain({ boundary: "turn-1", wouldIdle: false }))
    ])

    expect(Exit.isFailure(readExit) ? Cause.squash(readExit.cause) : undefined).toBe(unavailable)
    expect(Exit.isFailure(drainExit) ? Cause.squash(drainExit.cause) : undefined).toBe(unavailable)
  })
  describe("time left", () => {
    const steer = ModelRequest.Message.user("steer: prefer the shorter route")
    const source = Steering.make({
      read: () => Effect.succeed(Steering.empty()),
      drain: () =>
        Effect.succeed({
          inserts: [steer],
          seatChanges: [],
          remaining: Steering.empty(),
          duplicate: false
        })
    })
    const paced = Steering.withTimeLeft(source, { startedAt: 0, budgetMs: 40 * 60_000 })
    const drainAt = (elapsed: Parameters<typeof TestClock.adjust>[0], input: Steering.BoundaryInput) =>
      Effect.runPromise(
        Effect.gen(function*() {
          yield* TestClock.adjust(elapsed)
          return yield* paced.drain(input)
        }).pipe(Effect.provide(TestClock.layer()))
      )

    it("says the whole minutes left of the budget, and says to finish in the last one", () => {
      expect(Steering.timeLeft(40 * 60_000, 40 * 60_000)).toBe("Time left: 40 of your 40 minutes.")
      expect(Steering.timeLeft(12 * 60_000 + 59_999, 40 * 60_000)).toBe("Time left: 12 of your 40 minutes.")
      expect(Steering.timeLeft(59_999, 40 * 60_000)).toBe(
        "Time left: under a minute of your 40 minutes. Finish now, or the run ends with nothing."
      )
      expect(Steering.timeLeft(-5_000, 30_000)).toBe(
        "Time left: under a minute of your 1 minute. Finish now, or the run ends with nothing."
      )
    })

    it("notes the time left at a boundary the run continues through, after the source's own notes", async () => {
      const drained = await drainAt("15 minutes", { boundary: "1:close", wouldIdle: false })
      expect(drained.inserts).toEqual([steer])
      expect(drained.notes).toEqual([ModelRequest.Message.user("Time left: 25 of your 40 minutes.")])
      // A note is journaled with the drain, apart from the person's inserts.
      expect(Steering.drainRecord(drained)).toMatchObject({
        inserts: [steer],
        notes: [ModelRequest.Message.user("Time left: 25 of your 40 minutes.")]
      })
      const noted = Steering.withTimeLeft(
        Steering.make({
          read: source.read,
          drain: () => Effect.map(source.drain({ boundary: "x", wouldIdle: false }), (d) => ({ ...d, notes: [steer] }))
        }),
        { startedAt: 0, budgetMs: 60_000 }
      )
      const both = await Effect.runPromise(
        noted.drain({ boundary: "1:close", wouldIdle: false }).pipe(Effect.provide(TestClock.layer()))
      )
      expect(both.notes).toEqual([steer, ModelRequest.Message.user("Time left: 1 of your 1 minute.")])
    })

    it("adds nothing at a boundary that would idle or parks, so a note never answers a park", async () => {
      const idle = await drainAt("1 minute", { boundary: "2:close", wouldIdle: true })
      const parked = await drainAt("1 minute", {
        boundary: "2:park:0",
        wouldIdle: true,
        park: { reason: "waiting-input", message: "Which branch?" }
      })
      const parkedLive = await drainAt("1 minute", {
        boundary: "2:park:1",
        wouldIdle: false,
        park: { reason: "waiting-input", message: "Which branch?" }
      })
      for (const drained of [idle, parked, parkedLive]) {
        expect(drained.notes).toBeUndefined()
        expect(drained.inserts).toEqual([steer])
      }
      expect(Steering.drainRecord(idle)).not.toHaveProperty("notes")
    })

    it("reads through to the source's queue", async () => {
      expect(await Effect.runPromise(paced.read())).toEqual(Steering.empty())
    })
  })
})
