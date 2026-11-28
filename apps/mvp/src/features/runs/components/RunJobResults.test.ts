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

test("checkout forge receipts render compact stage/origin labels and stay hidden for historical receipts", () => {
  const render = (checkoutForge?: CiJob.CheckoutForgeReceipt) =>
    renderToStaticMarkup(createElement(RunJobResults, {
      jobs: [{
        name: "audit",
        outcome: "failed",
        steps: [
          {
            name: "checkout",
            outcome: "failed",
            exitCode: 75,
            checkoutFailure: "clone",
            checkoutTransportCause: "http_status",
            checkoutHttpStatus: 404,
            ...(checkoutForge === undefined ? {} : { checkoutForge }),
          },
          { name: "run", outcome: "skipped", exitCode: null },
        ],
      }],
    }))

  // Historical Stage 7 receipt (no checkoutForge) renders HTTP 404 with no forge pill.
  const historic = render()
  expect(historic).toContain(">HTTP 404<")
  expect(historic).not.toContain("Forge ")
  expect(historic).not.toContain("info-refs")
  expect(historic).not.toContain("upload-pack")

  const cases: ReadonlyArray<readonly [CiJob.CheckoutForgeReceipt, string]> = [
    [{ routing: "unreached" }, "Forge unreached"],
    [{ routing: "host_mismatch" }, "Forge host mismatch"],
    [{ routing: "no_branch" }, "Forge no branch"],
    [{ routing: "unscoped", refused: { source: "proxy", status: 403, outcome: "refused" } }, "Forge unscoped"],
    [{ routing: "failed" }, "Forge error"],
    [{ routing: "reached", upstream: "github", infoRefs: { source: "upstream", status: 404, outcome: "4xx" } }, "GitHub info-refs 404"],
    [{
      routing: "reached",
      upstream: "github",
      infoRefs: { source: "upstream", status: 200, outcome: "ok" },
      uploadPack: { source: "upstream", status: 404, outcome: "4xx" },
    }, "GitHub upload-pack 404"],
    [{ routing: "reached", upstream: "deployment", infoRefs: { source: "upstream", status: 404, outcome: "4xx" } }, "Mirror info-refs 404"],
    [{ routing: "reached", upstream: "github", infoRefs: { source: "proxy", status: 502, outcome: "transport" } }, "Proxy info-refs 502"],
    [{ routing: "reached", upstream: "github", refused: { source: "proxy", status: 403, outcome: "refused" } }, "Proxy refused 403"],
    [{ routing: "reached", upstream: "github", infoRefs: { source: "upstream", status: 200, outcome: "ok" } }, "GitHub info-refs 200"],
    [{ routing: "reached", upstream: "github", uploadPack: { source: "upstream", status: 200, outcome: "ok" } }, "GitHub upload-pack 200"],
    [{ routing: "reached" }, "Forge reached"],
  ]
  for (const [receipt, expected] of cases) {
    expect(render(receipt)).toContain(`>${expected}<`)
  }
})
