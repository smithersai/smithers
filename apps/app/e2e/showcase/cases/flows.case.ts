import { expect } from "@playwright/test"
import { showcase } from "../showcase"

const REPO = "smithersai/smithers"
const FLOW = "review-pr"
const DIGEST = "d".repeat(64)
const ENVELOPE = { capabilities: [], flows: [], budget: {} }

/** One plan node in the control plane's own shape (state/controller/graph.test.ts). */
const node = (id: string, action: string, dependsOn: ReadonlyArray<string> = [], key = "0") => ({
  id, kind: "step", key: `key1_${key.repeat(64)}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" },
  dependsOn, conflicts: [], strategy: "serialize", runtime: "delay-rebase", priority: 0, generation: 0, status: "run"
})
const NODES = [
  node("read-diff", "review/ReadDiff"),
  node("check", "review/Check", ["read-diff"], "1"),
  node("comment", "review/Comment", ["read-diff", "check"], "2")
]

export default showcase({
  id: "flows",
  order: 105,
  title: "Flows",
  summary: "Plan a flow and inspect its graph, run it, write a new one; schedules in the Dispatcher.",
  flows: ["flows", "flow.plan", "flow.plan.select", "flow.run", "flow.create", "triggers.list", "triggers.run", "triggers.pause"],
  run: async ({ page, app, backend }) => {
    let paused = false
    let planned = FLOW
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
    await backend.json("/api/workflow/provision", { status: "ready", repo: REPO, gatewayId: "gw-1" })
    await backend.json("/api/workflow/triggers", { status: "ok", repo: REPO, live: true, triggers: [], webhooks: [{ name: "github-pull-request", flowId: FLOW }] })
    await backend.json("/api/workflow/trigger-registrations", () => ({ status: "ok", rows: [
      { registrationId: "reg-nightly", slug: "nightly-review", flowId: FLOW, schedule: "0 3 * * *", enabled: !paused, ...(paused ? {} : { nextFireAt: "2026-09-26T03:00:00Z" }) }
    ] }))
    await backend.route(url => url.pathname === "/api/workflow/trigger-pause", route => { paused = true; return route.fulfill({ json: { status: "ok", paused: 1 } }) })
    await backend.route(url => url.pathname === "/api/workflow/rpc", route => {
      const call = route.request().postDataJSON() as { procedure: string; payload: { flowId?: string; selector?: { _tag?: string; runId?: string } } }
      const ok = (payload: unknown) => route.fulfill({ json: { ok: true, payload } })
      switch (call.procedure) {
        case "List": return ok({ _tag: "flows", items: [
          { flowId: FLOW, description: "Review a pull request and comment on it" },
          { flowId: "triage-issue", description: "Label and route a new issue" }
        ] })
        case "Plan": planned = call.payload.flowId ?? FLOW; return ok({
          planId: `${planned}-plan`, flowId: planned, digest: DIGEST, inputSummary: "{}", envelope: ENVELOPE, deployClass: false, nodes: NODES,
          graph: { edges: [{ from: "read-diff", to: "check", reason: "value" }, { from: "read-diff", to: "comment", reason: "value" }, { from: "check", to: "comment", reason: "value" }] },
          approval: { target: { _tag: "Plan", planId: `${planned}-plan`, digest: DIGEST, envelope: ENVELOPE }, scope: "run", idempotencyKey: `approve:${planned}-plan` }
        })
        case "Approval.Submit": return ok({ decision: { _tag: "Accepted", receiptId: "a" } })
        case "Run": return ok({ _tag: "Accepted", receiptId: "r", runId: planned === FLOW ? "run-review-71" : "run-create-flow-3" })
        case "Projection.Snapshot": {
          const tag = call.payload.selector?._tag
          const runId = call.payload.selector?.runId ?? "run-review-71"
          const rows = tag === "run-summary" ? [{ runId, flowId: runId === "run-review-71" ? FLOW : "create-flow", status: "running", createdAt: 1, updatedAt: 2,
            turns: 1, calls: 2, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: "running", diagnosis: "running" }] : []
          return ok({ cursor: { projection: tag, runId: null, value: 0 }, rows })
        }
        default: return ok({ _tag: "Accepted", receiptId: "ok" })
      }
    })

    await app.open("/")
    await app.click(page.getByRole("button", { name: "Dismiss", exact: true }))
    // The Flows chrome button is the `flows` surface: the repository's flow list as a card.
    await app.click(page.getByRole("button", { name: "Flows", exact: true }))
    const list = page.locator('[data-kind="workflow-list"]').last()
    await expect(list).toContainText(FLOW)
    await expect(list).toContainText("triage-issue")
    await app.show(list)
    await app.beat(500)

    await app.click(list.getByRole("button", { name: "Plan" }).first())
    const plan = page.locator('[data-kind="flow-plan"]').last()
    await expect(plan.locator(".flow-plan-count")).toHaveText("3")
    await app.show(plan)
    await app.maximize(plan)
    await app.beat(500)
    const check = plan.getByRole("button", { name: "review/Check check run" })
    await app.click(check)
    const drawer = plan.locator('.flow-graph-drawer[role="group"]')
    await expect(drawer).toContainText("review/Check")
    await app.beat(500)
    // A dependency in the drawer opens that node.
    await app.click(drawer.getByRole("button", { name: "read-diff", exact: true }))
    await expect(drawer).toContainText("review/ReadDiff")
    await app.beat(500)
    await app.click(plan.getByRole("button", { name: "Run", exact: true }))
    const run = page.locator('[data-kind="run-trace"][data-run-id="run-review-71"]')
    await expect(run).toContainText("Running", { timeout: 15_000 })
    await app.show(run)
    await app.beat(500)

    // A new flow from one sentence: an authoring run on the workspace.
    await app.slash(`/flow.create Mark issues idle for 30 days stale ${REPO}`)
    const authoring = page.locator('[data-kind="run-trace"][data-run-id="run-create-flow-3"]')
    await expect(authoring).toContainText("Running", { timeout: 15_000 })
    await app.closeComposer()
    await app.show(authoring)
    await app.beat(500)
    const authorToast = page.locator('.toast[data-toast-status="running"]').filter({ hasText: "Creating a flow" })
    await expect(authorToast).toHaveCount(1)
    await expect(authorToast.getByRole("button", { name: "Stop", exact: true })).toBeVisible()

    await app.slash(`/triggers.list ${REPO}`)
    const dispatcher = page.locator('[data-kind="trigger-list"]').last()
    await expect(dispatcher.getByTestId("trigger-live")).toBeVisible()
    await expect(dispatcher).toContainText("runs review-pr")
    await app.closeComposer()
    await app.show(dispatcher)
    await app.beat(500)
    await app.click(dispatcher.getByTestId("trigger-run-nightly-review"))
    const dispatched = page.locator('[data-kind="run-trace"]').filter({ hasText: "Run nightly-review" })
    await expect(dispatched).toContainText("Running", { timeout: 15_000 })
    await app.show(dispatched)
    await app.beat(500)
    const dispatchToast = page.locator('.toast[data-toast-status="running"]').filter({ hasText: /(?:Running|Run) nightly-review/ })
    await expect(dispatchToast).toHaveCount(1)
    await expect(dispatchToast.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
    await app.show(dispatcher)
    await app.click(dispatcher.getByTestId("trigger-pause-nightly-review"))
    await expect(dispatcher.getByTestId("trigger-state-reg-nightly")).toContainText("disabled", { timeout: 10_000 })
    await app.show(dispatcher)
  }
})
