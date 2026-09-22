import { expect, it } from "@effect/vitest"
import { renderDiagnostic } from "../src/internal/Diagnostic.ts"

it("redacts sensitive fields before traversing object and array values", () => {
  const secret = "sensitive-container-XYZ123"
  const value = { token: { value: secret }, password: [secret], apiKey: { message: secret } }
  expect(renderDiagnostic(value)).not.toContain(secret)
  expect(JSON.parse(renderDiagnostic(value))).toEqual({
    token: "[REDACTED]",
    password: "[REDACTED]",
    apiKey: "[REDACTED]"
  })
})

it("never traverses a proxy stored under a sensitive field", () => {
  let calls = 0
  const secret = new Proxy({}, {
    getOwnPropertyDescriptor: () => {
      calls++
      throw new Error("private")
    }
  })
  expect(renderDiagnostic({ token: secret })).toBe("{\"token\":\"[REDACTED]\"}")
  expect(calls).toBe(0)
})
