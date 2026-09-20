import { Control } from "@smthrs/control/Control"
import type { PlanCard } from "@smthrs/control/ControlSchema"
import { Projections } from "@smthrs/gateway/Projections"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { Engine, relayPrincipal, stackWith } from "./BridgedEngineRun.ts"

it("authors two source versions through engine copy-back, replans from disk, and runs the edited graph", { timeout: 120000 }, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const control = yield* Control
    const engine = yield* Engine
    const projections = yield* Projections
    const launch = (card: PlanCard) => Effect.gen(function*() {
      yield* control.approve({ ...card.approval, principal: relayPrincipal })
      const result = yield* control.run({ _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope, idempotencyKey: `run:${card.planId}` })
      if (result._tag !== "Accepted" || !result.runId) return yield* Effect.die("No accepted run")
      return result.runId
    })
    const author = yield* launch(yield* control.plan({ flowId: "create-flow", input: { args: "Build a flow" } }))
    expect(yield* engine.settled(author)).toBe("completed")
    const first = yield* control.plan({ flowId: "authoring-demo", input: {} })
    expect(first.nodes.some(node => node.id.endsWith(".read"))).toBe(true)
    expect(first.nodes.some(node => node.id.endsWith(".validate"))).toBe(false)
    const editor = yield* launch(yield* control.plan({ flowId: "create-flow", input: { args: "Add validation" } }))
    expect(yield* engine.settled(editor)).toBe("completed")
    const second = yield* control.plan({ flowId: "authoring-demo", input: {} })
    expect(second.nodes.some(node => node.id.endsWith(".validate"))).toBe(true)
    expect(second.digest).not.toBe(first.digest)
    // Editing the workspace must not change what an earlier approved plan runs.
    const oldRun = yield* launch(first)
    expect(yield* engine.settled(oldRun)).toBe("completed")
    const run = yield* launch(second)
    expect(yield* engine.settled(run)).toBe("completed")
    // Wait on the bridge's actual completion marker, not the control verdict.
    const records = yield* Effect.gen(function*() {
      for (let attempt = 0; attempt < 2000; attempt += 1) {
        const pages = yield* Effect.forEach([author, editor, oldRun, run], runId => projections.snapshot({ _tag: "run-events", runId }))
        if (pages.every(page => page.rows.some(row => row.kind === "control.engine.projection-settled"))) return pages.flatMap(page => page.rows)
        yield* Effect.sleep("2 millis")
      }
      return yield* Effect.die("authoring journal never drained")
    })
    const bridged = records.filter(row => row.kind === "control.engine.event").map(row => row.payload as { eventType: string; payload: { changedPaths: string[]; bundleIdentity: string } })
    const captures = bridged.filter(row => row.eventType === "flows.engine.diff-bundle-captured")
    const copies = bridged.filter(row => row.eventType === "flows.engine.copy-back-settled")
    expect(captures).toHaveLength(2)
    expect(copies).toHaveLength(2)
    expect(captures.map(row => row.payload.changedPaths)).toEqual([["flows/authoring-demo/flow.ts"], ["flows/authoring-demo/flow.ts"]])
    expect(copies.map(row => row.payload.bundleIdentity).sort()).toEqual(captures.map(row => row.payload.bundleIdentity).sort())
    // The fixture inlines the authored flow into its real agent/run wrapper.
    // Structural addresses therefore include that caller; action settlements
    // are the evidence that the source version actually executed.
    const actions = (runId: string) => records.filter(row => row.runId === runId && row.kind === "control.engine.event")
      .map(row => row.payload as { eventType: string; payload: { action?: string; outcome?: string } })
      .filter(row => row.eventType === "flows.engine.node-settled" && row.payload.outcome === "built")
      .map(row => row.payload.action)
    expect(actions(oldRun)).toContain("authoring/Read")
    expect(actions(oldRun)).not.toContain("authoring/Validate")
    expect(actions(run)).toContain("authoring/Validate")
  }).pipe(Effect.provide(stackWith({ authoring: true })))))
})
