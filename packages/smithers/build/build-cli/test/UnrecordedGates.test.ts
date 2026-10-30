import { expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"
import { requireRecorded, UnrecordedGates } from "../src/internal/UnrecordedGates.ts"

it("keeps the missing gate identities and their operator diagnostic in a typed refusal", () => {
  const message = "Affected gates were never planned: //b:test, //c:test"
  let error: unknown
  try {
    requireRecorded(["//a:test", "//b:test", "//c:test"], { results: [{ label: "//a:test" }] })
  } catch (cause) {
    error = cause
  }
  expect(error).toBeInstanceOf(UnrecordedGates)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({
    _tag: "smithers-build/UnrecordedGates",
    labels: ["//b:test", "//c:test"],
    message
  })
  expect(Diagnostic.present(error, { verbose: false })).toBe(message)
  expect(Diagnostic.present(error, { verbose: true })).toBe(message)
})

it("accepts a receipt for every selected gate, including an empty selection", () => {
  expect(requireRecorded(["//a:test", "//b:test"], {
    results: [{ label: "//b:test" }, { label: "//a:test" }, { label: "//other:test" }]
  })).toBeUndefined()
  expect(requireRecorded([], { results: [] })).toBeUndefined()
})

it("retains the planned-execution diagnostic through the same typed guard", () => {
  const prefix = "Planned targets have no execution record"
  expect(() => requireRecorded(["//a:test"], { results: [] }, prefix)).toThrow(
    "Planned targets have no execution record: //a:test"
  )
  expect(requireRecorded(["//a:test"], { results: [{ label: "//a:test" }] }, prefix)).toBeUndefined()
})
