import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { Effect, Exit, Fiber, Latch, Option, Scope } from "effect"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import * as Reference from "./PlanSchedulerReference.ts"
import { activate, compile, draft, owner, runtime } from "./SchedulerDifferentialHarness.ts"
import { runPromise } from "./Sha256.ts"

describe("differential scheduler recovery through independent store openings", () => {
  for (const strategy of ["delay-rebase", "stop-merge"] as const) {
    for (const resume of ["base", "grown"] as const) {
      it(`${strategy}, resume from ${resume}, preserves keys, stopped meaning and generation identity`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "scheduler-differential-"))
        const filenames: Array<string> = []
        try {
          const effects = { reads: [], writes: ["shared.out"], boundaryMode: "hard" as const }
          const plan = await compile([
            draft("winner", [], { effects, conflictStrategy: "lane", runtimeStrategy: strategy }),
            draft("loser", [], { effects, conflictStrategy: "lane", runtimeStrategy: strategy }),
            draft("consumer", ["loser"]),
            draft("loser+merge"),
            draft("unrelated")
          ])
          const drive = async (reference: boolean) => {
            const filename = TestStores.matrixFilename(
              join(directory, reference ? "reference.sqlite" : "indexed.sqlite")
            )
            filenames.push(filename)
            const implementation = reference ? Reference : PlanScheduler
            const calls: Array<string> = []
            const executor: PlanScheduler.Executor = {
              execute: ({ attempt, node }) =>
                Effect.suspend(() => {
                  calls.push(`${node.id}/${attempt}`)
                  if (node.id === "loser" && attempt === 1) {
                    return Effect.fail(
                      new WorkspaceSandbox.MaterializationConflict({ paths: ["shared.out"], message: "controlled" })
                    )
                  }
                  return Effect.succeed({ value: node.id })
                })
            }
            const service = () =>
              implementation.make({ runId: "reopen", owner, sourceId: "reopen", concurrency: { steps: 1 } })
            const first = await runPromise(
              Effect.gen(function*() {
                yield* activate("reopen")
                const scheduler = service()
                yield* scheduler.record(plan)
                return yield* scheduler.run(plan)
              }).pipe(Effect.provide(runtime(executor)), Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
            )
            const initialCalls = [...calls]
            const recovered = []
            for (let reopening = 0; reopening < 2; reopening++) {
              recovered.push(
                await runPromise(
                  Effect.gen(function*() {
                    const plans = yield* PlanStore.PlanStore
                    const loaded = Option.getOrThrow(yield* plans.get(plan.planId))
                    const report = yield* service().run(resume === "base" ? plan : loaded)
                    return { report, plan: Option.getOrThrow(yield* plans.get(plan.planId)) }
                  }).pipe(
                    Effect.provide(runtime(executor)),
                    Effect.provide(TestStores.layerAt(filename)),
                    Effect.scoped
                  )
                )
              )
            }
            expect(calls).toEqual(initialCalls)
            for (const { report } of recovered) {
              expect(report.results).toEqual(first.results)
              expect(report.appended).toEqual([])
              expect(report.settlements.map((node) => node.dispatchKey)).toEqual(
                first.settlements.map((node) => node.dispatchKey)
              )
              expect(report.settlements.find((node) => node.nodeId === "loser")!.outcome).toBe(
                strategy === "stop-merge" ? "skipped" : "clean"
              )
            }
            return { first, recovered, calls }
          }
          const expected = await drive(true)
          expect(await drive(false)).toEqual(expected)
        } finally {
          for (const filename of filenames) await runPromise(TestStores.dropMatrixFilename(filename))
          await rm(directory, { recursive: true, force: true })
        }
      })
    }
  }
})

