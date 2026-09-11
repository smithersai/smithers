import type { Page } from "@playwright/test"

/*
 * The tutorial's boundary double (onboarding SCRIPT v4, section 5 "Harness").
 *
 * Beats 0–9 need none of this: the practice repository is bundled in the
 * client. The routes below stand in only for what beats 10–12 cross:
 *   - the host's bootstrap, shaped like the dev and cloud host (identity + cloud)
 *   - GitHub OAuth (a 302 straight back with `signed-in=github`)
 *   - GitHub's App install page (a 302 to the setup URL with installation_id=1)
 *   - the server's install verification (`{ repos: [acme/api] }`)
 *   - the workflow gateway that launches Create Wiki and Create Mythical history
 * Every request the page makes is recorded, so a spec can prove the practice
 * beats never left the machine and assert exactly what crossed the wire.
 */

export const TUTORIAL_LOGIN = "tutorial-user"
export const INSTALLED_REPO = "acme/api"

interface RpcCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: Record<string, unknown>
}

export interface TutorialHost {
  /** Every URL the page requested, in order. */
  readonly requests: Array<string>
  /** Requests that left this machine (not 127.0.0.1 / localhost, not data: or blob:). */
  readonly external: () => ReadonlyArray<string>
  /** The gateway procedures the page called. */
  readonly rpc: Array<RpcCall>
  /** How many times the page asked the server to verify an install. */
  verifyCalls: number
  signedIn: boolean
  installed: boolean
}

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
const local = (url: string): boolean => {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true
  const { hostname } = new URL(url)
  return hostname === "127.0.0.1" || hostname === "localhost"
}

export const stubTutorialHost = async (page: Page, origin: string): Promise<TutorialHost> => {
  const host: TutorialHost = {
    requests: [],
    external: () => host.requests.filter((url) => !local(url)),
    rpc: [],
    verifyCalls: 0,
    signedIn: false,
    installed: false
  }
  page.on("request", (request) => { host.requests.push(request.url()) })
  // The last route registered wins, so the catch-all goes first: an unstubbed seam answers honestly absent.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "not part of the tutorial double" } }, 404)))
  await page.route("**/api/bootstrap", (route) => route.fulfill(json({
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity", "cloud"], authFlow: "redirect", sandbox: null
  })))
  await page.route("**/api/auth/session", (route) => route.fulfill(json(host.signedIn
    ? { status: "signed-in", login: TUTORIAL_LOGIN, allowlisted: true, admin: false }
    : { status: "signed-out" })))
  await page.route("**/api/auth/scopes", (route) => route.fulfill(json({ scopes: [{ plain: "Read your GitHub profile." }] })))
  // Page level, after the catch-all: a page route always wins over a context route, so the catch-all would shadow it.
  // With or without a query: from "/" the app sends no return_to at all.
  await page.route(/\/api\/auth\/github\/start(\?.*)?$/, (route) => {
    host.signedIn = true
    const returnTo = new URL(route.request().url()).searchParams.get("return_to") ?? "/"
    return route.fulfill({ status: 302, headers: { location: `${returnTo}${returnTo.includes("?") ? "&" : "?"}signed-in=github` } })
  })
  /* GitHub's install page: the user picks acme/api there, and GitHub sends them to the App's setup URL. */
  await page.context().route("https://github.com/apps/**", (route) => {
    host.installed = true
    return route.fulfill({ status: 302, headers: { location: `${origin}/?installation_id=1&setup_action=install` } })
  })
  await page.route("**/api/user/github-app/installations/*", (route) => {
    host.verifyCalls += 1
    return route.fulfill(json({ repos: [{ fullName: INSTALLED_REPO, pushedAt: "2026-09-09T10:00:00Z" }] }))
  })
  await page.route("**/api/cloud/api/user/repos", (route) => route.fulfill(json({
    repos: host.installed ? [{ owner: "acme", name: "api", full_name: INSTALLED_REPO, default_bookmark: "main" }] : []
  })))
  await page.route("**/api/cloud/api/user/orgs", (route) => route.fulfill(json({ orgs: [] })))
  await page.route("**/api/cloud/api/user/workspaces", (route) => route.fulfill(json({ workspaces: [] })))
  await page.route("**/api/workflow/provision", (route) => route.fulfill(json({ status: "ready", repo: INSTALLED_REPO, gatewayId: "gw-1" })))
  let runs = 0
  await page.route("**/api/workflow/rpc", (route) => {
    const call = route.request().postDataJSON() as RpcCall
    host.rpc.push(call)
    const rows = (projection: string, value: ReadonlyArray<unknown>) =>
      route.fulfill(json({ ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: value } }))
    switch (call.procedure) {
      case "List":
        return route.fulfill(json({ ok: true, payload: { _tag: "flows", items: [] } }))
      case "Plan":
        return route.fulfill(json({ ok: true, payload: {
          planId: `plan-${String(call.payload.flowId)}`, flowId: call.payload.flowId, digest: "digest",
          envelope: { capabilities: [], flows: [], budget: {} }, inputSummary: "", deployClass: false, nodes: []
        } }))
      case "Run":
        runs += 1
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: `receipt-${runs}`, runId: `librarian-run-${runs}` } }))
      case "Approval.Submit":
        return route.fulfill(json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approval" } } }))
      case "Projection.Snapshot": {
        const selector = (call.payload.selector ?? {}) as { _tag?: string; runId?: string }
        if (selector._tag === "run-summary" || selector._tag === "workspace-runs") {
          return rows(selector._tag, [{ runId: selector.runId ?? "librarian-run-1", flowId: "librarian", status: "running",
            createdAt: 0, updatedAt: 0, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
            inputTokens: 0, outputTokens: 0, verdict: "running", diagnosis: "" }])
        }
        return rows(String(selector._tag), [])
      }
      default:
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
    }
  })
  return host
}

/** The flows the gateway double was asked to run, in launch order. */
export const launchedFlows = (host: TutorialHost): ReadonlyArray<string> =>
  host.rpc.filter((call) => call.procedure === "Plan").map((call) => `${String(call.payload.flowId)} ${call.repo}`)
