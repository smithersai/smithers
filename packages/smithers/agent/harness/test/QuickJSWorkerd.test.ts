// `QuickJSWorkerd.variantFrom` is the workerd build over a compiled module. Node may compile WebAssembly from bytes, so
// this compiles the same `.wasm` file `#quickjs.wasm` names and hands the module over as workerd's bundler does; a
// cell then runs to completion. A load that fails is the sandbox's typed `runtime_failed`. The workerd path itself,
// Alchemy's bundler included, runs in apps/vibelang's workerd suite (`pnpm test:workerd`).
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as QuickJSWorkerd from "../src/QuickJSWorkerd.ts"
import * as Sandbox from "../src/Sandbox.ts"

/** The compiled module of the file this package's `#quickjs.wasm` import maps to. */
const compiled = async () => {
  const path = createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")
  return { default: await WebAssembly.compile(await readFile(path)) }
}

const flows: Readonly<Record<string, Cell.FlowProjection>> = {
  "fs/list": new Cell.FlowProjection({
    name: "fs/list",
    description: "List a directory.",
    capabilities: ["fs:read:**"],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })
}

const call: Sandbox.Handler = () => Effect.succeed(Cell.CallResult.new({ outcome: "success", value: ["README.md"] }))

const cell = `const files: Array<string> = await ctx.call("fs/list", { path: "." })
ctx.done(files.join(","))`

describe("QuickJSWorkerd", () => {
  it.effect("runs a cell on the separate-file build over a compiled module", () =>
    Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      const realm = yield* sandbox.openRealm!({ flows })
      const frame = yield* realm.evaluate({ cell: Cell.source(cell, "typescript"), frame: 0, call })
      expect(frame.outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "README.md" } })
    }).pipe(
      Effect.scoped,
      Effect.provide(QuickJSSandbox.layerWithVariant.pipe(Layer.provide(QuickJSWorkerd.variantFrom(compiled))))
    ))

  it.effect("fails as the sandbox's runtime_failed outside a Cloudflare bundle, where no bundler compiled the .wasm", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Layer.build(QuickJSWorkerd.variant))
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
      const failure = error?._tag === "Fail" ? error.error : undefined
      expect(failure).toBeInstanceOf(Sandbox.SandboxError)
      expect(failure).toMatchObject({ code: "runtime_failed" })
    }).pipe(Effect.scoped))

  it.effect("fails as the sandbox's runtime_failed when the module can't be loaded", () =>
    Effect.gen(function*() {
      const lost = new Error("no module")
      const exit = yield* Effect.exit(Layer.build(QuickJSWorkerd.variantFrom(() => Promise.reject(lost))))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
      const failure = error?._tag === "Fail" ? error.error : undefined
      expect(failure).toBeInstanceOf(Sandbox.SandboxError)
      expect(failure).toMatchObject({ code: "runtime_failed", cause: lost })
    }).pipe(Effect.scoped))
})