describe("differential recovery of an interrupted plan", () => {
  it("replays the settled prefix and resumes the in-flight node under its original attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scheduler-interrupted-"))
    const filenames: Array<string> = []
    try {
      const plan = await compile([draft("winner"), draft("loser", ["winner"]), draft("consumer", ["loser"])])
      const flow = Flow.make("SchedulerRecovery/Test", {
        payload: {},
        success: Schema.Void,
        body: () => Node.succeed(undefined)
      })
      const drive = async (reference: boolean) => {
        const implementation = reference ? Reference : PlanScheduler
        const filename = TestStores.matrixFilename(join(directory, reference ? "reference.sqlite" : "indexed.sqlite"))
        filenames.push(filename)
        const calls: Array<string> = []
        const service = () =>
          implementation.make({
            runId: "interrupted",
            owner,
            sourceId: "interrupted",
            concurrency: { steps: 1 }
          })
        const first = await runPromise(
          Effect.gen(function*() {
            yield* activate("interrupted")
            const started = yield* Latch.make()
            const release = yield* Latch.make()
            const instance = yield* Effect.acquireRelease(
              Effect.sync(() => FlowEngine.makeInstance(flow, "interrupted")),
              (instance) => Scope.close(instance.scope, Exit.void)
            )
            const executor: PlanScheduler.Executor = {
              execute: ({ attempt, node }) =>
                Effect.gen(function*() {
                  calls.push(`${node.id}/${attempt}`)
                  if (node.id === "loser") {
                    yield* Latch.open(started)
                    yield* Latch.await(release)
                  }
                  return { value: node.id }
                })
            }
            const scheduler = service()
            yield* scheduler.record(plan)
            const running = yield* scheduler.run(plan).pipe(
              Effect.provide(runtime(executor)),
              Effect.provideService(FlowRuntime.FlowInstance, instance),
              Effect.forkChild({ startImmediately: true })
            )
            yield* Latch.await(started)
            const sql = yield* SqlClient.SqlClient
            const before =
              yield* sql`SELECT step_key_digest, attempt, state FROM flows_attempts ORDER BY step_key_digest`
            expect(before.map((row) => row.state).sort()).toEqual(["running", "succeeded"])
            const journal = yield* Journal.Journal
            const page = yield* journal.entries({ runId: "interrupted" as never, limit: 100 })
            expect(
              page.entries.filter((event) => event.eventType === "flows.engine.node-settled")
                .map((event) => (event.payload as { nodeId: string }).nodeId)
            ).toEqual(["winner"])
            // Closing this incarnation must leave the unfinished attempt recoverable.
            yield* Fiber.interrupt(running)
            const interrupted = yield* Fiber.await(running)
            expect(Exit.isFailure(interrupted)).toBe(true)
            expect(calls).toEqual(["winner/1", "loser/1"])
            const after =
              yield* sql`SELECT step_key_digest, attempt, state FROM flows_attempts ORDER BY step_key_digest`
            expect(after).toEqual(before)
            return before
          }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
        )

        const recovered = await runPromise(
          Effect.gen(function*() {
            const plans = yield* PlanStore.PlanStore
            const loaded = Option.getOrThrow(yield* plans.get(plan.planId))
            const executor: PlanScheduler.Executor = {
              execute: ({ attempt, node }) =>
                Effect.sync(() => {
                  calls.push(`${node.id}/${attempt}`)
                  return { value: node.id }
                })
            }
            const scheduler = service()
            const report = yield* scheduler.run(loaded).pipe(Effect.provide(runtime(executor)))
            const replay = yield* scheduler.run(loaded).pipe(Effect.provide(runtime(executor)))
            const sql = yield* SqlClient.SqlClient
            const attempts =
              yield* sql`SELECT step_key_digest, attempt, state FROM flows_attempts ORDER BY step_key_digest`
            const journal = yield* Journal.Journal
            const page = yield* journal.entries({ runId: "interrupted" as never, limit: 100 })
            const settled = page.entries.filter((event) => event.eventType === "flows.engine.node-settled")
              .map((event) => event.payload)
            return { report, replay, attempts, settled }
          }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
        )
        expect(calls).toEqual(["winner/1", "loser/1", "loser/1", "consumer/1"])
        expect(recovered.attempts).toHaveLength(3)
        expect(recovered.attempts.every((row) => row.attempt === 1 && row.state === "succeeded")).toBe(true)
        // Replay emits observations again; the durable attempt and actual body
        // calls above establish that no additional work was admitted.
        expect([...new Set(recovered.settled.map((event) => (event as { nodeId: string }).nodeId))])
          .toEqual(["winner", "loser", "consumer"])
        for (const report of [recovered.report, recovered.replay]) {
          expect(report.settlements.map((node) => node.nodeId)).toEqual(["winner", "loser", "consumer"])
        }
        return { first, recovered, calls }
      }
      expect(await drive(false)).toEqual(await drive(true))
    } finally {
      for (const filename of filenames) await runPromise(TestStores.dropMatrixFilename(filename))
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("differential admission under explicitly gated completions", () => {
  it("releases the fast dependent while an agent holds its permit, then admits the waiting agent", async () => {
    const plan = await compile([
      draft("slow", [], { kind: "agent", priority: 3 }),
      draft("fast", [], { priority: 2 }),
      draft("waiting-agent", [], { kind: "agent", priority: 1 }),
      draft("dependent", ["fast"])
    ])
    const drive = (reference: boolean) =>
      runPromise(
        Effect.gen(function*() {
          const implementation = reference ? Reference : PlanScheduler
          const release = yield* Latch.make()
          const slowStarted = yield* Latch.make()
          const trace: Array<string> = []
          const executor: PlanScheduler.Executor = {
            execute: ({ node }) =>
              Effect.gen(function*() {
                trace.push(`start:${node.id}`)
                if (node.id === "slow") {
                  yield* Latch.open(slowStarted)
                  yield* Latch.await(release)
                } else if (node.id === "fast") yield* Latch.await(slowStarted)
                trace.push(`finish:${node.id}`)
                return { value: node.id }
              })
          }
          yield* activate("gated")
          const scheduler = implementation.make({
            runId: "gated",
            owner,
            sourceId: "gated",
            concurrency: { steps: 2, agents: 1 }
          })
          const running = yield* scheduler.run(plan).pipe(
            Effect.provide(runtime(executor)),
            Effect.forkChild({ startImmediately: true })
          )
          const journal = yield* Journal.Journal
          let seen = false
          for (let pass = 0; pass < 1000; pass++) {
            const page = yield* journal.entries({ runId: "gated" as never, limit: 100 })
            seen = page.entries.some((event) =>
              event.eventType === "flows.engine.node-settled" &&
              (event.payload as { nodeId: string }).nodeId === "dependent"
            )
            if (seen) break
            yield* Effect.yieldNow
          }
          expect(seen).toBe(true)
          expect(trace).toEqual(["start:slow", "start:fast", "finish:fast", "start:dependent", "finish:dependent"])
          yield* Latch.open(release)
          const report = yield* Fiber.join(running)
          const page = yield* journal.entries({ runId: "gated" as never, limit: 100 })
          return {
            trace,
            report,
            scheduled: page.entries.filter((event) => event.eventType === "flows.engine.node-scheduled").map((event) =>
              event.payload
            )
          }
        }).pipe(Effect.provide(TestStores.matrixLayer()), Effect.scoped)
      )
    const expected = await drive(true)
    expect(await drive(false)).toEqual(expected)
    expect(expected.trace.slice(-3)).toEqual(["finish:slow", "start:waiting-agent", "finish:waiting-agent"])
  })
})
