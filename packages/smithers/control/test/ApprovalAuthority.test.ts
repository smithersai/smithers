import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as ApprovalAuthority from "../src/ApprovalAuthority.ts"

const envelope = { capabilities: [], flows: [], budget: {} }
const actor = { id: "agent-with-delegation", kind: "agent" }
const principal = { ...actor, stampedAt: 0 }
const target = { _tag: "Plan" as const, planId: "plan", digest: "digest", envelope }
const request: ApprovalAuthority.Request = { principal, target, decision: "approved", scope: "once" }

describe("explicit approval authority", () => {
  it("does not turn an actor's kind or authentication into approval authority", async () => {
    // The in-memory test adapter's identity is not a production approver: a
    // caller that names kind "test" gets no authority from the local policy.
    for (
      const actor of [
        principal,
        { ...principal, kind: "operator" },
        { ...principal, kind: "bearer" },
        { id: "memory", kind: "test", stampedAt: 10 }
      ]
    ) {
      const error = await Effect.runPromise(
        Effect.flip(ApprovalAuthority.local.authorize({ ...request, principal: actor }))
      )
      expect(error._tag).toBe("/control/Unauthorized")
    }
    for (const actor of [{ id: "local", kind: "operator" }]) {
      await Effect.runPromise(ApprovalAuthority.local.authorize({ ...request, principal: { ...actor, stampedAt: 10 } }))
    }
  })

  it("binds exact scopes to exact target kinds without granting a cross product", async () => {
    const policy = await Effect.runPromise(ApprovalAuthority.make([
      { principal: actor, scopes: ["once"], targets: ["Plan"] },
      { principal: actor, scopes: ["run"], targets: ["Node"] },
      { principal: actor, scopes: ["run"], targets: ["Node"] }
    ]))
    for (const kind of ["Plan", "Node"] as const) {
      const current = kind === "Plan"
        ? target
        : { _tag: "Node" as const, runId: "run", requestId: "ask", digest: "digest", envelope }
      for (const scope of ["once", "run", "remembered"] as const) {
        const result = await Effect.runPromise(Effect.exit(policy.authorize({ ...request, target: current, scope })))
        expect(result._tag).toBe(
          (kind === "Plan" && scope === "once") || (kind === "Node" && scope === "run") ? "Success" : "Failure"
        )
      }
      await Effect.runPromise(
        policy.authorize({ ...request, target: current, decision: "denied", scope: "remembered" })
      )
    }
  })

  it("snapshots configuration and keeps identity tuple boundaries distinct", async () => {
    const grants: Array<ApprovalAuthority.Delegation> = [{
      principal: { ...actor },
      scopes: ["once"],
      targets: ["Plan"]
    }]
    const policy = await Effect.runPromise(ApprovalAuthority.make(grants))
    grants.push({ principal: { id: "another", kind: "agent" }, scopes: ["remembered"], targets: ["Plan"] })
    Object.assign(grants[0]!.principal, { id: "mutated" })
    // Use the original identity after mutating the caller's object too.
    await Effect.runPromise(
      policy.authorize({ ...request, principal: { id: "agent-with-delegation", kind: "agent", stampedAt: 1 } })
    )
    const error = await Effect.runPromise(
      Effect.flip(policy.authorize({ ...request, principal: { id: "another", kind: "agent", stampedAt: 1 } }))
    )
    expect(error._tag).toBe("/control/Unauthorized")
    const tuples = await Effect.runPromise(ApprovalAuthority.make([
      { principal: { id: "a:b", kind: "c" }, scopes: ["once"], targets: ["Plan"] }
    ]))
    expect(
      (await Effect.runPromise(
        Effect.exit(tuples.authorize({ ...request, principal: { id: "a", kind: "b:c", stampedAt: 1 } }))
      ))._tag
    ).toBe("Failure")
  })

  it("refuses malformed or oversized delegation configuration without disclosing it", async () => {
    const valid = { principal: { id: "RAW-SECRET", kind: "agent" }, scopes: ["once"], targets: ["Plan"] }
    for (
      const input of [
        [{ ...valid, unknown: true }],
        [{ ...valid, scopes: [] }],
        [{ ...valid, scopes: ["all"] }],
        [{ ...valid, targets: [] }],
        [{ ...valid, targets: ["Unknown"] }],
        [{ ...valid, principal: { id: "", kind: "agent" } }],
        Array.from({ length: 1025 }, () => valid)
      ]
    ) {
      const error = await Effect.runPromise(Effect.flip(ApprovalAuthority.make(input as never)))
      expect(error._tag).toBe("/control/InvalidInput")
      expect(JSON.stringify(error)).not.toContain("RAW-SECRET")
    }
    const empty = await Effect.runPromise(ApprovalAuthority.make([]))
    expect((await Effect.runPromise(Effect.exit(empty.authorize(request))))._tag).toBe("Failure")
    await Effect.runPromise(ApprovalAuthority.make(Array.from({ length: 1024 }, () => valid) as never))
  })
})
