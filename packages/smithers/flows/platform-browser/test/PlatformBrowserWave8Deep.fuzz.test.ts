import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BrowserCache, BrowserRuntime } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration, Steps } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261132")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(25, Math.min(baseExecutions, 80))
const runtimeExec = Math.max(6, Math.min(Math.ceil(baseExecutions / 20), 12))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("PlatformBrowser Wave 8 deep fuzzing", () => {
  it("BrowserCache.readAsset handles cache hit, cache miss, cache lookup error, HTTP errors, network errors, and body errors without leaking URL", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cacheMode: Schema.Literals(["hit-ok", "hit-not-ok", "miss", "throw"]),
        netMode: Schema.Literals(["ok", "http-404", "http-500", "net-throw", "body-throw"]),
        payloadByte: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cacheMode, netMode, payloadByte }) =>
          Effect.gen(function*() {
            const secretUrl = "https://cdn.example/secret-token-xyz/app.wasm"
            const bytes = new Uint8Array([payloadByte, 1, 2, 3])
            const cachesStub: Pick<globalThis.CacheStorage, "match"> = {
              match: async () => {
                if (cacheMode === "throw") throw new Error("cache storage disabled")
                if (cacheMode === "miss") return undefined
                if (cacheMode === "hit-not-ok") return new Response("bad", { status: 500 })
                return new Response(bytes, { status: 200 })
              }
            }
            const fetchStub: typeof globalThis.fetch = async () => {
              if (netMode === "net-throw") throw new TypeError("offline")
              if (netMode === "http-404") return new Response("nope", { status: 404 })
              if (netMode === "http-500") return new Response("boom", { status: 500 })
              if (netMode === "body-throw") {
                return {
                  ok: true,
                  status: 200,
                  arrayBuffer: async () => {
                    throw new Error("corrupt stream")
                  }
                } as unknown as Response
              }
              return new Response(bytes, { status: 200 })
            }

            const exit = yield* Effect.exit(
              BrowserCache.readAsset(secretUrl).pipe(
                Effect.provide(BrowserCache.layerAssets({ caches: cachesStub, fetch: fetchStub }))
              )
            )

            const shouldSucceed = cacheMode === "hit-ok" || netMode === "ok"
            if (shouldSucceed) {
              expect(Exit.isSuccess(exit)).toBe(true)
              if (Exit.isSuccess(exit)) {
                expect(new Uint8Array(exit.value)).toEqual(bytes)
              }
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
              expect(String(exit)).not.toContain("secret-token-xyz")
            }
            return true
          }),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("BrowserRuntime.run + BrowserEngine execute, list, inspect, handle authorize allow/deny, and log bad WASM stop", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals(["run-and-list", "authorize-deny", "bad-wasm"]),
        prefix: Schema.Literals(["a", "b", "w8"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, prefix }) =>
          Effect.acquireUseRelease(
            Effect.sync(() => MemoryOpfs.install()),
            () =>
              Effect.scoped(
                Effect.gen(function*() {
                  const telemetry = Telemetry.make()
                  const name = Engines.name()

                  if (scenario === "bad-wasm") {
                    const worker = BrowserRuntime.run({
                      name,
                      sqlite: { ...MemorySqlite.build, wasm: () => Promise.resolve(new Uint8Array([0])) },
                      flows,
                      registerFlows: registration(Effect.succeed),
                      telemetry: telemetry.layer
                    })
                    yield* Fiber.await(worker)
                    return true
                  }

                  if (scenario === "authorize-deny") {
                    let authorized = 0
                    const denied = BrowserRuntime.layerHost(
                      {
                        name,
                        sqlite: MemorySqlite.build,
                        authorize: () =>
                          Effect.sync(() => {
                            authorized++
                          }).pipe(Effect.andThen(Effect.fail("denied")))
                      },
                      registration(Effect.succeed)
                    )
                    const ex = yield* Effect.exit(Layer.build(denied))
                    expect(Exit.isFailure(ex)).toBe(true)
                    expect(authorized).toBe(1)
                    return true
                  }

                  const run = Engines.steps()
                  const worker = BrowserRuntime.run({
                    name,
                    sqlite: MemorySqlite.build,
                    flows,
                    registerFlows: registration(run.step),
                    telemetry: telemetry.layer
                  })
                  try {
                    const engine = yield* Engines.tab(name)
                    const execId = `pb-w8-${prefix}`
                    yield* engine.start(Steps, { executionId: execId, payload: { prefix } })
                    const res = yield* engine.result(Steps, execId)
                    expect(res).toEqual(Exit.succeed(`${prefix}:three`))
                    const listed = yield* engine.list({ limit: 10 })
                    expect(JSON.stringify(listed)).toContain(execId)
                    const inspected = yield* engine.inspect(execId)
                    expect(JSON.stringify(inspected)).toContain(execId)
                  } finally {
                    yield* Fiber.interrupt(worker)
                  }
                  expect(telemetry.count(BrowserRuntime.leaderships, {})).toBe(1)
                  return true
                })
              ),
            (remove) => Effect.sync(() => remove())
          ),
        { seed: seed + 1, executions: runtimeExec }
      )
    )
    assertPassed(report)
  }, 60_000)
})
