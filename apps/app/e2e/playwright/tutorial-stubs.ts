import type { Page } from "@playwright/test"
import { LiveTutorialRunSchema, LiveTutorialStartSchema, type LiveTutorialOperation, type LiveTutorialRun, type LiveTutorialStart } from "@smthrs/rpc/LiveTutorial"
import { practiceImplementation, practiceIssue } from "../../src/mainview/state/practice/PracticeRepository"
import commitsFixture from "../../src/mainview/state/practice/hello-server/commits.json"
import planFixture from "../../src/mainview/state/practice/hello-server/plan.json"

/*
 * The tutorial's boundary double (onboarding SCRIPT v4, section 5 "Harness").
 *
 * Read-only example data remains bundled; research, planning, implementation,
 * and Change creation cross the anonymous live API. This TEST boundary uses
 * recorded fixtures to exercise queued/running/completed responses. Other routes cover:
 *   - the host's bootstrap, shaped like the dev and cloud host (identity + cloud)
 *   - GitHub OAuth (a 302 straight back with `signed-in=github`)
 *   - GitHub's App install page (a 302 to the setup URL with installation_id=1)
 *   - the server's install verification (`{ repos: [acme/api] }`)
 *   - the workflow gateway that launches Create Wiki and Create Mythical history
 * Every request the page makes is recorded, so a spec can prove the practice
 * data stayed on the test host and assert exactly what crossed the wire.
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
  readonly live: Array<{ operation: LiveTutorialOperation; body: LiveTutorialStart }>
  readonly livePolls: Array<string>
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

export const stubTutorialHost = async (page: Page, _origin: string): Promise<TutorialHost> => {
  const host: TutorialHost = {
    requests: [],
    external: () => host.requests.filter((url) => !local(url)),
    rpc: [],
    live: [],
    livePolls: [],
    verifyCalls: 0,
    signedIn: false,
    installed: false
  }
  page.on("request", (request) => { host.requests.push(request.url()) })
  // The last route registered wins, so the catch-all goes first: an unstubbed seam answers honestly absent.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "not part of the tutorial double" } }, 404)))
  // Only this TEST boundary uses recorded git fixtures. Production runs real agents.
  const implementation = practiceImplementation()
  const snapshots = new Map<string, { run: LiveTutorialRun; polls: number }>()
  const keys = new Map<string, string>()
  await page.route("**/api/tutorial/live/**", async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "GET") {
      const runId = decodeURIComponent(path.split("/").at(-1)!)
      const entry = snapshots.get(runId)
      if (!entry) return route.fulfill(json({ error: "Run not found" }, 404))
      host.livePolls.push(runId)
      entry.polls++
      return route.fulfill(json(entry.polls === 1 ? { ...entry.run, phase: "running", result: undefined, plan: undefined, commits: undefined, change: undefined,
        events: [{ id: `${runId}-work`, label: `Running ${entry.run.operation}`, status: "running", startedAt: entry.run.createdAt }] } : entry.run))
    }
    const operation = path.split("/").at(-1) as LiveTutorialOperation
    if (!["research", "plan", "implement", "change"].includes(operation)) return route.fulfill(json({ error: "Unknown operation" }, 404))
    const body = LiveTutorialStartSchema.parse(route.request().postDataJSON())
    host.live.push({ operation, body })
    const old = keys.get(body.idempotencyKey)
    if (old) return route.fulfill(json(snapshots.get(old)!.run))
    if (operation === "implement" && body.planId !== "fixture-live-plan") return route.fulfill(json({ error: "The selected plan is not available" }, 409))
    const runId = `fixture-live-${operation}-${snapshots.size + 1}`
    const at = Date.now()
    const change = planFixture.changes[0]!
    const commits = commitsFixture.commits.map((commit, index) => ({ commitId: commit.commitId, parentCommitId: commitsFixture.commits[index - 1]?.commitId ?? commitsFixture.base.commitId,
      message: commit.message, files: commit.files, additions: commit.additions, deletions: commit.deletions }))
    const selected = commits.filter(commit => body.commitIds?.includes(commit.commitId))
    if (operation === "change" && !selected.length) return route.fulfill(json({ error: "Select at least one commit" }, 400))
    const run = LiveTutorialRunSchema.parse({ sessionId: "fixture-anonymous-session", runId, operation, phase: "completed", createdAt: at, updatedAt: at + 2000,
      events: [{ id: `${runId}-work`, label: `${operation} complete`, status: "completed", startedAt: at, finishedAt: at + 2000 }],
      ...(operation === "research" ? { result: `${practiceIssue(3)!.issueBody}\n\nRelevant source: src/hello.ts; tests: src/hello.test.ts.`, files: implementation.contents } : {}),
      ...(operation === "plan" ? { plan: { id: "fixture-live-plan", title: change.title, summary: change.intent, baseCommitId: planFixture.base.commitId,
        steps: change.atoms.map(atom => atom.message), files: change.atoms.flatMap(atom => atom.writes) } } : {}),
      ...(operation === "implement" ? { commits, diff: implementation.files, files: implementation.contents, branch: commitsFixture.branch,
        baseCommitId: commitsFixture.base.commitId, tests: { command: "npm test", exitCode: 0, output: "2 tests pass" }, result: `${commits.length} commits on ${commitsFixture.branch}` } : {}),
      ...(operation === "change" ? { change: { id: "fixture-live-change", title: change.title, summary: `${selected.length} commits selected for review`, commitIds: selected.map(commit => commit.commitId), baseCommitId: commitsFixture.base.commitId } } : {})
    })
    snapshots.set(runId, { run, polls: 0 }); keys.set(body.idempotencyKey, runId)
    return route.fulfill(json({ ...run, phase: "queued", result: undefined, plan: undefined, commits: undefined, change: undefined, events: [] }, 202))
  })
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
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Installed. Return to Smithers.</p>" })
  })
  await page.route("**/api/user/github-app/installations**", (route) => {
    host.verifyCalls += 1
    return route.fulfill(json({ repos: host.installed ? [{ fullName: INSTALLED_REPO, pushedAt: "2026-09-09T10:00:00Z" }] : [] }))
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
