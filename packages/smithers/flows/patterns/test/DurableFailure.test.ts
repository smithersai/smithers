/**
 * Declared patterns on the real durable engine, with members that fail with a
 * tagged error.
 *
 * The in-memory engine hands a settlement back as the value it is. The durable
 * engine encodes it first: a typed failure through the flow's error schema and
 * a success through its success schema, and `Schema.Unknown` encodes JSON data
 * only. A `Schema.TaggedError` is a class instance, so a pattern that declares
 * `Schema.Unknown` for its error, or that puts a caught member error into the
 * value it settles with, dies with `UnencodableResult` here while the same
 * case is green on the memory engine. Every case below therefore runs under
 * `EngineStore` over SQLite.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as CheckSuite from "../src/CheckSuite.ts"
import * as Debate from "../src/Debate.vibe"
import * as DriftDetector from "../src/DriftDetector.vibe"
import * as Escalation from "../src/Escalation.vibe"
import * as Kanban from "../src/Kanban.ts"
import * as MapReduce from "../src/MapReduce.ts"
import * as MergeQueue from "../src/MergeQueue.ts"
import * as Optimizer from "../src/Optimizer.ts"
import * as Panel from "../src/Panel.ts"
import { PatternError } from "../src/PatternError.ts"
import * as Recursion from "../src/Recursion.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as Saga from "../src/Saga.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.ts"
import * as Sidecar from "../src/Sidecar.ts"
import * as Supervisor from "../src/Supervisor.ts"
import type { Executable } from "./Execute.ts"
import { fields } from "./Parity.ts"

/** What a member fails with: the repository's idiom, a tagged error class. */
class Declined extends Schema.TaggedError<Declined>()("durable-failure/Declined", { step: Schema.String }) {}

/** The same failure as the JSON data its schema encodes it to. */
const wire = (step: string) => ({ _tag: "durable-failure/Declined", step })

/** A role that fails with `Declined`, named after itself. */
const declines = (step: string) => () => new Declined({ step })

/** A role's answer from its payload; a `Declined` answer fails the member. */
type Script = Readonly<Record<string, (payload: any) => unknown>>

const member = (role: string) =>
  Action.make(`durable-failure/${role}`, { payload: fields, success: Schema.Unknown, error: Declined })

type Members = Readonly<Record<string, ReturnType<typeof member>>>

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "durable-failure", changeId: "durable-failure" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** How one declared pattern settled: with a value, or with a typed failure. */
type Settled = { readonly succeeded: unknown } | { readonly failed: unknown }

let executions = 0

/**
 * Settles the pattern `declare` builds over the roles in `script`, on the
 * durable engine. A settlement the engine could not encode is a defect, which
 * rejects the promise and fails the case.
 */
const settle = (script: Script, declare: (members: Members) => Executable, payload: unknown): Promise<Settled> => {
  const members: Members = Object.fromEntries(Object.keys(script).map((role) => [role, member(role)]))
  const flow = declare(members)
  const implementations = Object.entries(script).map(([role, answer]) =>
    members[role]!.toLayer((handed) =>
      Effect.suspend(() => {
        const value = answer(handed)
        return value instanceof Declined ? Effect.fail(value) : Effect.succeed(value)
      })
    )
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "durable-failure" },
          journalSource: "durable-failure-test",
          isAlive: () => Effect.succeed(false)
        })
        const context = yield* Layer.build(
          Layer.mergeAll(
            Interpreter.layer(flow as never),
            ...(implementations as unknown as [Layer.Layer<any, any, any>])
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
          ) as Layer.Layer<any, never, any>
        )
        return yield* flow.execute(payload, { executionId: `durable-failure-${++executions}` }).pipe(
          Effect.provideContext(context),
          Effect.match({
            onFailure: (failed): Settled => ({ failed }),
            onSuccess: (succeeded): Settled => ({ succeeded })
          })
        )
      })
    ).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:")),
      Effect.provide(NodeCrypto.layer)
    ) as Effect.Effect<Settled, never, never>
  )
}

const saga = (onFailure: Saga.OnFailure) => (m: Members) =>
  Saga.make({
    steps: [
      { id: "a", action: m.a!, compensation: m.undoA! },
      { id: "b", action: m.b!, compensation: m.undoB! }
    ],
    onFailure
  })

const sagaScript = (undoFails: boolean): Script => ({
  a: () => "a-done",
  b: declines("b"),
  undoA: undoFails ? declines("undoA") : () => "a-undone",
  undoB: () => "b-undone"
})

const tasks = [{ id: "a", workerType: "coder" }]

const supervisor = (m: Members) =>
  Supervisor.make({
    plan: m.plan!,
    workers: { coder: m.coder! },
    review: m.review!,
    finalize: m.finalize!,
    maxRounds: 1,
    maxTasks: 4,
    concurrency: 1
  })

