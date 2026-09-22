import { describe, it } from "@effect/vitest"
import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { expect } from "vitest"
import { ModelLike } from "../src/ModelLike.ts"
import * as Plan from "../src/Plan.ts"
import { expectPlan, expectPure } from "../src/PlanAssertions.ts"
import { CapabilityContractError } from "../src/TestingError.ts"
import * as TestLayers from "../src/TestLayers.ts"

/** The defect a poisoned capability raises, or `undefined` when it did not. */
const defect = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

const reviewer = Action.make("recorded:reviewer", {
  payload: Schema.Struct({ pr: Schema.Number, reviewer: Schema.String }),
  success: Schema.String,
  tier: "sealed"
}).annotate(Flow.EffectsDeclaration, {
  reads: ["workspace/pr.json"],
  writes: ["workspace/review.json"],
  boundaryMode: "hard"
})

const review = Flow.make("review", {
  payload: Schema.Struct({
    pr: Schema.Number,
    reviewer: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("recorded:reviewer")))
  }),
  success: Schema.String,
  effects: {
    reads: ["workspace/pr.json"],
    writes: ["workspace/review.json"],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  },
  body: (payload) => reviewer.call({ pr: payload.pr, reviewer: payload.reviewer })
})

describe("plan purity", () => {
  it.effect("computes a plan under poisoned layers without touching Host or Model", () =>
    Effect.gen(function*() {
      // planOf decodes input first: the un-defaulted `reviewer` field cannot
      // reach the plan, so its key already hashes the defaulted value.
      const plan = yield* expectPure(Plan.planOf(review, { pr: 4821 }))
      const defaulted = yield* expectPure(Plan.planOf(review, { pr: 4821, reviewer: "recorded:reviewer" }))
      expect(Plan.render(plan)).toBe(Plan.render(defaulted))
      yield* expectPlan(plan).contains("root")
      yield* expectPlan(plan).node("root").tier("sealed")
      const root = Plan.node(plan, "root")
      expect(root?.key).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(root?.sealed).toBe(true)
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("rejects un-decodable input before any plan exists", () =>
    Effect.gen(function*() {
      const result = yield* Plan.planOf(review, { pr: "not-a-number" }).pipe(Effect.flip)
      expect(result._tag).toBe("SchemaError")
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("fails typed when a plan computation reaches a capability", () =>
    Effect.gen(function*() {
      // A hypothetical impure planner that consults the filesystem: under the
      // poisoned bundle the capability raises a typed defect, and expectPure
      // surfaces it as a purity violation instead of a plan.
      const impure = Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return yield* fs.readFileString("/workspace/pr.json")
      }).pipe(Effect.map(() => Plan.fromGraph(Graph.build(Node.succeed("ok")))))
      const raised = defect(yield* Effect.exit(impure))
      expect(raised).toBeInstanceOf(CapabilityContractError)
      expect((raised as CapabilityContractError).capability).toBe("filesystem")
      expect((raised as CapabilityContractError).operation).toBe("readFileString")
      const violation = yield* expectPure(impure).pipe(Effect.flip)
      expect(violation._tag).toBe("PlanAssertionError")
      expect(violation.code).toBe("purity_violation")
      expect(violation.actual).toBeInstanceOf(CapabilityContractError)
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("keeps the poisoned bundle typed for host services", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* spawner.spawn(ChildProcess.make("ls", { shell: true }))
      })))
      expect(defect(exit)).toBeInstanceOf(CapabilityContractError)
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("rejects a data-property read as loudly as a method call", () =>
    Effect.gen(function*() {
      // `Path.sep` is a data property. A proxy that answered every read with a
      // function let this succeed with a function value, so code that
      // interpolated the separator produced garbage and the purity gate saw
      // nothing.
      const path = yield* Path.Path
      const raised = defect(
        yield* Effect.exit(Effect.gen(function*() {
          return path.sep
        }))
      )
      expect(raised).toBeInstanceOf(CapabilityContractError)
      expect((raised as CapabilityContractError).operation).toBe("sep")
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("a fallback-shaped catch cannot launder a poisoned capability into purity", () =>
    Effect.gen(function*() {
      // The recoverable catch is the shape ordinary fallback code is written
      // in. It must not rescue a capability violation, or `expectPure` reports
      // a plan that touched the host as pure.
      const rescued = yield* Effect.exit(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* fs.readFileString("/workspace/pr.json")
        }).pipe(Effect.catch(() => Effect.succeed("fallback")))
      )
      expect(defect(rescued)).toBeInstanceOf(CapabilityContractError)
      const violation = yield* expectPure(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* fs.readFileString("/workspace/pr.json")
        }).pipe(Effect.catch(() => Effect.succeed("fallback")))
      ).pipe(Effect.flip)
      expect(violation.code).toBe("purity_violation")
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("dies rather than fails when a plan reaches the model", () =>
    Effect.gen(function*() {
      const model = yield* ModelLike
      const exit = yield* Effect.exit(Stream.runCollect(model.stream({} as never)))
      expect(defect(exit)).toBeInstanceOf(CapabilityContractError)
    }).pipe(Effect.provide(TestLayers.poisoned)))
})
