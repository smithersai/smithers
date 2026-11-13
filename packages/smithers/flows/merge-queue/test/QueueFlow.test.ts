import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Config, State } from "../src/index.ts"
import { empty, QueueFlow, sameTree, strip } from "../src/index.ts"
import type { Script, World } from "./support/World.ts"
import { makeWorld, statusesOf } from "./support/World.ts"

const config: Config = { required: [1, 2], maxAttempts: 2, maxBatch: 4, maxRuns: 2, window: 5, defaultDuration: 60 }

const start = { config, state: empty, cursor: 0, closed: false, ended: [], settled: 0, round: 0, lineage: 1_000 }

const threeIsBroken: Script = {
  failing: (entry) => entry.id === 3 && entry.rev === 0 ? [2] : [],
  fix: () => ({ _tag: "fixed" })
}

/** How every change ended, from the record; the final state holds no ended change. */
const statuses = (world: World, state: State): Readonly<Record<number, string>> => {
  expect(state.changes).toEqual([])
  return statusesOf(world, { state })
}

/** The queue flow over an engine and a world. */
const queue = (world: World, engine: Layer.Layer<any, any, any>) =>
  Layer.mergeAll(QueueFlow.layer, Interpreter.layer(QueueFlow.Queue)).pipe(
    Layer.provideMerge(world.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(engine)
  ) as Layer.Layer<any, never, never>

const memory = Layer.provideMerge(FlowEngine.layerMemory, NodeCrypto.layer)

/** Runs one lineage of the queue from a start value, as one run on its own engine. */
const lineage = (
  world: World,
  engine: Layer.Layer<any, any, any>,
  executionId: string,
  from: typeof QueueFlow.Payload.Type
) =>
  QueueFlow.Queue.execute(from, { executionId }).pipe(
    Effect.provide(queue(world, engine)),
    Effect.scoped
  ) as Effect.Effect<typeof QueueFlow.End.Type, unknown>

/**
 * Runs the queue to its end in one lineage and gives its final state, or
 * interrupts it (as a host that dies) after `dieAfter` milliseconds.
 */
const run = (world: World, engine: Layer.Layer<any, any, any>, executionId: string, dieAfter?: number) =>
  Effect.runPromiseExit(
    Effect.map(lineage(world, engine, executionId, start), (end): State => {
      expect(end.done).toBe(true)
      return end.position.state
    }).pipe(dieAfter === undefined ? (effect) => effect : Effect.timeout(dieAfter))
  )

/**
 * A host: runs lineage after lineage, each a new run on a new engine with an
 * empty store, starting each from the position the one before handed over,
 * until the queue is done. Gives every lineage's end.
 */
const host = async (world: World, rounds: number, poke?: (lineages: number) => void) => {
  const ends: Array<typeof QueueFlow.End.Type> = []
  let from: typeof QueueFlow.Payload.Type = { ...start, lineage: rounds }
  for (let lineages = 0; lineages < 400; lineages++) {
    poke?.(lineages)
    const end = await Effect.runPromise(lineage(world, memory, `lineage-${lineages}`, from))
    ends.push(end)
    // What the host is handed is what the run returned, and it survives as JSON.
    expect(world.handovers.at(-1)).toEqual({ done: end.done, position: end.position })
    from = Schema.decodeUnknownSync(QueueFlow.Payload)(JSON.parse(JSON.stringify(world.handovers.at(-1)!.position)))
    if (end.done) return ends
  }
  throw new Error("not done in 400 lineages")
}

const expectSound = (world: World): void => {
  for (let index = 1; index < world.targets.length; index++) {
    expect(strip(world.targets[index - 1]!, world.targets[index]!)).toBeDefined()
  }
  for (const tree of world.pushed) expect(world.passes(tree)).toBe(true)
}

const directory = mkdtempSync(join(tmpdir(), "merge-queue-flow-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe("the queue as a durable flow", () => {
  it("runs round after round until every change has ended, and succeeds with the final state", async () => {
    const world = makeWorld(config, threeIsBroken)
    for (const id of [1, 2, 3, 4]) world.enqueue(id)
    world.close()
    const exit = await run(world, memory, "queue-1")
    expect(Exit.isSuccess(exit)).toBe(true)
    const state = Exit.isSuccess(exit) ? exit.value : empty
    expect(statuses(world, state)).toEqual({ 1: "merged", 2: "merged", 3: "merged", 4: "merged" })
    // Nothing is left in the queue: every part on the target is settled and the state's tree is empty.
    expect([state.main, world.settled()]).toEqual([[], world.targets.at(-1)!.length])
    expect(world.endings.map((ending) => [ending.id, ending.rev, ending.status._tag]).sort()).toEqual([
      [1, 0, "merged"],
      [2, 0, "merged"],
      [3, 1, "merged"],
      [4, 0, "merged"]
    ])
    expectSound(world)
  })

  it("keeps going when someone else pushes to the target while it runs", async () => {
    const world = makeWorld(config)
    world.foreign(900)
    world.enqueue(1)
    world.close()
    const exit = await run(world, memory, "queue-2")
    const state = Exit.isSuccess(exit) ? exit.value : empty
    expect(state.main).toEqual([])
    expect(world.targets.at(-1)!.map((entry) => entry.id)).toEqual([900, 1])
    expectSound(world)
  })

  it("retries a round while a service is down, and lands once it is back", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    world.failNext("ci", 3)
    const exit = await run(world, memory, "queue-retry")
    expect(Exit.isSuccess(exit) && statuses(world, exit.value)).toEqual({ 1: "merged" })
    expectSound(world)
  })

  it("a new engine over the same store resumes from the recorded position and repeats no landing", async () => {
    const file = join(directory, "resume.db")
    const world = makeWorld(config, threeIsBroken)
    for (const id of [1, 2, 3]) world.enqueue(id)
    world.close()
    // The target is down, so rounds fail and are retried; then the first host dies.
    world.failNext("target", 1_000_000)
    const first = await run(world, TestNodeRuntime.durableEngine(file, "host-a"), "queue-3", 1500)
    expect(Exit.isFailure(first)).toBe(true)
    expect(world.pushed).toEqual([])
    world.failNext("target", 0)
    const second = await run(world, TestNodeRuntime.durableEngine(file, "host-b"), "queue-3")
    expect(Exit.isSuccess(second)).toBe(true)
    const state = Exit.isSuccess(second) ? second.value : empty
    expect(statuses(world, state)).toEqual({ 1: "merged", 2: "merged", 3: "merged" })
    expect(new Set(world.pushed.map((tree) => JSON.stringify(tree))).size).toBe(world.pushed.length)
    expect(world.endings.map((ending) => ending.id).sort()).toEqual([1, 2, 3])
    expectSound(world)
  })
})

