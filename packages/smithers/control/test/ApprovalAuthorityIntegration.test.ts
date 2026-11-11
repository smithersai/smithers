import { Effect, type Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import type { ApprovalTarget, Principal } from "../src/ControlSchema.vibe"
import * as TestControl from "../src/test/TestControl.ts"
import { durable } from "./DurableStack.ts"

const agent: Principal = { id: "mcp", kind: "agent", stampedAt: 0 }
const operator: Principal = { id: "local", kind: "operator", stampedAt: 0 }

const prepare = (kind: "Plan" | "Node") =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: {} })
    if (kind === "Plan") return card.approval.target
    yield* control.approve({ ...card.approval, principal: operator })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "launch",
      principal: operator
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected run")
    const target: Extract<ApprovalTarget, { readonly _tag: "Node" }> = {
      _tag: "Node",
      runId: receipt.runId,
      requestId: "irreversible-action",
      digest: "ask",
      envelope: card.envelope
    }
    yield* runtime.registerApproval(target)
    yield* runtime.resume(receipt.runId)
    const fence = yield* runtime.claimFence(receipt.runId)
    yield* runtime.writeStatus(receipt.runId, fence, "waiting-approval")
    return target
  })

const stacks: ReadonlyArray<readonly [string, Layer.Layer<Control | ControlRuntime, unknown>]> = [
  ["memory", TestControl.layer()],
  ["SQL", durable()]
]

for (const [name, layer] of stacks) {
  describe(`${name} approval authority`, () => {
    for (const kind of ["Plan", "Node"] as const) {
      for (const decision of ["approve", "deny"] as const) {
        it.each(["once", "run", "remembered"] as const)(
          `${kind} ${decision}: refuses agent scope %s before writes`,
          async (scope) => {
            await Effect.runPromise(
              Effect.gen(function*() {
                const control = yield* Control
                const runtime = yield* ControlRuntime
                const target = yield* prepare(kind)
                const before = yield* runtime.grants
                const request = { target, scope, idempotencyKey: "decide", principal: agent }
                const error = yield* Effect.flip(control[decision](request))
                expect(error).toMatchObject({ _tag: "/control/Unauthorized", code: "unauthorized" })
                expect(yield* runtime.grants).toEqual(before)
                expect((yield* runtime.lookupApproval(target))._tag).toBe("Pending")
                if (target._tag === "Node") {
                  expect((yield* runtime.getRun(target.runId)).status).toBe("waiting-approval")
                  expect(yield* runtime.pendingResumes).toEqual([])
                }
                const receipt = yield* control[decision]({ ...request, principal: operator })
                expect(receipt._tag).toBe("Accepted")
                if (target._tag === "Node") {
                  expect((yield* runtime.registerApproval(target))._tag).toBe(
                    decision === "approve" ? "Approved" : "Denied"
                  )
                }
              }).pipe(Effect.provide(layer), Effect.scoped)
            )
          }
        )
      }

      it(`${kind}: refuses direct runtime resolution by an agent`, async () => {
        await Effect.runPromise(
          Effect.gen(function*() {
            const runtime = yield* ControlRuntime
            const target = yield* prepare(kind)
            const token = yield* runtime.lookupApproval(target)
            const error = yield* Effect.flip(runtime.resolveApproval(token, "approved", agent))
            expect(error).toMatchObject({ _tag: "/control/Unauthorized", code: "unauthorized" })
            expect((yield* runtime.lookupApproval(target))._tag).toBe("Pending")
            yield* runtime.resolveApproval(token, "approved", operator)
          }).pipe(Effect.provide(layer), Effect.scoped)
        )
      })
    }
  })
}

it("uses the runtime's agent principal when an approval omits attribution", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      const error = yield* Effect.flip(control.approve(card.approval))
      expect(error).toMatchObject({ code: "unauthorized" })
      expect(yield* runtime.grants).toEqual([])
    }).pipe(Effect.provide(TestControl.layer({ principal: agent })), Effect.scoped)
  )
})
