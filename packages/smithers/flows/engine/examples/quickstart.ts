/**
 * The quickstart, runnable: one flow on the in-memory engine, submitted twice
 * under one execution id, and then once more with a different payload under
 * the same id.
 *
 * The second submission joins the first run and answers with its recorded
 * result, so `compiles` stays at 1. The third is refused with
 * `ExecutionIdentityConflict`, because an execution id names one flow and one
 * payload.
 *
 * `test/examples.test.ts` runs it and checks every field it returns.
 *
 * @since 1.0.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto } from "@smthrs/crypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { FlowEngine } from "../src/index.ts"

const Compile = Action.make("build/Compile", {
  payload: { target: Schema.String },
  success: Schema.String
})

const Build = Flow.make("build/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

/**
 * Runs the quickstart and reports what the engine did.
 *
 * Each call builds a fresh in-memory engine, so the counter and the recorded
 * runs start empty.
 *
 * @returns The two joined results, how many times `Compile` ran, and the
 *   field the conflicting third submission was refused on.
 * @since 1.0.0
 */
export const runQuickstart = (): Promise<{
  readonly first: string
  readonly second: string
  readonly compiles: number
  readonly conflictField: string
}> => {
  let compiles = 0

  const BuildLayer = Layer.mergeAll(
    Compile.toLayer(({ target }) =>
      Effect.sync(() => {
        compiles = compiles + 1
        return `${target}.js`
      })
    ),
    Interpreter.layer(Build)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(Crypto.layerFromDigest(NodeCrypto.layerDigest))
  )

  const program = Effect.gen(function*() {
    const first = yield* Build.execute({ target: "app" }, { executionId: "build-app-1" })
    const second = yield* Build.execute({ target: "app" }, { executionId: "build-app-1" })
    const conflict = yield* Build.execute({ target: "lib" }, { executionId: "build-app-1" }).pipe(Effect.flip)
    if (!(conflict instanceof FlowEngine.ExecutionIdentityConflict)) {
      return yield* Effect.die(conflict)
    }
    return { first, second, compiles, conflictField: conflict.field }
  }).pipe(Effect.provide(BuildLayer))

  return Effect.runPromise(program)
}
