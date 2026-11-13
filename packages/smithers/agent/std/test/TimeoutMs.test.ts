import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Path, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as ShellCommand from "../src/ShellCommand.ts"
import type * as StdError from "../src/StdError.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"

describe("process timeouts", () => {
  it.each([0, -1, NaN, Infinity, -Infinity, 600_001, 1e15])(
    "refuses invalid timeout %s before spawning",
    async (timeoutMs) => {
      expect(Schema.is(Bash.Input)({ mode: "unhermetic", command: "unused", timeoutMs })).toBe(false)
      expect(Schema.is(ShellCommand.Input)({ command: "unused", timeout_ms: timeoutMs })).toBe(false)
      expect(Schema.is(TestRun.Input)({ timeoutMs })).toBe(false)
      let spawns = 0
      let terminalCalls = 0
      const host = Layer.mergeAll(
        Path.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
          spawn: () => Effect.sync(() => spawns++).pipe(Effect.andThen(Effect.die("invalid input spawned")))
        })),
        TestRunner.layer({ command: "unused" }),
        Evaluator.layerUnavailable()
      )
      const calls: ReadonlyArray<
        Effect.Effect<
          unknown,
          StdError.StdError,
          ChildProcessSpawner.ChildProcessSpawner | Path.Path | Evaluator.Evaluator | TestRunner.TestRunner
        >
      > = [
        Bash.run({ mode: "unhermetic", command: "unused", timeoutMs }),
        ShellCommand.run({ command: "unused", timeout_ms: timeoutMs }),
        Bash.inTerminal(() =>
          Effect.sync(() => terminalCalls++).pipe(Effect.andThen(Effect.die("invalid input reached terminal")))
        )({ mode: "unhermetic", command: "unused", timeoutMs }),
        TestRun.run({ timeoutMs }),
        TestRun.run({}).pipe(Effect.provide(TestRunner.layer({ command: "unused", timeoutMs })))
      ]
      for (const call of calls) {
        const error = await Effect.runPromise(Effect.flip(call).pipe(Effect.provide(host)))
        expect(error).toMatchObject({ code: "invalid_input" })
      }
      expect(spawns).toBe(0)
      expect(terminalCalls).toBe(0)
    }
  )

  it.each([0.5, 1, 600_000])("accepts positive finite timeouts up to ten minutes: %s", (timeoutMs) => {
    expect(Schema.is(Bash.Input)({ mode: "unhermetic", command: "unused", timeoutMs })).toBe(true)
    expect(Schema.is(ShellCommand.Input)({ command: "unused", timeout_ms: timeoutMs })).toBe(true)
    expect(Schema.is(TestRun.Input)({ timeoutMs })).toBe(true)
  })
})
