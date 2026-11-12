import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Config, State } from "../src/index.ts"
import { empty, QueueFlow, sameTree, strip } from "../src/index.ts"
import type { Script, World } from "./support/World.ts"
import { makeWorld } from "./support/World.ts"

const config: Config = { required: [1, 2], maxAttempts: 2, maxBatch: 4, maxRuns: 2, window: 5, defaultDuration: 60 }

const start = { config, state: empty, cursor: 0, closed: false, ended: [], round: 0 }

const threeIsBroken: Script = {
  failing: (entry) => entry.id === 3 && entry.rev === 0 ? [2] : [],
  fix: () => ({ _tag: "fixed" })
}

const statuses = (state: State): Readonly<Record<number, string>> =>
  Object.fromEntries(state.changes.map((change) => [change.id, change.status._tag]))

/** The queue flow over an engine and a world. */
const queue = (world: World, engine: Layer.Layer<any, any, any>) =>
  Layer.mergeAll(QueueFlow.layer, Interpreter.layer(QueueFlow.Queue)).pipe(
    Layer.provideMerge(world.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(engine)
  ) as Layer.Layer<any, never, never>

const memory = Layer.provideMerge(FlowEngine.layerMemory, NodeCrypto.layer)

/** Runs the queue to its end, or interrupts it (as a host that dies) after `dieAfter` milliseconds. */
const run = (world: World, engine: Layer.Layer<any, any, any>, executionId: string, dieAfter?: number) =>
  Effect.runPromiseExit(
    (QueueFlow.Queue.execute(start, { executionId }).pipe(
      Effect.provide(queue(world, engine)),
      Effect.scoped
    ) as Effect.Effect<
      State,
      unknown
    >).pipe(dieAfter === undefined ? (effect) => effect : Effect.timeout(dieAfter))
  )

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
    expect(statuses(state)).toEqual({ 1: "merged", 2: "merged", 3: "merged", 4: "merged" })
    expect(sameTree(state.main, world.targets.at(-1)!)).toBe(true)
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
    expect(state.main.map((entry) => entry.id)).toEqual([900, 1])
    expectSound(world)
  })

  it("retries a round while a service is down, and lands once it is back", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    world.failNext("ci", 3)
    const exit = await run(world, memory, "queue-retry")
    expect(Exit.isSuccess(exit) && statuses(exit.value)).toEqual({ 1: "merged" })
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
    expect(statuses(state)).toEqual({ 1: "merged", 2: "merged", 3: "merged" })
    expect(new Set(world.pushed.map((tree) => JSON.stringify(tree))).size).toBe(world.pushed.length)
    expect(world.endings.map((ending) => ending.id).sort()).toEqual([1, 2, 3])
    expectSound(world)
  })
})
