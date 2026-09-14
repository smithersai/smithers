import { describe, expect, test } from "bun:test"
import { INFRA_NOT_YOUR_FAULT, refusalSentence } from "@smthrs/rpc/RefusalCopy"
import { clientRefusal, refusalOf } from "@smthrs/rpc/Refusal"
import { agentFailureText } from "./agentTools"

/*
 * What the chat model is told when something refuses.
 *
 * Before the failure registry the model got a sentence and nothing else, and
 * it guessed: it apologised to a user whose box request hit a FULL FLEET as
 * though they had asked for too much, and told a user sitting at their own
 * quota that Smithers was broken. Both guesses came from the same five words,
 * "service unavailable", because that was all there was to read.
 */
describe("the refusal the agent is handed", () => {
  const seamAnswer = (body: Record<string, unknown>, status: number, message: string) =>
    refusalSentence(refusalOf({ body, status, message }))

  test("a full fleet reaches the model as infra, with the words to say and the instruction not to retry", () => {
    const text = agentFailureText(seamAnswer({ code: "no_capacity", retry_after: 30 }, 503, "no sandbox slots are free"))
    expect(text).toContain("fault=infra")
    expect(text).toContain("code=no_capacity")
    expect(text).toContain("@fucory")
    expect(text).toContain("not their fault")
    expect(text).toContain("Do not retry it on a timer")
    /* plue's own words survive into the model's view of it. */
    expect(text).toContain("no sandbox slots are free")
  })

  test("an account at its own cap reaches the model as user fault, and is told NOT to say it isn't their fault", () => {
    const text = agentFailureText(seamAnswer({ code: "quota_exceeded" }, 429, "you already have 5 boxes running"))
    expect(text).toContain("fault=user")
    expect(text).toContain("code=quota_exceeded")
    expect(text).not.toContain("@fucory")
    expect(text).toContain("Never tell them it is not their fault")
  })

  test("a wait reaches the model as a wait, not as a failure to apologise for", () => {
    const text = agentFailureText(seamAnswer({ code: "guest_not_ready" }, 503, "service unavailable"))
    expect(text).toContain("fault=wait")
    expect(text).toContain("nothing is broken")
    expect(text).not.toContain("@fucory")
  })

  test("a bug is named as a bug, and the model is told not to blame the user for it", () => {
    const text = agentFailureText(seamAnswer({ code: "internal" }, 500, "internal server error"))
    expect(text).toContain("fault=bug")
    expect(text).toContain("Do not blame the user")
  })

  test("a refusal with no code in it is left alone — no verdict is better than a guessed one", () => {
    // The note fires only on a code the app itself wrote at the front of the
    // string. Ordinary prose, even prose containing a word that happens to be
    // one of plue's codes, gets nothing.
    expect(agentFailureText("failed: that repository has a conflict you need to resolve")).toBe(
      "failed: that repository has a conflict you need to resolve"
    )
    expect(agentFailureText("failed: the internal state was not found")).not.toContain("fault=")
  })

  test("the sign-in rewrite still happens, and now carries the fault beside it", () => {
    const signIn = agentFailureText("Sign in to Smithers Cloud first — /cloud.sign-in.")
    expect(signIn).toContain("cloud.prompt")
    const coded = agentFailureText(seamAnswer({ code: "unauthorized" }, 401, "sign in with /cloud.sign-in, or use a PAT"))
    expect(coded).toContain("cloud.prompt")
    expect(coded).toContain("fault=user")
  })
})

describe("a request that never got an answer", () => {
  /*
   * The tool-call leg in state/controller/turns.ts catches a throw from
   * executeForAgent. It used to build `failed: ${error.message}` — a string
   * with no verdict in it at all, which is the worst case of the guessing
   * above: nothing judged the request, so the model had the least evidence and
   * still had to decide whose fault it was.
   */
  test("classifies as an infra-class client refusal, not as a bare failure string", () => {
    const text = agentFailureText(refusalSentence(clientRefusal(new Error("Load failed"))))
    expect(text).not.toBe("failed: Load failed")
    expect(text).toContain("Load failed")
    expect(text).toContain(INFRA_NOT_YOUR_FAULT)
  })

  test("says it is not the user's fault, because nothing was in a position to judge them", () => {
    const refusal = clientRefusal(new Error("network error"))
    expect(refusal.fault).toBe("infra")
    expect(refusal.origin).toBe("client")
    expect(refusal.status).toBeNull()
  })
})
