/**
 * `release/runbook` on the real engine: the real graph, the real approval flow
 * and `HumanTask` declaration, with the five step modules and the person
 * answering replaced by recording implementations.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Cut } from "../cut/flow.ts"
import { Pack } from "../pack/flow.ts"
import { Publish } from "../publish/flow.ts"
import { Rehearse } from "../rehearsal/flow.ts"
import { Smoke } from "../smoke/flow.ts"
import Release, { Request } from "./flow.ts"

/** Runs the runbook once; the person says yes to every prompt except one naming `deny`. */
const release = async (request: typeof Request.Type, executionId: string, deny?: string) => {
  const trace: Array<string> = []
  /** A step module's stand-in: it records the payload it was handed and succeeds. */
  const record = (name: string) => (payload: unknown) =>
    Effect.sync(() => void trace.push(`${name} ${JSON.stringify(payload)}`))
  const layer = Layer.mergeAll(
    Interpreter.layer(Release),
    HumanTask.action.toLayer(({ prompt }) =>
      Effect.sync(() => {
        trace.push(`ask ${prompt}`)
        return deny === undefined || !prompt.endsWith(deny)
      }), { override: true }),
    Cut.toLayer(record("cut"), { implementationVersion: Cut.implementationVersion }),
    Rehearse.toLayer(record("rehearse"), { implementationVersion: Rehearse.implementationVersion }),
    Pack.toLayer(record("pack"), { implementationVersion: Pack.implementationVersion }),
    Smoke.toLayer(record("smoke"), { implementationVersion: Smoke.implementationVersion }),
    Publish.toLayer(record("publish"), { implementationVersion: Publish.implementationVersion })
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  const runtime = ManagedRuntime.make(layer)
  try {
    const exit = await runtime.runPromiseExit(Release.execute(request, { executionId }))
    return { exit, trace }
  } finally {
    await runtime.dispose()
  }
}

test("an approved release cuts, rehearses, packs, smokes and publishes, asking before cut and publish", async () => {
  const { exit, trace } = await release({ version: "1.0.0" }, "runbook-approved")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(exit))
  assert.deepEqual(trace, [
    "ask release step: cut",
    "cut {\"version\":\"1.0.0\",\"commit\":true}",
    "rehearse {\"tag\":\"v1.0.0\"}",
    "pack {\"directory\":\"dist/release-packs\"}",
    "smoke {\"directory\":\"dist/release-packs\"}",
    "ask release step: publish",
    "publish {\"directory\":\"dist/release-packs\"}"
  ])
  assert.deepEqual(exit.value, {
    outputs: { cut: undefined, rehearse: undefined, pack: undefined, smoke: undefined, publish: undefined },
    ran: ["cut", "rehearse", "pack", "smoke", "publish"],
    skipped: []
  })
})

test("a declined publication fails the run as Denied after the candidate is smoked, and publishes nothing", async () => {
  const { exit, trace } = await release({ version: "1.0.0-rc.1", directory: "dist/rc" }, "runbook-denied", "publish")
  assert.ok(Exit.isFailure(exit))
  assert.match(JSON.stringify(exit.cause), /release\/runbook\/Denied/)
  assert.deepEqual(trace.at(-2), "smoke {\"directory\":\"dist/rc\"}")
  assert.deepEqual(trace.at(-1), "ask release step: publish")
})

test("a declined cut runs no step", async () => {
  const { exit, trace } = await release({ version: "1.0.0" }, "runbook-no-cut", "cut")
  assert.ok(Exit.isFailure(exit))
  assert.deepEqual(trace, ["ask release step: cut"])
})
