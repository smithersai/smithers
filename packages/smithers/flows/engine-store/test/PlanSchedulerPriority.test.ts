/**
 * The authoring-to-scheduler path for `Node.priority`.
 *
 * `PlanScheduler.test.ts` already proves the scheduler orders ready work by
 * `NodeDraft.priority`. What it hands the compiler is a hand-written draft, so
 * it cannot tell whether any authoring API reaches that field. This file
 * closes the loop: a flow body annotates two independent action calls, the
 * graph is compiled the way a run compiles it, and the scheduler is driven
 * under a capacity of one.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node, Plan } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "priority-host", pid: 92, nonce: "priority-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "priority-snapshot" as never, changeId: "priority-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const Survey = Action.make("release/survey", {
  payload: { area: Schema.String },
  success: Schema.String
})

const Blocker = Action.make("release/blocker", {
  payload: { area: Schema.String },
  success: Schema.String
})

// Two independent calls, ready in the same pass. The blocker is the one that
// must go first, and only its declared priority says so: `Node.all` fixes no
// order, and declaration order would start the survey.
const Release = Flow.make("release/checks", {
  payload: { area: Schema.String },
  success: Schema.Unknown,
  body: ({ area }) =>
    Node.all({
      survey: Node.priority(Survey.call({ area }), 1),
      blocker: Node.priority(Blocker.call({ area }), 9)
    })
})

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const drafts = () => Graph.drafts(Graph.build(Release, { area: "engine" }))

const nodeIdOf = (suffix: string): string => {
  const id = drafts().map((draft) => draft.id).find((candidate) => candidate.endsWith(suffix))
  expect(id, suffix).toBeDefined()
  return id as string
}

describe("Node.priority reaches the scheduler", () => {
  it.effect("carries an authored priority into the compiled plan", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(
        Plan.compile({ planId: "plan-priority", flow: "release/checks", nodes: drafts() })
      )
      const priorities = Object.fromEntries(plan.nodes.map((node) => [node.id, node.priority]))

      expect(priorities[nodeIdOf(".all.blocker")]).toBe(9)
      expect(priorities[nodeIdOf(".all.survey")]).toBe(1)
      // A node that states none, and encloses none, stays at the default.
      expect(priorities["root"]).toBe(0)
    }))

  it.effect("starts the higher-priority ready node first under a capacity of one", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(
        Plan.compile({ planId: "plan-priority", flow: "release/checks", nodes: drafts() })
      )
      const started: Array<string> = []
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) =>
          Effect.sync(() => {
            started.push(node.id)
            return node.id
          })
      }
      const harness = Layer.mergeAll(
        StepBoundary.layerTest(),
        jjLayer,
        PlanScheduler.layerExecutor(executor)
      )

      yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-authored-priority")
          yield* PlanScheduler.make({
            runId: "run-authored-priority",
            owner,
            sourceId: "scheduler/run-authored-priority",
            concurrency: { steps: 1 }
          }).run(plan)
        }).pipe(Effect.provide(harness), Effect.provide(TestStores.layer()))
      )

      const blocker = started.indexOf(nodeIdOf(".all.blocker"))
      const survey = started.indexOf(nodeIdOf(".all.survey"))
      expect(blocker).toBeGreaterThanOrEqual(0)
      expect(blocker).toBeLessThan(survey)
    }))
})
