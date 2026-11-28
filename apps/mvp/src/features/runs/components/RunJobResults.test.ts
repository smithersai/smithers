import type { CiJob } from "@smthrs/sandbox"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { RunJobResults } from "./RunJobResults"

test("checkout details show the recorded stage, transport cause and exit code when available", () => {
  const render = (extra: {
    readonly checkoutFailure?: CiJob.CheckoutFailure
    readonly checkoutTransportCause?: CiJob.CheckoutTransportCause
    readonly checkoutHttpStatus?: CiJob.CheckoutHttpStatus
    readonly exitCode: number | null
  }) =>
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
  for (const [cause, status, label] of [
    ["http_status", 502, "HTTP 502"],
    ["http_status", undefined, "HTTP error"],
    ["dns", undefined, "DNS error"],
    ["missing_object", undefined, "Missing object"],
    ["pack_storage", undefined, "Pack or storage"],
    ["interrupted", undefined, "Interrupted"],
    ["unknown", undefined, "Unknown cause"],
  ] as const) {
    const failed = render({
      checkoutFailure: "clone",
      exitCode: 75,
      checkoutTransportCause: cause,
      ...(status === undefined ? {} : { checkoutHttpStatus: status }),
    })
    expect(failed).toContain("Fetch revision")
    expect(failed).toContain(`>${label}<`)
    expect(failed).toContain("Exit 75")
  }
  expect(render({ checkoutFailure: "clone", exitCode: 72 })).toContain(">Checkout<")
  expect(render({ checkoutFailure: "other", exitCode: 75 })).not.toContain("Fetch revision")
  expect(render({ checkoutFailure: "clone", exitCode: null })).toContain(">Checkout<")
  const stageFiveHistoric = render({ checkoutFailure: "clone", exitCode: 75 })
  expect(stageFiveHistoric).toContain("Fetch revision")
  expect(stageFiveHistoric).not.toContain("Unknown cause")
  expect(stageFiveHistoric).not.toContain("HTTP ")
  const historic = render({ exitCode: null })
  expect(historic).toContain("checkout")
  expect(historic).toContain('data-status="failed"')
  expect(historic).toContain('data-status="skipped"')
  expect(historic).not.toContain("Revision verification")
  expect(historic).not.toContain("Unknown cause")
  expect(historic).not.toContain("Exit ")
})
