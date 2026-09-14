import { describe, expect, test } from "vitest"
import { PLUE_FAILURE_CODES, PLUE_FAILURES } from "../src/PlueFailureCodes.ts"
import {
  faultOfStatus,
  isWorkerFailureCode,
  mayAutoRetry,
  refusalCode,
  refusalEntry,
  refusalFromStored,
  refusalOf,
  storedRefusal,
  workerRefusal
} from "../src/Refusal.ts"
import {
  agentFaultNote,
  agentRefusalText,
  INFRA_NOT_YOUR_FAULT,
  refusalDoors,
  refusalLead,
  refusalSentence,
  WORKER_REFUSAL_COPY
} from "../src/RefusalCopy.ts"
import { WORKER_FAILURE_CODES, WORKER_FAILURES, workerFailureCode } from "../src/WorkerFailureCodes.ts"

/*
 * The Cloudflare Worker's own refusals. plue's registry is generated and
 * vendored; this one is written by hand, and these are the properties that
 * keep the two from colliding, from drifting apart in shape, or from reaching
 * a person with a sentence nobody wrote for them.
 */
describe("the Worker's own failure registry", () => {
  test("shares no code with plue's, which is what lets one string name its author", () => {
    const shared = WORKER_FAILURE_CODES.filter((code) => Object.hasOwn(PLUE_FAILURES, code))
    expect(shared).toEqual([])
  })

  test("stays sorted and free of duplicates, so a new code lands in one obvious place", () => {
    expect([...WORKER_FAILURE_CODES]).toEqual([...new Set(WORKER_FAILURE_CODES)].sort())
  })

  test("answers the same three questions per row as plue's", () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      expect(Object.keys(entry).sort()).toEqual(["fault", "retryAfter", "status"])
      expect(PLUE_FAILURES[PLUE_FAILURE_CODES[0]].fault).toBeTypeOf("string")
      expect(entry.status).toBeGreaterThanOrEqual(400)
      expect(entry.retryAfter).toBeGreaterThanOrEqual(0)
    }
  })

  test("names a written lead for every code — an unwritten one does not compile, and is not blank either", () => {
    for (const code of WORKER_FAILURE_CODES) {
      expect(WORKER_REFUSAL_COPY[code].lead.trim()).not.toBe("")
    }
    expect(Object.keys(WORKER_REFUSAL_COPY).sort()).toEqual([...WORKER_FAILURE_CODES])
  })

  test("reads a code back to its own table and never to plue's", () => {
    for (const code of WORKER_FAILURE_CODES) {
      expect(workerFailureCode(code)).toBe(code)
      expect(refusalCode(code)).toBe(code)
      expect(isWorkerFailureCode(code)).toBe(true)
      expect(refusalEntry(code)).toEqual(WORKER_FAILURES[code])
    }
    expect(workerFailureCode("no_capacity")).toBeNull()
    expect(isWorkerFailureCode("no_capacity")).toBe(false)
  })
})

describe("a Worker refusal as it reaches the app", () => {
  test("carries the Worker's own code, its documented fault, and origin=worker", () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      const refusal = refusalOf({ body: { status: "error", code }, status: entry.status, message: "nope" })
      expect(refusal.code).toBe(code)
      expect(refusal.rawCode).toBe(code)
      expect(refusal.fault).toBe(entry.fault)
      expect(refusal.origin).toBe("worker")
    }
  })

  test("is built the same way on both sides: workerRefusal takes status and fault from the table", () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      const built = workerRefusal(code, "nope")
      expect(built.status).toBe(entry.status)
      expect(built.fault).toBe(entry.fault)
      expect(built.origin).toBe("worker")
      expect(built).toEqual(
        refusalOf({
          body: { status: "error", code, ...(entry.retryAfter > 0 ? { retry_after: entry.retryAfter } : {}) },
          status: entry.status,
          message: "nope"
        })
      )
    }
  })

  test("survives a round trip through a card's stored shape", () => {
    const refusal = workerRefusal("deployment_not_configured", "CEREBRAS_API_KEY is unset.")
    expect(refusalFromStored(storedRefusal(refusal))).toEqual(refusal)
  })

  test("beats the status guess it used to get: a 501 is infra here, not the bug faultOfStatus reads", () => {
    expect(faultOfStatus(501)).toBe("bug")
    expect(workerRefusal("deployment_not_configured", "x").fault).toBe("infra")
  })

  test("is never retried on a timer unless the Worker said to wait and said how long", () => {
    for (const code of WORKER_FAILURE_CODES) {
      const refusal = workerRefusal(code, "x")
      expect(mayAutoRetry(refusal)).toBe(WORKER_FAILURES[code].fault === "wait" && refusal.retryAfter !== null)
    }
  })
})

