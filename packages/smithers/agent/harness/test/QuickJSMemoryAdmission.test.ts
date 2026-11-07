import singlefile from "@jitl/quickjs-singlefile-browser-release-sync"
import { Effect, Exit } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as QuickJSVariant from "../src/QuickJSVariant.ts"
import * as Sandbox from "../src/Sandbox.ts"

const succeeds: Sandbox.Handler = () => Effect.succeed(Cell.CallResult.new({ outcome: "success", value: null }))

/** Drive real frames; prints and calls prove whether admission ran user code. */
const framesOf = (
  sources: ReadonlyArray<string>,
  steps = Number.MAX_SAFE_INTEGER,
  laterSteps = Number.MAX_SAFE_INTEGER
) =>
  Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    const realm = yield* sandbox.openRealm!({
      flows: {},
      limits: { memoryBytes: 4 * 1024 * 1024, steps: Number.MAX_SAFE_INTEGER }
    })
    const frames: Array<Sandbox.RealmFrame> = []
    for (const [frame, source] of sources.entries()) {
      frames.push(
        yield* realm.evaluate({
          cell: Cell.source(source),
          frame,
          call: succeeds,
          limits: { steps: frame === 0 ? steps : laterSteps }
        })
      )
    }
    return frames
  }).pipe(Effect.scoped, Effect.runPromise)

describe("QuickJS memory admission regressions", () => {
  it.each(["payload", "01", "4294967295"])("weighs custom enumerable array property %s", async (key) => {
    const frames = await framesOf([
      `var held = []; held[${JSON.stringify(key)}] = ["a".repeat(2300000), "b".repeat(2300000)]`,
      `console.log("unaccounted array property ran")`
    ])
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
    expect(frames[1]!.prints).toBe("")
  })

  it("accounts for two bytes per code unit in retained wide strings", async () => {
    const frames = await framesOf([
      `var held = ["漢".repeat(800000), "字".repeat(800000), "語".repeat(800000)]`,
      `console.log("undercounted wide strings ran")`
    ])
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
    expect(frames[1]!.prints).toBe("")
  })

  it("refuses frame admission after an interrupted probe instead of reusing a stale reading", async () => {
    const frames = await framesOf([
      `var held = Array(100000).fill("漢".repeat(30))`,
      `console.log("stale reading admitted user code")`
    ], 100)
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
    expect(frames[1]!.prints).toBe("")
  })

  it("keeps refusing allocating frames after the first memory refusal", async () => {
    const frames = await framesOf([
      `var held = ["a".repeat(2300000), "b".repeat(2300000)]`,
      `held.push("c".repeat(1000000)); console.log("first bypass")`,
      `held.push("d".repeat(1000000)); console.log("second bypass")`,
      `held.push("e".repeat(1000000)); console.log("third bypass")`
    ])
    expect(frames[0]!.outcome._tag).toBe("settled")
    for (const frame of frames.slice(1)) {
      expect(frame.outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
      expect(frame.prints).toBe("")
    }
  })

  it("refuses user code while a fresh admission probe still cannot finish", async () => {
    const frames = await framesOf(
      [
        `var held = Array(100000).fill(null)`,
        `console.log("incomplete admission probe ran user code")`,
        `console.log("repeated incomplete probe ran user code")`
      ],
      100,
      100
    )
    expect(frames[0]!.outcome._tag).toBe("settled")
    for (const frame of frames.slice(1)) {
      expect(frame.outcome).toMatchObject({
        _tag: "rejected",
        code: "limit_exceeded",
        message: expect.stringContaining("too large to measure")
      })
      expect(frame.prints).toBe("")
    }
  })

  it("admits user code once a fresh probe establishes a complete reading within the ceiling", async () => {
    const frames = await framesOf([
      `var held = Array(100000).fill(null)`,
      `console.log("measured safely")`
    ], 100)
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(frames[1]!.prints).toBe("measured safely")
  })

  it("counts array indices once and ignores custom accessors and inherited payloads", async () => {
    const frames = await framesOf([
      `var touched = false
       var held = ["漢".repeat(800000)]
       Object.defineProperty(held, "payload", { enumerable: true, get() { touched = true; throw new Error("getter") } })
       Object.defineProperty(held, "hidden", { value: "語".repeat(800000) })
       Object.setPrototypeOf(held, { inherited: "字".repeat(800000) })`,
      `console.log(String(touched))`
    ])
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(frames[1]!.prints).toBe("false")
  })

  it.each(["QTS_RuntimeSetMemoryLimit", "QTS_RuntimeSetMaxStackSize", "QTS_NewContext"] as const)(
    "frees an allocated runtime when initialization fails in %s",
    async (operation) => {
      const base = singlefile as unknown as QuickJSSyncVariant
      const failure = new Error(`injected ${operation} failure`)
      let allocated = 0
      let freed = 0
      // Fault injection through the Variant Effect service. All allocation and
      // disposal still use the real WASM runtime; only the named operation fails.
      const variant: QuickJSSyncVariant = {
        ...base,
        importFFI: async () => {
          const FFI = await base.importFFI()
          return class extends FFI {
            constructor(...args: ConstructorParameters<typeof FFI>) {
              super(...args)
              const allocate = this.QTS_NewRuntime
              const release = this.QTS_FreeRuntime
              this.QTS_NewRuntime = () => {
                allocated++
                return allocate()
              }
              this.QTS_FreeRuntime = (runtime) => {
                release(runtime)
                freed++
              }
              this[operation] = () => {
                throw failure
              }
            }
          }
        }
      }
      const exit = await Effect.gen(function*() {
        const sandbox = yield* QuickJSSandbox.makeWithVariant
        return yield* sandbox.openRealm!({ flows: {} })
      }).pipe(
        Effect.scoped,
        Effect.provide(QuickJSVariant.layerVariant(variant)),
        Effect.provide(QuickJSSandbox.layerClockLive),
        Effect.exit,
        Effect.runPromise
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ defect: failure }))
      expect(allocated).toBe(1)
      expect(freed).toBe(allocated)
    }
  )
})
