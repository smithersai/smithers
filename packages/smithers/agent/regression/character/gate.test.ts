import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { readFileSync } from "node:fs"
import { EvalError } from "../../evals/src/index.ts"
import * as AgentSuite from "../agent.eval.ts"
import { EvalRunHost, program } from "../run.ts"

const baseline = () => readFileSync(new URL("../baseline.json", import.meta.url), "utf8")

// Run the production suite, runner, comparison and scoring. Only the host I/O
// service is injected, so fault tests cannot overwrite the committed baseline.
const run = async (readBaseline: Effect.Effect<string, EvalError.EvalError>) => {
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  let status: number | undefined
  await Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(EvalRunHost)(EvalRunHost.of({
    args: [],
    readBaseline,
    writeBaseline: () => Effect.fail(new EvalError.EvalError({
      code: "invalid_baseline", message: "The test host cannot write a baseline"
    })),
    stdout: (text) => Effect.sync(() => { stdout.push(text) }),
    stderr: (text) => Effect.sync(() => { stderr.push(text) }),
    setExitCode: (code) => Effect.sync(() => { status = code })
  })))))
  return { status, stdout: stdout.join(""), stderr: stderr.join("") }
}

describe("baseline gate", () => {
  test("the committed baseline measures behaviour once per scenario", () => {
    const records = JSON.parse(baseline()).records as Array<{ case: string; scorerName: string }>
    expect(AgentSuite.bindings.map((binding) => binding.scorer.name)).toEqual(["evals/agent/behaviour"])
    expect(records).toHaveLength(AgentSuite.cases.length)
    expect(records.every((record) => record.scorerName === "evals/agent/behaviour")).toBe(true)
    expect(records.map((record) => record.case).sort()).toEqual(AgentSuite.cases.map((c) => c.name).sort())
  })

  test("the behaviour scorer rejects a wrong observation", async () => {
    const scorer = AgentSuite.bindings[0]!.scorer
    const groundTruth = AgentSuite.cases[0]!.expected
    expect((await Effect.runPromise(scorer.score({ input: {}, output: groundTruth, groundTruth }))).score).toBe(1)
    expect((await Effect.runPromise(scorer.score({ input: {}, output: { kind: "failure" }, groundTruth }))).score).toBe(0)
  })

  test("unchanged observations pass", async () => {
    const result = await run(Effect.succeed(baseline()))
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("passed")
  }, 120_000)

  test("score drift is a result (1)", async () => {
    const changed = JSON.parse(baseline())
    changed.records[0].score = 0
    const result = await run(Effect.succeed(JSON.stringify(changed)))
    expect(result.status).toBe(1)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("nondeterminism")
  }, 120_000)

  test("missing-only drift is undecided (5)", async () => {
    const changed = JSON.parse(baseline())
    changed.records.pop()
    const result = await run(Effect.succeed(JSON.stringify(changed)))
    expect(result.status).toBe(5)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("missing baseline observation")
  }, 120_000)

  test("an unreadable baseline is a harness error (5)", async () => {
    const result = await run(Effect.fail(new EvalError.EvalError({
      code: "invalid_baseline", message: "Baseline cannot be read"
    })))
    expect(result.status).toBe(5)
    expect(result.stderr).toContain("Baseline cannot be read")
  }, 120_000)

  test("a corrupt baseline is a harness error (5)", async () => {
    const result = await run(Effect.succeed("{"))
    expect(result.status).toBe(5)
    expect(result.stderr).toContain("Baseline is not valid JSON")
  }, 120_000)
})
