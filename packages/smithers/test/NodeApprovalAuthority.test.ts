import { ApprovalAuthority, ControlRuntime, type ControlSchema } from "@smthrs/control"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import { Registry } from "@smthrs/registry"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

for (const discovered of [false, true]) {
  it(`durable Node composition forwards host principal and independent delegation (${discovered ? "registry" : "system"} catalog)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-host-authority-"))
    const principal = { id: "explicit-host-reviewer", kind: "user" }
    const approvalAuthority = await Effect.runPromise(ApprovalAuthority.make([
      { principal, scopes: ["once"], targets: ["Plan"] }
    ]))
    try {
      const engine = NodeControl.engineDurable(root, discovered ? Registry.layerNoop() : undefined, {
        principal,
        approvalAuthority,
        credential: "explicit-host-test-credential"
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          const actor = yield* runtime.stampPrincipal()
          expect(actor).toMatchObject(principal)
          const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
          const token = yield* runtime.lookupApproval(card.approval.target)
          expect(
            (yield* Effect.flip(runtime.resolveApproval(token, "approved", {
              ...NodeGateway.bearerPrincipal,
              stampedAt: 1
            }, "once")))._tag
          ).toBe("/control/Unauthorized")
          expect((yield* Effect.flip(runtime.resolveApproval(token, "approved", actor, "remembered")))._tag).toBe(
            "/control/Unauthorized"
          )
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
          yield* runtime.resolveApproval(token, "approved", actor, "once")
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("approved")
        }).pipe(Effect.provide(engine.runtime), Effect.scoped)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const credential of [undefined, "", "gateway-authority-test-credential"]) {
  it(`delegates gateway decisions only when a nonempty credential is configured (${String(credential)})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-gateway-authority-"))
    try {
      const engine = NodeControl.engineDurable(root, undefined, { credential })
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
          const targets: ReadonlyArray<ControlSchema.ApprovalTarget> = [
            card.approval.target,
            {
              _tag: "Node",
              runId: "policy-run",
              requestId: "policy-request",
              digest: card.digest,
              envelope: card.envelope
            }
          ]
          for (
            const principal of [
              { id: "local", kind: "operator", stampedAt: 1 },
              { ...NodeGateway.bearerPrincipal, stampedAt: 1 },
              { id: "another-caller", kind: "bearer", stampedAt: 1 }
            ]
          ) {
            const allowed = principal.id === "local" || (principal.id === "gateway" && Boolean(credential))
            for (const target of targets) {
              for (const scope of ["once", "run", "remembered"] as const) {
                for (const decision of ["approved", "denied"] as const) {
                  const authorization = runtime.authorizeApproval({ principal, target, scope, decision })
                  if (allowed) yield* authorization
                  else expect((yield* Effect.flip(authorization))._tag).toBe("/control/Unauthorized")
                }
              }
            }
          }
        }).pipe(Effect.provide(engine.runtime), Effect.scoped)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
