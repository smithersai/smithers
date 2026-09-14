import { describe, expect, test } from "vitest"
import { PLUE_FAILURES, PLUE_FAULTS } from "../src/PlueFailureCodes.ts"
import type { PlueFailureCode } from "../src/PlueFailureCodes.ts"
import { clientRefusal, mayAutoRetry, refusalOf, workerRefusal } from "../src/Refusal.ts"
import {
  agentRefusalText,
  INFRA_NOT_YOUR_FAULT,
  NOTHING_ANSWERED,
  REFUSAL_COPY,
  refusalCopy,
  refusalDoors,
  refusalLead
} from "../src/RefusalCopy.ts"
import { WORKER_FAILURE_CODES } from "../src/WorkerFailureCodes.ts"
import type { WorkerFailureCode } from "../src/WorkerFailureCodes.ts"

/** A refusal exactly as plue answers for this code, through its own registry row. */
const forCode = (code: PlueFailureCode, message = "plue's own words") =>
  refusalOf({ body: { code, fault: PLUE_FAILURES[code].fault }, status: PLUE_FAILURES[code].status, message })

describe("the copy table", () => {
  test("every fault has a row, and every row says something", () => {
    for (const fault of PLUE_FAULTS) {
      const row = REFUSAL_COPY[fault]
      expect(row.lead, fault).not.toBe("")
      expect(row.agent, fault).toContain(`fault=${fault}`)
    }
    expect(Object.keys(REFUSAL_COPY).sort()).toEqual([...PLUE_FAULTS].sort())
  })

  test("every one of plue's codes resolves to a lead line and an agent sentence", () => {
    // The exhaustiveness that matters at runtime: the table is keyed by fault,
    // so a code plue adds is covered the moment it has a registry row — and a
    // code whose fault somehow has no row would surface here rather than as a
    // blank line in front of a user.
    for (const code of Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>) {
      const copy = refusalCopy(forCode(code))
      expect(copy.lead, code).not.toBe("")
      expect(copy.agent, code).not.toBe("")
    }
  })

  test("a busy build cache is a wait with a stated pace, never the caller's request to change", () => {
    // plue's build cache refuses with 429 when the CACHE is at its own
    // concurrency ceiling, not the caller's budget. The Worker proxy forwards
    // `code` and `retry_after` but drops `fault`, so a build that predates the
    // code guesses from the status and tells the reader to change a request
    // that works unchanged a second later.
    expect(PLUE_FAILURES.build_cache_busy).toEqual({ fault: "wait", status: 429, retryAfter: 1 })
    const refusal = refusalOf({
      body: { code: "build_cache_busy", retry_after: 1 },
      status: 429,
      message: "build cache is busy"
    })
    expect(refusal.code).toBe("build_cache_busy")
    expect(refusal.fault).toBe("wait")
    expect(refusal.origin).toBe("plue")
    expect(mayAutoRetry(refusal)).toBe(true)
    expect(refusalLead(refusal)).toBe(REFUSAL_COPY.wait.lead)
    expect(refusalDoors(refusal)).toEqual(["retry"])
    expect(agentRefusalText(refusal)).toContain("fault=wait")
    expect(agentRefusalText(refusal)).not.toContain("@fucory")
  })

  test("each fault renders its own lead line", () => {
    const leads = PLUE_FAULTS.map((fault) => REFUSAL_COPY[fault].lead)
    expect(new Set(leads).size).toBe(PLUE_FAULTS.length)
  })
})

describe("the infra line", () => {
  test("appears for no_capacity, names @fucory, and says it is not the user's fault", () => {
    const lead = refusalLead(forCode("no_capacity", "no sandbox slots are free"))
    expect(lead).toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).toContain("not your fault")
    expect(lead).toContain("@fucory")
    expect(lead).toContain("infra")
  })

  test("does NOT appear for quota_exceeded — that one is the account's own cap", () => {
    const refusal = forCode("quota_exceeded", "you already have 5 boxes running")
    expect(refusal.fault).toBe("user")
    expect(refusalLead(refusal)).not.toContain("@fucory")
    expect(refusalLead(refusal)).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(agentRefusalText(refusal)).not.toContain("@fucory")
    expect(agentRefusalText(refusal)).toContain("Never tell them it is not their fault")
  })

  test("appears for every infra code in the registry and for no code outside it", () => {
    for (const code of Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>) {
      const carriesInfraLine = refusalLead(forCode(code)).includes("@fucory")
      expect(carriesInfraLine, code).toBe(PLUE_FAILURES[code].fault === "infra")
    }
  })

  /*
   * The line says one thing — our fleet is full and somebody has to buy more.
   * A fetch that never got an answer is `infra` by fault, because nobody
   * judged the request, but it is not that failure and we are in no position
   * to claim it is: nothing answered, so nothing is known about the fleet.
   */
  test("does NOT appear for a fetch nothing answered — that is the connection, and we cannot see our own fleet from there", () => {
    const refusal = clientRefusal(new Error("Load failed"))
    expect(refusal.fault).toBe("infra")
    const lead = refusalLead(refusal)
    expect(lead).toBe(NOTHING_ANSWERED)
    expect(lead).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).not.toContain("@fucory")
    expect(lead).not.toContain("ran out")
    /* Still says plainly that it was not the reader, and still offers the way on. */
    expect(lead).toContain("not something you did")
    expect(refusalDoors(refusal)).toEqual(["retry"])
    /* And there is nothing to report to us: we were never reached. */
    expect(refusalDoors(refusal)).not.toContain("report")
  })

  test("the model is corrected too: it must not claim we ran out when nothing answered", () => {
    const text = agentRefusalText(clientRefusal(new Error("Load failed")))
    expect(text).toContain("origin=client")
    expect(text).toContain("fault=infra")
    expect(text).toContain("Do NOT say Smithers ran out of infra")
    expect(text).not.toContain("@fucory")
    expect(text).toContain("worth trying again")
  })
})

