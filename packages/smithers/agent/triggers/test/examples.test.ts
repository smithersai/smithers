import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { runQuickstart } from "../examples/quickstart.ts"

describe("examples", () => {
  // The quickstart page promises this exact output. The example is the same
  // program, so a behavior change that breaks the page breaks this test.
  it("quickstart launches the second boundary once and records it as the last fire", async () => {
    const { launched, registered } = await runQuickstart()
    expect(launched).toEqual([
      {
        flowId: "reports/nightly",
        input: { channel: "#ops" },
        idempotencyKey: "nightly-report:2026-03-02T03:00:00.000Z"
      }
    ])
    expect(Option.getOrThrow(registered)).toEqual({
      id: "nightly-report",
      flowId: "reports/nightly",
      input: { channel: "#ops" },
      cron: "0 3 * * *",
      timezone: "UTC",
      overlap: "skip",
      catchUp: "one",
      maxCatchUp: 1,
      enabled: true,
      revision: 1,
      registeredAt: Date.parse("2026-03-01T03:00:00.000Z"),
      lastFiredAt: Date.parse("2026-03-02T03:00:00.000Z")
    })
  })
})
