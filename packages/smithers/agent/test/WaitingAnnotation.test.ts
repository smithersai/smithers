import { describe, expect, it } from "vitest"
import { waitingAnnotation } from "../src/internal/WaitingAnnotation.ts"

describe("waiting annotation", () => {
  it("keeps the earliest durable timer wake on an unrequested poll", () => {
    expect(waitingAnnotation("parked", [{ dueAtMs: 90 }, { dueAtMs: 40 }]))
      .toEqual({ reason: "timer", wakeAt: 40 })
  })

  it("keeps approval and event parks distinct from timers", () => {
    expect(waitingAnnotation("waiting-approval", [])).toEqual({ reason: "approval" })
    expect(waitingAnnotation("parked", [])).toEqual({ reason: "event" })
  })
})