describe("what a person is told about a Worker refusal", () => {
  /*
   * The product owner's infra line names ONE failure: the fleet is full and
   * somebody has to buy more. No refusal the Worker writes is that failure —
   * `no_capacity` is plue's — so borrowing the sentence here would send a
   * reader to the wrong person about the wrong problem.
   */
  test("never borrows the capacity line for a failure that is not a full fleet", () => {
    for (const code of WORKER_FAILURE_CODES) {
      const refusal = workerRefusal(code, "x")
      expect(refusalLead(refusal)).not.toContain("@fucory")
      expect(agentRefusalText(refusal)).not.toContain("@fucory")
    }
  })

  test("a misconfigured deployment is infra, says so, and says the honest thing about it", () => {
    const refusal = workerRefusal("deployment_not_configured", "CHAT_URL is not configured on this deployment.")
    expect(refusal.fault).toBe("infra")
    const lead = refusalLead(refusal)
    expect(lead).toBe(
      "This deployment of Smithers isn't fully set up. Not your fault — and not something you can fix from here; whoever deployed it has to finish wiring it."
    )
    expect(lead).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).not.toContain("ran out")
    expect(lead).toContain("Not your fault")
    /* The words the deployment wrote still reach the reader, underneath. */
    expect(refusalSentence(refusal)).toContain("CHAT_URL is not configured on this deployment.")
    const agent = agentRefusalText(refusal)
    expect(agent).toContain("fault=infra")
    expect(agent).toContain("origin=worker")
    expect(agent).toContain("do NOT say Smithers ran out of infra")
  })

  test("an absent seam gets the same audience and the same refusal to mention capacity", () => {
    const refusal = workerRefusal("seam_not_configured", "Repository actions need the identity seam.")
    expect(refusal.fault).toBe("infra")
    expect(refusalLead(refusal)).toContain("doesn't have the piece that answers this")
    expect(refusalLead(refusal)).not.toContain("ran out")
  })

  test("opens the doors each refusal actually has", () => {
    expect(refusalDoors(workerRefusal("sign_in_required", "x"))).toContain("sign-in")
    expect(refusalDoors(workerRefusal("session_expired", "x"))).toContain("sign-in")
    expect(refusalDoors(workerRefusal("route_not_found", "x"))).toEqual([])
    expect(refusalDoors(workerRefusal("account_not_allowlisted", "x"))).toEqual([])
    /* The report door stays carried and unattached: no surface renders it yet. */
    expect(refusalDoors(workerRefusal("deployment_not_configured", "x"))).toContain("report")
    expect(refusalDoors(workerRefusal("unexpected_failure", "x"))).toContain("report")
  })

  test("tells the chat model the fault class for a Worker code, not only a plue one", () => {
    const note = agentFaultNote("deployment_not_configured — CHAT_URL is not configured on this deployment.")
    expect(note).toContain("[fault=infra code=deployment_not_configured]")
    expect(note).not.toContain("@fucory")
    expect(agentFaultNote("turn_rate_limited — that is 10 turns today.")).toContain("[fault=wait")
    /* Still reads plue's vocabulary, and still refuses to guess from English. */
    expect(agentFaultNote("no_capacity — no sandbox slots are free.")).toContain("[fault=infra code=no_capacity]")
    expect(agentFaultNote("something went wrong")).toBeNull()
  })

  test("keeps the two infra audiences apart, which is the whole reason origin exists", () => {
    const fleetFull = refusalOf({ body: { code: "no_capacity", fault: "infra" }, status: 503, message: "full" })
    const misconfigured = workerRefusal("deployment_not_configured", "unset")
    expect(fleetFull.origin).toBe("plue")
    expect(misconfigured.origin).toBe("worker")
    expect(fleetFull.fault).toBe(misconfigured.fault)
    expect(refusalLead(fleetFull)).not.toBe(refusalLead(misconfigured))
    expect(refusalLead(fleetFull)).toContain("@fucory")
  })
})
