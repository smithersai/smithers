import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { afterAll, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Trellis } from "@smthrs/patterns"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DelegateWork, envelope, leafNodesFor, main, plan, RunPlan } from "../../examples/33-delegation-trellis.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("builds one leaf step per plan leaf", () => {
  expect(leafNodesFor(plan)).toBe(3)
  expect(leafNodesFor({ agent: { goal: "solo" } })).toBe(1)
  expect(envelope).toEqual({ fuel: 4, depth: 3, fanout: 3 })
})

it.effect("runs the authored plan durably, one trampoline round per plan", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "delegation.sqlite"))

    // Round two's graph came from the plan round one authored.
    expect(summary.leafNodes).toBe(3)
    expect(summary.authored).toBe(1)
    // The sequence starts with the outline. Its two parallel leaves may
    // dispatch in either order, each exactly once with its own plan path.
    expect(summary.dispatched[0]).toBe("outline@root.sequence[0]")
    expect(summary.dispatched.slice(1).sort()).toEqual([
      "draft@root.sequence[1].parallel[0]",
      "review@root.sequence[1].parallel[1]"
    ])
    // Outputs come back in plan order.
    expect(summary.result).toEqual(["OUTLINE", "DRAFT", "REVIEW"])
  }))

const executePlan = (authored: Trellis.Plan, work: (leaf: Trellis.Leaf) => Effect.Effect<string>) =>
  Effect.scoped(
    RunPlan.execute({ goal: "test delegation", plan: authored }, { executionId: "admission-test" }).pipe(
      Effect.provide(
        Layer.mergeAll(DelegateWork.toLayer(work), Interpreter.layer(RunPlan)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

it.effect("waits for a delayed outline before starting draft and review", () =>
  Effect.gen(function*() {
    const events: Array<string> = []
    const draftStarted = yield* Deferred.make<void>()
    const reviewStarted = yield* Deferred.make<void>()
    const result = yield* executePlan(plan, ({ goal }) =>
      Effect.gen(function*() {
        events.push(`${goal}:start`)
        if (goal === "outline") {
          for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow
        }
        if (goal === "draft") {
          yield* Deferred.succeed(draftStarted, undefined)
          yield* Deferred.await(reviewStarted)
        }
        if (goal === "review") {
          yield* Deferred.succeed(reviewStarted, undefined)
          yield* Deferred.await(draftStarted)
        }
        events.push(`${goal}:done`)
        return goal.toUpperCase()
      }))
    expect(events.indexOf("draft:start")).toBeGreaterThan(events.indexOf("outline:done"))
    expect(events.indexOf("review:start")).toBeGreaterThan(events.indexOf("outline:done"))
    expect(result).toEqual(["OUTLINE", "DRAFT", "REVIEW"])
  }))

const agent = (goal: string): Trellis.Plan => ({ agent: { goal } })

const rejected: ReadonlyArray<{
  bound: keyof Trellis.Envelope
  code: Trellis.TrellisErrorCode
  path: string
  plan: Trellis.Plan
}> = [
  {
    bound: "fuel",
    code: "fuel_exhausted",
    path: "root",
    plan: { parallel: [{ sequence: [agent("a"), agent("b"), agent("c")] }, { sequence: [agent("d"), agent("e")] }] }
  },
  {
    bound: "depth",
    code: "depth_exceeded",
    path: "root.sequence[0].sequence[0].sequence[0]",
    plan: { sequence: [{ sequence: [{ sequence: [agent("a")] }] }] }
  },
  {
    bound: "fanout",
    code: "fanout_exceeded",
    path: "root",
    plan: { parallel: [agent("a"), agent("b"), agent("c"), agent("d")] }
  }
]

for (const fixture of rejected) {
  it.effect(`refuses only ${fixture.bound} without building or dispatching leaf work`, () =>
    Effect.gen(function*() {
      expect(Trellis.validate(fixture.plan, envelope).map(({ code }) => code)).toEqual([fixture.code])
      // Raising just this bound admits the fixture: no other bound masks it.
      expect(Trellis.validate(fixture.plan, { ...envelope, [fixture.bound]: envelope[fixture.bound] + 1 })).toEqual([])
      expect(leafNodesFor(fixture.plan)).toBe(0)
      const dispatched: Array<string> = []
      const result = yield* executePlan(fixture.plan, ({ goal }) =>
        Effect.sync(() => {
          dispatched.push(goal)
          return goal.toUpperCase()
        }))
      expect(result).toEqual([`refused:${fixture.code}:${fixture.path}`])
      expect(dispatched).toEqual([])
    }))
}

const accepted: ReadonlyArray<{ bound: keyof Trellis.Envelope; plan: Trellis.Plan; goals: ReadonlyArray<string> }> = [
  {
    bound: "fuel",
    plan: { parallel: [{ sequence: [agent("a"), agent("b")] }, { sequence: [agent("c"), agent("d")] }] },
    goals: ["a", "b", "c", "d"]
  },
  { bound: "depth", plan: { sequence: [{ sequence: [agent("a")] }] }, goals: ["a"] },
  { bound: "fanout", plan: { parallel: [agent("a"), agent("b"), agent("c")] }, goals: ["a", "b", "c"] }
]

for (const fixture of accepted) {
  it.effect(`admits exactly the ${fixture.bound} limit and dispatches every leaf once`, () =>
    Effect.gen(function*() {
      expect(Trellis.validate(fixture.plan, envelope)).toEqual([])
      expect(Trellis.validate(fixture.plan, { ...envelope, [fixture.bound]: envelope[fixture.bound] - 1 }))
        .toHaveLength(1)
      expect(leafNodesFor(fixture.plan)).toBe(fixture.goals.length)
      const dispatched: Array<string> = []
      const result = yield* executePlan(fixture.plan, ({ goal }) =>
        Effect.sync(() => {
          dispatched.push(goal)
          return goal.toUpperCase()
        }))
      expect(result).toEqual(fixture.goals.map((goal) => goal.toUpperCase()))
      expect(dispatched.sort()).toEqual([...fixture.goals].sort())
    }))
}
