import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.vibe"
import * as Catalog from "../src/Catalog.vibe"
import type * as Event from "../src/Event.vibe"
import * as Steering from "../src/Steering.vibe"
import { failChain, flow, runChain } from "./harness.ts"

const doneScript = flow(`return done("ok")`)

const withQueue = <A>(
  layer: Layer.Layer<Steering.Steering>,
  use: (steering: Steering.Service) => Effect.Effect<A, Steering.SteeringError>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Steering.Steering, use).pipe(Effect.provide(layer), Effect.orDie)
  )

describe("Steering", () => {
  it("admits and drains everything, once", async () => {
    const drained = await withQueue(Steering.layerMemory(), (steering) =>
      Effect.gen(function*() {
        yield* steering.admit("first")
        yield* steering.admit("second")
        const all = yield* steering.drain("0/0")
        const after = yield* steering.drain("0/1")
        return { after, all }
      }))
    expect(drained.all).toEqual(["first", "second"])
    expect(drained.after).toEqual([])
  })

  it("seeds from initial messages", async () => {
    const drained = await withQueue(Steering.layerMemory(["seeded"]), (steering) => steering.drain("0/0"))
    expect(drained).toEqual(["seeded"])
  })

  it("snapshots a caller-owned seed array when the layer is constructed", async () => {
    const seed = ["a"]
    const layer = Steering.layerMemory(seed)
    seed.push("b")

    const drained = await withQueue(layer, (steering) => steering.drain("0/0"))
    expect(drained).toEqual(["a"])
  })

  it("fails as noop and accepts overrides", async () => {
    const noop = Steering.makeNoop()
    const admitError = await Effect.runPromise(Effect.flip(noop.admit("x")))
    expect(admitError.code).toBe("steering_unavailable")
    const drainError = await Effect.runPromise(Effect.flip(noop.drain("0/0")))
    expect(drainError.message).toBe("drain is unavailable")
    const overridden = Steering.makeNoop({ drain: () => Effect.succeed(["canned"]) })
    expect(await Effect.runPromise(overridden.drain("0/0"))).toEqual(["canned"])
    const viaLayer = await Effect.runPromise(
      Effect.flip(Effect.flatMap(Steering.Steering, (steering) => steering.drain("0/0"))).pipe(
        Effect.provide(Steering.layerNoop()),
        Effect.orDie
      )
    )
    expect(viaLayer.code).toBe("steering_unavailable")
  })

  it("promotes queued steering into the bootstrap author context", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const { events, outcome } = await runChain({
      author,
      steering: Steering.layerMemory(["ship it today"])
    })
    expect(outcome).toEqual({ _tag: "Done", value: "ok" })
    expect(seen[0]?.context).toEqual(["fix TODOs", "[steering] ship it today"])
    const drain = events.find((event) => event._tag === "SteeringDrained") as Event.SteeringDrained
    expect(drain).toMatchObject({ link: 0, messages: ["ship it today"], ordinal: 0 })
  })

  it("delivers steering admitted mid-run to the next author call", async () => {
    const queue: Array<string> = []
    const boundaries: Array<string> = []
    const steering = Steering.make({
      admit: (message) =>
        Effect.sync(() => {
          queue.push(message)
        }),
      drain: (boundary) =>
        Effect.sync(() => {
          boundaries.push(boundary)
          return queue.splice(0)
        })
    })
    const seen: Array<Author.Input> = []
    const relay = flow(
      `await ctx.call("interrupt", {})`,
      `const s = await ctx.call("author", { context: ["carrying on"] })`,
      `return to(s)`
    )
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? relay : doneScript
    })
    const interrupt: Catalog.Entry = {
      description: "admits steering mid-link, like a user typing",
      handler: () =>
        Effect.sync(() => {
          queue.push("stop and reconsider")
          return null
        }),
      name: "interrupt"
    }
    const { events, outcome } = await runChain({
      author,
      entries: [interrupt],
      steering: Layer.succeed(Steering.Steering)(steering)
    })
    expect(outcome).toEqual({ _tag: "Done", value: "ok" })
    expect(seen[1]?.context).toEqual(["carrying on", "[steering] stop and reconsider"])
    const drains = events.filter((event) => event._tag === "SteeringDrained") as Array<Event.SteeringDrained>
    expect(drains).toHaveLength(1)
    expect(drains[0]).toMatchObject({ link: 1, messages: ["stop and reconsider"] })
    expect(boundaries).toEqual(["0/0", "1/1"])
  })

  it("carries drained steering into the retry after a rejected author attempt", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? "no fence at all" : doneScript
    })
    const { events, outcome } = await runChain({
      author,
      steering: Steering.layerMemory(["urgent: change of plan"])
    })
    expect(outcome).toEqual({ _tag: "Done", value: "ok" })
    // The first attempt drained the line and was shape-rejected; the retry
    // must still see it.
    expect(seen[0]?.context).toContain("[steering] urgent: change of plan")
    expect(seen[1]?.context).toContain("[steering] urgent: change of plan")
    expect(events.filter((event) => event._tag === "SteeringDrained")).toHaveLength(1)
  })

  it("reuses a recorded drain on re-execution instead of draining live", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const initial: ReadonlyArray<Event.Event> = [
      { _tag: "ChainStarted", envelope: null, goal: "fix TODOs" },
      { _tag: "SteeringDrained", link: 0, messages: ["recorded line"], ordinal: 0 }
    ]
    const { events, outcome } = await runChain({
      author,
      initial,
      steering: Steering.layerMemory(["should not surface"])
    })
    expect(outcome).toEqual({ _tag: "Done", value: "ok" })
    expect(seen[0]?.context).toEqual(["fix TODOs", "[steering] recorded line"])
    expect(events.filter((event) => event._tag === "SteeringDrained")).toHaveLength(1)
  })

  it("journals nothing for an empty queue and none for steering-free chains", async () => {
    const empty = await runChain({
      author: Author.layerMock([doneScript]),
      steering: Steering.layerMemory()
    })
    expect(empty.events.some((event) => event._tag === "SteeringDrained")).toBe(false)
    const absent = await runChain({ author: Author.layerMock([doneScript]) })
    expect(absent.events.some((event) => event._tag === "SteeringDrained")).toBe(false)
  })

  it("propagates a failing steering port as its typed error", async () => {
    const error = await failChain({
      author: Author.layerMock([doneScript]),
      steering: Steering.layerNoop()
    }) as { _tag: string; message: string }
    expect(error._tag).toBe("/chain/SteeringError")
    expect(error.message).toBe("drain is unavailable")
  })
})