/*
 * The desktop app's own host answers the same `/api/cloud/*` routes the Worker
 * does, under the same codes. Only the noun in the sentence differs, and
 * "this deployment" is wrong for a program on the reader's own laptop.
 */
describe("a refusal the native host wrote", () => {
  const local = (code: WorkerFailureCode, message: string) => workerRefusal(code, message, { origin: "local" })

  test("is told apart from the Worker's, which is the point of widening origin", () => {
    expect(local("seam_not_configured", "x").origin).toBe("local")
    expect(workerRefusal("seam_not_configured", "x").origin).toBe("worker")
  })

  test("never talks about a deployment, or about whoever deployed it", () => {
    for (const code of ["deployment_not_configured", "seam_not_configured"] as const) {
      const lead = refusalLead(local(code, "x"))
      expect(lead).toContain("This build")
      expect(lead).not.toContain("deployment")
      expect(lead).not.toContain("deployed")
      expect(lead).not.toContain("@fucory")
      expect(lead).toContain("Not your fault")
      const agent = agentRefusalText(local(code, "x"))
      expect(agent).toContain("origin=local")
      expect(agent).toContain("do NOT say Smithers ran out of infra")
      /* Told in as many words not to send the reader after a deployment that does not exist. */
      expect(agent).toMatch(/never tell them to contact whoever deployed it|do not refer to a deployment/u)
    }
  })

  test("keeps the Worker's wording for every code that has no local rewording", () => {
    for (const code of WORKER_FAILURE_CODES) {
      if (code === "deployment_not_configured" || code === "seam_not_configured") continue
      expect(refusalLead(local(code, "x"))).toBe(refusalLead(workerRefusal(code, "x")))
    }
  })

  test("is read back off the wire from the origin it states, not guessed from its code", () => {
    const refusal = refusalOf({
      body: { status: "error", code: "feature_unavailable_here", origin: "local" },
      status: 501,
      message: "The cloud seam is disabled in this build."
    })
    expect(refusal.origin).toBe("local")
    /* An origin nobody states, or one outside the closed set, still reads as the Worker's. */
    expect(refusalOf({ body: { code: "feature_unavailable_here" }, status: 501, message: "x" }).origin).toBe("worker")
    expect(
      refusalOf({ body: { code: "feature_unavailable_here", origin: "somewhere" }, status: 501, message: "x" }).origin
    ).toBe("worker")
  })
})

describe("doors", () => {
  test("a stopped box offers resume, a dead session offers sign-in, a wait offers retry", () => {
    expect(refusalDoors(forCode("desktop_not_running"))).toContain("resume")
    expect(refusalDoors(forCode("unauthorized"))).toContain("sign-in")
    expect(refusalDoors(forCode("desktop_not_ready"))).toContain("retry")
  })

  test("report is offered for infra and bug, and is not offered for a user fault", () => {
    expect(refusalDoors(forCode("no_capacity"))).toContain("report")
    expect(refusalDoors(forCode("internal"))).toContain("report")
    expect(refusalDoors(forCode("quota_exceeded"))).not.toContain("report")
  })
})

describe("the agent's tool result", () => {
  test("carries the fault class, the code and the pacing as machine facts", () => {
    const text = agentRefusalText(
      refusalOf({
        body: { code: "no_capacity", fault: "infra", retry_after: 30 },
        status: 503,
        message: "no sandbox slots are free"
      })
    )
    expect(text.startsWith("failed: ")).toBe(true)
    expect(text).toContain("fault=infra")
    expect(text).toContain("code=no_capacity")
    expect(text).toContain("status=503")
    expect(text).toContain("retry_after=30s")
    expect(text).toContain("origin=plue")
    // plue's own words survive into the model's view of it.
    expect(text).toContain("no sandbox slots are free")
    expect(text).toContain("@fucory")
  })

  test("a fetch that threw is told to the model as infra, not as a bare failure string", () => {
    const text = agentRefusalText(clientRefusal(new Error("Load failed")))
    expect(text).toContain("fault=infra")
    expect(text).toContain("origin=client")
    expect(text).toContain("Load failed")
    // The old shape was exactly `failed: Load failed`, with no verdict in it.
    expect(text).not.toBe("failed: Load failed")
  })

  test("every fault produces a distinct instruction to the model", () => {
    const sentences = PLUE_FAULTS.map((fault) => REFUSAL_COPY[fault].agent)
    expect(new Set(sentences).size).toBe(PLUE_FAULTS.length)
  })
})
