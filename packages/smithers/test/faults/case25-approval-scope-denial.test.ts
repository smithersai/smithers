/**
 * Case 25 — an approval authorises exactly what was reviewed, and nothing else.
 *
 * Unauthenticated callers and bearer callers without approval delegation are
 * refused over RPC. An authorized local operator is still bound by the exact
 * reviewed envelope, digest and single-decision token. The operator runs the
 * shipped CLI in another process against the served workspace.
 */
import { Control, ControlError } from "@smthrs/control"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { servedSuite } from "./harness/servedSuite.ts"
import { localDecision } from "./harness/serveProcess.ts"

const suite = servedSuite("case25")

beforeAll(() => suite.start(), 180_000)
afterAll(() => suite.stop())

const plan = Effect.gen(function*() {
  const control = yield* Control.Control
  return yield* control.plan({ flowId: "system/test", input: { case: "case25" } })
})

describe("case25 approval scope denial", () => {
  it("refuses a caller with no credential before it reaches the control plane", async () => {
    const exit = await suite.remoteWith({}, Effect.exit(plan))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(ControlError.Unauthorized)
    }
  })

  it("refuses a caller with the wrong credential", async () => {
    const exit = await suite.remoteWith({ credential: "not-the-token" }, Effect.exit(plan))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(ControlError.Unauthorized)
    }
  })

  it("refuses bearer decisions before disclosing target validation or resolution", async () => {
    await suite.remote(Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* plan
      const targets = [
        card.approval.target,
        { ...card.approval.target, digest: `${card.digest}-tampered` },
        {
          ...card.approval.target,
          envelope: { ...card.envelope, capabilities: [...card.envelope.capabilities, "fs:write *"] }
        }
      ]
      for (const target of targets) {
        const input = { ...card.approval, target }
        expect((yield* Effect.flip(control.approve(input)))._tag).toBe("/control/Unauthorized")
        expect((yield* Effect.flip(control.deny(input)))._tag).toBe("/control/Unauthorized")
      }
      const decision = yield* Effect.promise(() => localDecision(suite.server().root, "approve", card.approval))
      expect(decision, decision.stderr).toMatchObject({ status: 0 })
      expect((yield* Effect.flip(control.deny(card.approval)))._tag).toBe("/control/Unauthorized")
    }))
  })

  it("refuses a local approval whose envelope was edited after the card was read", async () => {
    const card = await suite.remote(plan)
    const outcome = await localDecision(suite.server().root, "approve", {
      ...card.approval,
      target: {
        ...card.approval.target,
        envelope: { ...card.envelope, capabilities: [...card.envelope.capabilities, "fs:write *"] }
      }
    })
    expect(outcome.status).toBe(1)
    expect(outcome.stdout + outcome.stderr).toContain("EnvelopeMismatch")
  })

  it("refuses a local approval quoting a digest the server never issued", async () => {
    const card = await suite.remote(plan)
    const outcome = await localDecision(suite.server().root, "approve", {
      ...card.approval,
      target: { ...card.approval.target, digest: `${card.digest}-tampered` }
    })
    expect(outcome.status).toBe(1)
    expect(outcome.stdout + outcome.stderr).toContain("PlanDigestMismatch")
  })

  it("refuses a second authorized decision on a token that is already resolved", async () => {
    const card = await suite.remote(plan)
    const approved = await localDecision(suite.server().root, "approve", card.approval)
    expect(approved, approved.stderr).toMatchObject({ status: 0 })
    const outcome = await localDecision(suite.server().root, "deny", {
      ...card.approval,
      idempotencyKey: `twice:${card.planId}`
    })
    expect(outcome.status).toBe(1)
    expect(outcome.stdout + outcome.stderr).toContain("AlreadyResolved")
  })
})
