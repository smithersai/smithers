import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"

const target = Flow.make({ name: "case-executor-target" })
const execution = { output: 1, stepKey: "step", latencyMs: 0, target }
const suiteCase = { name: "a", input: 1 }

describe("CaseExecutor", () => {
  it("accepts a bare callback and a `run` object alike", async () => {
    const callback = CaseExecutor.make(() => Effect.succeed(execution))
    const named = CaseExecutor.make({ run: () => Effect.succeed(execution) })
    for (const executor of [callback, named]) {
      expect(await Effect.runPromise(executor.run(suiteCase))).toEqual(execution)
    }
  })

  // The 1.0.0-rc.0 notes retired the `execute` spelling; `run` is the one name.
  it("refuses the retired `execute` spelling", () => {
    // @ts-expect-error `execute` is not an implementation field.
    expect(() => CaseExecutor.make({ execute: () => Effect.succeed(execution) })).toThrow(
      "CaseExecutor.make needs a callback, or an object with a `run` callback"
    )
    expect("CaseInput" in CaseExecutor).toBe(false)
  })

  // Degrading to the unavailable executor turned one wiring mistake into a
  // whole suite of cases failing with `executor`, which reads as a broken
  // target rather than a missing one.
  it("refuses an implementation carrying no callback", () => {
    expect(() => CaseExecutor.make({} as CaseExecutor.Implementation)).toThrow(TypeError)
    expect(() => CaseExecutor.make({ run: undefined } as unknown as CaseExecutor.Implementation)).toThrow(
      "CaseExecutor.make needs a callback, or an object with a `run` callback"
    )
  })

  it("fails every case with a typed executor error when no executor is available", async () => {
    const error = await Effect.runPromise(Effect.flip(CaseExecutor.makeNoop().run(suiteCase)))
    expect(error.code).toBe("executor")
    expect(error.message).toBe("No executor is available for case 'a'")
    expect(error.path).toBe("cases['a']")
  })

  it("provides the unavailable executor as a layer", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(CaseExecutor.CaseExecutor, (service) => service.run(suiteCase)).pipe(
        Effect.provide(CaseExecutor.layerNoop)
      )
    )
    expect(exit._tag).toBe("Failure")
  })
})
