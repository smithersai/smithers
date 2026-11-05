import { NodeCrypto } from "@effect/platform-node"
import { ApprovalAuthority, ControlRuntime } from "@smthrs/control"
import { PersistenceError, Unauthorized } from "@smthrs/control/ControlError"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { targetsInstall } from "../src/internal/backend/Destination.ts"
import * as NodeControl from "../src/NodeControl.ts"

const home = mkdtempSync(join(tmpdir(), "smithers-control-triage-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const environment = { HOME: home, XDG_CONFIG_HOME: home }

describe("#4309 credential-only destination routing", () => {
  it.each([
    { SMITHERS_TOKEN_FILE: join(home, "absent-token") },
    { SMITHERS_TOKEN: "routing-test-token" },
    { SMITHERS_TOKEN_FILE: join(home, "absent-token"), SMITHERS_TOKEN: "routing-test-token" }
  ])("keeps local list and run inspection local with %j", (credential) => {
    const runtime = { environment: { ...environment, ...credential } }
    expect(targetsInstall({ args: {}, options: {} }, runtime)).toBe(false)
    expect(targetsInstall({ args: { run: "run-1" }, options: {} }, runtime)).toBe(false)
  })

  it("uses a configured origin and preserves explicit routing precedence", () => {
    const runtime = { environment: { ...environment, SMITHERS_URL: "https://smithers.example" } }
    expect(targetsInstall({ args: {}, options: {} }, runtime)).toBe(true)
    expect(targetsInstall({ args: { run: "run-1" }, options: {} }, runtime)).toBe(false)
    expect(targetsInstall({ args: {}, options: { root: home, cloud: true } }, runtime)).toBe(false)
    expect(targetsInstall({ args: {}, options: { repo: "owner/repo" } }, { environment })).toBe(true)
    expect(targetsInstall({ args: {}, options: { cloud: true } }, { environment })).toBe(true)
  })

  it("routes a saved install without requiring credentials", () => {
    const saved = join(home, "saved")
    mkdirSync(join(saved, "smithers"), { recursive: true })
    writeFileSync(join(saved, "smithers", "config.toon"), "api_origin: https://smithers.example\n")
    expect(targetsInstall({ args: {}, options: {} }, {
      environment: { ...environment, XDG_CONFIG_HOME: saved }
    })).toBe(true)
  })
})

const operator = { id: "local", kind: "operator", stampedAt: 1 }
const envelope = { capabilities: [], flows: [], budget: {} }

describe("#4242 scoped human-wait authority", () => {
  it.each(["memory", "sqlite"] as const)("checks the recorded flow and exact wait in %s", async (adapter) => {
    const policy = await Effect.runPromise(ApprovalAuthority.make([
      { principal: operator, scopes: ["once"], targets: ["Plan"] },
      { principal: operator, scopes: ["once"], targets: ["Node"], flowId: "system/test", waitName: "question/1" }
    ].map((delegation) => ({ ...delegation, principal: { id: operator.id, kind: operator.kind } }))))
    const layer = adapter === "memory"
      ? ControlRuntime.layerMemory({ approvalAuthority: policy })
      : NodeControl.engineDurable(join(home, "scoped-authority"), undefined, { approvalAuthority: policy }).runtime
    const program = Effect.gen(function*() {
      const runtime = yield* ControlRuntime.ControlRuntime
      const launch = (flowId: string) =>
        Effect.gen(function*() {
          const { card } = yield* runtime.plan({ flowId, input: {} })
          const token = yield* runtime.lookupApproval(card.approval.target)
          yield* runtime.resolveApproval(token, "approved", operator, "once")
          const result = yield* runtime.launch(card.planId, card.digest, card.envelope)
          if (result._tag !== "Started") throw new Error("expected launch")
          return result.run.runId
        })
      const allowed = yield* launch("system/test")
      const other = yield* launch("system/target")
      for (
        const [runId, waitName, scope, expected] of [
          [allowed, "question/1", "once", "Success"],
          [allowed, "question/2", "once", "Failure"],
          [other, "question/1", "once", "Failure"],
          [allowed, "question/1", "remembered", "Failure"]
        ] as const
      ) {
        const exit = yield* Effect.exit(runtime.authorizeApproval({
          principal: operator,
          target: { _tag: "Node", runId, requestId: waitName, digest: "wait-token", envelope },
          scope,
          decision: "approved"
        }))
        expect(exit._tag).toBe(expected)
      }
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(NodeCrypto.layer), Effect.scoped))
  })
})

it("#4242 verifies named proof on every decision and fails closed on revoked or unavailable proof", async () => {
  const delegation = {
    principal: { id: operator.id, kind: operator.kind },
    scopes: ["once" as const],
    targets: ["Node" as const],
    waitName: "question/1",
    requiredProof: "person-passkey"
  }
  const request = {
    principal: operator,
    target: { _tag: "Node" as const, runId: "run-proof", requestId: "question/1", digest: "token-1", envelope },
    scope: "once" as const,
    decision: "approved" as const
  }
  const absent = await Effect.runPromise(ApprovalAuthority.make([delegation]))
  expect((await Effect.runPromise(Effect.flip(absent.authorize(request))))._tag).toBe("/control/Unauthorized")
  let outcome: "valid" | "revoked" | "unavailable" = "valid"
  const checks: string[] = []
  const policy = await Effect.runPromise(ApprovalAuthority.make([delegation], {
    verifyProof: (name, decision) =>
      Effect.suspend(() => {
        checks.push(name)
        expect(decision.target).toEqual(request.target)
        if (outcome === "unavailable") {
          return Effect.fail(new PersistenceError({ operation: "proof", message: "offline" }))
        }
        if (outcome === "revoked") return Effect.fail(new Unauthorized({ message: "revoked" }))
        return Effect.void
      })
  }))
  await Effect.runPromise(policy.authorize(request))
  outcome = "revoked"
  expect((await Effect.runPromise(Effect.flip(policy.authorize(request))))._tag).toBe("/control/Unauthorized")
  outcome = "unavailable"
  expect((await Effect.runPromise(Effect.flip(policy.authorize(request))))._tag).toBe("/control/PersistenceError")
  expect(
    (await Effect.runPromise(Effect.flip(policy.authorize({ ...request, principal: { ...operator, id: "agent" } }))))
      ._tag
  )
    .toBe("/control/Unauthorized")
  expect(checks).toEqual(["person-passkey", "person-passkey", "person-passkey"])
})
