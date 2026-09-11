import type { Page } from "@playwright/test"
import { SCOPED_TEST_USER, SCOPED_TEST_USER_CLOUD_SESSION } from "./identity.ts"

/*
 * Lane runs T1 (docs/workbench-lanes/runs.md "Exit"): launch a fixture flow,
 * steer it, stop it, and see it in the run inbox — the whole lifecycle over
 * the workspace gateway, with the server as a double (piper.spec.ts's
 * pattern): every seam answers through page.route, and the RPC double
 * records each procedure so the test asserts the wire, not just the pixels.
 */

export const REPO = "smithersai/smithers"
export const RUN_ID = "run-e2e"

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
export const serve = async (page: Page, journal: ReadonlyArray<Record<string, unknown>> = []): Promise<{ rpc: Array<RpcCall> }> => {
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
            return rows("workspace-runs", [{ ...summaryRow("completed"), steeringPending }])
          case "run-summary":
            return rows("run-summary", [{ ...summaryRow("completed"), steeringPending }])
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