const supervisorScript: Script = {
  plan: () => ({ tasks }),
  coder: declines("coder"),
  review: ({ results }) => ({ allDone: true, saw: results }),
  finalize: ({ results, review }) => ({ results, review })
}

interface Case {
  readonly name: string
  readonly script: Script
  readonly declare: (members: Members) => Executable
  readonly payload?: unknown
}

/** A member's tagged error is what the declared pattern fails with. */
const propagating: ReadonlyArray<Case & { readonly step: string }> = [
  {
    name: "Saga under compensate-and-fail",
    script: sagaScript(false),
    declare: saga("compensate-and-fail"),
    step: "b"
  },
  { name: "Saga under fail", script: sagaScript(false), declare: saga("fail"), step: "b" },
  {
    name: "ReviewLoop",
    script: { produce: declines("produce"), review: () => true, revise: () => "draft" },
    declare: (m) => ReviewLoop.make({ produce: m.produce!, review: m.review!, revise: m.revise!, maxRounds: 1 }),
    step: "produce"
  },
  {
    name: "Sidecar, on its primary",
    script: { primary: declines("primary"), shadow: () => "shadow" },
    declare: (m) => Sidecar.make({ primary: m.primary!, shadow: m.shadow! }),
    payload: { input: { prompt: "x" } },
    step: "primary"
  },
  {
    name: "Supervisor, on its plan",
    script: { ...supervisorScript, plan: declines("plan") },
    declare: supervisor,
    payload: { input: { tasks } },
    step: "plan"
  },
  {
    name: "Panel",
    script: { a: () => "a", b: declines("b"), moderator: () => "summary" },
    declare: (m) => Panel.make({ panelists: { a: m.a!, b: m.b! }, moderator: m.moderator! }),
    payload: { input: { prompt: "x" } },
    step: "b"
  },
  {
    name: "Recursion",
    script: { child: declines("child") },
    declare: (m) => Recursion.recurse({ child: m.child!, fuel: 1, depth: 1, fanout: 1 }),
    step: "child"
  },
  {
    name: "ScanFixVerify",
    script: { scan: declines("scan"), fix: () => "fixed", verify: () => true },
    declare: (m) =>
      ScanFixVerify.make({
        scan: m.scan!,
        fix: m.fix!,
        verify: m.verify!,
        maxRetries: 1,
        maxIssues: 1,
        concurrency: 1
      }),
    step: "scan"
  },
  {
    name: "Debate",
    script: { proponent: declines("proponent"), opponent: () => "o", judge: () => "verdict" },
    declare: (m) => Debate.make({ proponent: m.proponent!, opponent: m.opponent!, judge: m.judge!, rounds: 1 }),
    step: "proponent"
  },
  {
    name: "CheckSuite that stops at the first failure",
    script: { lint: declines("lint") },
    declare: (m) =>
      CheckSuite.make({ checks: { lint: m.lint! }, concurrency: 1, strategy: "all-pass", continueOnFail: false }),
    step: "lint"
  },
  {
    name: "discovered CheckSuite that stops at the first failure",
    script: { check: declines("check") },
    declare: (m) =>
      CheckSuite.makeDiscovered({
        check: m.check!,
        concurrency: 1,
        strategy: "all-pass",
        continueOnFail: false,
        onEmpty: "fail"
      }),
    payload: { checks: ["lint"], input: "head" },
    step: "check"
  },
  {
    name: "Escalation",
    script: { cheap: declines("cheap"), strong: () => "strong" },
    declare: (m) => Escalation.make({ rungs: [m.cheap!, m.strong!] }),
    step: "cheap"
  },
  {
    name: "DriftDetector",
    script: { capture: declines("capture"), compare: () => ({ drifted: false }) },
    declare: (m) => DriftDetector.make({ capture: m.capture!, compare: m.compare!, baseline: { version: 1 } }),
    step: "capture"
  },
  {
    name: "MapReduce",
    script: { map: declines("map"), reduce: () => "reduced" },
    declare: (m) => MapReduce.make({ map: m.map!, reduce: m.reduce!, concurrency: 1, onEmpty: "fail" }),
    payload: { shards: [1] },
    step: "map"
  },
  {
    name: "Kanban, on its completion call",
    script: { build: () => "built", done: declines("done") },
    declare: (m) =>
      Kanban.make({
        columns: [{ name: "build", flow: m.build! }],
        items: [{ id: "a" }],
        concurrency: 1,
        onComplete: m.done!
      }),
    step: "done"
  },
  {
    name: "MergeQueue under halt",
    script: { m1: declines("m1") },
    declare: (m) => MergeQueue.make({ members: [{ id: "m1", flow: m.m1! }], concurrency: 1, failurePolicy: "halt" }),
    step: "m1"
  },
  {
    name: "Optimizer",
    script: { generate: declines("generate"), evaluate: () => ({ score: 1 }) },
    declare: (m) => Optimizer.make({ generate: m.generate!, evaluate: m.evaluate!, maxIterations: 1 }),
    step: "generate"
  }
]

