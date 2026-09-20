import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlRuntime } from "@smthrs/control"
import { Deferred, Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

it("Application.Config.health reaches the real scoped native control host and closes its probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-health-host-"))
  let called = 0
  let finalized = 0
  try {
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    // Park one durable run before opening the production executor; an operator park is stable.
    const preparation = Application.layer({}, registry, engine).pipe(Layer.provideMerge(engine.runtime))
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        yield* control.approve({ ...card.approval, idempotencyKey: "native-health-approve" })
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "native-health-run"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("run missing")
        yield* runtime.resume(receipt.runId)
        const fence = yield* runtime.claimFence(receipt.runId)
        yield* runtime.writeStatus(receipt.runId, fence, "parked")
      }).pipe(
        Effect.provide(preparation as Layer.Layer<Control.Control | ControlRuntime.ControlRuntime>),
        Effect.scoped
      )
    )
    const began = Deferred.makeUnsafe<void>()
    const config: Application.Config = {
      root,
      health: {
        checkers: [{
          id: "native-test",
          probe: (context) =>
            Effect.gen(function*() {
              expect(context.summary?.flowId).toBe("system/test")
              called += 1
              yield* Deferred.succeed(began, undefined)
              return yield* Effect.never
            }).pipe(Effect.ensuring(Effect.sync(() => {
              finalized += 1
            })))
        }],
        bindings: { "system/test": { checkerId: "native-test" } }
      }
    }
    await Effect.runPromise(
      Deferred.await(began).pipe(
        Effect.provide(NodeControl.layerControl({ ...config, evaluator: ScriptedJudge.layer }, registry, engine)),
        Effect.scoped,
        Effect.timeout("30 seconds")
      )
    )
    expect(called).toBe(1)
    expect(finalized).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it("remote client composition does not admit or execute local health configuration", async () => {
  let called = false
  await Effect.runPromise(
    Effect.asVoid(Control.Control).pipe(
      Effect.provide(NodeControl.layerControl({
        remote: "http://127.0.0.1:1",
        health: {
          // Local startup would reject these limits; a remote client leaves them to its remote host.
          limits: { maxSubjects: 0 },
          checkers: [{
            id: "never-local",
            probe: () =>
              Effect.sync(() => {
                called = true
                return { activity: "unknown" as const }
              })
          }]
        }
      })),
      Effect.scoped
    )
  )
  expect(called).toBe(false)
})
