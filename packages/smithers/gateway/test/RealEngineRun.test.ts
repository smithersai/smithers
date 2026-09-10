/**
 * The read path over a run the durable engine really executed.
 *
 * Every other suite in this package writes the events it folds. This one
 * writes none: it plans, approves, and runs a real `@smthrs/flow` `Flow`
 * through `@smthrs/control`, an executor hands the launch to a real
 * `@smthrs/flows` `NodeRuntime` engine over its own SQLite file, and the
 * assertions below are over what the control plane and the engine each
 * recorded.
 *
 * The last test is the one that decides what `GatewayProjection` may fold: the
 * engine's `flows.engine.*` records exist, and they are in the engine's
 * journal, which no control watch reads.
 *
 * See `RealEngineRun.ts` for the composition and for what is real in it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Control } from "@smthrs/control/Control"
import type { ApprovalPayload, PlanCard, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, type Scope } from "effect"
import type * as GatewayProjection from "../src/GatewayProjection.ts"
import { Projections } from "../src/Projections.ts"
import { Drives, EngineRun, flowId, stack } from "./RealEngineRun.ts"

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

const terminal: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/**
 * The run, once its drive has finished: the terminal status is written AND
 * the `control.run.<status>` record is journaled. Polling the status row
 * would return between those two writes, and the assertions over the journal
 * below would race the executor. A drive that died fails this with its cause.
 */
const settled = (runId: string): Effect.Effect<RunSummary, never, Control | Drives> =>
  Effect.gen(function*() {
    yield* (yield* Drives).settled(runId)
    const control = yield* Control
    const listed = yield* Effect.orDie(control.list({ _tag: "runs", filters: { runId } }))
    const run = listed._tag === "runs" ? listed.items[0] : undefined
    if (run === undefined || !terminal.has(run.status)) {
      return yield* Effect.die(`run ${runId} drive finished but the run is ${run?.status ?? "missing"}`)
    }
    return run
  })

/** Plans, approves, and runs the flow the engine executes; returns its run id. */
const launch = (path: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId, input: { path } })
    yield* control.approve(approvalOf(card))
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${card.planId}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
    return receipt.runId
  })

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, { timeout: 60_000 }, () => Effect.runPromise(Effect.scoped(body())))

describe("the read path over a run the engine executed", () => {
  test("reports a run the engine carried to completion", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch("docs/proof.md")
      const run = yield* settled(runId)
      expect(run.status).toBe("completed")

      const summary = ((yield* projections.snapshot({ _tag: "run-summary", runId }))
        .rows as ReadonlyArray<GatewayProjection.RunSummaryRow>)[0]
      expect(summary?.flowId).toBe(flowId)
      expect(summary?.status).toBe("completed")
      // The verdict reads a status, never an operation name.
      expect(summary?.verdict).toBe("completed")
      expect(summary?.diagnosis).toContain(runId)

      // The lifecycle really reached the client's stream, terminal record
      // included: the executor wrote the status under the run's fence and
      // journaled it, the way `AgentSession.settle` does.
      const events = (yield* projections.snapshot({ _tag: "run-events", runId }))
        .rows as ReadonlyArray<{ readonly kind: string }>
      const kinds = events.map((event) => event.kind)
      expect(kinds).toContain("control.run.accepted")
      expect(kinds).toContain("control.run.running")
      expect(kinds).toContain("control.run.completed")

      const transcript = (yield* projections.snapshot({ _tag: "transcript", runId }))
        .rows as ReadonlyArray<GatewayProjection.TranscriptRow>
      expect(transcript.map((row) => row.text)).toContain("run.completed")
      expect(transcript.every((row) => row.runId === runId)).toBe(true)

      // No agent drove this run, so it has no calls and no node rows. An empty
      // tree is the honest answer: a row here would name work nothing did.
      expect(yield* projections.snapshot({ _tag: "run-tree", runId })).toMatchObject({ rows: [] })
    }).pipe(Effect.provide(stack((path) => Effect.succeed(`wrote ${path}`)))))

  test("reports the run the engine left failed, with the cause it failed on", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch("docs/broken.md")
      const run = yield* settled(runId)
      expect(run.status).toBe("failed")

      const summary = ((yield* projections.snapshot({ _tag: "run-summary", runId }))
        .rows as ReadonlyArray<GatewayProjection.RunSummaryRow>)[0]
      expect(summary?.status).toBe("failed")
      expect(summary?.verdict.startsWith("failed")).toBe(true)
      expect(summary?.diagnosis).toContain("the action refused")
    }).pipe(Effect.provide(stack(() => Effect.die("the action refused")))))

  test("keeps the engine's own records in the engine's journal, where no watch reads them", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const engine = yield* EngineRun
      const runId = yield* launch("docs/partitioned.md")
      yield* settled(runId)

      // The engine journaled the step it ran, under the run's own id.
      const engineKinds = yield* engine.kinds(runId)
      expect(engineKinds).toContain("flows.engine.attempt-started")
      expect(engineKinds).toContain("flows.engine.attempt-finished")
      expect(engineKinds).toContain("flows.engine.run-decision")

      // And a client watching that run sees none of them: the control plane
      // and the engine keep separate databases with separate journals
      // (`@smthrs/cli` `NodeControl.databasePath` and
      // `executionDatabasePath`), and `ControlLive.streamForRun` reads one
      // run's partition of the control journal. This is why the projections
      // fold `control.*` records and nothing else.
      const events = (yield* projections.snapshot({ _tag: "run-events", runId }))
        .rows as ReadonlyArray<{ readonly kind: string }>
      expect(events.length).toBeGreaterThan(0)
      expect(events.filter((event) => event.kind.startsWith("flows."))).toEqual([])
    }).pipe(Effect.provide(stack((path) => Effect.succeed(`wrote ${path}`)))))
})
