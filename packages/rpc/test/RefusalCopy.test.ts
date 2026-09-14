import { describe, expect, test } from "vitest"
import { PLUE_FAILURES, PLUE_FAULTS } from "../src/PlueFailureCodes"
import type { PlueFailureCode } from "../src/PlueFailureCodes"
import { clientRefusal, refusalOf } from "../src/Refusal"
import {
  agentRefusalText,
  INFRA_NOT_YOUR_FAULT,
  REFUSAL_COPY,
  refusalCopy,
  refusalDoors,
  refusalLead
} from "../src/RefusalCopy"

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

  test("every one of plue's 95 codes resolves to a lead line and an agent sentence", () => {
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

  test("a client-side fetch failure gets it too — nothing judged the request, so it was not the user", () => {
    expect(refusalLead(clientRefusal(new Error("Load failed")))).toBe(INFRA_NOT_YOUR_FAULT)
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
