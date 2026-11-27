import type { CiJob } from "@smthrs/sandbox"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { RunJobResults } from "./RunJobResults"

test("checkout details show the recorded stage and exit code when available", () => {
  const render = (extra: { readonly checkoutFailure?: CiJob.CheckoutFailure; readonly exitCode: number | null }) =>
    renderToStaticMarkup(createElement(RunJobResults, { jobs: [{ name: "readiness", outcome: "failed", steps: [
      { name: "checkout", outcome: "failed", ...extra },
      { name: "check", outcome: "skipped", exitCode: null },
    ] }] }))
  const observed = render({ checkoutFailure: "verify", exitCode: 1 })
  expect(observed).toContain("Revision verification")
  expect(observed).toContain("Exit 1")
  for (const [code, label] of [
    [73, "Initialize repository"], [74, "Configure remote"],
    [75, "Fetch revision"], [76, "Write working copy"],
  ] as const) {
    const failed = render({ checkoutFailure: "clone", exitCode: code })
    expect(failed).toContain(label)
    expect(failed).toContain("Exit " + code)
  }
  expect(render({ checkoutFailure: "clone", exitCode: 72 })).toContain(">Checkout<")
  expect(render({ checkoutFailure: "other", exitCode: 75 })).not.toContain("Fetch revision")
  expect(render({ checkoutFailure: "clone", exitCode: null })).toContain(">Checkout<")
  const historic = render({ exitCode: null })
  expect(historic).toContain("checkout")
  expect(historic).toContain('data-status="failed"')
  expect(historic).toContain('data-status="skipped"')
  expect(historic).not.toContain("Revision verification")
  expect(historic).not.toContain("Exit ")
})
