import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import * as FuzzV8Coverage from "../src/FuzzV8Coverage.ts"
import { makeMethods } from "../src/internal/FuzzRegistration.ts"

const makeScriptedSession = (
  snapshots: Array<ReadonlyArray<FuzzV8Coverage.ScriptCoverage>>,
  options?: {
    readonly failOn?: string
    readonly connectError?: Error
  }
) => {
  const calls: Array<string> = []
  let disconnected = false
  let takeIndex = 0
  const session: FuzzV8Coverage.InspectorSession = {
    connect: () => {
      calls.push("connect")
      if (options?.connectError !== undefined) throw options.connectError
    },
    disconnect: () => {
      calls.push("disconnect")
      disconnected = true
    },
    post: (method, _params, callback) => {
      calls.push(method)
      if (options?.failOn === method) {
        callback?.(new Error(`injected ${method} failure`))
        return
      }
      if (method === "Profiler.takePreciseCoverage") {
        const next = snapshots[Math.min(takeIndex, snapshots.length - 1)] ?? []
        takeIndex++
        callback?.(null, { result: next })
        return
      }
      callback?.(null, undefined)
    }
  }
  return { session, calls, isDisconnected: () => disconnected }
}

describe("FuzzV8Coverage", () => {
  it("loads a portable helper through the package root without resolving the inspector", async () => {
    const result = await build({
      stdin: {
        contents: "import { FuzzV8Coverage } from \"./src/index.ts\"; globalThis.bucket = FuzzV8Coverage.hitBucket(7)",
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      packages: "external",
      plugins: [{
        name: "inspector-boundary",
        setup(build) {
          build.onResolve({ filter: /^node:inspector$/ }, () => ({ errors: [{ text: "static inspector import" }] }))
        }
      }]
    })
    const bundle = await build({
      stdin: { contents: result.outputFiles[0]!.text, resolveDir: process.cwd() },
      platform: "browser",
      bundle: true,
      format: "iife",
      write: false
    })
    const context = { TextEncoder, TextDecoder, URL, AbortController, performance, queueMicrotask, bucket: 0 }
    runInNewContext(bundle.outputFiles[0]!.text, context)
    expect(context.bucket).toBe(4)
  })
  it("buckets positive hit counts into AFL-style tiers", () => {
    expect(FuzzV8Coverage.hitBucket(1)).toBe(1)
    expect(FuzzV8Coverage.hitBucket(2)).toBe(2)
    expect(FuzzV8Coverage.hitBucket(3)).toBe(3)
    expect(FuzzV8Coverage.hitBucket(4)).toBe(4)
    expect(FuzzV8Coverage.hitBucket(7)).toBe(4)
    expect(FuzzV8Coverage.hitBucket(8)).toBe(8)
    expect(FuzzV8Coverage.hitBucket(15)).toBe(8)
    expect(FuzzV8Coverage.hitBucket(16)).toBe(16)
    expect(FuzzV8Coverage.hitBucket(31)).toBe(16)
    expect(FuzzV8Coverage.hitBucket(32)).toBe(32)
    expect(FuzzV8Coverage.hitBucket(127)).toBe(32)
    expect(FuzzV8Coverage.hitBucket(128)).toBe(128)
    expect(FuzzV8Coverage.hitBucket(10_000)).toBe(128)
  })

  it("extracts exact executed bytecode intervals by carving zero-count holes", () => {
    expect(FuzzV8Coverage.executedBlocks([])).toEqual([])
    expect(FuzzV8Coverage.executedBlocks([{ startOffset: 0, endOffset: 50, count: 0 }])).toEqual([])
    // Branch 1 taken: [46..136] count 1 minus [93..135] count 0 -> [46..93] and [135..136].
    expect(
      FuzzV8Coverage.executedBlocks([
        { startOffset: 46, endOffset: 136, count: 1 },
        { startOffset: 93, endOffset: 135, count: 0 }
      ])
    ).toEqual([
      { startOffset: 46, endOffset: 93, count: 1 },
      { startOffset: 135, endOffset: 136, count: 1 }
    ])
    // Branch 2 taken: [46..136] minus [82..93] and [120..135] -> [46..82], [93..120], [135..136].
    expect(
      FuzzV8Coverage.executedBlocks([
        { startOffset: 46, endOffset: 136, count: 1 },
        { startOffset: 82, endOffset: 93, count: 0 },
        { startOffset: 120, endOffset: 135, count: 0 }
      ])
    ).toEqual([
      { startOffset: 46, endOffset: 82, count: 1 },
      { startOffset: 93, endOffset: 120, count: 1 },
      { startOffset: 135, endOffset: 136, count: 1 }
    ])
    // Nested loop body with a skipped inner branch: positive child pops cleanly before sibling.
    expect(
      FuzzV8Coverage.executedBlocks([
        { startOffset: 0, endOffset: 100, count: 1 },
        { startOffset: 10, endOffset: 50, count: 5 },
        { startOffset: 20, endOffset: 30, count: 0 },
        { startOffset: 60, endOffset: 80, count: 2 }
      ])
    ).toEqual([
      { startOffset: 0, endOffset: 10, count: 1 },
      { startOffset: 10, endOffset: 20, count: 5 },
      { startOffset: 30, endOffset: 50, count: 5 },
      { startOffset: 50, endOffset: 60, count: 1 },
      { startOffset: 60, endOffset: 80, count: 2 },
      { startOffset: 80, endOffset: 100, count: 1 }
    ])
    // Adjacent sibling with zero-count parent does not emit parent gap.
    expect(
      FuzzV8Coverage.executedBlocks([
        { startOffset: 0, endOffset: 40, count: 0 },
        { startOffset: 10, endOffset: 20, count: 0 },
        { startOffset: 40, endOffset: 60, count: 3 }
      ])
    ).toEqual([{ startOffset: 40, endOffset: 60, count: 3 }])
  })

  it("filters default and custom script URLs", () => {
    expect(FuzzV8Coverage.defaultInclude("")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("node:internal/bootstrap")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("file:///repo/node_modules/effect/index.js")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("C:\\repo\\node_modules\\effect\\index.js")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("file:///repo/packages/fuzz/src/Fuzz.ts")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("file:///repo/packages/testing/src/FuzzV8Coverage.ts")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("file:///repo/packages/testing/src/internal/fuzz.ts")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("file:///repo/packages/testing/src/internal/FuzzRegistration.ts")).toBe(false)
    expect(FuzzV8Coverage.defaultInclude("file:///repo/packages/smithers/flows/engine/src/Engine.ts")).toBe(true)
  })

  it("parses EFFECT_FUZZ_V8_COVERAGE environment variants", () => {
    expect(FuzzV8Coverage.fromEnv({})).toBeUndefined()
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: "" })).toBeUndefined()
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: "0" })).toBeUndefined()
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: "false" })).toBeUndefined()
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: "1" })).toEqual({})
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: "true" })).toEqual({})
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: " , " })).toEqual({})
    expect(FuzzV8Coverage.fromEnv({ EFFECT_FUZZ_V8_COVERAGE: "packages/engine, apps/mvp" })).toEqual({
      include: ["packages/engine", "apps/mvp"]
    })
  })

  it("reports coverage features per execution and cleans up on scope close", async () => {
    const scripts: ReadonlyArray<FuzzV8Coverage.ScriptCoverage> = [
      {
        scriptId: "1",
        url: "node:fs",
        functions: [{
          functionName: "read",
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 10, count: 1 }]
        }]
      },
      {
        scriptId: "2",
        url: "file:///repo/packages/app/src/parser.ts",
        functions: [
          {
            functionName: "parse",
            isBlockCoverage: true,
            ranges: [
              { startOffset: 0, endOffset: 100, count: 1 },
              { startOffset: 40, endOffset: 60, count: 0 }
            ]
          }
        ]
      }
    ]
    const fake = makeScriptedSession([[], scripts])
    const seen: Array<string | number> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const feedback = yield* FuzzV8Coverage.make({
            name: "v8-custom",
            include: ["packages/app/"]
          }).pipe(Effect.provideService(FuzzV8Coverage.Inspector, () => fake.session))
          expect(feedback.name).toBe("v8-custom")
          const value = yield* feedback.measure(Effect.succeed(42), {
            feature: (key) => {
              seen.push(key)
            }
          })
          expect(value).toBe(42)
        })
      )
    )
    expect(fake.isDisconnected()).toBe(true)
    expect(fake.calls).toEqual([
      "connect",
      "Profiler.enable",
      "Profiler.startPreciseCoverage",
      "Profiler.takePreciseCoverage",
      "Profiler.takePreciseCoverage",
      "Profiler.stopPreciseCoverage",
      "disconnect"
    ])
    expect(seen).toEqual([
      "file:///repo/packages/app/src/parser.ts:0:40#1",
      "file:///repo/packages/app/src/parser.ts:60:100#1"
    ])
  })

  it("accepts a custom predicate and still reports coverage when the property fails", async () => {
    const scripts: ReadonlyArray<FuzzV8Coverage.ScriptCoverage> = [
      {
        scriptId: "3",
        url: "custom://target",
        functions: [{
          functionName: "crash",
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 20, count: 4 }]
        }]
      }
    ]
    const fake = makeScriptedSession([[], scripts], { failOn: "Profiler.stopPreciseCoverage" })
    const seen: Array<string | number> = []
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function*() {
          const feedback = yield* FuzzV8Coverage.make({
            include: (url) => url.startsWith("custom://")
          }).pipe(Effect.provideService(FuzzV8Coverage.Inspector, () => fake.session))
          expect(feedback.name).toBe("v8")
          return yield* feedback.measure(Effect.fail("boom"), {
            feature: (key) => {
              seen.push(key)
            }
          })
        })
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(fake.isDisconnected()).toBe(true)
    expect(seen).toEqual(["custom://target:0:20#4"])
  })

  it("wraps startup failures as Feedback FuzzError and disconnects on partial startup", async () => {
    const connectFail = makeScriptedSession([], { connectError: new Error("no inspector") })
    const e1 = await Effect.runPromiseExit(
      Effect.scoped(
        FuzzV8Coverage.make().pipe(Effect.provideService(FuzzV8Coverage.Inspector, () => connectFail.session))
      )
    )
    expect(Exit.isFailure(e1)).toBe(true)
    expect(connectFail.isDisconnected()).toBe(false)

    const enableFail = makeScriptedSession([], { failOn: "Profiler.startPreciseCoverage" })
    const e2 = await Effect.runPromiseExit(
      Effect.scoped(
        FuzzV8Coverage.make().pipe(Effect.provideService(FuzzV8Coverage.Inspector, () => enableFail.session))
      )
    )
    expect(Exit.isFailure(e2)).toBe(true)
    expect(enableFail.isDisconnected()).toBe(true)
  })

  it("guides @smthrs/fuzz to a hidden multi-branch bug using real Node V8 coverage without spans or observe", () => {
    const moduleUrl = fileURLToPath(new URL("../src/FuzzV8Coverage.ts", import.meta.url))
    const script = `
      import { Fuzz } from "@smthrs/fuzz"
      import { Arbitrary, Effect, Schema } from "effect"
      import * as FuzzV8Coverage from ${JSON.stringify(moduleUrl)}

      function parseGate(bytes) {
        if (bytes[0] !== 7) return true
        if (bytes[1] !== 11) return true
        if (bytes[2] !== 3) return true
        if (bytes[3] !== 13) return true
        return false
      }

      const Nib = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
      const arb = Arbitrary.schema(Schema.Tuple([Nib, Nib, Nib, Nib]))
      const guided = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const v8 = yield* FuzzV8Coverage.make({ include: (url) => url.includes("[eval") })
            return yield* Fuzz.run(arb, (bytes) => parseGate(bytes), {
              seed: 20261122,
              executions: 3000,
              feedback: [v8]
            })
          })
        )
      )
      const unguided = await Effect.runPromise(
        Fuzz.run(arb, (bytes) => parseGate(bytes), {
          seed: 20261122,
          executions: 3000,
          feedback: []
        })
      )
      process.stdout.write(JSON.stringify({
        guidedTag: guided._tag,
        unguidedTag: unguided._tag,
        features: guided.stats.features,
        executions: guided.stats.executions
      }))
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 20_000
    })
    const parsed = JSON.parse(output) as {
      readonly guidedTag: string
      readonly unguidedTag: string
      readonly features: Record<string, number>
      readonly executions: number
    }
    expect(parsed.features.v8).toBeGreaterThan(0)
    expect(parsed.guidedTag).toBe("Falsified")
    expect(parsed.unguidedTag).toBe("Passed")
  })
})

// Verify Vitest registration path when EFFECT_FUZZ_V8_COVERAGE is active without interfering with Vitest's own V8 coverage.
describe("FuzzRegistration with EFFECT_FUZZ_V8_COVERAGE", () => {
  const previous = {
    selector: process.env.EFFECT_FUZZ,
    executions: process.env.EFFECT_FUZZ_EXECUTIONS,
    v8: process.env.EFFECT_FUZZ_V8_COVERAGE
  }
  const fake = makeScriptedSession([[], []])
  const methods = makeMethods(it, () => fake.session)
  process.env.EFFECT_FUZZ = "v8 registration probe"
  process.env.EFFECT_FUZZ_EXECUTIONS = "1"
  process.env.EFFECT_FUZZ_V8_COVERAGE = "packages/app/"
  methods.effect.fuzz("v8 registration probe uses default spans plus v8", [Schema.Int], () => Effect.succeed(true), {
    id: "v8-registration-probe-default",
    revision: "1"
  })
  methods.effect.fuzz("v8 registration probe appends to custom feedback", [Schema.Int], () => Effect.succeed(true), {
    id: "v8-registration-probe-custom",
    revision: "1",
    fuzz: { feedback: [] }
  })
  if (previous.selector === undefined) delete process.env.EFFECT_FUZZ
  else process.env.EFFECT_FUZZ = previous.selector
  if (previous.executions === undefined) delete process.env.EFFECT_FUZZ_EXECUTIONS
  else process.env.EFFECT_FUZZ_EXECUTIONS = previous.executions
  if (previous.v8 === undefined) delete process.env.EFFECT_FUZZ_V8_COVERAGE
  else process.env.EFFECT_FUZZ_V8_COVERAGE = previous.v8

  it("createNodeSession connects and disconnects cleanly", () => {
    const session = FuzzV8Coverage.Inspector.defaultValue()()
    session.connect()
    session.disconnect()
  })
})