describe("a lineage is bounded and hands its position over", () => {
  /** Eight changes: 3 fails until fixed once, 5 is hopeless, 7 is withdrawn, 6 jumps the order. */
  const script: Script = {
    failing: (entry) => (entry.id === 3 && entry.rev === 0) || entry.id === 5 ? [2] : [],
    fix: (brief) => brief.id === 5 ? { _tag: "gaveUp", detail: "redo it" } : { _tag: "fixed" }
  }
  const intake = (world: World): void => {
    for (const id of [1, 2, 3, 4, 5]) world.enqueue(id)
    world.enqueue(6, 5)
    world.enqueue(7)
    world.withdraw(7)
    world.foreign(900)
    world.enqueue(8)
    world.close()
  }

  it("the same intake gives the same decisions in one lineage and across hand-overs, with nothing lost or twice", async () => {
    const whole = makeWorld(config, script)
    intake(whole)
    const [only] = await host(whole, 1_000)
    expect(whole.handovers).toHaveLength(1)

    for (const rounds of [1, 2, 3, 5]) {
      const world = makeWorld(config, script)
      intake(world)
      const ends = await host(world, rounds)
      const context = `lineages of ${rounds} rounds`
      expect(ends.length, context).toBeGreaterThan(1)
      expect(ends.slice(0, -1).every((end) => !end.done && end.position.round === 0), context).toBe(true)
      // The same record of endings, in the same order, each change once.
      expect(world.endings, context).toEqual(whole.endings)
      expect(new Set(world.endings.map((ending) => ending.id)).size, context).toBe(world.endings.length)
      // The same target history, the same pushes, the same CI runs and fix briefs: no decision moved.
      expect(world.targets, context).toEqual(whole.targets)
      expect(world.pushed, context).toEqual(whole.pushed)
      expect(world.log, context).toEqual(whole.log)
      expect(ends.at(-1)!.position, context).toEqual({ ...only!.position, lineage: rounds })
      expectSound(world)
    }
  })

  it("a lineage ends after exactly its rounds, and an ending its last round made is recorded by the next lineage", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    // One round per lineage: every round's outcome crosses a hand-over.
    const ends = await host(world, 1)
    expect(ends.slice(0, -1).every((end) => !end.done && end.position.round === 0 && end.position.lineage === 1))
      .toBe(true)
    expect(world.handovers).toHaveLength(ends.length)
    // One lineage ended change 1 in its only round and handed the ending on; the next one recorded it,
    // and the queue was not done before that.
    const ending = ends.findIndex((end) => end.position.ended.length > 0)
    expect(ending).toBeGreaterThanOrEqual(0)
    expect(ends[ending]!.done).toBe(false)
    expect(ends[ending]!.position.ended.map((entry) => [entry.id, entry.status._tag])).toEqual([[1, "merged"]])
    expect(ends.at(-1)).toMatchObject({ done: true, position: { ended: [], state: { changes: [] } } })
    expect(world.endings.map((entry) => entry.id)).toEqual([1])
    expect(world.pushed).toHaveLength(1)
  })

  it("takes changes handed in while the host is between two lineages", async () => {
    const world = makeWorld(config, script)
    world.enqueue(1)
    const ends = await host(world, 2, (lineages) => {
      if (lineages === 1) { for (const id of [2, 3]) world.enqueue(id) }
      if (lineages === 2) world.close()
    })
    expect(ends.at(-1)!.done).toBe(true)
    expect(world.endings.map((ending) => [ending.id, ending.rev, ending.status._tag]).sort()).toEqual([
      [1, 0, "merged"],
      [2, 0, "merged"],
      [3, 1, "merged"]
    ])
    expectSound(world)
  })

  it("retries the round, deciding nothing twice, while the hand-over cannot be saved", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    world.failNext("handover", 2)
    const end = await Effect.runPromise(lineage(world, memory, "handover-down", { ...start, lineage: 1_000 }))
    expect(end.done).toBe(true)
    expect(world.handovers).toEqual([{ done: true, position: end.position }])
    expect(world.pushed).toHaveLength(1)
    expect(world.endings.map((ending) => ending.id)).toEqual([1])
  })

  it("refuses a start value whose lineage has no rounds", () => {
    expect(() => Schema.decodeUnknownSync(QueueFlow.Payload)({ ...start, lineage: 0 })).toThrow()
    expect(QueueFlow.lineageRounds).toBe(200)
  })
})
