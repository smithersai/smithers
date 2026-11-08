---
title: "Run on Cloudflare workerd"
description: "How to run @smthrs/harness cells inside Cloudflare workerd by naming the QuickJS build through the Variant seam, and a whole worker that proves it."
sidebar:
  order: 4
---

`QuickJSSandbox.make` and `QuickJSSandbox.layer` compile the single-file
QuickJS build from bytes, which is what Node and a browser want. Cloudflare's
workerd runs no WebAssembly it did not compile itself: `WebAssembly.compile`
over bytes fails at runtime, and the only module a worker can instantiate is
one its toolchain bundled and handed over as an import. `QuickJSSandbox.Variant`
is the seam for that host.

## Use the packaged build

`@smthrs/harness/QuickJSWorkerd` names the build for you:

```ts
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as QuickJSWorkerd from "@smthrs/harness/QuickJSWorkerd"
import { Layer } from "effect"

const layer = QuickJSSandbox.layerWithVariant.pipe(Layer.provide(QuickJSWorkerd.variant))
```

- `variant` imports `#quickjs.wasm`, which this package's `imports` map to
  the separate-file build's `.wasm`. Alchemy's rolldown plugin and wrangler
  upload that file as a CompiledWasm module and hand the Worker its
  `WebAssembly.Module`; the Worker's own `package.json` names no QuickJS
  package.
- The import is dynamic and runs when the layer is built, inside the Worker,
  so a deploy tool that imports the Worker's modules in Node never loads it.
- `variantFrom(load)` takes another source of the compiled module. A load
  that fails is `SandboxError` with code `runtime_failed`.
- It is a subpath of its own, not part of the root entry, so a browser or
  Node bundle never meets the `.wasm` import.

`test/QuickJSWorkerd.workerd.test.ts` bundles `test/workerd/worker.ts` with
esbuild, keeps `#quickjs.wasm` a module of its own, and runs one cell in local
workerd through Miniflare.

## Name the build by hand

A worker can name its build itself, with the `.wasm` module its bundler
compiled:

```ts
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { Layer } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { newVariant } from "quickjs-emscripten-core"

const base = wasmfile as unknown as QuickJSSyncVariant

const layer = QuickJSSandbox.layerWithVariant.pipe(
  Layer.provide(QuickJSSandbox.layerVariant(newVariant(base, { wasmModule })))
)
```

The pieces:

- `@jitl/quickjs-wasmfile-release-sync` is the separate-file build, whose
  emscripten glue carries a `workerd` export condition. Its published types
  name the CommonJS declaration, so TypeScript models the import as
  `module.exports` while bundlers resolve the ESM variant; the assertion
  states the shape the runtime delivers.
- `@jitl/quickjs-wasmfile-release-sync/wasm` is the `.wasm` file as a module
  import, which is how wrangler hands a worker a compiled
  `WebAssembly.Module`.
- `newVariant(base, { wasmModule })` builds the variant. It only records the
  module; nothing instantiates until the sandbox compiles it, so module scope
  stays free of the work workerd forbids there.
- `QuickJSSandbox.layerVariant(variant)` provides the named build, and
  `layerWithVariant` is the sandbox over whichever build is in context.

The compiled module is cached per variant, so two sandboxes over one variant
share it. `QuickJSSandbox.layerVariantLive` provides the single-file default,
and `makeWithVariant` is the effectful constructor over the same seam.

## Run one cell in a worker

The worker below is the layer above plus one evaluation: it opens a realm,
runs a cell that calls a flow and completes, and returns the frame's outcome
as JSON. A `200` response carrying a `complete` transition means the realm
opened, the host bridge settled a call, and the transition came back.

```ts
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import * as Cell from "@smthrs/harness/Cell"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Sandbox from "@smthrs/harness/Sandbox"
import { Effect, Layer, Option } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { newVariant } from "quickjs-emscripten-core"

const base = wasmfile as unknown as QuickJSSyncVariant

const layer = QuickJSSandbox.layerWithVariant.pipe(
  Layer.provide(QuickJSSandbox.layerVariant(newVariant(base, { wasmModule })))
)

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

const call: Sandbox.Handler = () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: ["README.md"] }))

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
```

`main` names this file. The `CompiledWasm` rule explicitly matches the package's
extensionless `/wasm` export so Wrangler bundles it as a compiled module. The
`nodejs_compat` flag is on because the packages the harness imports for
canonical JSON and schema decoding reach Node builtins, even though the
harness itself reaches none:

```json
{
  "name": "harness-cell-worker",
  "main": "worker.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "rules": [
    {
      "type": "CompiledWasm",
      "globs": ["**/*.wasm", "@jitl/quickjs-wasmfile-release-sync/wasm"],
      "fallthrough": true
    }
  ]
}
```

Cell parsing and TypeScript type erasure run in JavaScript; they do not start a
native compiler process. The smoke fixture under `test/workerd` executes the
typed cell above and checks its exact completion output.

## What a failure here means

A worker that compiles the default single-file build dies at startup with the
runtime's refusal of `WebAssembly.compile` over bytes, which the sandbox
reports as a `SandboxError` of code `runtime_failed`. That failure means the
host named no build; the fix is the variant wiring above, not a limits
change. For the error taxonomy, see
[Troubleshooting](../troubleshooting.md).
