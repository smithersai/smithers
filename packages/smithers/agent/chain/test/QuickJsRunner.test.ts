import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { Cause, Effect, Logger } from "effect"
import type { ExecutePendingJobsResult, QuickJSWASMModule } from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import * as QuickJsJobs from "../src/internal/QuickJsJobs.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as Script from "../src/Script.vibe"
import type * as ScriptRunner from "../src/ScriptRunner.ts"

describe("QuickJsRunner load machinery", () => {
  it("caches a successful load and shares it", async () => {
    let loads = 0
    const load = QuickJsRunner.cachedLoad(() => {
      loads = loads + 1
      return Promise.resolve("module")
    })
    expect(await load()).toBe("module")
    expect(await load()).toBe("module")
    expect(loads).toBe(1)
  })

  it("retries after a rejected load instead of caching the failure", async () => {
    let loads = 0
    const load = QuickJsRunner.cachedLoad(() => {
      loads = loads + 1
      return loads === 1 ? Promise.reject(new Error("transient")) : Promise.resolve("module")
    })
    await expect(load()).rejects.toThrow("transient")
    expect(await load()).toBe("module")
    expect(loads).toBe(2)
  })

  it("fails typed — never a defect — when the module cannot load", async () => {
    const error = await Effect.runPromise(
      Effect.flip(QuickJsRunner.make({}, () => Promise.reject(new Error("csp blocked wasm"))))
    ) as ScriptRunner.ScriptFailure
    expect(error._tag).toBe("/chain/ScriptFailure")
    expect(error.code).toBe("runner_unavailable")
    expect(error.message).toBe("csp blocked wasm")
  })
})

describe("QuickJS pending jobs", () => {
  it("dumps and disposes a failed job result", () => {
    let disposed = false
    const error = {
      context: { dump: () => ({ message: "job interrupted" }) }
    }
    const result = {
      error,
      dispose: () => {
        disposed = true
      }
    } as unknown as ExecutePendingJobsResult
    expect(Effect.runSync(Effect.flip(QuickJsJobs.check(result))))
      .toMatchObject({ code: "runtime", message: "job interrupted" })
    expect(disposed).toBe(true)
  })
})

describe("QuickJsRunner defect boundary", () => {
  // The boundary absorbs every non-handler defect into a journaled
  // `runtime` failure on purpose (see RunnerConformance: a native abort
  // must not kill a resumed chain forever). What it must never do is let
  // that failure read like the script's own: a host RangeError thrown by
  // the realm machinery mid-evaluation carries the host marker, and the
  // defect itself is logged with its cause so the stack survives.
  it("marks a host defect raised by the realm machinery and logs its cause", async () => {
    const real = await newQuickJSWASMModuleFromVariant(variant)
    const module = {
      newRuntime: () => {
        const runtime = real.newRuntime()
        runtime.executePendingJobs = () => {
          throw new RangeError("Maximum call stack size exceeded")
        }
        return runtime
      }
    } as unknown as QuickJSWASMModule
    const logged: Array<{ readonly message: unknown; readonly cause: Cause.Cause<unknown> }> = []
    const logger = Logger.make<unknown, void>(({ cause, message }) => {
      logged.push({ cause, message })
    })
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          QuickJsRunner.make({}, () => Promise.resolve(module)),
          (runner) => runner.run(Script.make(`return done(1)`), () => Effect.succeed(null))
        )
      ).pipe(Effect.provide(Logger.layer([logger])))
    ) as ScriptRunner.ScriptFailure
    expect(error._tag).toBe("/chain/ScriptFailure")
    expect(error.code).toBe("runtime")
    expect(error.message).toBe(`${QuickJsRunner.hostDefectMarker}Maximum call stack size exceeded`)
    expect(error.message.startsWith("host: ")).toBe(true)
    const entry = logged.find((line) => Cause.hasDies(line.cause))
    expect(entry).toBeDefined()
    expect(Cause.prettyErrors(entry!.cause)[0]?.message).toBe("Maximum call stack size exceeded")
  })

  // The marker is the host boundary's alone: a script's own uncaught
  // throw is the script's failure and must not be labelled host-side.
  it("never marks a failure the script itself raised", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          QuickJsRunner.make(),
          (runner) => runner.run(Script.make(`throw new RangeError("mine")`), () => Effect.succeed(null))
        )
      )
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("mine")
  })
})

describe("QuickJsRunner limits", () => {
  const busyLoop = Script.make(`for (let i = 0; i < 5000000; i++) {}\nreturn done(1)`)

  // NaN never satisfies `++steps > budget`, so an unvalidated NaN budget
  // would remove the step bound instead of enforcing one; a NaN or negative
  // stack size reaches QuickJS as "no limit" the same way.
  it.each(
    [
      ["steps", Number.NaN],
      ["steps", Number.POSITIVE_INFINITY],
      ["steps", -1],
      ["steps", 1.5],
      ["memoryBytes", Number.NaN],
      ["memoryBytes", Number.POSITIVE_INFINITY],
      ["stackBytes", Number.NaN],
      ["stackBytes", -1]
    ] as const
  )("dies at construction when %s is %s", async (limit, value) => {
    await expect(Effect.runPromise(QuickJsRunner.make({ [limit]: value }))).rejects.toThrow(
      `${limit} must be a non-negative integer, got ${value}`
    )
  })

  it("enforces the limits it was constructed with, not a later edit of the caller's object", async () => {
    const limits: { steps: number | undefined } = { steps: 100 }
    const runner = await Effect.runPromise(QuickJsRunner.make(limits))
    limits.steps = 1_000_000_000
    const error = await Effect.runPromise(
      Effect.flip(runner.run(busyLoop, () => Effect.succeed(null)))
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })
})
