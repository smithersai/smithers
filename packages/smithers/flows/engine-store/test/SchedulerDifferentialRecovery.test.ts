import { Journal } from "@smthrs/journal"
import { PlanStore } from "@smthrs/plan-store"
import { Effect, Fiber, Latch, Option } from "effect"
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

describe("differential scheduler recovery through independent SQLite openings", () => {
  for (const strategy of ["delay-rebase", "stop-merge"] as const) {
    for (const resume of ["base", "grown"] as const) {
      it(`${strategy}, resume from ${resume}, preserves keys, stopped meaning and generation identity`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "scheduler-differential-"))
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
            const filename = join(directory, reference ? "reference.sqlite" : "indexed.sqlite")
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
          await rm(directory, { recursive: true, force: true })
        }
      })
    }
  }
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
        }).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.scoped)
      )
    const expected = await drive(true)
    expect(await drive(false)).toEqual(expected)
    expect(expected.trace.slice(-3)).toEqual(["finish:slow", "start:waiting-agent", "finish:waiting-agent"])
  })
})
