import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * Use the library from a browser bundle.
 *
 * Every import in this file comes from an entry point that the repository's
 * browser gate (`pnpm run browser`) bundles with esbuild `platform: "browser"`:
 * the `@smthrs/engine`, `@smthrs/keys`, `@smthrs/journal`, and
 * `@smthrs/platform-browser` roots never statically resolve a `node:`
 * built-in, because platform access lives in layers, and the Node and Bun
 * bundles are their own packages.
 *
 * The barrel `@smthrs/flows` and `@smthrs/engine-store` bundle for the browser
 * as well, and this file still imports the per-package roots: the barrel pulls
 * every engine package into the bundle, and the Node-only composition is the
 * `@smthrs/flows/NodeRuntime` subpath, which opens SQLite through `node:sqlite`.
 * The test for this example bundles the file itself for the browser and fails
 * if a Node-only import ever sneaks in.
 */
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { deriveKey } from "@smthrs/keys"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * The declared atom. A declaration is pure data, so it bundles for the browser
 * whether or not this bundle also carries an implementation for it, which is
 * the placement half of the declaration/implementation split.
 */
export const CompileTarget = Action.make("examples/CompileTarget", {
  payload: { target: Schema.String },
  success: Schema.String
})

export const Compile = Flow.make("examples/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ target }) => target,
  body: (payload) => CompileTarget.call(payload)
})

const CompileLayer = Layer.mergeAll(
  CompileTarget.toLayer(({ target }) => Effect.succeed(`built ${target}`)),
  Interpreter.layer(Compile)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory)
)

export interface Summary {
  readonly result: string
  readonly stepKey: string
}

export const main: Effect.Effect<Summary, never, (EffectDigest.Digest | SecureRandom.SecureRandom)> = Effect.gen(
  function*() {
    const result = yield* Compile.execute({ target: "web" })

    const key = yield* deriveKey({
      body: "examples/compile/v1",
      target: "web"
    })

    return { result, stepKey: key }
  }
).pipe(Effect.provide(CompileLayer), Effect.orDie)
