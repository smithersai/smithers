/**
 * The QuickJS build is a seam a host can name.
 *
 * The default compiles the single-file build from bytes, which is what Node and
 * a browser want. Cloudflare's workerd refuses that: the only WebAssembly it
 * runs is a module its toolchain compiled and handed to the worker as an
 * import. So the host builds the variant and the sandbox compiles whatever it
 * is given.
 *
 * These cases stand in for that host. They read the `.wasm` file of the
 * separate-file build, compile it here, and hand the module to
 * `newVariant`, which is exactly the shape a worker's `import wasm from
 * "...wasm"` produces. What is pinned is that a cell runs against it.
 */
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { Effect, Layer, Option } from "effect"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { newVariant } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import { QuickJSVariant } from "../src/index.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.vibe"

/**
 * The separate-file build.
 *
 * The package publishes one `types` entry for all of its export conditions and
 * it names the CommonJS declaration, so TypeScript models this import as
 * `module.exports` while Node, vite and every bundler resolve the ESM file
 * through the `import` condition and hand over the variant itself. The
 * assertion states the shape the runtime actually delivers.
 */
const base = wasmfile as unknown as QuickJSSyncVariant

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

const succeeds: Sandbox.Handler = () => Effect.succeed(Cell.CallResult.new({ outcome: "success", value: null }))

/**
 * The variant a workerd host builds, built the way a workerd host builds it.
 *
 * A worker imports the `.wasm` file as a module and passes the
 * `WebAssembly.Module` straight through. Node has no such import, so the bytes
 * are read and compiled here; what reaches `newVariant` is the same thing
 * either way, and it is the compiled module rather than the bytes.
 *
 * `wasmLocation` names a file that does not exist, which is what makes these
 * cases mean anything. The separate-file build can find its own `.wasm` on a
 * Node filesystem, so a variant that only carried `wasmModule` would still run
 * if the option were ignored. With nowhere to load from, a cell that completes
 * can only have run against the module named here — the same position workerd
 * puts a host in.
 */
const hostVariant = async (): Promise<QuickJSSyncVariant> => {
  const path = fileURLToPath(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"))
  const wasmModule = await WebAssembly.compile(await readFile(path))
  return newVariant(base, { wasmModule, wasmLocation: "/nonexistent/quickjs.wasm" })
}

/** Runs one cell through the sandbox layer over the build the host named. */
const runCell = (variant: QuickJSSyncVariant, text: string): Promise<Cell.Outcome> =>
  Effect.gen(function*() {
    const sandbox = yield* Sandbox.Sandbox
    const realm = yield* sandbox.openRealm!({ flows })
    const frame = yield* realm.evaluate({ cell: Cell.source(text), frame: 0, call: succeeds })
    return frame.outcome
  }).pipe(
    Effect.scoped,
    Effect.provide(
      QuickJSSandbox.layerWithVariant.pipe(Layer.provide(QuickJSSandbox.layerVariant(variant)))
    ),
    Effect.runPromise
  )

describe("QuickJSSandbox variant", () => {
  it("runs a cell against a build whose WebAssembly module the host compiled", async () => {
    const outcome = await runCell(await hostVariant(), `ctx.done(String(1 + 1))`)

    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "2" } })
  })

  it("compiles one build once, however many sandboxes are made over it", async () => {
    // The compiled module is cached per variant, not per process, because the
    // variant is the thing a host names. Two sandboxes over one variant share
    // a module; the second open proves the cached module is still usable.
    const variant = await hostVariant()

    expect(await runCell(variant, `ctx.done("first")`)).toMatchObject({
      transition: { _tag: "complete", output: "first" }
    })
    expect(await runCell(variant, `ctx.done("second")`)).toMatchObject({
      transition: { _tag: "complete", output: "second" }
    })
  })

  it("keeps the single-file build as the default", async () => {
    // `layerVariantLive` is what `layer` and `make` compile, so a host that
    // names nothing gets the build that runs unchanged on Node and in a
    // browser.
    const { variant } = await Effect.runPromise(
      QuickJSSandbox.Variant.pipe(Effect.provide(QuickJSSandbox.layerVariantLive))
    )

    expect(variant.type).toBe("sync")
    expect(variant).not.toBe(base)
  })

  it("hands every realm over one variant the same compiled module", async () => {
    // The presentation realm in @smthrs/views compiles through the same seam
    // as the cell sandbox, so a host that names one build pays for one
    // compile, whichever realm opens first.
    const variant = await hostVariant()
    const compile = QuickJSVariant.compiledModule.pipe(Effect.provide(QuickJSVariant.layerVariant(variant)))

    const first = await Effect.runPromise(compile)
    const second = await Effect.runPromise(compile)

    expect(second).toBe(first)
    expect(first.evalCode("6 * 7")).toBe(42)
  })

  it("is the seam QuickJSSandbox names", () => {
    // One service, one tag: a host that provides the root's `QuickJSVariant`
    // has provided the sandbox's `Variant` too.
    expect(QuickJSSandbox.Variant).toBe(QuickJSVariant.Variant)
    expect(QuickJSSandbox.layerVariant).toBe(QuickJSVariant.layerVariant)
  })
})
