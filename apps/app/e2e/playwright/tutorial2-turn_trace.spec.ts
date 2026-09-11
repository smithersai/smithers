import { expect, test } from "@playwright/test"
import type { Page, Locator } from "@playwright/test"
import { SCOPED_TEST_USER, SCOPED_TEST_USER_CLOUD_SESSION } from "./identity"

// Gateway projection fixture: tests the real card/flow/persistence path, not a live agent run.
const REPO = "smithersai/smithers"
const RUN_ID = "run-e2e"

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

interface RpcCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: Record<string, unknown>
}

const summaryRow = (status: string) => ({
  runId: RUN_ID,
  flowId: "tutorial-change",
  status,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: 1,
  calls: 2,
  callsFailed: 0,
  editsAttempted: 0,
  editsSucceeded: 0,
  inputTokens: 0,
  outputTokens: 0,
  verdict: status === "completed" ? "completed — done." : status,
  diagnosis: "Verdict   done."
})

/** Install the server double: signed in as the scoped-down user, one loaded repo, one gateway that accepts everything. */
const serve = async (page: Page, journal: ReadonlyArray<Record<string, unknown>> = []): Promise<{ rpc: Array<RpcCall> }> => {
  const rpc: Array<RpcCall> = []
  let planned: { flowId: string; input: unknown } | undefined
  /** The engine's own accounting: a steer the gateway took is pending until the next turn. */
  let steeringPending = 0
  // The last route registered wins, so the catch-all goes first.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/bootstrap", (route) => route.fulfill(json({
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "test",
    capabilities: ["agent", "identity", "cloud", "local.repositories"],
    authFlow: "none",
    sandbox: { platform: "darwin", mode: "trusted-only" }
  })))
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos: [] })))
  await page.route("**/api/auth/session", (route) =>
    route.fulfill(json(SCOPED_TEST_USER)))
  await page.route("**/api/cloud-auth/session", (route) =>
    route.fulfill(json(SCOPED_TEST_USER_CLOUD_SESSION)))
  await page.route("**/api/cloud/api/user/repos", (route) =>
    route.fulfill(json({
      repos: [{ owner: "smithersai", name: "smithers", full_name: REPO, default_bookmark: "main" }]
    })))
  await page.route("**/api/cloud/api/user/orgs", (route) => route.fulfill(json({ orgs: [{ login: "smithersai" }] })))
  await page.route("**/api/cloud/api/repos/smithersai/smithers/bookmarks", (route) =>
    route.fulfill(json({ bookmarks: [{ name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee" }] })))
  await page.route("**/api/cloud/api/user/workspaces", (route) => route.fulfill(json({ workspaces: [] })))
  await page.route("**/api/workflow/provision", (route) =>
    route.fulfill(json({ status: "ready", repo: REPO, gatewayId: "gw-1" })))
  await page.route("**/api/workflow/rpc", async (route) => {
    const call = route.request().postDataJSON() as RpcCall
    rpc.push(call)
    const rows = (projection: string, value: ReadonlyArray<unknown>) =>
      route.fulfill(json({ ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: value } }))
    switch (call.procedure) {
      case "List":
        return route.fulfill(json({
          ok: true,
          payload: { _tag: "flows", items: [{ flowId: "tutorial-change", description: "Review a PR" }] }
        }))
      case "Plan":
        planned = { flowId: String(call.payload.flowId), input: call.payload.input }
        return route.fulfill(json({
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: planned.flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        }))
      case "Run":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: RUN_ID } }))
      case "Approval.Submit":
        // The launch path auto-approves the plan it just made.
        return route.fulfill(json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } }))
      case "Steer":
        steeringPending += 1
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Resume":
      case "Signal":
      case "Cancel":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Projection.Snapshot": {
        const selector = (call.payload.selector ?? {}) as { _tag?: string }
        switch (selector._tag) {
          case "workspace-runs":
            return rows("workspace-runs", [{ ...summaryRow("running"), steeringPending }])
          case "run-summary":
            return rows("run-summary", [{ ...summaryRow("running"), steeringPending }])
          case "approvals":
            return rows("approvals", [])
          case "transcript":
            return rows("transcript", [])
          case "run-events":
            return rows("run-events", journal)
          default:
            return rows(String(selector._tag), [])
        }
      }
      default:
        return route.fulfill(json({ ok: false, error: { message: `no ${call.procedure}` } }))
    }
  })
  return { rpc }
}


const tabTo = async (page: Page, target: Locator) => {
  for (let i = 0; i < 140; i++) {
    if (await target.evaluate(el => el === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  throw new Error("Trace control is not keyboard reachable")
}
const send = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await tabTo(page, page.getByTestId("composer-input"))
  await page.keyboard.insertText(command)
  await page.keyboard.press("Enter")
}
test("change turns expose grounded explanations and exact source/results through keyboard and slash, durably embedded", async ({ page }) => {
  test.setTimeout(120_000)
  const record = (sequence: number, kind: string, payload: Record<string, unknown>) => ({ sequence, kind, payload, occurredAt: 1000 + sequence })
  const source = "await ctx.call('files.read', { path: 'src/index.ts' })"
  await serve(page, [
    record(1, "control.agent.turn-opened", {}),
    record(2, "control.agent.model-settled", { text: "I will inspect the entry point. Then I will plan the change." }),
    record(3, "control.agent.cell-produced", { text: source, language: "ts" }),
    record(4, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "src/index.ts" } }),
    record(5, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "export const exactRecordedResult = 42" }),
    record(6, "control.agent.turn-opened", {}),
    record(7, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "unitTests" } }),
    record(8, "control.agent.cell-call-settled", { flowName: "target.run", outcome: "failure", message: "recorded test failure" })
  ])
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toBeVisible()
  // Shared GuideShell currently hides the app during lessons; root handoff restores it.
  await send(page, "/onboarding.act finish")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "14")
  await send(page, `/runs.open ${RUN_ID} ${REPO}`)
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  const turns = card.getByRole("list", { name: "Turn explanations" })
  await expect(turns.locator("button")).toHaveCount(2)
  await expect(turns.locator(".run-turn-text").first()).toHaveText("I will inspect the entry point.")
  await expect(turns.locator(".run-turn-text").nth(1)).toHaveText("The agent called target.run.")
  await expect(card.getByRole("list", { name: "Call tree" })).toHaveCount(0)
  await tabTo(page, card.locator("[data-turn='1']"))
  expect(await card.locator("[data-turn='1']").evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await expect(card.getByRole("region", { name: "Recorded turn source" })).toContainText(source)
  await expect(card.getByRole("list", { name: "Call tree" })).not.toContainText("target.run")
  await tabTo(page, card.locator("[data-trace-span='call-1']"))
  await page.keyboard.press("Enter")
  const pane = card.getByTestId(`run-trace-pane-${RUN_ID}`)
  await expect(pane).toContainText("export const exactRecordedResult = 42")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await send(page, "/debug.verbose")
  await send(page, `/runs.trace.select ${RUN_ID} call-2`)
  await expect(pane).toContainText("recorded test failure")
  await expect(card).toContainText("No script source was recorded for this turn.")
  await expect(page.getByText(/You ran \/runs\.trace\.select run-e2e call-2 .*→ executed/)).toBeVisible()
  await page.keyboard.press("Escape")
  await page.reload()
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(pane).toHaveAttribute("data-span", "call-2")
  await expect(pane).toContainText("recorded test failure")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(page.getByTestId("composer-input")).toBeVisible()
})
