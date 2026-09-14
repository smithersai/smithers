import { describe, expect, test } from "bun:test"
import { agentRefusalText, INFRA_NOT_YOUR_FAULT, refusalSentence } from "@smthrs/rpc/RefusalCopy"
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

/*
 * The Cloudflare Worker answers about a third of what a person sees refused
 * without plue ever seeing it — no session, no such route, a body past the
 * ceiling, a secret this deployment never set. Those used to reach the model
 * as prose with no verdict on it at all, which is the same guessing problem
 * one layer down: "not configured on this deployment" reads like something the
 * user did until somebody says whose problem it is.
 */
describe("a refusal the Worker wrote itself", () => {
  const workerAnswer = (code: string, status: number, message: string) =>
    refusalSentence(refusalOf({ body: { status: "error", code }, status, message }))

  test("a misconfigured deployment reaches the model as infra — and never as a full fleet", () => {
    const text = agentFailureText(
      workerAnswer("deployment_not_configured", 501, "The chat seam is not configured on this deployment (CHAT_URL).")
    )
    expect(text).toContain("fault=infra")
    expect(text).toContain("code=deployment_not_configured")
    expect(text).not.toContain("@fucory")
    /* Told in as many words NOT to reach for the capacity sentence, which is about a different failure. */
    expect(text).toContain("do NOT say Smithers ran out of infra")
    expect(text).toContain("this deployment is misconfigured")
    expect(text).toContain("whoever deployed it")
    /* The deployment's own words survive into the model's view of it. */
    expect(text).toContain("CHAT_URL")
  })

  test("a signed-out caller is a user fault with a door, not a platform failure", () => {
    const text = agentFailureText(workerAnswer("sign_in_required", 401, "Sign in to run a Smithers turn."))
    expect(text).toContain("fault=user")
    expect(text).toContain("code=sign_in_required")
    expect(text).not.toContain("@fucory")
  })

  test("an upstream that never answered is a dependency, so the model does not tell the user to change the ask", () => {
    const text = agentFailureText(
      workerAnswer("upstream_unreachable", 502, "Smithers Cloud chat is unreachable: connection refused")
    )
    expect(text).toContain("fault=dependency")
    expect(text).toContain("Not the user's doing")
  })

  test("a spent turn budget is a wait, and the model is told not to loop on it", () => {
    const text = agentFailureText(workerAnswer("turn_rate_limited", 429, "That is 20 turns today without signing in."))
    expect(text).toContain("fault=wait")
    expect(text).toContain("Nothing is broken")
    expect(text).not.toContain("@fucory")
  })

  test("the Worker's 500 is named a bug, the same as plue's", () => {
    const text = agentFailureText(
      workerAnswer("unexpected_failure", 500, "Smithers could not complete this request. Try again in a moment.")
    )
    expect(text).toContain("fault=bug")
    expect(text).toContain("Do not blame the user")
  })

  test("the tool result carries the verdict as machine facts, origin included", () => {
    const refusal = refusalOf({
      body: { status: "error", code: "deployment_not_configured" },
      status: 501,
      message: "The chat seam is not configured on this deployment (CHAT_URL)."
    })
    const text = agentRefusalText(refusal)
    expect(text).toContain("fault=infra")
    expect(text).toContain("code=deployment_not_configured")
    expect(text).toContain("status=501")
    expect(text).toContain("origin=worker")
    expect(text.startsWith("failed: ")).toBe(true)
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
