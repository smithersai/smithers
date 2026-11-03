import { expect, test } from "vitest"
import { redact, redactError } from "./redact"

// Each line is the shape of a Playwright request error's call log.
test("a request error's log loses every credential header's value and keeps the rest", () => {
  const log = [
    "apiRequestContext.post: connect ECONNRESET",
    "  - authorization: Bearer the-token",
    "  - Authorization: Bearer THE-TOKEN",
    "  - cookie: session=the-session",
    "  - set-cookie: session=the-session; Path=/",
    "  - accept: application/json",
  ].join("\n")
  const redacted = redact(log)
  expect(redacted).not.toMatch(/the-token|the-session/i)
  expect(redacted).toContain("apiRequestContext.post: connect ECONNRESET")
  expect(redacted).toContain("authorization: [redacted]")
  expect(redacted).toContain("accept: application/json")
})

test("an error loses them from its message and its stack", () => {
  const error = new Error("authorization: Bearer the-token")
  error.stack = "Error: authorization: Bearer the-token\n  at x"
  redactError(error)
  expect(`${error.message} ${error.stack}`).not.toContain("the-token")
})
