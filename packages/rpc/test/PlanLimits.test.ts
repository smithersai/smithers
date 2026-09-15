import { expect, test } from "vitest"
import { refusalOf, storedRefusal, refusalFromStored } from "../src/Refusal.ts"
import { refusalDoors, refusalLead } from "../src/RefusalCopy.ts"
import { SessionRefusalSchema } from "../src/Cards.ts"
import { machineReadableRefusal } from "../src/UpstreamProse.ts"

test("plan-limit metadata and upgrade copy survive the shared refusal boundary", () => {
  const body = { code: "plan_limit_exceeded", plan_key: "free", limit_kind: "sandbox_hours_per_day", upgrade_plan_key: "pro" }
  const refusal = refusalOf({ body: machineReadableRefusal(JSON.stringify(body)), status: 402, message: "Daily sandbox hours exhausted." })
  const restored = refusalFromStored(SessionRefusalSchema.parse(storedRefusal(refusal)))
  expect(restored).toMatchObject({ plan_key: "free", limit_kind: "sandbox_hours_per_day", upgrade_plan_key: "pro", rawCode: body.code })
  expect(refusalLead(restored)).toBe("Your plan is at its sandbox limit.")
  expect(refusalDoors(restored)).toEqual(["upgrade"])
  expect(refusalDoors(refusalOf({ body: { code: "quota_exceeded" }, status: 429, message: "cap" }))).toEqual([])
})
