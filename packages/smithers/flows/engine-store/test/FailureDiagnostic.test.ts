import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { expect, it } from "vitest"
import { bound, record, site, withinState } from "../src/internal/FailureDiagnostic.ts"
import * as HostReflection from "../src/internal/HostReflection.ts"

it("contains throwing proxy metadata on portable hosts without native proxy detection", () => {
  let reads = 0
  const value = new Proxy({ executionId: "run", attempts: 1 }, {
    getOwnPropertyDescriptor() {
      reads++
      throw new Error("untrusted metadata")
    }
  })
  expect(site(value, HostReflection.make(undefined))).toBeUndefined()
  expect(reads).toBe(1)
  expect(site(value)).toBeUndefined()
  expect(reads).toBe(1)
})

it("ignores inherited and accessor coordinates and normalizes invalid attempt counts", () => {
  let reads = 0
  expect(site({
    executionId: "run",
    attempts: 0,
    get action() {
      reads++
      throw new Error("untrusted getter")
    }
  }))
    .toEqual({ executionId: "run", attempts: null })
  expect(reads).toBe(0)
  for (const attempts of [null, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(site({ executionId: "run", attempts })).toEqual({ executionId: "run", attempts: null })
  }
  expect(site({ executionId: "run", attempts: "1" })).toBeUndefined()
  expect(site(Object.create({ executionId: "inherited", attempts: 1 }))).toBeUndefined()
  expect(site({ executionId: "run", attempts: 2, action: "step", nodeId: "node" }))
    .toEqual({ executionId: "run", attempts: 2, action: "step", nodeId: "node" })
})

it("keeps optional coordinates without manufacturing a primary failure", () => {
  const coordinates = { executionId: "run", attempts: 2, action: "step" }
  expect(JSON.parse(withinState("{\"version\":1}", undefined, [coordinates])))
    .toEqual({ version: 1, failureSites: [coordinates] })
  expect(bound({ tag: "Refused", message: "refused", attempts: null, retryable: false }))
    .toEqual({ tag: "Refused", message: "refused", attempts: null, retryable: false })
})

it("does not invent a primary failure for an empty failure cause", () => {
  expect(record(Exit.failCause(Cause.empty), "empty")).toBeUndefined()
})
