import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { RunStore } from "@smthrs/run-store"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { expect } from "vitest"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as Selection from "../src/Selection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import * as Reference from "./PlanSchedulerReference.ts"
import { runPromise, sha256 } from "./Sha256.ts"

export const draft = (
  id: string,
  dependencies: ReadonlyArray<string> = [],
  options: Partial<Plan.NodeDraft> = {}
): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: dependencies.map((from, i) =>
      i % 2 === 0 ? { _tag: "Ref", from, path: ["value"] } : { _tag: "Pending", from }
    ),
    layers: [],
    capabilities: []
  },
  effects: { reads: [], writes: [`${id}.out`], boundaryMode: "hard" },
  ...options
})

export const compile = (nodes: ReadonlyArray<Plan.NodeDraft>) =>
  runPromise(Plan.compile({ planId: "differential", flow: "diff", nodes }))
export const owner = { hostId: "differential", pid: 93, nonce: "differential" }
export const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const claimed = yield* runs.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1)
    expect(claimed._tag).toBe("Activated")
  })

export interface Scenario {
  readonly plan: Plan.Plan
  readonly concurrency?: PlanScheduler.Options["concurrency"]
  readonly fail?: ReadonlySet<string>
  readonly conflicts?: ReadonlyMap<string, number>
  readonly defer?: ReadonlySet<string>
  readonly deviation?: "Fail" | "Reorder" | "FactorOut"
  readonly reorder?: ReadonlyArray<string>
  readonly changed?: Plan.Plan
  readonly suffix?: ReadonlyArray<Plan.NodeDraft>
  readonly replay?: boolean
  readonly interleave?: boolean
}

export const runtime = (executor: PlanScheduler.Executor) =>
  Layer.mergeAll(
    PlanScheduler.layerExecutor(executor),
    Reference.layerExecutor(executor),
    boundary(false),
    Layer.succeed(
      Jj.Jj,
      Jj.make({
        snapshot: () => Effect.succeed({ changeId: "differential" as never }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    )
  )

// Protocol-shaped output evidence makes the fixture valid under replay-path
// authorization too. Only expected boundaries deliberately deviate.
const boundary = (deviate: boolean) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
      settle: ({ descriptor }) =>
        Effect.succeed({
          declaredOutputs: { outputs: descriptor.writeSet.map((path) => ({ path, digest: sha256(String(path)) })) },
          diffIdentity: "differential",
          wholeTreeWritesVerified: true,
          hermeticReadsVerified: true,
          ...(deviate && descriptor.boundaryMode === "expected"
            ? {
              deviation: {
                _tag: "ExpectedSetDeviation" as const,
                paths: ["undeclared.out"],
                diffIdentity: "differential"
              }
            }
            : {})
        }),
      replayOutputs: () => Effect.void
    })
  )

export const drive = (scenario: Scenario, reference: boolean) => {
  const implementation = reference ? Reference : PlanScheduler
  const executed: Array<{ nodeId: string; attempt: number; boundary: unknown; inputs: unknown }> = []
  const selections: Array<Selection.Input> = []
  const executor: PlanScheduler.Executor = {
    execute: ({ attempt, boundary, inputs, node }) =>
      Effect.gen(function*() {
        executed.push({ nodeId: node.id, attempt, boundary, inputs })
        if (scenario.interleave) {
          for (let i = 0; i <= node.id.length % 3; i++) yield* Effect.yieldNow
        }
        if (attempt <= (scenario.conflicts?.get(node.id) ?? 0)) {
          return yield* Effect.fail(
            new WorkspaceSandbox.MaterializationConflict({ paths: ["shared.out"], message: "controlled" })
          )
        }
        if (scenario.fail?.has(node.id)) return yield* Effect.fail({ node: node.id, reason: "controlled" })
        return { value: node.id, merge: node.kind === "merge" ? node.material.body : null }
      })
  }
  const selection = Selection.layer({
    select: (input) =>
      Effect.sync(() => {
        selections.push(input)
        return input.sinks.map(({ nodeId }) => ({
          nodeId,
          verdict: scenario.defer?.has(nodeId)
            ? {
              _tag: "Defer" as const,
              likelihood: 0,
              edge: { scope: "**", affects: nodeId, confidence: 0, validFromMs: 0, evidence: [] }
            }
            : { _tag: "Admit" as const }
        }))
      })
  })
  const reconciliation = Reconciliation.layer({
    onConflict: Reconciliation.makeDefault().onConflict,
    onDeviation: (deviation) =>
      Effect.succeed(
        scenario.deviation === "Reorder"
          ? { _tag: "Reorder", dependsOn: scenario.reorder ?? [], reason: "controlled" }
          : scenario.deviation === "FactorOut"
          ? { _tag: "FactorOut", paths: deviation.paths, reason: "controlled" }
          : { _tag: "Fail", reason: "controlled" }
      )
  })
  return runPromise(
    Effect.gen(function*() {
      const reports: Array<PlanScheduler.Report> = []
      const topologies: Array<Plan.Plan> = []
      const plans = yield* PlanStore.PlanStore
      yield* activate("diff-1")
      const scheduler = implementation.make({
        runId: "diff-1",
        owner,
        sourceId: "diff",
        concurrency: scenario.concurrency,
        rebaseLimit: 2
      })
      yield* scheduler.record(scenario.plan)
      reports.push(yield* scheduler.run(scenario.plan))
      topologies.push(Option.getOrThrow(yield* plans.get(scenario.plan.planId)))
      if (scenario.replay) reports.push(yield* scheduler.run(scenario.plan))
      if (scenario.suffix) {
        const grown = yield* Plan.append(topologies[0]!, scenario.suffix)
        yield* scheduler.append(grown)
        reports.push(yield* scheduler.run(grown))
        topologies.push(Option.getOrThrow(yield* plans.get(scenario.plan.planId)))
      }
      if (scenario.changed) {
        yield* activate("diff-2")
        reports.push(
          yield* implementation.make({ runId: "diff-2", owner, sourceId: "diff", concurrency: scenario.concurrency })
            .run(scenario.changed)
        )
      }
      const journal = yield* Journal.Journal
      const records: Array<{ type: string; payload: unknown }> = []
      for (const runId of scenario.changed ? ["diff-1", "diff-2"] : ["diff-1"]) {
        let cursor: number | undefined
        while (true) {
          const page = yield* journal.entries({
            runId: runId as never,
            limit: 512,
            ...(cursor === undefined ? {} : { after: cursor as never })
          })
          for (const event of page.entries) {
            if (/flows\.engine\.(node-|selection-|subgraph-appended|plan-recorded)/.test(event.eventType)) {
              records.push({ type: event.eventType, payload: event.payload })
            }
            cursor = event.seq
          }
          if (!page.hasMore) break
        }
      }
      const sql = yield* SqlClient.SqlClient
      const attempts =
        yield* sql`SELECT run_id, step_key_digest, attempt, state FROM flows_attempts ORDER BY run_id, step_key_digest, attempt`
      const cache = yield* sql`SELECT key_digest FROM flows_step_cache ORDER BY key_digest`
      return { reports, topologies, executed, selections, records, attempts, cache }
    }).pipe(
      Effect.provide(selection),
      Effect.provide(reconciliation),
      Effect.provide(boundary(scenario.deviation !== undefined)),
      Effect.provide(runtime(executor)),
      Effect.provide(TestStores.layerAt(":memory:")),
      Effect.scoped
    )
  )
}
