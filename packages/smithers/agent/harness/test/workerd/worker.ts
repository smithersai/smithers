/**
 * The workerd smoke: one TypeScript cell, run inside Cloudflare's runtime.
 *
 * workerd runs no WebAssembly it did not compile itself. `WebAssembly.compile`
 * over bytes is refused at runtime, so the single-file build the sandbox
 * defaults to cannot load here. What workerd does accept is a `.wasm` module
 * the toolchain bundled, which `QuickJSWorkerd.variant` imports as
 * `#quickjs.wasm` (this package's `imports`) and puts behind the seam.
 *
 * The cell calls a flow and then completes, so a passing response means the
 * types were erased, the realm opened, the host bridge settled a call, and
 * the transition came back. `test/QuickJSWorkerd.workerd.test.ts` bundles and
 * runs this worker in Miniflare; see `packages/smithers/agent/harness/README.md`
 * for running it under wrangler.
 */
import { Effect, Layer, Option } from "effect"
import * as Cell from "../../src/Cell.ts"
import * as QuickJSSandbox from "../../src/QuickJSSandbox.ts"
import * as QuickJSWorkerd from "../../src/QuickJSWorkerd.vibe"
import * as Sandbox from "../../src/Sandbox.vibe"

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

/** The sandbox over the build the bundle carries, assembled when the request runs, never at module scope. */
const layer = QuickJSSandbox.layerWithVariant.pipe(Layer.provide(QuickJSWorkerd.variant))

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
