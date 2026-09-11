/**
 * Skyframe-style incremental invalidation over a persistent driver: a cached
 * action and its downstream graph, re-executed by FRESH engine instances over
 * one durable log. An unchanged read set replays the recorded artifact into
 * the dependent; a changed read-set digest dirties the key, the action
 * rebuilds, and the dependent recomputes on the new artifact; a failing
 * rebuild propagates its typed error to the run and the dependent never
 * dispatches.
 *
 * At the engine seam, dirty→recheck→rebuild collapses to key-based
 * invalidation: the hermetic boundary descriptor is cache-key material, so a
 * changed digest can never hit the stale row (the store-side re-measure
 * before serving a hit — `StepBoundary.prepare` — lives in engine-store, not
 * here).
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"
import { effect } from "./Harness.ts"

const environment: Action.CacheEnvironment = {
  layers: ["Model=fixed"],
  capabilities: {}
}

describe("incremental invalidation across engine instances", () => {
  effect("hits on an unchanged read set, rebuilds on a changed one, and recomputes the dependent", () => {
    const log = makeLog()
    let builds = 0
    const packaged: Array<number> = []

    /** The sealed cross-run-cacheable action, declared over one read set. */
    const build = (digest: string) =>
      Action.make({
        name: "Invalidate/build",
        success: Schema.Number,
        error: Schema.String,
        idempotencyKey: "invalidate/artifact",
        metadata: {
          readSet: [{ path: "src/input.ts", digest }],
          writeSet: ["out/artifact"],
          boundaryMode: "hard"
        },
        execute: Effect.suspend(() => {
          builds++
          return digest.startsWith("bad")
            ? Effect.fail("input-unreadable")
            : Effect.succeed(builds * 10)
        })
      })
    const buildDeclaration = Action.make("Invalidate/build/step", {
      payload: { digest: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const packDeclaration = Action.make("Invalidate/pack/step", {
      payload: { artifact: Schema.Number },
      success: Schema.String
    })
    const flow = Flow.make("Invalidate/pipeline", {
      payload: { digest: Schema.String },
      success: Schema.String,
      error: Schema.String,
      body: ({ digest }) =>
        buildDeclaration.call({ digest }).pipe(
          Node.bindPlanned((artifact) => packDeclaration.call({ artifact }))
        )
    })
    const stack = Layer.mergeAll(
      buildDeclaration.toLayer(({ digest }) => build(digest)),
      packDeclaration.toLayer(({ artifact }) =>
        Effect.sync(() => {
          packaged.push(artifact)
          return `packed:${artifact}`
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerDurable(log)),
      Layer.provideMerge(Action.layerCacheEnvironment(environment))
    )

    /** Each run is a FRESH engine instance over the shared log. */
    const run = (executionId: string, digest: string) =>
      flow.execute({ digest }, { executionId }).pipe(Effect.exit, Effect.provide(stack))

    return Effect.gen(function*() {
      // Run 1: cold — the action builds and the dependent packs its output.
      const first = yield* run("invalidate-run-1", "d1")
      expect(Exit.isSuccess(first) && first.value).toBe("packed:10")
      expect(builds).toBe(1)
      expect(packaged).toEqual([10])

      // Run 2, new engine instance, same read set: the cached artifact
      // replays — no rebuild — and the run-local dependent recomputes ON the
      // recorded value.
      const second = yield* run("invalidate-run-2", "d1")
      expect(Exit.isSuccess(second) && second.value).toBe("packed:10")
      expect(builds).toBe(1)
      expect(packaged).toEqual([10, 10])

      // Run 3, changed digest: the key is dirty, the action rebuilds, and
      // the dependent recomputes on the NEW artifact.
      const third = yield* run("invalidate-run-3", "d2")
      expect(Exit.isSuccess(third) && third.value).toBe("packed:20")
      expect(builds).toBe(2)
      expect(packaged).toEqual([10, 10, 20])
    })
  })

  effect("propagates a failed rebuild to the run and never dispatches the dependent", () => {
    const log = makeLog()
    let builds = 0
    const packaged: Array<number> = []
    const build = (digest: string) =>
      Action.make({
        name: "Invalidate/failing-build",
        success: Schema.Number,
        error: Schema.String,
        idempotencyKey: "invalidate/failing-artifact",
        metadata: {
          readSet: [{ path: "src/input.ts", digest }],
          writeSet: ["out/artifact"],
          boundaryMode: "hard"
        },
        execute: Effect.suspend(() => {
          builds++
          return Effect.fail("input-unreadable")
        })
      })
    const buildDeclaration = Action.make("Invalidate/failing-build/step", {
      payload: { digest: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const packDeclaration = Action.make("Invalidate/failing-pack/step", {
      payload: { artifact: Schema.Number },
      success: Schema.String
    })
    const flow = Flow.make("Invalidate/failing-pipeline", {
      payload: { digest: Schema.String },
      success: Schema.String,
      error: Schema.String,
      body: ({ digest }) =>
        buildDeclaration.call({ digest }).pipe(
          Node.bindPlanned((artifact) => packDeclaration.call({ artifact }))
        )
    })
    const stack = Layer.mergeAll(
      buildDeclaration.toLayer(({ digest }) => build(digest)),
      packDeclaration.toLayer(({ artifact }) =>
        Effect.sync(() => {
          packaged.push(artifact)
          return `packed:${artifact}`
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerDurable(log)),
      Layer.provideMerge(Action.layerCacheEnvironment(environment))
    )
    const run = (executionId: string) =>
      flow.execute({ digest: "d1" }, { executionId }).pipe(Effect.exit, Effect.provide(stack))

    return Effect.gen(function*() {
      // The failed build is the run's typed error; the dependent is
      // downstream of the dead value and never dispatches.
      const first = yield* run("failing-run-1")
      expect(Exit.isFailure(first)).toBe(true)
      expect(Exit.isFailure(first) && Cause.squash(first.cause)).toBe("input-unreadable")
      expect(builds).toBe(1)
      expect(packaged).toEqual([])

      // A later engine instance replays the RECORDED failure for the same
      // key: the error propagates again without a re-execution.
      const second = yield* run("failing-run-2")
      expect(Exit.isFailure(second)).toBe(true)
      expect(Exit.isFailure(second) && Cause.squash(second.cause)).toBe("input-unreadable")
      expect(builds).toBe(1)
      expect(packaged).toEqual([])
    })
  })
})
