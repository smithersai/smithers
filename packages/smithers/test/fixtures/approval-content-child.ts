import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { Control } from "@smthrs/control/Control"
import type { PlanCard } from "@smthrs/control/ControlSchema"
import { ModelError } from "@smthrs/model/ModelError"
import { RequestExecutor } from "@smthrs/model/RequestExecutor"
import { Cause, Effect, Exit, Layer } from "effect"
import { RpcSerialization } from "effect/unstable/rpc"
import { readFileSync } from "node:fs"
import * as Application from "../../src/Application.ts"
import * as NodeControl from "../../src/NodeControl.ts"

const [action, root, cardFile] = process.argv.slice(2)
if (root === undefined) throw new Error("Expected an action and project root")
const captured: Array<{ model: string; original: boolean; changed: boolean }> = []
const registry = NodeControl.layerRegistry(root)
const engine = NodeControl.engineDurable(root, registry)
const transport = Layer.succeed(RequestExecutor, {
  execute: (request, options) =>
    Effect.suspend(() => {
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      captured.push({
        model: options.modelId,
        original: body.includes("ORIGINAL_APPROVED_PROMPT"),
        changed: body.includes("CHANGED_UNAPPROVED_PROMPT")
      })
      return Effect.fail(
        new ModelError({ code: "invalid_request", message: "Offline test stopped before network dispatch" })
      )
    })
})
const executor = action === "plan" ? undefined : NodeControl.layerExecutor(registry, engine, root, {
  environment: { ANTHROPIC_API_KEY: "synthetic-offline-test", OPENAI_API_KEY: "synthetic-offline-test" },
  grants: NodeControl.layerGrantStore(root),
  requestExecutor: transport
})
const result = await Effect.runPromise(
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId: "review", input: { args: "same input" } })
    if (action === "plan") {
      yield* control.approve(card.approval)
      return { pid: process.pid, card }
    }
    if (cardFile === undefined) throw new Error("Expected the original plan card")
    const original = JSON.parse(readFileSync(cardFile, "utf8")) as PlanCard
    const exit = yield* Effect.exit(control.run({
      _tag: "Plan",
      planId: original.planId,
      digest: original.digest,
      envelope: original.envelope,
      idempotencyKey: "original-approved-run"
    }))
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as { readonly _tag?: string; readonly message?: string }
      return { pid: process.pid, card, error: { _tag: failure._tag, message: failure.message }, captured }
    }
    for (let i = 0; i < 200 && captured.length === 0; i++) yield* Effect.sleep("25 millis")
    const receipt = exit.value
    if ("runId" in receipt && receipt.runId !== undefined) {
      yield* control.cancel({ runId: receipt.runId, idempotencyKey: "fixture-cleanup" })
    }
    return { pid: process.pid, card, receipt, captured }
  }).pipe(
    Effect.provide(
      Application.layer({}, registry, engine, executor).pipe(Layer.provide([
        NodeHttpClient.layerUndici,
        NodeSocket.layerWebSocket("ws://127.0.0.1"),
        RpcSerialization.layerNdjson
      ]))
    ),
    Effect.scoped,
    Effect.timeout("20 seconds")
  )
)
process.stdout.write(`APPROVAL_CONTENT_RESULT:${JSON.stringify(result)}\n`)
