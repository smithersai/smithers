import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { RunJobResults } from "./RunJobResults"

test("checkout details show the recorded stage and exit code when available", () => {
  const render = (extra: { readonly checkoutFailure?: "verify"; readonly exitCode: number | null }) =>
    renderToStaticMarkup(createElement(RunJobResults, { jobs: [{ name: "readiness", outcome: "failed", steps: [
      { name: "checkout", outcome: "failed", ...extra },
      { name: "check", outcome: "skipped", exitCode: null },
    ] }] }))
  const observed = render({ checkoutFailure: "verify", exitCode: 1 })
  expect(observed).toContain("Revision verification")
  expect(observed).toContain("Exit 1")
  const historic = render({ exitCode: null })
  expect(historic).toContain("checkout")
  expect(historic).toContain('data-status="failed"')
  expect(historic).toContain('data-status="skipped"')
  expect(historic).not.toContain("Revision verification")
  expect(historic).not.toContain("Exit ")
})