/** A recovery arm caught the member's error and the pattern settles with it as data. */
const recovering: ReadonlyArray<Case & { readonly succeeded: unknown }> = [
  {
    name: "Saga that unwinds cleanly",
    script: sagaScript(false),
    declare: saga("compensate"),
    succeeded: { _tag: "Compensated", failure: wire("b") }
  },
  {
    name: "Sidecar whose shadow fails",
    script: { primary: () => "primary", shadow: declines("shadow") },
    declare: (m) => Sidecar.make({ primary: m.primary!, shadow: m.shadow! }),
    payload: { input: { prompt: "x" } },
    succeeded: { primary: "primary", shadow: { quarantined: true, error: wire("shadow") } }
  },
  {
    name: "Supervisor whose worker fails",
    script: supervisorScript,
    declare: supervisor,
    payload: { input: { tasks } },
    succeeded: (() => {
      const results = [{ _tag: "Failed", id: "a", workerType: "coder", round: 1, error: wire("coder") }]
      return { exhausted: false, rounds: 1, final: { results, review: { allDone: true, saw: results } } }
    })()
  },
  {
    name: "CheckSuite that continues past a failure",
    script: { lint: declines("lint") },
    declare: (m) =>
      CheckSuite.make({ checks: { lint: m.lint! }, concurrency: 1, strategy: "all-pass", continueOnFail: true }),
    succeeded: { passed: [], failed: ["lint"], errors: { lint: wire("lint") }, strategy: "all-pass", verdict: false }
  },
  {
    name: "discovered CheckSuite that continues past a failure",
    script: { check: declines("check") },
    declare: (m) =>
      CheckSuite.makeDiscovered({
        check: m.check!,
        concurrency: 1,
        strategy: "all-pass",
        continueOnFail: true,
        onEmpty: "fail"
      }),
    payload: { checks: ["lint"], input: "head" },
    succeeded: { passed: [], failed: ["lint"], errors: { lint: wire("check") }, strategy: "all-pass", verdict: false }
  },
  {
    name: "Kanban whose column fails an item",
    script: { build: declines("build") },
    declare: (m) => Kanban.make({ columns: [{ name: "build", flow: m.build! }], items: [{ id: "a" }], concurrency: 1 }),
    succeeded: { board: {}, completed: [], failed: [{ id: "a", column: "build", error: wire("build") }], iterations: 1 }
  },
  {
    name: "MergeQueue under quarantine",
    script: { m1: declines("m1") },
    declare: (m) =>
      MergeQueue.make({ members: [{ id: "m1", flow: m.m1! }], concurrency: 1, failurePolicy: "quarantine" }),
    succeeded: { landed: [], quarantined: [{ id: "m1", error: wire("m1") }], order: ["m1"] }
  }
]

describe("declared patterns on the durable engine", () => {
  describe("fail with the tagged error a member failed with", () => {
    for (const scenario of propagating) {
      it(scenario.name, async () => {
        const settled = await settle(scenario.script, scenario.declare, scenario.payload ?? { input: "order" })
        expect(settled).toEqual({ failed: new Declined({ step: scenario.step }) })
        expect((settled as { readonly failed: unknown }).failed).toBeInstanceOf(Declined)
      })
    }
  })

  describe("settle with a caught member error as the data its schema encodes", () => {
    for (const scenario of recovering) {
      it(scenario.name, async () => {
        expect(await settle(scenario.script, scenario.declare, scenario.payload ?? { input: "order" }))
          .toEqual({ succeeded: scenario.succeeded })
      })
    }
  })

  it("fails a saga whose compensation also failed with a PatternError that names both failures as data", async () => {
    const settled = await settle(sagaScript(true), saga("compensate"), { input: "order" })
    const { failed } = settled as { readonly failed: PatternError }
    expect(failed).toBeInstanceOf(PatternError)
    expect(failed).toMatchObject({
      code: "compensation_failed",
      message: "Saga compensation failed for: a",
      cause: { failure: wire("b"), residue: [{ id: "a", error: wire("undoA") }] }
    })
  })

  it("fails with the pattern's own PatternError", async () => {
    const settled = await settle(
      { generate: () => "candidate", evaluate: () => ({ score: 0 }) },
      (m) =>
        Optimizer.make({
          generate: m.generate!,
          evaluate: m.evaluate!,
          targetScore: 1,
          maxIterations: 1,
          onMaxReached: "fail"
        }),
      { input: "order" }
    )
    const { failed } = settled as { readonly failed: PatternError }
    expect(failed).toBeInstanceOf(PatternError)
    expect(failed).toMatchObject({ code: "exhausted" })
  })
})
