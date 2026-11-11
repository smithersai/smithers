import { describe, expect, test } from "bun:test"
import { CaseExecutor, Runner, Suite } from "@smthrs/evals"
import { Effect, Layer } from "effect"
import { layerMemory } from "./host.ts"
import { executor, makeExecutor, suite } from "./review-seeded-bugs.eval.ts"
import { scriptedSeats } from "./scriptedSeats.ts"

const runOptions = { runId: "review-seeded-bugs-adapter", at: "2026-01-01T00:00:00.000Z" } as const

/** The declared suite narrowed to one clean control, so one fixture is reviewed. */
async function cleanControl(): Promise<Suite.Suite> {
  const declared = await Effect.runPromise(suite)
  const control = declared.cases.find((entry) => entry.name === "clean-refactor")
  if (control === undefined) throw new Error("the corpus has no clean-refactor control")
  return Effect.runPromise(
    Suite.make({ name: declared.name, concurrency: 1, bindings: declared.bindings, cases: [control] })
  )
}

/** Runs the narrowed suite through the evals runner with the given adapter. */
function runWith(adapter: CaseExecutor.Service, narrowed: Suite.Suite): Promise<Runner.RunResult> {
  return Effect.runPromise(
    Runner.run(narrowed, runOptions).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(adapter)))
  )
}

describe("the fixed-suite adapter", () => {
  test("a clean control whose review failed is a lost execution, not a perfect score", async () => {
    // Every seat refuses, so every file review fails and the review ends
    // `failed` with no comments: the same comments a finished clean review has.
    const refusing = makeExecutor(layerMemory(scriptedSeats(() => undefined), {}))
    const result = await runWith(refusing, await cleanControl())

    expect(result.cases).toHaveLength(1)
    expect(result.cases[0].execution).toBeUndefined()
    expect(result.cases[0].error).toMatchObject({ code: "executor", path: "cases['clean-refactor']" })
    expect(result.cases[0].error?.message).toContain("ended failed")
    expect(result.observations).toEqual([])
  }, 120_000)

  test("a finished clean review scores its findings", async () => {
    const result = await runWith(executor, await cleanControl())

    expect(result.cases[0].error).toBeUndefined()
    expect(result.cases[0].execution).toMatchObject({ output: [], stepKey: "review-seeded-bugs/clean-refactor" })
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ case: "clean-refactor", kind: "score", score: 1 })
  }, 120_000)
})
