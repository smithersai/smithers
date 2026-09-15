/**
 * Reading one parked execution as a wait a person can end.
 *
 * Two readers produce these rows and they must agree: the control plane's own
 * SQL runtime, when it shares a database with the engine, and the executor's
 * observation port, when it does not — which is what a deployed host runs.
 * This is the one definition both call.
 */
import * as Sha256 from "@smthrs/crypto/Sha256"
import { describe, expect, it } from "vitest"
import * as ControlExecutor from "../src/ControlExecutor.ts"

/** A durable deferred token: base64 of `[flowName, executionId, deferredName]`. */
const token = (deferredName: string): string =>
  globalThis.btoa(JSON.stringify(["coding/PreparePlan", "execution-1", deferredName]))

const base = { runId: "execution-1", reason: ControlExecutor.humanWaitReason, createdAt: 42 }

describe("pendingWaitOf", () => {
  it("names the question and the attempt a HumanTask parked on", () => {
    expect(ControlExecutor.pendingWaitOf({
      ...base,
      flowId: "coding/PreparePlan",
      token: token("WaitFor/coding-clarification#1"),
      request: { kind: "ask", prompt: "Which service?" }
    })).toEqual({
      runId: "execution-1",
      flowId: "coding/PreparePlan",
      reason: "approval",
      token: token("WaitFor/coding-clarification#1"),
      tokenDigest: Sha256.digestSync(token("WaitFor/coding-clarification#1")),
      name: "coding-clarification",
      attempt: 1,
      request: { kind: "ask", prompt: "Which service?" },
      createdAt: 42
    })
  })

  it("names a plain WaitFor gate, which has no attempt", () => {
    const row = ControlExecutor.pendingWaitOf({ ...base, token: token("WaitFor/sign-off") })
    expect(row).toMatchObject({ name: "sign-off" })
    expect(row === undefined ? "unread" : Object.keys(row)).not.toContain("attempt")
    // Nothing was declared about the question, so nothing is claimed about it.
    expect(row === undefined ? "unread" : Object.keys(row)).not.toContain("request")
    expect(row === undefined ? "unread" : Object.keys(row)).not.toContain("flowId")
  })

  it("is not a wait a person can end when it is not an approval park", () => {
    expect(ControlExecutor.pendingWaitOf({ ...base, reason: "timer", token: token("WaitFor/later") }))
      .toBeUndefined()
  })

  it("is not answerable when the park recorded no wait address", () => {
    for (const absent of [null, undefined]) {
      expect(ControlExecutor.pendingWaitOf({ ...base, token: absent })).toBeUndefined()
    }
  })

  it("still travels when the token names nothing this plane can read", () => {
    // The token is the durable address either way, so the wait stays
    // answerable; only the name a person was asked under is missing.
    for (
      const opaque of [
        "not-base64-at-all!!",
        globalThis.btoa("not json"),
        globalThis.btoa(JSON.stringify(["flow", "execution-1", 7])),
        token("DurableQueue/items"),
        token("WaitFor/release#not-a-number"),
        token("WaitFor/release#0")
      ]
    ) {
      const row = ControlExecutor.pendingWaitOf({ ...base, token: opaque })
      expect(row?.token).toBe(opaque)
      expect(row?.reason).toBe("approval")
    }
    // A `#` suffix that is not an attempt leaves the whole point as the name.
    expect(ControlExecutor.pendingWaitOf({ ...base, token: token("WaitFor/release#x") })?.name)
      .toBe("release#x")
    expect(ControlExecutor.pendingWaitOf({ ...base, token: globalThis.btoa("not json") })?.name)
      .toBeUndefined()
  })
})

describe("answerableWait", () => {
  const envelope = { capabilities: [], flows: [], budget: {} }

  it("reads a human wait out of the payload the projection published", () => {
    // The projection publishes the durable wait token as the digest and the
    // wait point's own name as the request id, which is all a decision needs
    // to tell a question from a grant.
    expect(ControlExecutor.answerableWait({
      _tag: "Node",
      runId: "run-1",
      requestId: "coding-clarification#1",
      digest: token("WaitFor/coding-clarification#1"),
      envelope
    })).toEqual({ name: "coding-clarification#1", token: token("WaitFor/coding-clarification#1") })
  })

  it("is not a question when the digest is an ordinary request digest", () => {
    // A capability gate: the run asked the control plane for permission, and a
    // registered approval token decides it.
    for (
      const digest of [
        "9829dcfa757bfd57477cac4b52b51a1377da9d31e1d6adb6de9e76f22784ed8a",
        globalThis.btoa("not json"),
        token("DurableQueue/items")
      ]
    ) {
      expect(ControlExecutor.answerableWait({ _tag: "Node", runId: "run-1", requestId: "gate", digest, envelope }))
        .toBeUndefined()
    }
  })

  it("is not a question when the target is a plan", () => {
    expect(ControlExecutor.answerableWait({
      _tag: "Plan",
      planId: "plan-1",
      digest: token("WaitFor/coding-clarification#1"),
      envelope
    })).toBeUndefined()
  })
})
