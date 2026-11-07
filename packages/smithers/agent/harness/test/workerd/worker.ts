/**
 * The workerd smoke: one TypeScript cell, run inside Cloudflare's runtime.
 *
 * workerd runs no WebAssembly it did not compile itself. `WebAssembly.compile`
 * over bytes is refused at runtime, so the single-file build the sandbox
 * defaults to cannot load here. What workerd does accept is a `.wasm` module
 * the toolchain bundled, imported like any other module, and that is what this
 * worker hands the sandbox: `newVariant(base, { wasmModule })` names the
 * imported module and `QuickJSSandbox.layerVariant` puts it behind the seam.
 *
 * The cell calls a flow and then completes, so a passing response means the
 * types were erased, the realm opened, the host bridge settled a call, and
 * the transition came back.
 *
 * See `packages/smithers/agent/harness/README.md` for how to run this.
 */
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import { Effect, Layer, Option } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { newVariant } from "quickjs-emscripten-core"
import * as Cell from "../../src/Cell.ts"
import * as QuickJSSandbox from "../../src/QuickJSSandbox.ts"
import * as Sandbox from "../../src/Sandbox.ts"

/**
 * The separate-file build, whose emscripten glue has a `workerd` export
 * condition.
 *
 * The package publishes one `types` entry for all of its export conditions and
 * it names the CommonJS declaration, so TypeScript models this import as
 * `module.exports` while wrangler resolves the ESM file and hands over the
 * variant itself. The assertion states the shape the runtime delivers.
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

const call: Sandbox.Handler = () => Effect.succeed(Cell.CallResult.new({ outcome: "success", value: ["README.md"] }))

/**
 * The build this host names, assembled once per isolate.
 *
 * `newVariant` only records the module; nothing is instantiated until the
 * sandbox compiles it, so module scope stays free of the work workerd forbids
 * there.
 */
const layer = QuickJSSandbox.layerWithVariant.pipe(
  Layer.provide(QuickJSSandbox.layerVariant(newVariant(base, { wasmModule })))
)

const cell = `const files: Array<string> = await ctx.call("fs/list", { path: "." })
ctx.done(files.join(","))`

const runCell = Effect.gen(function*() {
  const sandbox = yield* Sandbox.Sandbox
  const realm = yield* sandbox.openRealm!({ flows })
  const frame = yield* realm.evaluate({ cell: Cell.source(cell, "typescript"), frame: 0, call })
  return frame.outcome
}).pipe(Effect.scoped, Effect.provide(layer))

export default {
  fetch: (): Promise<Response> =>
    Effect.runPromise(
      runCell.pipe(
        Effect.map((outcome) => Response.json(outcome)),
        Effect.catchCause((cause) => Effect.succeed(new Response(String(cause), { status: 500 })))
      )
    )
}
