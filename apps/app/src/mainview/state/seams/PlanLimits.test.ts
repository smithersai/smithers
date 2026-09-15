import { expect, test } from "bun:test"
import { cloudFailure } from "./CloudClient"
import { refusalFromStored, storedRefusal } from "@smthrs/rpc/Refusal"
import { refusalDoors, refusalLead } from "@smthrs/rpc/RefusalCopy"
import { SessionRefusalSchema } from "@smthrs/rpc/Cards"
import { machineReadableRefusal } from "@smthrs/rpc/UpstreamProse"
import { platformProxyMatch } from "../../../../../server/src/proxies"

test("plan-limit fields survive the proxy, CloudClient, and persisted card", async () => {
  const body = { code: "plan_limit_exceeded", plan_key: "free", limit_kind: "concurrent_sandboxes", upgrade_plan_key: "pro" }
  const forwarded = machineReadableRefusal(JSON.stringify(body))
  const failure = await cloudFailure(Response.json({ ...forwarded, message: "Suspend one or upgrade." }, { status: 402 }), "fallback")
  const refusal = refusalFromStored(SessionRefusalSchema.parse(storedRefusal(failure.refusal)))
  expect(refusal).toMatchObject({ ...body, rawCode: body.code, fault: "user" , code: null })
  expect(refusalLead(refusal)).toBe("Your plan is at its sandbox limit.")
  expect(refusalDoors(refusal)).toEqual(["upgrade"])
})

test("malformed optional plan fields are dropped", async () => {
  const failure = await cloudFailure(Response.json({ code: "plan_limit_exceeded", plan_key: 1, limit_kind: {}, upgrade_plan_key: false }, { status: 402 }), "limit")
  expect(failure.refusal.plan_key).toBeUndefined()
  expect(failure.refusal.limit_kind).toBeUndefined()
  expect(failure.refusal.upgrade_plan_key).toBeUndefined()
})

test("only billing overview and catalog GETs join the platform proxy", () => {
  for (const path of ["/api/billing", "/api/billing/plans"]) {
    expect(platformProxyMatch(path, "GET")).toBe(true)
    expect(platformProxyMatch(path, "POST")).toBe(false)
  }
  expect(platformProxyMatch("/api/billing/balance", "GET")).toBe(false)
})
