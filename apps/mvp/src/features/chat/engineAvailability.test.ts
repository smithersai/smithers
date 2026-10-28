import { expect, test } from "vitest"
import { branchUnavailable, engineStopped } from "./engineAvailability"

test("only an unavailable engine disables flow actions; pending, network and sync failures do not", () => {
  expect(engineStopped(undefined)).toBe(false)
  for (const status of ["up", "offline", "failed"]) expect(engineStopped({ status })).toBe(false)
  expect(engineStopped({ status: "stopped" })).toBe(true)
})

test("a confirmed person keeps branch recovery guidance while offline, but visitors do not", () => {
  expect(branchUnavailable(true, { status: "unreachable" }, { role: "Member" })).toBe(true)
  expect(branchUnavailable(true, { status: "signed_in" }, undefined)).toBe(true)
  for (const status of ["loading", "signed_out", "unreachable"]) expect(branchUnavailable(true, { status }, undefined)).toBe(false)
  expect(branchUnavailable(true, undefined, undefined)).toBe(false)
  expect(branchUnavailable(true, { status: "signed_out" }, { role: "Member" })).toBe(false)
  expect(branchUnavailable(true, { status: "loading" }, { role: "Member" })).toBe(true)
  expect(branchUnavailable(false, { status: "signed_in" }, undefined)).toBe(false)
  expect(branchUnavailable(false, { status: "unreachable" }, { role: "Member" })).toBe(false)
})
